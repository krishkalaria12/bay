package bay.app.browser

import android.util.LruCache
import bay.core.displayUrl as coreDisplayUrl
import bay.core.hostOf as coreHostOf
import bay.core.siteName as coreSiteName

/**
 * The core's address helpers, remembered: views ask for the same site's host, name and short address on every frame
 * (each card, row and icon), and each answer is a call across the FFI that allocates on both sides. The answers depend
 * only on the address.
 */
private class Remembered(private val compute: (String) -> String) {
    private val answers = LruCache<String, String>(1024)

    operator fun invoke(url: String): String = answers.get(url) ?: compute(url).also { answers.put(url, it) }
}

private val hosts = Remembered(::coreHostOf)
private val shortAddresses = Remembered(::coreDisplayUrl)
private val names = Remembered(::coreSiteName)

/** The address's host without "www.". */
fun hostOf(url: String): String = hosts(url)

/** The address as the bar shows it. */
fun displayUrl(url: String): String = shortAddresses(url)

/** The site's name for a list row. */
fun siteName(url: String): String = names(url)
