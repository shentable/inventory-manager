package com.sandwich.inventory

import android.annotation.SuppressLint
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.pm.PackageManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/**
 * 飨拓™库存管理 — Android 壳 App 主界面。
 *
 * 行为：
 *  - 首次启动（未配置服务器地址）显示原生配置页，输入地址后存入 SharedPreferences；
 *  - 配置完成后先轮询健康接口，再用受限 WebView 加载 Web 前端；
 *  - 右上角菜单可随时「刷新」或「设置服务器地址」；
 *  - 返回键：先退网页历史，再退出应用；
 *  - 启动时执行 EasyTier 组网提醒逻辑（见 [EasyTierHelper]）。
 */
class MainActivity : Activity() {

    private lateinit var prefs: SharedPreferences
    private lateinit var root: LinearLayout

    /** 复用的 WebView：在「网页 / 设置页」间切换时保留其状态 */
    private var webView: WebView? = null

    /** 顶部加载进度条（挂在 WebView 容器上） */
    private var progressBar: ProgressBar? = null

    /** 当前是否显示原生配置页（首次启动或菜单进入设置） */
    private var showingConfig = false
    @Volatile private var backendOnline = false
    private var probeGeneration = 0
    private val healthHandler = Handler(Looper.getMainLooper())

    companion object {
        private const val PREFS_NAME = "app_config"
        private const val KEY_SERVER_URL = "server_url"

        /** 配置页提示样例地址 */
        private const val URL_HINT = "http://10.126.126.1:8000"

        private const val MENU_REFRESH = 1
        private const val MENU_SETTINGS = 2
        private const val MENU_BACKUP = 3
        private const val MENU_RESTORE = 4
        private const val REQUEST_BACKUP_TREE = 201
        private const val REQUEST_RESTORE_FILE = 202
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 库存操作时保持屏幕常亮，方便店员持续使用
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        setContentView(root)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }

        // 二合一 APK 首次启动必须先明确设备角色，不能因编译期默认地址跳过选择。
        if (!NodeConfig.hasSelectedMode(this)) {
            showRoleChoiceView()
            return
        }

        val savedUrl = prefs.getString(KEY_SERVER_URL, null) ?: BuildConfig.DEFAULT_SERVER_URL
        // 旧版本把一个现已失效的公共节点写死在代码中。升级后若尚未配置可用
        // 初始节点，直接进入设置页，避免用户只看到无意义的连接超时。
        if (EasyTierHelper.isEnabled(this) && EasyTierCore.isBundled(this) &&
            EasyTierHelper.getConfig(this) == null
        ) {
            showConfigView(savedUrl)
            Toast.makeText(this, getString(R.string.toast_easytier_need_peer), Toast.LENGTH_LONG).show()
            return
        }

        // 已配置设备按保存的角色恢复对应进程，再探测后端。
        EasyTierHelper.bootstrap(this)

