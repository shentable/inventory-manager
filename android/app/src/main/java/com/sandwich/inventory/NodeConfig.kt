package com.sandwich.inventory

import android.content.Context

enum class NodeMode { CLIENT, SERVER }

/** APK 节点角色与本机服务端初始化资料。敏感值由 [SecureStore] 加密保存。 */
object NodeConfig {
    data class CloudflareDdnsConfig(
        val enabled: Boolean,
        val zoneId: String,
        val hostname: String,
        val proxied: Boolean,
        val publicHttpsPort: Int,
    )

    const val DEFAULT_SERVER_IP = "10.126.126.1"
    const val DEFAULT_EASYTIER_PUBLIC_PORT = 32147
    const val LOCAL_SERVER_URL = "http://127.0.0.1:8000"
    private const val PREFS = "node_config"
    private const val KEY_MODE = "mode"
    private const val KEY_MODE_SELECTED = "mode_selected"
    private const val KEY_IP = "server_virtual_ip"
    private const val KEY_RESUME = "resume_after_boot"
    private const val KEY_BACKUP_TREE = "backup_tree_uri"
    private const val KEY_LAST_BACKUP = "last_backup_ms"
    private const val KEY_TRUSTED_STORE_ID = "trusted_store_id"
    private const val KEY_EASYTIER_PUBLIC_PORT = "easytier_public_port"
    private const val KEY_CF_DDNS_ENABLED = "cf_ddns_enabled"
    private const val KEY_CF_ZONE_ID = "cf_zone_id"
    private const val KEY_CF_HOSTNAME = "cf_hostname"
    private const val KEY_CF_PROXIED = "cf_proxied"
    private const val KEY_CF_PUBLIC_HTTPS_PORT = "cf_public_https_port"
    private const val KEY_CF_LAST_STATUS = "cf_last_status"
    private const val KEY_CF_LAST_IP = "cf_last_ip"
    private const val KEY_CF_LAST_SYNC = "cf_last_sync_ms"

    fun mode(context: Context): NodeMode = runCatching {
        NodeMode.valueOf(context.getSharedPreferences(PREFS, 0).getString(KEY_MODE, "CLIENT")!!)
    }.getOrDefault(NodeMode.CLIENT)
    fun serverIp(context: Context): String = context.getSharedPreferences(PREFS, 0)
        .getString(KEY_IP, DEFAULT_SERVER_IP) ?: DEFAULT_SERVER_IP
    fun saveMode(context: Context, mode: NodeMode, ip: String = DEFAULT_SERVER_IP) {
        context.getSharedPreferences(PREFS, 0).edit().putString(KEY_MODE, mode.name)
            .putString(KEY_IP, ip.trim()).putBoolean(KEY_MODE_SELECTED, true)
            .putBoolean(KEY_RESUME, true).apply()
    }
    fun hasSelectedMode(context: Context): Boolean = context.getSharedPreferences(PREFS, 0)
        .getBoolean(KEY_MODE_SELECTED, false)
    fun shouldResume(context: Context): Boolean = context.getSharedPreferences(PREFS, 0)
        .getBoolean(KEY_RESUME, false)
    fun backupTree(context: Context): String? = context.getSharedPreferences(PREFS, 0)
        .getString(KEY_BACKUP_TREE, null)
    fun setBackupTree(context: Context, uri: String) = context.getSharedPreferences(PREFS, 0)
        .edit().putString(KEY_BACKUP_TREE, uri).apply()
    fun lastBackup(context: Context): Long = context.getSharedPreferences(PREFS, 0)
        .getLong(KEY_LAST_BACKUP, 0)
    fun markBackup(context: Context, time: Long = System.currentTimeMillis()) =
        context.getSharedPreferences(PREFS, 0).edit().putLong(KEY_LAST_BACKUP, time).apply()
    fun clientServerUrl(context: Context): String = context.getSharedPreferences("app_config", 0)
        .getString("server_url", BuildConfig.DEFAULT_SERVER_URL) ?: BuildConfig.DEFAULT_SERVER_URL
    fun trustedStoreId(context: Context): String? = context.getSharedPreferences(PREFS, 0)
        .getString(KEY_TRUSTED_STORE_ID, null)?.trim()?.ifEmpty { null }
    fun trustStore(context: Context, storeId: String): Boolean {
        require(storeId.isNotBlank()) { "store_id 不能为空" }
        return context.getSharedPreferences(PREFS, 0).edit()
            .putString(KEY_TRUSTED_STORE_ID, storeId.trim()).commit()
    }
    fun clearTrustedStore(context: Context) = context.getSharedPreferences(PREFS, 0)
        .edit().remove(KEY_TRUSTED_STORE_ID).commit()

