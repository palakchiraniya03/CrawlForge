/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * These functions classify IP addresses and hostnames to prevent the crawler
 * from being used to probe internal services, cloud metadata endpoints,
 * or other non-public resources.
 *
 * Security model:
 * - We resolve hostnames to IPs and check EVERY resolved address.
 * - We check both IPv4 and IPv6 (including IPv4-mapped IPv6 addresses).
 * - We deny on any error — fail-closed is the correct default for security.
 * - URL normalization is NOT treated as an SSRF defence. We check the
 *   actual resolved IPs after each DNS lookup and after each redirect.
 */

import * as dns from 'dns/promises';
import { isIP } from 'net';
import ipaddr from 'ipaddr.js';

/**
 * SSRF_ALLOWED_HOSTS: a comma-separated list of hostnames that bypass the
 * SSRF IP-range check. Intended ONLY for local development and testing
 * (e.g. "localhost" to allow the local fixture server).
 *
 * WARNING: Never set this in production. An empty value (the default) means
 * no bypass is active and all hosts are subject to full SSRF checking.
 */
function getAllowedHosts(): Set<string> {
  const raw = process.env.SSRF_ALLOWED_HOSTS ?? '';
  if (!raw.trim()) return new Set();
  return new Set(raw.split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
}

export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * Blocked IPv4 CIDR ranges.
 * Covers loopback, private (RFC 1918), link-local, shared address space,
 * IETF protocol assignments, documentation, benchmark, multicast,
 * limited broadcast, and reserved ranges.
 */
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',         // "This" network
  '10.0.0.0/8',        // RFC 1918 private
  '100.64.0.0/10',     // Shared address space (RFC 6598)
  '127.0.0.0/8',       // Loopback
  '169.254.0.0/16',    // Link-local (includes AWS metadata 169.254.169.254)
  '172.16.0.0/12',     // RFC 1918 private
  '192.0.0.0/24',      // IETF protocol assignments
  '192.0.2.0/24',      // Documentation (TEST-NET-1)
  '192.88.99.0/24',    // 6to4 relay anycast (deprecated)
  '192.168.0.0/16',    // RFC 1918 private
  '198.18.0.0/15',     // Benchmarking
  '198.51.100.0/24',   // Documentation (TEST-NET-2)
  '203.0.113.0/24',    // Documentation (TEST-NET-3)
  '224.0.0.0/4',       // Multicast
  '233.252.0.0/24',    // Documentation (MCAST-TEST-NET)
  '240.0.0.0/4',       // Reserved
  '255.255.255.255/32', // Limited broadcast
];

/**
 * Blocked IPv6 CIDR ranges.
 * Covers loopback, link-local, unique-local, IPv4-mapped/translated,
 * multicast, documentation, and other non-global ranges.
 */
const BLOCKED_IPV6_CIDRS = [
  '::1/128',              // Loopback
  '::/128',               // Unspecified
  '::ffff:0:0/96',        // IPv4-mapped
  '::ffff:0:0:0/96',      // IPv4-translated
  '64:ff9b::/96',         // IPv4/IPv6 translation
  '64:ff9b:1::/48',       // IPv4/IPv6 translation
  '100::/64',             // Discard prefix
  '2001::/23',            // IETF protocol assignments (includes Teredo 2001::/32)
  '2001:2::/48',          // Benchmarking
  '2001:db8::/32',        // Documentation
  '2002::/16',            // 6to4
  'fc00::/7',             // Unique local (includes fd00::/8)
  'fe80::/10',            // Link-local
  'ff00::/8',             // Multicast
];

// Pre-parse all blocked CIDRs for performance
const blockedIpv4Ranges = BLOCKED_IPV4_CIDRS.map(cidr => ipaddr.parseCIDR(cidr) as [ipaddr.IPv4, number]);
const blockedIpv6Ranges = BLOCKED_IPV6_CIDRS.map(cidr => ipaddr.parseCIDR(cidr) as [ipaddr.IPv6, number]);

/**
 * Check whether a single IP address string is safe (publicly routable).
 * Returns false for any private, loopback, link-local, multicast, or
 * reserved address — for both IPv4 and IPv6.
 */