        if (savedUrl.isNullOrBlank()) {
            // 首次启动：显示原生配置页
            showConfigView(null)
        } else {
            prefs.edit().putString(KEY_SERVER_URL, normalizeUrl(savedUrl)).apply()
            showWebView(savedUrl)
        }
    }

    // ------------------------------------------------------------------
    // WebView
    // ------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(url: String) {
        title = getString(R.string.app_name)
        // 内嵌组网启用时：先把 WebView 进程级代理指向内核 socks5，再加载页面
        EasyTierHelper.applyWebViewProxy(this)
        val wv = webView ?: createWebView().also { webView = it }
        val normalized = normalizeUrl(url)
        val cfg = EasyTierHelper.getConfig(this)
        val embeddedEt = cfg != null && EasyTierCore.isBundled(this)
        val generation = ++probeGeneration
        showConnectingView(normalized)
        HealthProbe.start(this, normalized, if (embeddedEt && cfg?.serverMode != true) cfg?.socksPort else null) { result ->
            if (generation != probeGeneration) return@start
            if (result.ok && verifyStoreIdentity(cfg, result)) {
                backendOnline = true
                if (embeddedEt) NodeService.markAvailable(this)
                wv.stopLoading()
                attachWebView()
                wv.loadUrl(normalized)
                scheduleHealthMonitor(normalized, cfg, generation)
            } else {
                // 断网时保留已经验证过的门店页面与 GET 数据缓存；仅进入只读态。
                // LOAD_CACHE_ELSE_NETWORK 让曾经成功加载过的网页壳可在冷启动时打开。
                backendOnline = false
                attachWebView()
                wv.loadUrl(normalized)
                notifyWebConnectivity(false)
                scheduleHealthMonitor(normalized, cfg, generation, 1)
                Toast.makeText(this, getString(R.string.toast_offline_cache), Toast.LENGTH_LONG).show()
            }
        }
    }

    /** 探测期间绝不挂载旧 WebView，防止断网时短暂展示上一次连接的数据。 */
    private fun showConnectingView(url: String) {
        root.removeAllViews()
        showingConfig = true
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        box.addView(ProgressBar(this))
        box.addView(TextView(this).apply {
            text = getString(R.string.connecting_verifying, url)
            gravity = android.view.Gravity.CENTER
            setPadding(0, dp(16), 0, 0)
        })
        root.addView(box, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        ))
        invalidateOptionsMenu()
    }

    private fun verifyStoreIdentity(cfg: EasyTierCore.Config?, result: HealthProbe.Result): Boolean {
        if (cfg?.serverMode == true) return true
        val actual = result.storeId ?: return false
        val expected = NodeConfig.trustedStoreId(this)
        if (expected == null) {
            return NodeConfig.trustStore(this, actual)
        }
        return expected == actual
    }

    /** 页面存续期间持续验证健康和 store_id；失联时保留缓存，但始终禁止写入。 */
    private fun scheduleHealthMonitor(
        url: String,
        cfg: EasyTierCore.Config?,
        generation: Int,
        failures: Int = 0,
    ) {
        healthHandler.postDelayed({
            if (generation != probeGeneration || showingConfig) return@postDelayed
            Thread {
                val embeddedEt = cfg != null && EasyTierCore.isBundled(this)
                val result = HealthProbe.checkOnce(
                    this@MainActivity,
                    url,
                    if (embeddedEt && cfg?.serverMode != true) cfg?.socksPort else null,
                )
                runOnUiThread {
                    if (generation != probeGeneration || showingConfig) return@runOnUiThread
                    val identityOk = result.ok && verifyStoreIdentity(cfg, result)
                    val nextFailures = if (identityOk) 0 else failures + 1
                    if (identityOk) {
                        val recovered = !backendOnline
                        backendOnline = true
                        if (recovered) notifyWebConnectivity(true)
                    } else {
                        val wasOnline = backendOnline
                        backendOnline = false
                        if (wasOnline || nextFailures >= 2) notifyWebConnectivity(false)
                        if (result.ok && nextFailures == 2) {
                            Toast.makeText(this, getString(R.string.toast_foreign_store), Toast.LENGTH_LONG).show()
                        }
                    }
                    scheduleHealthMonitor(url, cfg, generation, nextFailures)
                }
            }.apply { isDaemon = true; start() }
        }, 5_000)
    }

    /** 把（已有的）WebView 挂载回界面，并带上顶部进度条 */
    private fun attachWebView() {
        root.removeAllViews()
        val wv = webView ?: return
        wv.layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        )
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(3)
            )
        }
        container.addView(progressBar)
        (wv.parent as? ViewGroup)?.removeView(wv)
        container.addView(wv)
        root.addView(container)
        showingConfig = false
        invalidateOptionsMenu()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView = WebView(this).apply {
        val s = settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.setSupportZoom(true)
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.mediaPlaybackRequiresUserGesture = false
        s.cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK

        addJavascriptInterface(object {
            @JavascriptInterface
            fun isBackendOnline(): Boolean = backendOnline
        }, "SandwichNative")

        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val uri = request?.url ?: return false
                val scheme = uri.scheme
                if ((scheme == "http" || scheme == "https") && isAllowedServerUri(uri)) {
                    return false
                }
                Toast.makeText(this@MainActivity, getString(R.string.toast_blocked_external), Toast.LENGTH_SHORT).show()
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                // 内网服务器未启动 / 地址错误时的提示（WebView 自带错误页仍会显示）
                Toast.makeText(this@MainActivity, getString(R.string.toast_cannot_connect), Toast.LENGTH_LONG).show()
            }
        }

        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                val bar = this@MainActivity.progressBar ?: return
                if (newProgress < 100) {
                    bar.progress = newProgress
                    bar.visibility = View.VISIBLE
                } else {
                    bar.visibility = View.GONE
                }
            }
        }
    }

    private fun notifyWebConnectivity(online: Boolean) {
        webView?.post {
            webView?.evaluateJavascript(
                "window.API && window.API.setConnectivity(${if (online) "true" else "false"});",
                null,
            )
        }
    }

    // ------------------------------------------------------------------
    // 原生配置页（首次启动 / 菜单「设置服务器地址」）
    // ------------------------------------------------------------------

    private fun showRoleChoiceView() {
        root.removeAllViews()
        title = getString(R.string.role_title)
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(32))
        }
        inner.addView(TextView(this).apply {
            text = getString(R.string.role_heading)
            textSize = 26f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#1B5E20"))
        })
        inner.addView(TextView(this).apply {
            text = getString(R.string.role_description)
            textSize = 15f
            setTextColor(Color.parseColor("#555555"))
            setPadding(0, dp(10), 0, dp(28))
        })
        inner.addView(Button(this).apply {
            text = getString(R.string.role_client_button)
            textSize = 17f
            minHeight = dp(82)
            isAllCaps = false
            setOnClickListener { showConfigView(null, NodeMode.CLIENT) }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        inner.addView(Button(this).apply {
            text = getString(R.string.role_server_button)
            textSize = 17f
            minHeight = dp(96)
            isAllCaps = false
            setOnClickListener { showConfigView(null, NodeMode.SERVER) }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(18)
        })
        inner.addView(TextView(this).apply {
            text = getString(R.string.role_server_warning)
            textSize = 13f
            setTextColor(Color.parseColor("#B71C1C"))
            setPadding(0, dp(18), 0, 0)
        })
        root.addView(inner, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        ))
        showingConfig = true
        invalidateOptionsMenu()
    }

    private fun showConfigView(currentUrl: String?, selectedMode: NodeMode? = null) {
        probeGeneration++
        healthHandler.removeCallbacksAndMessages(null)
        root.removeAllViews()
        val initialMode = selectedMode ?: NodeConfig.mode(this)
        title = getString(if (initialMode == NodeMode.SERVER) R.string.config_title_server else R.string.config_title_client)

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(Color.WHITE)
        }
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(56), dp(24), dp(24))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        }
        inner.addView(TextView(this).apply {
            text = getString(if (initialMode == NodeMode.SERVER) R.string.config_heading_server else R.string.config_heading_client)
            textSize = 22f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#2E7D32"))
        })
        inner.addView(TextView(this).apply {
            text = getString(R.string.config_url_hint_text, URL_HINT)
            textSize = 14f
            setTextColor(Color.parseColor("#666666"))
            setPadding(0, dp(8), 0, dp(20))
        })
        val etDefaults = EasyTierHelper.formDefaults(this)
        val configuredUrl = currentUrl ?: prefs.getString(KEY_SERVER_URL, null) ?: BuildConfig.DEFAULT_SERVER_URL
        val peerHost = EasyTierCore.parsePeers(etDefaults.peers).firstOrNull()
            ?.let { runCatching { Uri.parse(it).host }.getOrNull() }
        val displayedUrl = if (
            initialMode == NodeMode.CLIENT && EasyTierHelper.isEnabled(this) &&
            Uri.parse(normalizeUrl(configuredUrl)).host == NodeConfig.DEFAULT_SERVER_IP && peerHost != null
        ) peerHost else configuredUrl
        val urlInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = URL_HINT
            setSingleLine(true)
            setText(displayedUrl)
            selectAll()
        }
        inner.addView(urlInput)
        val urlTestStatus = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.parseColor("#666666"))
        }
        val urlTestButton = Button(this).apply {
            text = getString(R.string.config_test_url_button)
            isAllCaps = false
            isEnabled = initialMode == NodeMode.CLIENT
            setOnClickListener {
                val url = normalizeUrl(urlInput.text.toString())
                isEnabled = false
                urlTestStatus.text = getString(R.string.config_test_url_running, url)
                Thread {
                    val result = ConnectionTester.testDirect(this@MainActivity, url)
                    runOnUiThread {
                        urlTestStatus.text = result.message
                        this@apply.isEnabled = true
                        Toast.makeText(
                            this@MainActivity,
                            result.message,
                            if (result.ok) Toast.LENGTH_SHORT else Toast.LENGTH_LONG,
                        ).show()
                    }
                }.apply { isDaemon = true; start() }
            }
        }
        inner.addView(urlTestButton)
        inner.addView(urlTestStatus)

        // ---------------- EasyTier 内嵌组网（可选） ----------------
        val bundled = EasyTierCore.isBundled(this)
        inner.addView(TextView(this).apply {
            text = getString(if (bundled) R.string.easytier_section_bundled else R.string.easytier_section_external)
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#2E7D32"))
            setPadding(0, dp(24), 0, dp(4))
        })
        val etSwitch = Switch(this).apply {
            text = getString(R.string.easytier_enable_switch)
            isChecked = bundled && (initialMode == NodeMode.SERVER || EasyTierHelper.isEnabled(this@MainActivity))
            isEnabled = bundled
        }
        inner.addView(etSwitch)
        fun etField(hint: String, default: String): EditText = EditText(this).apply {
            this.hint = hint
            setSingleLine(true)
            setText(default)
            isEnabled = bundled && etSwitch.isChecked
        }
        val etName = etField(getString(R.string.easytier_hint_network_name), etDefaults.name)
        val etSecret = etField(getString(R.string.easytier_hint_secret), etDefaults.secret)
        val etPeers = etField(getString(R.string.easytier_hint_peers), etDefaults.peers).apply {
            setSingleLine(false)
            minLines = 2
        }
        val etPublicPort = etField(
            getString(R.string.easytier_hint_public_port),
            NodeConfig.easyTierPublicPort(this).toString(),
        ).apply { inputType = InputType.TYPE_CLASS_NUMBER }
        fun derivedEasyTierPeer(): String? {
            if (initialMode != NodeMode.CLIENT) return null
            val host = Uri.parse(normalizeUrl(urlInput.text.toString())).host ?: return null
            if (host == NodeConfig.DEFAULT_SERVER_IP || host == "127.0.0.1") return null
            val port = etPublicPort.text.toString().toIntOrNull() ?: return null
            return "tcp://$host:$port"
        }
        inner.addView(etName)
        inner.addView(etSecret)
        inner.addView(etPeers)
        inner.addView(etPublicPort)
        val bundledRelayAvailable = BuildConfig.EASYTIER_NETWORK_NAME.isNotBlank() &&
            BuildConfig.EASYTIER_NETWORK_SECRET.isNotBlank() && BuildConfig.EASYTIER_PEERS.isNotBlank()
        val bundledRelayButton = Button(this).apply {
            text = getString(R.string.easytier_use_bundled_relay)
            isAllCaps = false
            isEnabled = bundled && bundledRelayAvailable
            setOnClickListener {
                etSwitch.isChecked = true
                etName.setText(BuildConfig.EASYTIER_NETWORK_NAME)
                etSecret.setText(BuildConfig.EASYTIER_NETWORK_SECRET)
                etPeers.setText(BuildConfig.EASYTIER_PEERS)
                EasyTierCore.parsePeers(BuildConfig.EASYTIER_PEERS).firstOrNull()?.let { peer ->
                    runCatching { Uri.parse(peer).host }.getOrNull()?.takeIf { it.isNotBlank() }
                        ?.let { urlInput.setText(it) }
                    runCatching { Uri.parse(peer).port }.getOrNull()?.takeIf { it in 1024..65535 }
                        ?.let { etPublicPort.setText(it.toString()) }
                }
                listOf(etName, etSecret, etPeers, etPublicPort).forEach { it.isEnabled = true }
                Toast.makeText(this@MainActivity, getString(R.string.toast_bundled_relay_loaded), Toast.LENGTH_LONG).show()
            }
        }
        inner.addView(bundledRelayButton)
        val etGenerateButton = Button(this).apply {
            text = getString(R.string.easytier_generate_peer)
            isAllCaps = false
            isEnabled = initialMode == NodeMode.CLIENT && etSwitch.isChecked
            setOnClickListener {
                val peer = derivedEasyTierPeer()
                if (peer == null) {
                    Toast.makeText(this@MainActivity, getString(R.string.toast_no_relay_in_url), Toast.LENGTH_LONG).show()
                } else {
                    etPeers.setText(peer)
                    Toast.makeText(this@MainActivity, getString(R.string.toast_generated_peer, peer), Toast.LENGTH_SHORT).show()
                }
            }
        }
        inner.addView(etGenerateButton)
        val etTestStatus = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.parseColor("#666666"))
        }
        val etTestButton = Button(this).apply {
            text = getString(R.string.easytier_test_button)
            isAllCaps = false
            isEnabled = initialMode == NodeMode.CLIENT && bundled && etSwitch.isChecked
            setOnClickListener {
                val candidate = EasyTierCore.Config(
                    networkName = etName.text.toString().trim(),
                    networkSecret = etSecret.text.toString().trim(),
                    peers = derivedEasyTierPeer()?.let(::listOf)
                        ?: EasyTierCore.parsePeers(etPeers.text.toString()),
                    listenerPort = etPublicPort.text.toString().toIntOrNull()
                        ?: NodeConfig.DEFAULT_EASYTIER_PUBLIC_PORT,
                )
                EasyTierCore.validate(candidate)?.let { error ->
                    Toast.makeText(this@MainActivity, error, Toast.LENGTH_LONG).show()
                    return@setOnClickListener
                }
                val url = "http://${NodeConfig.DEFAULT_SERVER_IP}:8000"
                isEnabled = false
                urlTestButton.isEnabled = false
                etTestStatus.text = getString(R.string.easytier_test_running, url)
                Thread {
                    val result = ConnectionTester.testEasyTier(this@MainActivity, candidate, url)
                    runOnUiThread {
                        etTestStatus.text = result.message
                        this@apply.isEnabled = initialMode == NodeMode.CLIENT && etSwitch.isChecked
                        urlTestButton.isEnabled = initialMode == NodeMode.CLIENT
                        Toast.makeText(
                            this@MainActivity,
                            result.message,
                            if (result.ok) Toast.LENGTH_SHORT else Toast.LENGTH_LONG,
                        ).show()
                    }
                }.apply { isDaemon = true; start() }
            }
        }
        inner.addView(etTestButton)
        inner.addView(etTestStatus)
        inner.addView(TextView(this).apply {
            text = getString(R.string.easytier_recommended_peers)
            textSize = 12f
            setTextColor(Color.parseColor("#666666"))
            setPadding(0, dp(4), 0, 0)
        })
        etSwitch.setOnCheckedChangeListener { _, checked ->
            etName.isEnabled = checked; etSecret.isEnabled = checked; etPeers.isEnabled = checked; etPublicPort.isEnabled = checked
            etGenerateButton.isEnabled = checked && initialMode == NodeMode.CLIENT
            etTestButton.isEnabled = checked && initialMode == NodeMode.CLIENT
        }

        inner.addView(TextView(this).apply {
            text = getString(R.string.config_role_section); textSize = 16f; setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#2E7D32")); setPadding(0, dp(24), 0, dp(4))
        })
        val serverSwitch = Switch(this).apply {
            text = getString(R.string.config_server_mode_switch)
            isChecked = initialMode == NodeMode.SERVER
            isEnabled = NativeServerCore.isBundled(this@MainActivity)
        }
        val serverIp = EditText(this).apply { hint=getString(R.string.config_hint_server_ip);setText(NodeConfig.serverIp(this@MainActivity));setSingleLine(true) }
        val adminPin = EditText(this).apply { hint=getString(R.string.config_hint_admin_pin);inputType=InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD }
        val recovery = EditText(this).apply { hint=getString(R.string.config_hint_recovery);inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        inner.addView(serverSwitch);inner.addView(serverIp);inner.addView(adminPin);inner.addView(recovery)
        inner.addView(TextView(this).apply { text=getString(R.string.config_uninstall_warning);textSize=12f;setTextColor(Color.parseColor("#B71C1C"));setPadding(0,dp(6),0,0) })

        // ---------------- Cloudflare 公网 IPv6 DDNS（仅服务端） ----------------
        val ddnsDefaults = NodeConfig.cloudflareDdns(this)
        inner.addView(TextView(this).apply {
            text = getString(R.string.ddns_section_title)
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setTextColor(Color.parseColor("#2E7D32"))
            setPadding(0, dp(24), 0, dp(4))
        })
        val ddnsSwitch = Switch(this).apply {
            text = getString(R.string.ddns_enable_switch)
            isChecked = ddnsDefaults.enabled
        }
        val ddnsHostname = EditText(this).apply {
            hint = getString(R.string.ddns_hint_hostname)
            setSingleLine(true)
            setText(ddnsDefaults.hostname)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        val ddnsZoneId = EditText(this).apply {
            hint = getString(R.string.ddns_hint_zone_id)
            setSingleLine(true)
            setText(ddnsDefaults.zoneId)
        }
        val ddnsToken = EditText(this).apply {
            hint = getString(if (CloudflareDdns.hasToken(this@MainActivity)) {
                R.string.ddns_hint_token_saved
            } else {
                R.string.ddns_hint_token_input
            })
            setSingleLine(true)
            // 安全约束：Token 永远不从 Keystore 读回到界面。
            setText("")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val ddnsProxied = Switch(this).apply {
            text = getString(R.string.ddns_proxied_switch)
            isChecked = ddnsDefaults.proxied && !etSwitch.isChecked
        }
        val publicHttpsPort = EditText(this).apply {
            hint = getString(R.string.ddns_hint_https_port)
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(ddnsDefaults.publicHttpsPort.toString())
        }
        val originCert = EditText(this).apply {
            hint = getString(if (NativeServerCore.hasOriginTls(this@MainActivity)) {
                R.string.tls_hint_cert_saved
            } else {
                R.string.tls_hint_cert_input
            })
            setSingleLine(false)
            minLines = 3
            maxLines = 6
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
        val originKey = EditText(this).apply {
            hint = getString(if (NativeServerCore.hasOriginTls(this@MainActivity)) {
                R.string.tls_hint_key_saved
            } else {
                R.string.tls_hint_key_input
            })
            setSingleLine(false)
            minLines = 3
            maxLines = 6
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val tlsStatus = TextView(this).apply {
            text = getString(if (NativeServerCore.hasOriginTls(this@MainActivity)) {
                R.string.tls_status_configured
            } else {
                R.string.tls_status_missing
            })
            textSize = 12f
            setTextColor(Color.parseColor("#666666"))
        }
        val ddnsStatus = TextView(this).apply {
            text = getString(R.string.ddns_status_format, NodeConfig.cloudflareDdnsStatus(this@MainActivity))
            textSize = 12f
            setTextColor(Color.parseColor("#666666"))
            setPadding(0, dp(4), 0, 0)
        }
        inner.addView(ddnsSwitch)
        inner.addView(ddnsHostname)
        inner.addView(ddnsZoneId)
        inner.addView(ddnsToken)
        inner.addView(ddnsProxied)
        inner.addView(publicHttpsPort)
        inner.addView(originCert)
        inner.addView(originKey)
        inner.addView(tlsStatus)
        inner.addView(ddnsStatus)
        val ddnsTestButton = Button(this).apply {
            text = getString(R.string.ddns_test_button)
            isAllCaps = false
        }
        inner.addView(ddnsTestButton)
        inner.addView(TextView(this).apply {
            text = getString(R.string.ddns_security_note)
            textSize = 12f
            setTextColor(Color.parseColor("#B71C1C"))
            setPadding(0, dp(4), 0, 0)
        })

        fun updateDdnsFields() {
            val enabled = serverSwitch.isChecked && ddnsSwitch.isChecked
            ddnsSwitch.isEnabled = serverSwitch.isChecked
            ddnsHostname.isEnabled = enabled
            ddnsZoneId.isEnabled = enabled
            ddnsToken.isEnabled = enabled
            if (enabled && etSwitch.isChecked) ddnsProxied.isChecked = false
            ddnsProxied.isEnabled = enabled && !etSwitch.isChecked
            publicHttpsPort.isEnabled = enabled
            originCert.isEnabled = enabled
            originKey.isEnabled = enabled
            ddnsTestButton.isEnabled = enabled
        }
        fun saveEnteredOriginTls(): String? {
            val cert = originCert.text.toString().trim()
            val key = originKey.text.toString().trim()
            if (cert.isEmpty() && key.isEmpty()) return null
            if (cert.isEmpty() || key.isEmpty()) return getString(R.string.tls_error_pair_required)
            return runCatching {
                NativeServerCore.installOriginTls(this@MainActivity, cert, key)
                originCert.text?.clear(); originKey.text?.clear()
                originCert.hint = getString(R.string.tls_hint_cert_saved)
                originKey.hint = getString(R.string.tls_hint_key_saved)
                tlsStatus.text = getString(R.string.tls_status_configured)
                null
            }.getOrElse { it.message ?: getString(R.string.tls_error_save_failed) }
        }
        fun updateServerFields(enabled:Boolean){serverIp.isEnabled=enabled;adminPin.isEnabled=enabled&&!NativeServerCore.database(this).exists();recovery.isEnabled=enabled&&NativeServerCore.recoveryPassphrase(this)==null;urlInput.isEnabled=!enabled;urlTestButton.isEnabled=!enabled;etTestButton.isEnabled=!enabled&&bundled&&etSwitch.isChecked;updateDdnsFields()}
        updateServerFields(serverSwitch.isChecked)
        ddnsSwitch.setOnCheckedChangeListener { _, _ -> updateDdnsFields() }
        serverSwitch.setOnCheckedChangeListener{_,checked->updateServerFields(checked);if(checked)urlInput.setText(NodeConfig.LOCAL_SERVER_URL)}
        ddnsTestButton.setOnClickListener {
            val config = NodeConfig.CloudflareDdnsConfig(
                enabled = serverSwitch.isChecked && ddnsSwitch.isChecked,
                zoneId = ddnsZoneId.text.toString().trim(),
                hostname = ddnsHostname.text.toString().trim().lowercase(),
                proxied = ddnsProxied.isChecked && !etSwitch.isChecked,
                publicHttpsPort = publicHttpsPort.text.toString().toIntOrNull() ?: -1,
            )
            val enteredToken = ddnsToken.text.toString().trim()
            CloudflareDdns.validateMessage(
                this@MainActivity,
                config,
                enteredToken.isNotEmpty() || CloudflareDdns.hasToken(this@MainActivity),
            )?.let { error ->
                Toast.makeText(this@MainActivity, error, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            saveEnteredOriginTls()?.let { error ->
                Toast.makeText(this@MainActivity, error, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            NodeConfig.saveCloudflareDdns(this@MainActivity, config)
            if (enteredToken.isNotEmpty()) CloudflareDdns.saveToken(this@MainActivity, enteredToken)
            ddnsToken.text?.clear()
            ddnsToken.hint = getString(R.string.ddns_hint_token_saved)
            ddnsTestButton.isEnabled = false
            ddnsStatus.text = getString(R.string.ddns_status_format, getString(R.string.ddns_status_checking))
            Thread {
                val result = CloudflareDdns.syncNow(this@MainActivity)
                runOnUiThread {
                    ddnsStatus.text = getString(R.string.ddns_status_format, NodeConfig.cloudflareDdnsStatus(this@MainActivity))
                    ddnsTestButton.isEnabled = serverSwitch.isChecked && ddnsSwitch.isChecked
                    Toast.makeText(
                        this@MainActivity,
                        result.message,
                        if (result.ok) Toast.LENGTH_SHORT else Toast.LENGTH_LONG,
                    ).show()
                    if (result.ok && NativeServerCore.publicTlsEnabled(this@MainActivity)) {
                        EasyTierHelper.getConfig(this@MainActivity)?.let { NodeService.start(this@MainActivity, it) }
                    }
                }
            }.apply { isDaemon = true; start() }
        }

        var exitConfirmed = false
        inner.addView(
            Button(this).apply {
                text = getString(R.string.config_save_button)
                setOnClickListener {
                    if(serverSwitch.isChecked&&!etSwitch.isChecked){Toast.makeText(this@MainActivity,getString(R.string.toast_server_requires_easytier),Toast.LENGTH_LONG).show();return@setOnClickListener}
                    val raw = when {
                        serverSwitch.isChecked -> NodeConfig.LOCAL_SERVER_URL
                        etSwitch.isChecked -> "http://${NodeConfig.DEFAULT_SERVER_IP}:8000"
                        else -> urlInput.text.toString().trim()
                    }
                    if (raw.isEmpty()) {
                        Toast.makeText(this@MainActivity, getString(R.string.toast_url_required), Toast.LENGTH_SHORT).show()
                        return@setOnClickListener
                    }
                    if (etSwitch.isChecked) {
                        val candidate = EasyTierCore.Config(
                            networkName = etName.text.toString().trim(),
                            networkSecret = etSecret.text.toString().trim(),
                            peers = if (!serverSwitch.isChecked) {
                                derivedEasyTierPeer()?.let(::listOf)
                                    ?: EasyTierCore.parsePeers(etPeers.text.toString())
                            } else EasyTierCore.parsePeers(etPeers.text.toString()),
                            serverMode = serverSwitch.isChecked,
                            virtualIp = serverIp.text.toString().trim(),
                            listenerPort = etPublicPort.text.toString().toIntOrNull()
                                ?: NodeConfig.DEFAULT_EASYTIER_PUBLIC_PORT,
                        )
                        EasyTierCore.validate(candidate)?.let { error ->
                            Toast.makeText(this@MainActivity, error, Toast.LENGTH_LONG).show()
                            return@setOnClickListener
                        }
                    }
                    val ddnsConfig = NodeConfig.CloudflareDdnsConfig(
                        enabled = serverSwitch.isChecked && ddnsSwitch.isChecked,
                        zoneId = ddnsZoneId.text.toString().trim(),
                        hostname = ddnsHostname.text.toString().trim().lowercase(),
                        proxied = ddnsProxied.isChecked && !etSwitch.isChecked,
                        publicHttpsPort = publicHttpsPort.text.toString().toIntOrNull() ?: -1,
                    )
                    val enteredDdnsToken = ddnsToken.text.toString().trim()
                    CloudflareDdns.validateMessage(
                        this@MainActivity,
                        ddnsConfig,
                        enteredDdnsToken.isNotEmpty() || CloudflareDdns.hasToken(this@MainActivity),
                    )?.let { error ->
                        Toast.makeText(this@MainActivity, error, Toast.LENGTH_LONG).show()
                        return@setOnClickListener
                    }
                    saveEnteredOriginTls()?.let { error ->
                        Toast.makeText(this@MainActivity, error, Toast.LENGTH_LONG).show()
                        return@setOnClickListener
                    }
                    // 保存组网配置；启用时校验并拉起内核服务
                    val easyTierPort = etPublicPort.text.toString().toIntOrNull()
                        ?: NodeConfig.DEFAULT_EASYTIER_PUBLIC_PORT
                    runCatching { NodeConfig.setEasyTierPublicPort(this@MainActivity, easyTierPort) }
                        .onFailure {
                            Toast.makeText(this@MainActivity, it.message, Toast.LENGTH_LONG).show()
                            return@setOnClickListener
                        }
                    val peersToSave = if (!serverSwitch.isChecked && etSwitch.isChecked) {
                        derivedEasyTierPeer() ?: etPeers.text.toString()
                    } else etPeers.text.toString()
                    EasyTierHelper.saveConfig(
                        this@MainActivity, etSwitch.isChecked,
                        etName.text.toString(), etSecret.text.toString(), peersToSave
                    )
                    if(serverSwitch.isChecked){
                        if(!NativeServerCore.database(this@MainActivity).exists()||NativeServerCore.recoveryPassphrase(this@MainActivity)==null){
                            runCatching{NativeServerCore.initialize(this@MainActivity,adminPin.text.toString(),recovery.text.toString())}.onFailure{Toast.makeText(this@MainActivity,it.message,Toast.LENGTH_LONG).show();return@setOnClickListener}
                        }
                        NodeConfig.saveMode(this@MainActivity,NodeMode.SERVER,serverIp.text.toString())
                        NodeConfig.saveCloudflareDdns(this@MainActivity, ddnsConfig)
                        if (enteredDdnsToken.isNotEmpty()) CloudflareDdns.saveToken(this@MainActivity, enteredDdnsToken)
                        // 输入框立即清空；Token 此后只存在于 Keystore 加密存储中。
                        ddnsToken.text?.clear()
                        requestBatteryExemption()
                    }else{
                        if(NodeConfig.mode(this@MainActivity)==NodeMode.SERVER){
                            val recent = System.currentTimeMillis()-NodeConfig.lastBackup(this@MainActivity)<10*60*1000L
                            if(!recent){Toast.makeText(this@MainActivity,getString(R.string.toast_backup_required_first),Toast.LENGTH_LONG).show();return@setOnClickListener}
                            if(!exitConfirmed){AlertDialog.Builder(this@MainActivity).setTitle(getString(R.string.dialog_stop_server_title)).setMessage(getString(R.string.dialog_stop_server_message)).setNegativeButton(getString(R.string.dialog_cancel),null).setPositiveButton(getString(R.string.dialog_confirm_switch)){_,_->exitConfirmed=true;this@apply.performClick()}.show();return@setOnClickListener}
                        }
                        NodeConfig.saveMode(this@MainActivity,NodeMode.CLIENT)
                        NodeConfig.saveCloudflareDdns(this@MainActivity, ddnsConfig.copy(enabled = false))
                    }
                    if (etSwitch.isChecked && bundled) {
                        val cfg = EasyTierHelper.getConfig(this@MainActivity)
                        if (cfg == null) {
                            Toast.makeText(this@MainActivity, getString(R.string.toast_config_incomplete), Toast.LENGTH_LONG).show()
                            return@setOnClickListener
                        }
                        NodeService.start(this@MainActivity, cfg)
                    } else {
                        NodeService.stop(this@MainActivity)
                    }
                    val url = normalizeUrl(raw)
                    prefs.edit().putString(KEY_SERVER_URL, url).apply()
                    Toast.makeText(this@MainActivity, getString(R.string.toast_saved_url, url), Toast.LENGTH_SHORT).show()
                    showWebView(url)
                }
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(20) }
        )
        inner.addView(TextView(this).apply {
            text = getString(R.string.config_footer_hint)
            textSize = 12f
            setTextColor(Color.parseColor("#999999"))
            setPadding(0, dp(12), 0, 0)
        })
        scroll.addView(inner)
        root.addView(scroll)

        showingConfig = true
        invalidateOptionsMenu()
    }

    // ------------------------------------------------------------------
    // 菜单与返回键
    // ------------------------------------------------------------------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, MENU_REFRESH, 0, getString(R.string.menu_refresh))
        menu.add(0, MENU_SETTINGS, 1, getString(R.string.menu_settings))
        menu.add(0, MENU_BACKUP, 2, getString(R.string.menu_backup))
        menu.add(0, MENU_RESTORE, 3, getString(R.string.menu_restore))
        return super.onCreateOptionsMenu(menu)
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        // 配置页时不显示菜单，避免重复进入
        menu.findItem(MENU_REFRESH)?.isVisible = !showingConfig
        menu.findItem(MENU_SETTINGS)?.isVisible = !showingConfig
        menu.findItem(MENU_BACKUP)?.isVisible = !showingConfig && NodeConfig.mode(this)==NodeMode.SERVER
        menu.findItem(MENU_RESTORE)?.isVisible = !showingConfig && NodeConfig.mode(this)==NodeMode.SERVER
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            MENU_REFRESH -> {
                showWebView(NodeConfig.clientServerUrl(this))
                true
            }
            MENU_SETTINGS -> {
                // 预填当前地址，方便修改
                showConfigView(webView?.url)
                true
            }
            MENU_BACKUP -> {
                val saved=NodeConfig.backupTree(this)
                if(saved==null) startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE),REQUEST_BACKUP_TREE)
                else BackupCoordinator.create(this,false){ok,msg->runOnUiThread{Toast.makeText(this,msg,if(ok)Toast.LENGTH_SHORT else Toast.LENGTH_LONG).show()}}
                true
            }
            MENU_RESTORE -> {
                startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply{type="application/octet-stream";addCategory(Intent.CATEGORY_OPENABLE)},REQUEST_RESTORE_FILE)
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==REQUEST_BACKUP_TREE&&resultCode==RESULT_OK){data?.data?.let{uri->
            val flags=(data?.flags ?: 0) and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            contentResolver.takePersistableUriPermission(uri,flags)
            NodeConfig.setBackupTree(this,uri.toString());BackupCoordinator.create(this,false){ok,msg->runOnUiThread{Toast.makeText(this,msg,if(ok)Toast.LENGTH_SHORT else Toast.LENGTH_LONG).show()}}
        }}
        if(requestCode==REQUEST_RESTORE_FILE&&resultCode==RESULT_OK){data?.data?.let{uri->
            AlertDialog.Builder(this).setTitle(getString(R.string.dialog_restore_title)).setMessage(getString(R.string.dialog_restore_message))
                .setNegativeButton(getString(R.string.dialog_cancel),null).setPositiveButton(getString(R.string.dialog_confirm_restore)){_,_->BackupCoordinator.restore(this,uri){ok,msg->runOnUiThread{Toast.makeText(this,msg,if(ok)Toast.LENGTH_SHORT else Toast.LENGTH_LONG).show();if(ok)showWebView(NodeConfig.LOCAL_SERVER_URL)}}}.show()
        }}
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // 设置页 → 返回网页（保留 WebView 状态）
            if (showingConfig && webView != null) {
                showWebView(NodeConfig.clientServerUrl(this))
                return true
            }
            // 网页历史后退（如盘点页 → 首页）
            val wv = webView
            if (wv != null && wv.canGoBack()) {
                wv.goBack()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    /** 规范化输入：去空白、去尾部斜杠、补 http:// 前缀 */
    private fun normalizeUrl(input: String): String {
        var url = input.trim()
        if (url.isEmpty()) return ""
        while (url.endsWith("/")) url = url.dropLast(1)
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://$url"
        }
        val parsed = Uri.parse(url)
        if (parsed.host.isNullOrBlank()) return url
        val cleanPath = parsed.path.orEmpty().trimEnd('/')
        return parsed.buildUpon()
            .encodedPath(cleanPath)
            .clearQuery()
            .fragment(null)
            .build()
            .toString()
            .trimEnd('/')
    }

    private fun isAllowedServerUri(uri: Uri): Boolean {
        val configured = Uri.parse(
            prefs.getString(KEY_SERVER_URL, BuildConfig.DEFAULT_SERVER_URL)
                ?: BuildConfig.DEFAULT_SERVER_URL
        )
        return uri.scheme == configured.scheme && uri.host == configured.host &&
            effectivePort(uri) == effectivePort(configured)
    }

    private fun effectivePort(uri: Uri): Int = when {
        uri.port >= 0 -> uri.port
        uri.scheme == "https" -> 443
        else -> 80
    }

    private fun showConnectionError(url: String, detail: String) {
        probeGeneration++
        healthHandler.removeCallbacksAndMessages(null)
        // 错误态销毁旧页面，保证客户端不会把上一次成功连接的业务数据当作本地回退。
        webView?.stopLoading()
        webView?.destroy()
        webView = null
        root.removeAllViews()
        showingConfig = true
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        box.addView(TextView(this).apply {
            text = getString(R.string.error_title_cannot_connect)
            textSize = 20f
            setTypeface(typeface, Typeface.BOLD)
        })
        box.addView(TextView(this).apply {
            val peers = EasyTierHelper.getConfig(this@MainActivity)?.peers
                ?.joinToString() ?: getString(R.string.peers_not_configured)
            text = getString(R.string.error_detail_format, url, detail, peers)
            setPadding(0, dp(12), 0, dp(20))
        })
        box.addView(Button(this).apply {
            text = getString(R.string.error_retry)
            setOnClickListener { showWebView(url) }
        })
        box.addView(Button(this).apply {
            text = getString(R.string.error_check_settings)
            setOnClickListener { showConfigView(url) }
        })
        root.addView(
            box,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        invalidateOptionsMenu()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun requestBatteryExemption() {
        val power=getSystemService(POWER_SERVICE) as PowerManager
        if(!power.isIgnoringBatteryOptimizations(packageName)) runCatching {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,Uri.parse("package:$packageName")))
        }
    }

    override fun onDestroy() {
        probeGeneration++
        healthHandler.removeCallbacksAndMessages(null)
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
