package com.sandwich.inventory

import android.content.Context
import android.util.Log
import java.io.File
import java.net.URI

/**
 * 内嵌 easytier-core 内核进程管理。
 *
 * 集成方式（详见 android/easytier/README.md 与 build-core.sh）：
 *  - easytier-core 按 ABI 交叉编译为可执行文件，重命名为 `libeasytiercore.so`
 *    放入 `app/src/main/jniLibs/<abi>/`，APK 安装时随原生库提取到
 *    `nativeLibraryDir`（多数设备自带可执行权限；不行则复制到 filesDir 兜底）；
 *  - 以 `--no-tun --socks5 <port>` 运行：不创建虚拟网卡（无需 VPN 权限），
 *    在本机 127.0.0.1:<port> 开一个 socks5 入口直通虚拟网；
 *  - WebView 流量由 [EasyTierHelper.applyWebViewProxy] 指向该 socks5。
 *
 * 参数集已对照 easytier/easytier 官方镜像 `--help` 实测确认。
 */
object EasyTierCore {

    private const val TAG = "EasyTierCore"

    /** jniLibs 中的内核文件名（伪装成 .so 才能被提取到 nativeLibraryDir） */
    const val LIB_NAME = "libeasytiercore.so"

    const val DEFAULT_SOCKS_PORT = 10808

    data class Config(
        val networkName: String,
        val networkSecret: String,
        val peers: List<String>,
        val socksPort: Int = DEFAULT_SOCKS_PORT,
        val serverMode: Boolean = false,
        val virtualIp: String = NodeConfig.DEFAULT_SERVER_IP,
        val listenerPort: Int = NodeConfig.DEFAULT_EASYTIER_PUBLIC_PORT,
    )

    /** APK 是否内置了内核可执行文件 */
    fun isBundled(context: Context): Boolean =
        File(context.applicationInfo.nativeLibraryDir, LIB_NAME).exists()

    /** 组装命令行参数 */
    fun buildArgs(cfg: Config): List<String> = buildList {
        add("--no-tun")
        add("--hostname"); add(if (cfg.serverMode) "android-store-host" else "android-phone")
        if (cfg.serverMode) {
            add("--ipv4"); add(cfg.virtualIp)
            add("--listeners"); add("tcp://[::]:${cfg.listenerPort}")
        } else add("--dhcp")
        // 两端都保留 EasyTier 监听器。客户端处在移动网络/对称 NAT 后时，
        // 监听器仍会被 UDP/TCP 打洞逻辑使用；--no-listener 会令跨网场景
        // 过度依赖共享节点转发，而同一 Wi-Fi 下的直连测试无法暴露这个问题。
        if (cfg.serverMode) add("--need-p2p")
        addAll(listOf(
        "--network-name", cfg.networkName,
        "--network-secret", cfg.networkSecret,
        "--socks5", cfg.socksPort.toString(),
        "--peers"
        ))
        addAll(cfg.peers)
        if (cfg.serverMode) {
            // no-tun 模式只允许虚拟网访问库存后端，不把手机其它端口暴露给节点。
            add("--tcp-whitelist"); add("8000")
        }
        add("--multi-thread")
    }

    /** 启动内核进程（调用方负责持有/销毁返回的 Process） */
    fun start(context: Context, cfg: Config): Process {
        val exe = resolveExecutable(context)
        val cmd = mutableListOf(exe.absolutePath) + buildArgs(cfg)
        Log.i(TAG, "starting easytier-core: " + cmd.joinToString(" ") { if (it == cfg.networkSecret) "******" else it })
        return ProcessBuilder(cmd).redirectErrorStream(true).start()
    }

    /** 优先直接执行 nativeLibraryDir 中的内核；无执行权限则复制到 filesDir 赋权后执行 */
    private fun resolveExecutable(context: Context): File {
        val bundled = File(context.applicationInfo.nativeLibraryDir, LIB_NAME)
        if (bundled.exists() && bundled.canExecute()) return bundled

        val fallback = File(context.filesDir, "bin/easytier-core")
        if (fallback.exists() && fallback.canExecute()) return fallback

        check(bundled.exists()) { "APK 未内置 $LIB_NAME（请先运行 android/easytier/build-core.sh）" }
        Log.i(TAG, "nativeLibraryDir 不可执行，复制内核到 filesDir")
        fallback.parentFile?.mkdirs()
        bundled.inputStream().use { input -> fallback.outputStream().use { input.copyTo(it) } }
        fallback.setExecutable(true, false)
        return fallback
    }

    /** 校验配置，返回错误文案的字符串资源 id（null = 合法） */
    fun validate(cfg: Config): Int? = when {
        cfg.networkName.isBlank() -> R.string.easytier_err_name_empty
        cfg.networkSecret.isBlank() -> R.string.easytier_err_secret_empty
        cfg.peers.isEmpty() -> R.string.easytier_err_no_peers
        cfg.peers.any { !isValidPeer(it) } ->
            R.string.easytier_err_peer_format
        cfg.serverMode && (cfg.virtualIp.split('.').size != 4 ||
            cfg.virtualIp.split('.').any { it.toIntOrNull() !in 0..255 }) ->
            R.string.easytier_err_virtual_ip
        cfg.serverMode && cfg.listenerPort !in 1024..65535 -> R.string.easytier_err_port_range
        else -> null
    }

    /** 支持逗号、空格或换行分隔多个共享初始节点。 */
    fun parsePeers(raw: String): List<String> = raw
        .split(Regex("[,\\s]+"))
        .map(String::trim)
        .filter(String::isNotEmpty)
        .distinct()

    private fun isValidPeer(value: String): Boolean = runCatching {
        val uri = URI(value)
        uri.scheme?.lowercase() in setOf("tcp", "udp", "ws", "wss", "quic", "faketcp") &&
            !uri.host.isNullOrBlank() && uri.port in 1..65535
    }.getOrDefault(false)
}
