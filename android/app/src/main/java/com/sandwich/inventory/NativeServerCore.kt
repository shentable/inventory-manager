package com.sandwich.inventory

import android.content.Context
import java.io.File
import java.security.SecureRandom

object NativeServerCore {
    const val LIB_NAME = "libsandwichserver.so"
    const val DEFAULT_PUBLIC_HTTPS_PORT = 2096
    private const val TOKEN_SECRET = "token_secret"
    private const val RECOVERY = "recovery_passphrase"
    private const val BOOTSTRAP = "bootstrap_pin"
    private const val ORIGIN_CERT = "cloudflare_origin_cert"
    private const val ORIGIN_KEY = "cloudflare_origin_key"

    fun isBundled(context: Context) = File(context.applicationInfo.nativeLibraryDir, LIB_NAME).exists()
    fun database(context: Context) = File(context.filesDir, "store/app.db")
    fun initialize(context: Context, bootstrapPin: String, recoveryPassphrase: String) {
        require(bootstrapPin.matches(Regex("^\\d{4,6}$"))) { context.getString(R.string.server_pin_invalid) }
        require(recoveryPassphrase.length >= 12) { context.getString(R.string.server_recovery_too_short) }
        if (SecureStore.get(context, TOKEN_SECRET) == null) {
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            SecureStore.put(context, TOKEN_SECRET, bytes.joinToString("") { "%02x".format(it) })
        }
        SecureStore.put(context, RECOVERY, recoveryPassphrase)
        SecureStore.put(context, BOOTSTRAP, bootstrapPin)
    }
    fun recoveryPassphrase(context: Context) = SecureStore.get(context, RECOVERY)
    fun hasOriginTls(context: Context): Boolean =
        !SecureStore.get(context, ORIGIN_CERT).isNullOrBlank() &&
            !SecureStore.get(context, ORIGIN_KEY).isNullOrBlank()

    fun installOriginTls(context: Context, certificatePem: String, privateKeyPem: String) {
        val cert = certificatePem.trim()
        val key = privateKeyPem.trim()
        require(cert.contains("-----BEGIN CERTIFICATE-----") && cert.contains("-----END CERTIFICATE-----")) {
            context.getString(R.string.tls_cert_invalid_pem)
        }
        require(
            (key.contains("-----BEGIN PRIVATE KEY-----") && key.contains("-----END PRIVATE KEY-----")) ||
                (key.contains("-----BEGIN EC PRIVATE KEY-----") && key.contains("-----END EC PRIVATE KEY-----")) ||
                (key.contains("-----BEGIN RSA PRIVATE KEY-----") && key.contains("-----END RSA PRIVATE KEY-----")),
        ) { context.getString(R.string.tls_key_invalid_pem) }
        SecureStore.put(context, ORIGIN_CERT, cert)
        SecureStore.put(context, ORIGIN_KEY, key)
    }

    fun publicTlsEnabled(context: Context): Boolean =
        NodeConfig.cloudflareDdns(context).enabled && hasOriginTls(context)

    fun publicHttpsPort(context: Context): Int = NodeConfig.cloudflareDdns(context).publicHttpsPort

    fun publicHttpsUrl(context: Context): String? {
        val host = NodeConfig.cloudflareDdns(context).hostname.takeIf { it.isNotBlank() } ?: return null
        return "https://$host:${publicHttpsPort(context)}"
    }

    private fun materializeOriginTls(context: Context): Pair<File, File> {
        val cert = SecureStore.get(context, ORIGIN_CERT) ?: error("未配置 Cloudflare Origin Certificate")
        val key = SecureStore.get(context, ORIGIN_KEY) ?: error("未配置 Cloudflare Origin Private Key")
        val directory = File(context.noBackupFilesDir, "origin-tls").apply { mkdirs() }
        val certFile = File(directory, "origin.pem").apply { writeText(cert + "\n") }
        val keyFile = File(directory, "origin-key.pem").apply {
            writeText(key + "\n")
            setReadable(false, false); setWritable(false, false)
            setReadable(true, true); setWritable(true, true)
        }
        return certFile to keyFile
    }

    fun start(context: Context): Process {
        val exe = File(context.applicationInfo.nativeLibraryDir, LIB_NAME)
        check(exe.exists()) { "APK 未内置 $LIB_NAME" }
        val secret = SecureStore.get(context, TOKEN_SECRET) ?: error("服务端尚未初始化")
        val bootstrap = SecureStore.get(context, BOOTSTRAP)
        database(context).parentFile?.mkdirs()
        val args = mutableListOf(exe.absolutePath, "serve", "--db", database(context).absolutePath,
            "--listen", "127.0.0.1:8000",
            "--app-version", BuildConfig.VERSION_NAME)
        if (publicTlsEnabled(context)) {
            val (cert, key) = materializeOriginTls(context)
            args += listOf(
                "--public-listen", "[::]:${publicHttpsPort(context)}",
                "--tls-cert", cert.absolutePath,
                "--tls-key", key.absolutePath,
            )
        }
        return ProcessBuilder(args).redirectErrorStream(true).apply {
            environment()["SANDWICH_TOKEN_SECRET"] = secret
            bootstrap?.let { environment()["SANDWICH_BOOTSTRAP_PIN"] = it }
        }.start()
    }
}
