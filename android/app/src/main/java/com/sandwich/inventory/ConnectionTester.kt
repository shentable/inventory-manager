package com.sandwich.inventory

import android.content.Context
import java.util.concurrent.TimeUnit

/** 配置页使用的非持久化连接测试。 */
object ConnectionTester {
    private const val TEST_SOCKS_PORT = 10818

    data class Result(
        val ok: Boolean,
        val message: String,
        val storeId: String? = null,
    )

    fun testDirect(context: Context, serverUrl: String): Result {
        val health = HealthProbe.checkOnce(context, serverUrl, null)
        return if (health.ok) {
            Result(
                true,
                context.getString(
                    R.string.test_direct_success,
                    health.backendKind ?: "backend",
                    health.storeId,
                ),
                health.storeId,
            )
        } else Result(false, context.getString(R.string.test_direct_failed, health.detail))
    }

    /**
     * 用表单参数临时启动一个客户端内核，验证 SOCKS5 和业务健康接口。
     * 测试前停止已保存的客户端内核，结束后无论成功失败都恢复原配置。
     */
    fun testEasyTier(context: Context, formConfig: EasyTierCore.Config, serverUrl: String): Result {
        val previous = EasyTierHelper.getConfig(context)
        val candidate = formConfig.copy(socksPort = TEST_SOCKS_PORT, serverMode = false)
        EasyTierCore.validate(candidate)?.let { return Result(false, context.getString(it)) }
        NodeService.stop(context)
        repeat(30) {
            if (!HealthProbe.isTcpPortOpen("127.0.0.1", EasyTierCore.DEFAULT_SOCKS_PORT)) return@repeat
            Thread.sleep(100)
        }
        var process: Process? = null
        return try {
            process = EasyTierCore.start(context, candidate)
            Thread {
                runCatching { process.inputStream.bufferedReader().use { it.readText() } }
            }.apply { isDaemon = true; start() }
            var socksReady = false
            repeat(60) {
                if (process?.isAlive != true) return@repeat
                if (HealthProbe.isTcpPortOpen("127.0.0.1", TEST_SOCKS_PORT)) {
                    socksReady = true
                    return@repeat
                }
                Thread.sleep(100)
            }
            if (!socksReady) {
                val exit = if (process.isAlive) context.getString(R.string.test_process_running)
                    else context.getString(R.string.test_process_exited, runCatching { process.exitValue() }.getOrDefault(-1))
                Result(false, context.getString(R.string.test_socks_failed, exit))
            } else {
                var last = HealthProbe.Result(false, context.getString(R.string.test_store_unreachable))
                repeat(30) {
                    if (process.isAlive) {
                        last = HealthProbe.checkOnce(context, serverUrl, TEST_SOCKS_PORT)
                        if (last.ok) return@repeat
                        Thread.sleep(500)
                    }
                }
                if (last.ok) {
                    Result(true, context.getString(R.string.test_easytier_success, last.storeId), last.storeId)
                } else {
                    Result(false, context.getString(R.string.test_socks_up_store_down, last.detail))
                }
            }
        } catch (e: Exception) {
            Result(false, context.getString(R.string.test_easytier_failed, e.message ?: e.javaClass.simpleName))
        } finally {
            process?.destroy()
            runCatching {
                if (process?.waitFor(2, TimeUnit.SECONDS) == false) process?.destroyForcibly()
            }
            previous?.let { NodeService.start(context, it) }
        }
    }
}