    fun easyTierPublicPort(context: Context): Int = context.getSharedPreferences(PREFS, 0)
        .getInt(KEY_EASYTIER_PUBLIC_PORT, DEFAULT_EASYTIER_PUBLIC_PORT)
    fun setEasyTierPublicPort(context: Context, port: Int) {
        require(port in 1024..65535) { context.getString(R.string.easytier_port_invalid) }
        context.getSharedPreferences(PREFS, 0).edit().putInt(KEY_EASYTIER_PUBLIC_PORT, port).apply()
    }

    fun cloudflareDdns(context: Context): CloudflareDdnsConfig {
        val prefs = context.getSharedPreferences(PREFS, 0)
        return CloudflareDdnsConfig(
            enabled = prefs.getBoolean(KEY_CF_DDNS_ENABLED, false),
            zoneId = prefs.getString(KEY_CF_ZONE_ID, "").orEmpty().trim(),
            hostname = prefs.getString(KEY_CF_HOSTNAME, "").orEmpty().trim().lowercase(),
            proxied = prefs.getBoolean(KEY_CF_PROXIED, true),
            publicHttpsPort = prefs.getInt(KEY_CF_PUBLIC_HTTPS_PORT, NativeServerCore.DEFAULT_PUBLIC_HTTPS_PORT),
        )
    }

    fun saveCloudflareDdns(context: Context, config: CloudflareDdnsConfig) {
        context.getSharedPreferences(PREFS, 0).edit()
            .putBoolean(KEY_CF_DDNS_ENABLED, config.enabled)
            .putString(KEY_CF_ZONE_ID, config.zoneId.trim())
            .putString(KEY_CF_HOSTNAME, config.hostname.trim().lowercase())
            .putBoolean(KEY_CF_PROXIED, config.proxied)
            .putInt(KEY_CF_PUBLIC_HTTPS_PORT, config.publicHttpsPort)
            .apply()
    }

    fun markCloudflareDdns(context: Context, status: String, ip: String? = null) {
        context.getSharedPreferences(PREFS, 0).edit()
            .putString(KEY_CF_LAST_STATUS, status)
            .putString(KEY_CF_LAST_IP, ip.orEmpty())
            .putLong(KEY_CF_LAST_SYNC, System.currentTimeMillis())
            .apply()
    }

    fun cloudflareDdnsStatus(context: Context): String {
        val prefs = context.getSharedPreferences(PREFS, 0)
        val status = prefs.getString(KEY_CF_LAST_STATUS, null) ?: return context.getString(R.string.ddns_status_never)
        val ip = prefs.getString(KEY_CF_LAST_IP, "").orEmpty()
        val time = prefs.getLong(KEY_CF_LAST_SYNC, 0)
        val ageMinutes = if (time > 0) (System.currentTimeMillis() - time).coerceAtLeast(0) / 60_000 else 0
        return buildString {
            append(status)
            if (ip.isNotBlank()) append(" · ").append(ip)
            if (time > 0) append(" · ").append(context.getString(R.string.ddns_status_minutes_ago, ageMinutes))
        }
    }
}
