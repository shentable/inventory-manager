package com.sandwich.inventory

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.NetworkCapabilities
import android.system.OsConstants
import java.net.HttpURLConnection
import java.net.Inet6Address
import java.net.URL
import java.net.URLEncoder
import org.json.JSONObject

/** 将服务端 Wi-Fi 的公网 IPv6 同步到一个 Cloudflare AAAA 记录。 */
object CloudflareDdns {
    private const val API = "https://api.cloudflare.com/client/v4"
    private const val TOKEN_KEY = "cloudflare_api_token"
    val SUPPORTED_PROXY_HTTPS_PORTS = setOf(2053, 2083, 2087, 2096, 8443)

    data class SyncResult(val ok: Boolean, val message: String, val ip: String? = null)

    fun hasToken(context: Context): Boolean = !SecureStore.get(context, TOKEN_KEY).isNullOrBlank()

    fun saveToken(context: Context, token: String) {
        val trimmed = token.trim()
        if (trimmed.isNotEmpty()) SecureStore.put(context, TOKEN_KEY, trimmed)
    }

    /** 校验配置，返回错误文案的字符串资源 id（null = 合法） */
    fun validate(config: NodeConfig.CloudflareDdnsConfig, hasToken: Boolean): Int? {
        if (!config.enabled) return null
        if (!config.zoneId.matches(Regex("^[0-9a-fA-F]{32}$"))) return R.string.cf_err_zone_id
        if (!isValidHostname(config.hostname)) return R.string.cf_err_hostname
        if (config.proxied && config.publicHttpsPort !in SUPPORTED_PROXY_HTTPS_PORTS) {
            return R.string.cf_err_proxy_port
        }
        if (config.publicHttpsPort !in 1024..65535) return R.string.cf_err_https_port_range
        if (!hasToken) return R.string.cf_err_token_required
        return null
    }

    /** 校验并直接返回本地化错误文案（null = 合法） */
    fun validateMessage(context: Context, config: NodeConfig.CloudflareDdnsConfig, hasToken: Boolean): String? =
        validate(config, hasToken)?.let { res ->
            if (res == R.string.cf_err_proxy_port) {
                context.getString(res, SUPPORTED_PROXY_HTTPS_PORTS.sorted().joinToString())
            } else {
                context.getString(res)
            }
        }

    internal fun isValidHostname(value: String): Boolean {
        if (value.length !in 4..253 || value.endsWith('.')) return false
        val labels = value.split('.')
        if (labels.size < 2) return false
        return labels.all { label ->
            label.length in 1..63 && label.first().isLetterOrDigit() &&
                label.last().isLetterOrDigit() && label.all { it.isLetterOrDigit() || it == '-' }
        }
    }

    internal fun isGlobalIpv6(address: Inet6Address): Boolean {
        val first = address.address.first().toInt() and 0xff
        return first in 0x20..0x3f && !address.isAnyLocalAddress && !address.isLoopbackAddress &&
            !address.isLinkLocalAddress && !address.isSiteLocalAddress && !address.isMulticastAddress
    }

    private fun publicWifiIpv6(context: Context): String? {
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val candidates = mutableListOf<LinkAddress>()
        manager.allNetworks.forEach { network ->
            val capabilities = manager.getNetworkCapabilities(network) ?: return@forEach
            if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return@forEach
            manager.getLinkProperties(network)?.linkAddresses?.forEach { link ->
                val address = link.address as? Inet6Address ?: return@forEach
                if (isGlobalIpv6(address)) candidates += link
            }
        }
        val healthy = candidates.filter { link ->
            val flags = link.flags
            flags and OsConstants.IFA_F_DADFAILED == 0 &&
                flags and OsConstants.IFA_F_TENTATIVE == 0 &&
                flags and OsConstants.IFA_F_DEPRECATED == 0
        }
        val selected = healthy.sortedWith(
            compareBy<LinkAddress> { it.flags and OsConstants.IFA_F_TEMPORARY != 0 }
                .thenBy { it.address.hostAddress.orEmpty() },
        ).firstOrNull() ?: return null
        return selected.address.hostAddress?.substringBefore('%')?.lowercase()
    }

    fun syncNow(context: Context): SyncResult {
        val config = NodeConfig.cloudflareDdns(context)
        if (!config.enabled) return SyncResult(true, context.getString(R.string.cf_not_enabled))
        val token = SecureStore.get(context, TOKEN_KEY)
        validateMessage(context, config, !token.isNullOrBlank())?.let { return failed(context, it) }
        val ip = publicWifiIpv6(context)
            ?: return failed(context, context.getString(R.string.cf_no_public_ipv6))
        return try {
            val encodedName = URLEncoder.encode(config.hostname, Charsets.UTF_8.name())
            val list = request(
                context,
                "GET",
                "$API/zones/${config.zoneId}/dns_records?type=AAAA&name=$encodedName&per_page=100",
                token!!,
            )
            val records = list.optJSONArray("result") ?: return failed(context, apiError(context, list))
            val exact = (0 until records.length()).map { records.getJSONObject(it) }
                .filter { it.optString("type") == "AAAA" && it.optString("name").equals(config.hostname, true) }
            if (exact.size > 1) return failed(context, context.getString(R.string.cf_duplicate_records))

            val existing = exact.firstOrNull()
            val unchanged = existing != null && existing.optString("content").equals(ip, true) &&
                existing.optBoolean("proxied") == config.proxied
            if (!unchanged) {
                val payload = JSONObject()
                    .put("type", "AAAA")
                    .put("name", config.hostname)
                    .put("content", ip)
                    .put("ttl", 1)
                    .put("proxied", config.proxied)
                    .put("comment", "Managed by Shantech Inventory Android host")
                val endpoint = if (existing == null) {
                    "$API/zones/${config.zoneId}/dns_records"
                } else {
                    "$API/zones/${config.zoneId}/dns_records/${existing.getString("id")}"
                }
                val response = request(context, if (existing == null) "POST" else "PATCH", endpoint, token, payload)
                if (!response.optBoolean("success")) return failed(context, apiError(context, response))
            }
            val message = context.getString(
                if (unchanged) R.string.cf_already_latest else R.string.cf_update_success
            )
            NodeConfig.markCloudflareDdns(context, message, ip)
            SyncResult(true, message, ip)
        } catch (e: Exception) {
            failed(context, context.getString(R.string.cf_sync_failed, e.message ?: e.javaClass.simpleName))
        }
    }

    private fun failed(context: Context, message: String): SyncResult {
        NodeConfig.markCloudflareDdns(context, message)
        return SyncResult(false, message)
    }

    private fun request(context: Context, method: String, url: String, token: String, body: JSONObject? = null): JSONObject {
        val connection = URL(url).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = method
            connection.connectTimeout = 8_000
            connection.readTimeout = 8_000
            connection.useCaches = false
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (text.isBlank()) throw IllegalStateException(context.getString(R.string.cf_http_error, connection.responseCode))
            JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    private fun apiError(context: Context, response: JSONObject): String {
        val errors = response.optJSONArray("errors")
        if (errors != null && errors.length() > 0) {
            val detail = errors.optJSONObject(0)?.optString("message").orEmpty()
                .ifBlank { context.getString(R.string.cf_request_failed) }
            return context.getString(R.string.cf_error_prefix, detail)
        }
        return context.getString(R.string.cf_invalid_response)
    }
}
