package com.sandwich.inventory

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executor

/**
 * EasyTier 组网协调器。
 *
 * 优先路径（本仓库目标方案）：**内嵌 easytier-core 内核**
 *  - APK 内置内核可执行文件（[EasyTierCore.isBundled]）且用户已启用组网 →
 *    [EasyTierService] 常驻拉起内核，WebView 经 [applyWebViewProxy] 走本机 socks5
 *    进入虚拟网，店员手机**无需安装任何额外 App**；
 *
 * 兜底路径：APK 未内置内核（如开发期 debug 包）→ 检测系统 EasyTier App 并引导。
 *
 * 组网参数三来源，优先级从高到低：配置页手动输入 > BuildConfig 编译期注入 >
 * 默认值。门店批量装机建议在构建 APK 时通过 gradle property / 环境变量注入
 * （见 android/easytier/README.md），店员拿到手机零配置。
 */
object EasyTierHelper {

    private const val TAG = "EasyTierHelper"

    private const val PREFS_NAME = "easytier_config"
    private const val KEY_ENABLED = "et_enabled"
    private const val KEY_NAME = "et_network_name"
    private const val KEY_SECRET = "et_network_secret"
    private const val KEY_PEERS = "et_peers"
    private const val RETIRED_PUBLIC_NODE = "public.easytier.cn"

    private const val KEY_COMPANION_PROMPT_DISMISSED = "companion_prompt_dismissed"

    /** 官方 EasyTier App 候选包名（兜底路径用；装机一次后核对修订，见 easytier/README.md） */
    val CANDIDATE_PACKAGES = listOf(
        "cn.easytier.gui", "com.easytier.gui", "cn.easytier.android", "com.easytier.android"
    )
    const val DOWNLOAD_PAGE_URL = "https://github.com/EasyTier/EasyTier/releases"

    // ------------------------------------------------------------------
    // 配置存取
    // ------------------------------------------------------------------

    fun isEnabled(context: Context): Boolean =
        prefs(context).getBoolean(KEY_ENABLED, BuildConfig.EASYTIER_NETWORK_NAME.isNotBlank())

    /** 当前生效的组网配置；未启用或缺参数时返回 null */
    fun getConfig(context: Context): EasyTierCore.Config? {
        if (!isEnabled(context)) return null
        val p = prefs(context)
        val cfg = EasyTierCore.Config(
            networkName = p.getString(KEY_NAME, null) ?: BuildConfig.EASYTIER_NETWORK_NAME,
            networkSecret = p.getString(KEY_SECRET, null) ?: BuildConfig.EASYTIER_NETWORK_SECRET,
            peers = effectivePeers(p.getString(KEY_PEERS, null)),
            serverMode = NodeConfig.mode(context) == NodeMode.SERVER,
            virtualIp = NodeConfig.serverIp(context),
            listenerPort = NodeConfig.easyTierPublicPort(context),
        )
        return if (EasyTierCore.validate(cfg) == null) cfg else null
    }

    fun saveConfig(
        context: Context,
        enabled: Boolean,
        name: String,
        secret: String,
        peers: String,
    ) {
        val saved = prefs(context).edit()
            .putBoolean(KEY_ENABLED, enabled)
            .putString(KEY_NAME, name.trim())
            .putString(KEY_SECRET, secret.trim())
            .putString(KEY_PEERS, EasyTierCore.parsePeers(peers).joinToString("\n"))
            .commit()
        check(saved) { "无法保存 EasyTier 组网配置" }
    }

    /** 读取用于表单回显的值（BuildConfig 编译期注入优先作为初始值） */
    data class FormDefaults(val name: String, val secret: String, val peers: String)

    fun formDefaults(context: Context): FormDefaults {
        val p = prefs(context)
        return FormDefaults(
            name = p.getString(KEY_NAME, null) ?: BuildConfig.EASYTIER_NETWORK_NAME,
            secret = p.getString(KEY_SECRET, null) ?: BuildConfig.EASYTIER_NETWORK_SECRET,
            peers = effectivePeers(p.getString(KEY_PEERS, null)).joinToString("\n"),
        )
    }

