package com.sandwich.inventory

import java.net.Inet6Address
import java.net.InetAddress
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CloudflareDdnsTest {
    @Test fun validatesHostnameAndRequiredFields() {
        assertTrue(CloudflareDdns.isValidHostname("inventory.example.com"))
        assertFalse(CloudflareDdns.isValidHostname("http://inventory.example.com"))
        assertFalse(CloudflareDdns.isValidHostname("single-label"))
        val config = NodeConfig.CloudflareDdnsConfig(
            enabled = true,
            zoneId = "0123456789abcdef0123456789abcdef",
            hostname = "inventory.example.com",
            proxied = true,
            publicHttpsPort = 2096,
        )
        assertNull(CloudflareDdns.validate(config, true))
    }

    @Test fun acceptsOnlyGlobalUnicastIpv6() {
        fun ipv6(value: String) = InetAddress.getByName(value) as Inet6Address
        assertTrue(CloudflareDdns.isGlobalIpv6(ipv6("2409:8a6c:1c2:65e0::1")))
        assertFalse(CloudflareDdns.isGlobalIpv6(ipv6("fe80::1")))
        assertFalse(CloudflareDdns.isGlobalIpv6(ipv6("fd00::1")))
        assertFalse(CloudflareDdns.isGlobalIpv6(ipv6("::1")))
    }
}
