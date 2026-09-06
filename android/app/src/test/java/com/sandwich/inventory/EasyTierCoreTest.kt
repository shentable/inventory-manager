package com.sandwich.inventory

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EasyTierCoreTest {
    private val peer = listOf("tcp://relay.example.com:11010")

    @Test
    fun buildArgsUsesDhcpAndSocks5() {
        val args = EasyTierCore.buildArgs(
            EasyTierCore.Config(networkName = "shop", networkSecret = "secret", peers = peer)
        )
        assertTrue(args.contains("--dhcp"))
        assertTrue(args.contains("--no-tun"))
        assertFalse(args.contains("--no-listener"))
        assertTrue(args.contains("--socks5"))
        assertTrue(args.contains(peer.first()))
        assertFalse(args.contains("--ipv4"))
    }

    @Test
    fun validConfigDoesNotRequireStaticIp() {
        assertNull(
            EasyTierCore.validate(
                EasyTierCore.Config(networkName = "shop", networkSecret = "secret", peers = peer)
            )
        )
    }

    @Test
    fun serverModeUsesStaticIpWithoutDhcp() {
        val args = EasyTierCore.buildArgs(
            EasyTierCore.Config("shop", "secret", peer, serverMode = true, virtualIp = "10.126.126.1")
        )
        assertTrue(args.contains("--ipv4"))
        assertTrue(args.contains("10.126.126.1"))
        assertFalse(args.contains("--dhcp"))
        assertFalse(args.contains("--no-listener"))
        assertTrue(args.contains("--need-p2p"))
        assertTrue(args.contains("--tcp-whitelist"))
        assertTrue(args.contains("8000"))
        assertTrue(args.contains("--listeners"))
        assertTrue(args.contains("tcp://[::]:32147"))
    }

    @Test
    fun serverModeRejectsInvalidStaticIp() {
        assertNotNull(EasyTierCore.validate(EasyTierCore.Config("shop", "secret", peer, serverMode = true, virtualIp = "10.126.126.999")))
    }

    @Test
    fun rejectsMissingOrMalformedPeer() {
        assertNotNull(EasyTierCore.validate(EasyTierCore.Config("shop", "secret", emptyList())))
        assertNotNull(EasyTierCore.validate(EasyTierCore.Config("shop", "secret", listOf("relay.example.com:11010"))))
    }

    @Test
    fun parsesMultiplePeers() {
        assertTrue(
            EasyTierCore.parsePeers("tcp://one.example:11010,\nudp://two.example:11010") ==
                listOf("tcp://one.example:11010", "udp://two.example:11010")
        )
    }
}
