package expo.modules.bayengine

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

/**
 * Filter lists in the Rust blocker. Every page view asks it about each subresource request (on WebView's network
 * threads) and for the cosmetic CSS of the page it shows.
 */
internal object BayContentBlocker {
  @Volatile private var handle = 0L
  @Volatile private var pausedHosts: Set<String> = emptySet()
  private val builder = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private var generation = 0

  /**
   * Loads a blocker from list files (`file://` URIs; null turns blocking off) off the main thread. The built engine is
   * cached per `version` in `cacheDir`, so later launches load it instead of parsing every rule again.
   */
  fun apply(files: List<String>?, version: String, context: android.content.Context, onDone: (Result<Unit>) -> Unit) {
    val current = ++generation
    builder.execute {
      val started = SystemClock.elapsedRealtime()
      val result = runCatching {
        if (files.isNullOrEmpty()) return@runCatching 0L
        val paths = files.mapNotNull { Uri.parse(it).path }.toTypedArray()
        val directory = java.io.File(context.cacheDir, "bay-adblock").apply { mkdirs() }
        val resources = bundledResources(context, directory)?.path ?: ""
        BayAdblock.nativeLoad(paths, directory.resolve("engine.bin").path, version, resources)
          .also { check(it != 0L) { "The filter lists couldn't be read." } }
      }
      Log.i("BayAdblock", "blocker ready in ${SystemClock.elapsedRealtime() - started} ms (${files?.size ?: 0} lists)")
      main.post {
        val next = result.getOrNull()
        if (current != generation || next == null) {
          next?.takeIf { it != 0L }?.let(BayAdblock::nativeFree)
          onDone(result.map { })
          return@post
        }
        val previous = handle
        synchronized(pages) {
          handle = next
          pages.clear()
        }
        // Requests already inside the old engine finish quickly; free it once they have.
        if (previous != 0L) main.postDelayed({ BayAdblock.nativeFree(previous) }, 30_000)
        onDone(Result.success(Unit))
      }
    }
  }

  fun setPausedHosts(hosts: List<String>) {
    pausedHosts = hosts.map { it.lowercase() }.toSet()
  }

  /**
   * The engine to ask about `pageUrl`, or 0 when blocking is off or paused there. Callers read `handle` only through
   * this, once per call: turning blocking off sets it to 0 from the main thread while network threads are mid-check.
   */
  private fun engineFor(pageUrl: String?): Long {
    val engine = handle
    if (engine == 0L) return 0L
    val host = pageUrl?.let { Uri.parse(it).host?.lowercase() } ?: return engine
    return if (pausedHosts.none { host == it || host.endsWith(".$it") }) engine else 0L
  }

  /** The scriptlet and redirect resources ship in the app's assets; the engine reads them from a file. */
  private fun bundledResources(context: android.content.Context, directory: java.io.File): java.io.File? = runCatching {
    val file = directory.resolve("resources.json")
    context.assets.open("bay-adblock-resources.json").use { input -> file.outputStream().use { input.copyTo(it) } }
    file
  }.getOrNull()

  /** For a blocked subresource, an empty response or a harmless stand-in (`$redirect`); null to let it load. */
  fun intercept(request: WebResourceRequest, pageUrl: String?): WebResourceResponse? {
    if (request.isForMainFrame) return null
    val engine = engineFor(pageUrl)
    if (engine == 0L) return null
    val url = request.url.toString()
    if (!url.startsWith("http")) return null
    val answer = BayAdblock.nativeCheck(engine, url, pageUrl ?: url, resourceType(request))
    return when {
      answer.isEmpty() -> null
      answer.startsWith("data:") -> standIn(answer)
      else -> WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
  }

  /** A `data:[mime][;base64],payload` URL as a response. */
  private fun standIn(dataUrl: String): WebResourceResponse {
    val header = dataUrl.substringAfter("data:").substringBefore(',')
    val payload = dataUrl.substringAfter(',')
    val bytes = if (header.endsWith(";base64")) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray()
    val mime = header.substringBefore(';').ifEmpty { "text/plain" }
    return WebResourceResponse(mime, "utf-8", 200, "OK", mapOf("Access-Control-Allow-Origin" to "*"), ByteArrayInputStream(bytes))
  }

  /** The page's scriptlets (`##+js`), or "" when it has none or blocking is off for it. */
  fun scriptlets(pageUrl: String): String {
    val engine = engineFor(pageUrl)
    return if (engine != 0L) page(engine, pageUrl).script else ""
  }

  /** A page's cosmetic resources and scriptlets, from one `url_cosmetic_resources` lookup (an expensive one). */
  private class Page(val engine: Long, val hide: List<String>, val exceptions: String, val generichide: Boolean, val script: String)

  // The scriptlets are read when a navigation starts and the cosmetic CSS in two passes once it loads; they share one
  // lookup. Frames have their own URLs, hence a few entries. Cleared when the engine changes.
  private val pages = object : java.util.LinkedHashMap<String, Page>(16, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Page>?): Boolean = size > 32
  }

  private fun page(engine: Long, url: String): Page {
    synchronized(pages) { pages[url] }?.takeIf { it.engine == engine }?.let { return it }
    val json = JSONObject(BayAdblock.nativePageResources(engine, url))
    val hide = json.optJSONArray("hide")
    val page = Page(
      engine,
      if (hide == null) emptyList() else List(hide.length()) { hide.getString(it) },
      json.optJSONArray("exceptions")?.toString() ?: "[]",
      json.optBoolean("generichide"),
      json.optString("script"),
    )
    // An engine swapped in meanwhile cleared the cache; don't put this one's answer back.
    synchronized(pages) { if (engine == handle) pages[url] = page }
    return page
  }

