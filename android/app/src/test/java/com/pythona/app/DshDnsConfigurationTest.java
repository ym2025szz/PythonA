package com.pythona.app;
import static org.junit.Assert.*;
import org.junit.Test;
import java.net.InetAddress;
import java.util.Arrays;
import java.util.Collections;

public final class DshDnsConfigurationTest {
    @Test public void offlineNetworkDoesNotInventPublicResolvers() {
        assertNull(DshDnsConfiguration.render(null));
        assertNull(DshDnsConfiguration.render(Collections.emptyList()));
    }
    @Test public void usesNumericAddressesRatherThanDnsHostLabels() throws Exception {
        InetAddress dns = InetAddress.getByAddress("resolver-name", new byte[]{10,0,0,1});
        String text = DshDnsConfiguration.render(Arrays.asList(dns,InetAddress.getByName("::1")));
        assertTrue(text.contains("nameserver 10.0.0.1\n"));
        assertTrue(text.contains("nameserver 0:0:0:0:0:0:0:1\n"));
        assertFalse(text.contains("resolver-name"));
        assertTrue(text.endsWith("options timeout:2 attempts:2\n"));
    }
    @Test public void boundsToLibcResolverCount() throws Exception {
        InetAddress a=InetAddress.getByName("127.0.0.1");
        assertEquals(3, DshDnsConfiguration.render(Arrays.asList(a,a,a,a)).split("nameserver",-1).length-1);
    }
}
