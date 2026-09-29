package com.pythona.app;
import java.net.InetAddress;
import java.util.List;

/** glibc inside the runtime needs resolver servers supplied by Android. */
final class DshDnsConfiguration {
    static String render(List<InetAddress> servers) {
        if (servers == null || servers.isEmpty()) return null;
        StringBuilder value = new StringBuilder("# Managed by PythonA from Android active network\n");
        int count = 0;
        for (InetAddress address : servers) {
            if (address == null) continue;
            String ip = address.getHostAddress();
            if (ip != null && ip.matches("[0-9a-fA-F:.%a-zA-Z0-9_-]+")) {
                value.append("nameserver ").append(ip).append('\n');
                if (++count == 3) break; // glibc's MAXNS; preserve Android order.
            }
        }
        return count == 0 ? null : value.append("options timeout:2 attempts:2\n").toString();
    }
}
