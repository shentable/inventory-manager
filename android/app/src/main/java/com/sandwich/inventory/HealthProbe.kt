package com.sandwich.inventory

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.net.URL
import org.json.JSONObject

/** 通过 EasyTier 本地 SOCKS5 探测真实后端健康状态。 */
object HealthProbe {
    data class Result(
        val ok: Boolean,
        val detail: String = "",
        val storeId: String? = null,
        val backendKind: String? = null,
        val appVersion: String? = null,
    )

    fun isTcpPortOpen(host: String, port: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(host, port), 750) }
        true
    } catch (_: Exception) {
        false
    }

    fun checkOnce(context: Context, serverUrl: String, socksPort: Int?): Result {
        return try {
            val healthUrl = URL(serverUrl.trimEnd('/') + "/api/health")
            val connection = if (socksPort != null) healthUrl.openConnection(
                Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort))
            ) else healthUrl.openConnection()
            connection as HttpURLConnection
            connection.requestMethod = "GET"; connection.connectTimeout = 1_500
            connection.readTimeout = 1_500; connection.useCaches = false
            val code = connection.responseCode
            val body = if (code == 200) connection.inputStream.bufferedReader().use { it.readText() } else ""
            connection.disconnect()
            if (code != 200) return Result(false, context.getString(R.string.probe_server_returned_code, code))
            val json = JSONObject(body)
            val storeId = json.optString("store_id").trim().ifEmpty { null }
            if (json.optString("status") != "ok" || storeId == null) {
                Result(false, context.getString(R.string.probe_health_missing_fields))
            } else {
                Result(
                    ok = true,
                    storeId = storeId,
                    backendKind = json.optString("backend_kind").trim().ifEmpty { null },
                    appVersion = json.optString("app_version").trim().ifEmpty { null },
                )
            }
        } catch (e: Exception) { Result(false, e.message ?: e.javaClass.simpleName) }
    }
    fun start(context: Context, serverUrl: String, socksPort: Int?, callback: (Result) -> Unit) {
        Thread {
            var lastError = context.getString(R.string.probe_timeout)
            repeat(30) {
                try {
                    val result = checkOnce(context, serverUrl, socksPort)
                    if (result.ok) {
                        Handler(Looper.getMainLooper()).post { callback(result) }
                        return@Thread
                    }
                    lastError = result.detail
                } catch (e: Exception) {
                    lastError = e.message ?: e.javaClass.simpleName
                }
                Thread.sleep(500)
            }
            Handler(Looper.getMainLooper()).post { callback(Result(false, lastError)) }
        }.apply { isDaemon = true; start() }
    }
}
