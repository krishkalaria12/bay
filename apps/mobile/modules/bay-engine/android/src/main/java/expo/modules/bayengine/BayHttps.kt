package expo.modules.bayengine

import android.net.Uri
import android.os.SystemClock

/** Hosts that failed over HTTPS this session, so they load over HTTP without another attempt. */
internal object BayHttps {
  val httpOnlyHosts: MutableSet<String> = java.util.Collections.synchronizedSet(mutableSetOf())

  private val ipv4 = Regex("^(\\d{1,3}\\.){3}\\d{1,3}$")

  fun isLocal(host: String): Boolean =
    host == "localhost" || host.startsWith("[") || ipv4.matches(host) ||
      listOf(".local", ".localhost", ".test", ".internal", ".lan", ".home.arpa").any { host.endsWith(it) }
}

/**
 * HTTPS first: an `http:` address a view opens is tried over HTTPS, and an upgraded page that can't connect, or that
 * sends the view straight back to HTTP, keeps HTTP from then on (BayHttps.httpOnlyHosts). One per page view.
 */
internal class BayHttpsUpgrades {
  /** Hosts this view moved from HTTP to HTTPS, with when. */
  private val upgradedHosts = mutableMapOf<String, Long>()

  /** The HTTPS address to load instead, or null to load `address` as it is. */
  fun upgrade(address: String): String? {
    val uri = Uri.parse(address)
    val host = uri.host?.lowercase() ?: return null
    if (uri.scheme?.lowercase() != "http" || BayHttps.isLocal(host) || host in BayHttps.httpOnlyHosts) return null
    val upgraded = upgradedHosts[host]
    if (upgraded != null && SystemClock.uptimeMillis() - upgraded < 5_000) {
      // The HTTPS page redirected back to HTTP: the site doesn't serve HTTPS properly, so keep HTTP.
      BayHttps.httpOnlyHosts += host
      return null
    }
    upgradedHosts[host] = SystemClock.uptimeMillis()
    val authority = if (uri.port == 80) uri.host else uri.encodedAuthority
    return uri.buildUpon().scheme("https").encodedAuthority(authority).build().toString()
  }

  /** After an upgraded HTTPS load fails to connect, the HTTP address to load instead; null when it wasn't upgraded. */
  fun fallback(address: String): String? {
    val uri = Uri.parse(address)
    val host = uri.host?.lowercase() ?: return null
    if (uri.scheme != "https" || host !in upgradedHosts) return null
    BayHttps.httpOnlyHosts += host
    return uri.buildUpon().scheme("http").build().toString()
  }
}
