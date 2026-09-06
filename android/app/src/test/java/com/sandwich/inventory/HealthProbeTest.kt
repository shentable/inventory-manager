package com.sandwich.inventory

import java.net.ServerSocket
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HealthProbeTest {
    @Test
    fun detectsOpenAndClosedTcpPorts() {
        val server = ServerSocket(0)
        val port = server.localPort
        assertTrue(HealthProbe.isTcpPortOpen("127.0.0.1", port))
        server.close()
        assertFalse(HealthProbe.isTcpPortOpen("127.0.0.1", port))
    }
}