export function isIpSafe(ipString: string): SsrfCheckResult {
  // Reject anything that's not a parseable IP at all
  if (!isIP(ipString)) {
    return { safe: false, reason: `Not a valid IP address: ${ipString}` };
  }

  try {
    const parsed = ipaddr.parse(ipString);

    if (parsed.kind() === 'ipv4') {
      const v4 = parsed as ipaddr.IPv4;
      for (const [network, prefix] of blockedIpv4Ranges) {
        if (v4.match(network, prefix)) {
          return { safe: false, reason: `IPv4 ${ipString} is in blocked range ${network}/${prefix}` };
        }
      }
      return { safe: true };
    }

    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;

      // IPv4-mapped IPv6 (::ffff:192.168.x.x) — also check the embedded v4 address
      if (v6.isIPv4MappedAddress()) {
        const embedded = v6.toIPv4Address();
        for (const [network, prefix] of blockedIpv4Ranges) {
          if (embedded.match(network, prefix)) {
            return {
              safe: false,
              reason: `IPv4-mapped IPv6 ${ipString} maps to blocked IPv4 ${embedded.toString()}`,
            };
          }
        }
      }

      for (const [network, prefix] of blockedIpv6Ranges) {
        if (v6.match(network, prefix)) {
          return { safe: false, reason: `IPv6 ${ipString} is in blocked range ${network}/${prefix}` };
        }
      }
      return { safe: true };
    }

    return { safe: false, reason: `Unknown IP kind for: ${ipString}` };
  } catch (err) {
    return { safe: false, reason: `IP parse error for ${ipString}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Resolve the hostname portion of a URL and verify ALL resolved addresses
 * are safe. Fails closed — any resolution error or unsafe address returns
 * { safe: false }.
 *
 * This is the primary guard against DNS rebinding: we resolve here in the
 * application layer so we can inspect and reject dangerous IPs before
 * the fetch library opens a socket.
 *
 * Note: This does NOT completely prevent DNS rebinding if the attacker can
 * change DNS TTL to zero and race between our check and the actual connect.
 * True prevention requires binding to a resolved IP and/or using a TPROXY
 * approach. We document this limitation explicitly.
 */
export async function checkHostnameSafe(hostname: string): Promise<SsrfCheckResult> {
  // Dev/test bypass: explicitly allowed hostnames skip IP-range checks.
  // getAllowedHosts() reads SSRF_ALLOWED_HOSTS env var; empty in production.
  const allowedHosts = getAllowedHosts();
  if (allowedHosts.has(hostname.toLowerCase())) {
    return { safe: true };
  }

  // If hostname is already an IP literal, check it directly
  if (isIP(hostname)) {
    return isIpSafe(hostname);
  }

  // Strip IPv6 brackets if present (e.g. "[::1]")
  const stripped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

  if (isIP(stripped)) {
    return isIpSafe(stripped);
  }

  // Reject numeric-only hostnames that look like octal/hex IP representations
  // e.g. http://0177.0.0.1/ (octal for 127.0.0.1)
  // The WHATWG URL parser handles these, but as a defence-in-depth check:
  if (/^[0-9]+$/.test(hostname)) {
    return { safe: false, reason: `Suspicious numeric hostname: ${hostname}` };
  }

  try {
    const addresses = await dns.resolve(hostname);
    if (!addresses || addresses.length === 0) {
      return { safe: false, reason: `No DNS records for hostname: ${hostname}` };
    }

    for (const addr of addresses) {
      const check = isIpSafe(addr);
      if (!check.safe) {
        return {
          safe: false,
          reason: `Hostname ${hostname} resolved to unsafe IP ${addr}: ${check.reason}`,
        };
      }
    }

    return { safe: true };
  } catch (err) {
    return {
      safe: false,
      reason: `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Full SSRF check for a URL string.
 * Parses the URL, extracts the hostname, and runs checkHostnameSafe.
 *
 * IMPORTANT LIMITATION: We check the hostname before fetching. If the
 * DNS record changes between our check and the actual TCP connection
 * (DNS rebinding attack with TTL=0), the protection can be bypassed.
 * Full mitigation would require controlling the TCP stack or using a
 * proxy that binds to the resolved IP. This is documented as a known
 * limitation.
 */
export async function checkUrlSafe(urlString: string): Promise<SsrfCheckResult> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: `Invalid URL: ${urlString}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { safe: false, reason: `Unsupported protocol: ${url.protocol}` };
  }

  // Reject embedded credentials in URL (potential bypass / auth confusion)
  if (url.username || url.password) {
    return { safe: false, reason: 'URL contains embedded credentials' };
  }

  return checkHostnameSafe(url.hostname);
}