    /** 升级旧包时自动淘汰已经失效的官方域名，避免服务端只在局域网可见。 */
    private fun effectivePeers(stored: String?): List<String> {
        val configured = EasyTierCore.parsePeers(stored.orEmpty())
            .filterNot { it.contains(RETIRED_PUBLIC_NODE, ignoreCase = true) }
        return configured.ifEmpty { EasyTierCore.parsePeers(BuildConfig.EASYTIER_PEERS) }
    }

    // ------------------------------------------------------------------
    // 启动引导（MainActivity.onCreate 调用）
    // ------------------------------------------------------------------

    fun bootstrap(activity: Activity) {
        val cfg = getConfig(activity)
        if (cfg != null) {
            if (EasyTierCore.isBundled(activity)) {
                // 内嵌路径：确保内核服务在跑（重启按新配置生效）
                NodeService.start(activity, cfg)
            } else {
                Log.w(TAG, "已启用内嵌组网但 APK 未内置内核，无法建立隧道")
            }
            return
        }
        // 内置内核但用户选择直连（店内 Wi-Fi）：不打扰
        if (EasyTierCore.isBundled(activity)) return
        // 未内置内核（开发包）：兜底检测系统 EasyTier App（伴生方案）
        val pkg = findCompanionApp(activity)
        if (pkg == null) promptInstallCompanionApp(activity)
    }

    // ------------------------------------------------------------------
    // WebView 代理（内嵌路径的核心：把 WebView 流量送入内核 socks5）
    // ------------------------------------------------------------------

    /**
     * 按当前配置应用/清除 WebView 全局代理。必须在 loadUrl 之前调用。
     * 代理对本进程所有 WebView 生效；设备 WebView 不支持 PROXY_OVERRIDE 时静默跳过
     * （此时内嵌组网不可用，只能走直连或伴生 App）。
     */
    fun applyWebViewProxy(context: Context) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            Log.w(TAG, "当前 WebView 不支持 PROXY_OVERRIDE，内嵌代理不可用")
            return
        }
        val cfg = getConfig(context)
        val controller = ProxyController.getInstance()
        val executor = Executor { it.run() }
        if (cfg != null && EasyTierCore.isBundled(context)) {
            val config = ProxyConfig.Builder()
                .addProxyRule("socks5://127.0.0.1:${cfg.socksPort}")
                .addBypassRule("127.0.0.1")
                .addBypassRule("localhost")
                .build()
            controller.setProxyOverride(config, executor) {
                Log.i(TAG, "WebView 代理已指向 socks5://127.0.0.1:${cfg.socksPort}")
            }
        } else {
            controller.clearProxyOverride(executor) {
                Log.i(TAG, "WebView 代理已清除（直连模式）")
            }
        }
    }

    // ------------------------------------------------------------------
    // 伴生 App 兜底（APK 未内置内核时）
    // ------------------------------------------------------------------

    private fun findCompanionApp(context: Context): String? {
        for (pkg in CANDIDATE_PACKAGES) {
            try {
                context.packageManager.getPackageInfo(pkg, 0)
                return pkg
            } catch (_: Exception) { /* 尝试下一个 */ }
        }
        return null
    }

    private fun promptInstallCompanionApp(activity: Activity) {
        if (prefs(activity).getBoolean(KEY_COMPANION_PROMPT_DISMISSED, false)) return
        AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.easytier_dialog_title))
            .setMessage(activity.getString(R.string.easytier_dialog_message))
            .setPositiveButton(activity.getString(R.string.easytier_dialog_download)) { _, _ -> openDownloadPage(activity) }
            .setNegativeButton(activity.getString(R.string.easytier_dialog_later)) { _, _ ->
                prefs(activity).edit().putBoolean(KEY_COMPANION_PROMPT_DISMISSED, true).apply()
            }
            .show()
    }

    private fun openDownloadPage(context: Context) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(DOWNLOAD_PAGE_URL)))
        } catch (e: Exception) {
            Log.w(TAG, "无法打开下载页: ${e.message}")
        }
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