  private val imagePath = Regex("\\.(png|jpe?g|gif|webp|svg|ico|avif)$")
  private val fontPath = Regex("\\.(woff2?|ttf|otf)$")
  private val mediaPath = Regex("\\.(mp4|webm|m3u8|mp3|m4a)$")

  private fun resourceType(request: WebResourceRequest): String {
    val headers = request.requestHeaders
    fun header(name: String) = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
    return requestType(header("Sec-Fetch-Dest"), header("X-Requested-With"), header("Accept").orEmpty(),
      request.url.path.orEmpty().lowercase())
  }

  /**
   * adblock-rust's request type (the names `Request::new` accepts) for a subresource, so `$script`, `$xmlhttprequest`,
   * `$subdocument` rules and `$redirect` stand-ins apply. `Sec-Fetch-Dest` is exact when WebView passes it; without
   * it, a page's own `X-Requested-With: XMLHttpRequest`, then the `Accept` header Chromium sets per destination (often
   * missing on WebView), then the file extension. Anything else is "other", which only untyped rules match.
   */
  internal fun requestType(fetchDest: String?, requestedWith: String?, accept: String, path: String): String =
    when (fetchDest?.lowercase()) {
      "script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet" -> "script"
      "style" -> "stylesheet"
      "image" -> "image"
      "font" -> "font"
      "audio", "video", "track" -> "media"
      "iframe", "frame" -> "subdocument"
      "empty" -> "xmlhttprequest"
      "document" -> "document"
      "object", "embed" -> "object"
      else -> when {
        requestedWith.equals("XMLHttpRequest", ignoreCase = true) -> "xmlhttprequest"
        // Only navigations ask for HTML first, and main-frame ones never get here: this is a frame.
        accept.startsWith("text/html") -> "subdocument"
        accept.startsWith("text/css") || path.endsWith(".css") -> "stylesheet"
        accept.startsWith("image/") || imagePath.containsMatchIn(path) -> "image"
        path.endsWith(".js") || path.endsWith(".mjs") -> "script"
        fontPath.containsMatchIn(path) -> "font"
        mediaPath.containsMatchIn(path) -> "media"
        else -> "other"
      }
    }

  /**
   * CSS hiding the page's ad slots: its site rules (when `siteRules`, the page's first pass), plus generic rules for
   * the classes and ids it uses (JSON arrays of the ones not sent before).
   */
  fun cosmeticCss(pageUrl: String, classesJson: String, idsJson: String, siteRules: Boolean): String {
    val engine = engineFor(pageUrl)
    if (engine == 0L) return ""
    val page = page(engine, pageUrl)
    val selectors = if (siteRules) page.hide.toMutableList() else mutableListOf()
    if (!page.generichide && (classesJson != "[]" || idsJson != "[]")) {
      val generic = JSONArray(BayAdblock.nativeHiddenSelectors(engine, classesJson, idsJson, page.exceptions))
      for (i in 0 until generic.length()) selectors += generic.getString(i)
    }
    // One rule per chunk, so a selector the browser can't parse only drops its own chunk.
    return selectors.chunked(200).joinToString("\n") { "${it.joinToString(",")}{display:none!important}" }
  }

  /**
   * The page side: at DOMContentLoaded, ask for the site rules and the generic rules for the classes and ids in use;
   * after load, only for classes and ids not seen yet. Each answer goes in a new style sheet, so earlier ones aren't
   * parsed again. A cross-origin frame (ads, embeds) only gets its site rules: scanning its whole DOM runs on the
   * page's main thread.
   */
  const val COSMETIC_SCRIPT = """
(() => {
  if (window.__bayCosmeticDone || !window.__bayCosmetic) return;
  window.__bayCosmeticDone = true;
  let scan = true;
  try { scan = window === window.top || !!window.top.location.href; } catch (e) { scan = false; }
  const seen = { classes: new Set(), ids: new Set() };
  let first = true;
  const apply = () => {
    const classes = [], ids = [];
    if (scan) for (const el of document.querySelectorAll('[class],[id]')) {
      for (const c of el.classList) if (!seen.classes.has(c)) { seen.classes.add(c); classes.push(c); }
      if (el.id && !seen.ids.has(el.id)) { seen.ids.add(el.id); ids.push(el.id); }
    }
    if (!first && !classes.length && !ids.length) return;
    const css = window.__bayCosmetic.css(location.href, JSON.stringify(classes), JSON.stringify(ids), first);
    first = false;
    if (!css) return;
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true }); else apply();
  if (scan) window.addEventListener('load', apply, { once: true });
})();
"""

  /** Exposed to pages as `__bayCosmetic`; it only answers with CSS selectors. */
  class Bridge {
    @JavascriptInterface
    fun css(pageUrl: String, classes: String, ids: String, siteRules: Boolean): String =
      runCatching { cosmeticCss(pageUrl, classes, ids, siteRules) }.getOrDefault("")
  }
}

/** Hosts that failed over HTTPS this session, so they load over HTTP without another attempt. */
internal object BayHttps {
  val httpOnlyHosts: MutableSet<String> = java.util.Collections.synchronizedSet(mutableSetOf())

  private val ipv4 = Regex("^(\\d{1,3}\\.){3}\\d{1,3}$")

  fun isLocal(host: String): Boolean =
    host == "localhost" || host.startsWith("[") || ipv4.matches(host) ||
      listOf(".local", ".localhost", ".test", ".internal", ".lan", ".home.arpa").any { host.endsWith(it) }
}
