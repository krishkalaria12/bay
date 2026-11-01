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
        handle = next
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
    return if (engine != 0L) BayAdblock.nativeScriptlets(engine, pageUrl) else ""
  }

  private val imagePath = Regex("\\.(png|jpe?g|gif|webp|svg|ico|avif)$")
  private val fontPath = Regex("\\.(woff2?|ttf|otf)$")
  private val mediaPath = Regex("\\.(mp4|webm|m3u8|mp3|m4a)$")

  private fun resourceType(request: WebResourceRequest): String {
    val accept = request.requestHeaders["Accept"].orEmpty()
    val path = request.url.path.orEmpty().lowercase()
    return when {
      accept.startsWith("text/css") || path.endsWith(".css") -> "stylesheet"
      accept.startsWith("image/") || imagePath.containsMatchIn(path) -> "image"
      path.endsWith(".js") || path.endsWith(".mjs") -> "script"
      fontPath.containsMatchIn(path) -> "font"
      mediaPath.containsMatchIn(path) -> "media"
      else -> "other"
    }
  }

  /** CSS hiding the page's ad slots: its site rules, plus generic rules for the classes and ids it uses. */
  fun cosmeticCss(pageUrl: String, classesJson: String, idsJson: String): String {
    val engine = engineFor(pageUrl)
    if (engine == 0L) return ""
    val resources = JSONObject(BayAdblock.nativeCosmetic(engine, pageUrl))
    val selectors = mutableListOf<String>()
    resources.optJSONArray("hide")?.let { hide -> for (i in 0 until hide.length()) selectors += hide.getString(i) }
    if (!resources.optBoolean("generichide")) {
      val exceptions = resources.optJSONArray("exceptions")?.toString() ?: "[]"
      val generic = JSONArray(BayAdblock.nativeHiddenSelectors(engine, classesJson, idsJson, exceptions))
      for (i in 0 until generic.length()) selectors += generic.getString(i)
    }
    // One rule per chunk, so a selector the browser can't parse only drops its own chunk.
    return selectors.chunked(200).joinToString("\n") { "${it.joinToString(",")}{display:none!important}" }
  }

  /** The page side: collect the classes and ids in use, ask for CSS, add it as a style sheet; again after load. */
  const val COSMETIC_SCRIPT = """
(() => {
  if (window.__bayCosmeticDone || !window.__bayCosmetic) return;
  window.__bayCosmeticDone = true;
  const seen = { classes: new Set(), ids: new Set() };
  const style = document.createElement('style');
  const apply = () => {
    const classes = [], ids = [];
    for (const el of document.querySelectorAll('[class],[id]')) {
      for (const c of el.classList) if (!seen.classes.has(c)) { seen.classes.add(c); classes.push(c); }
      if (el.id && !seen.ids.has(el.id)) { seen.ids.add(el.id); ids.push(el.id); }
    }
    const css = window.__bayCosmetic.css(location.href, JSON.stringify(classes), JSON.stringify(ids));
    if (css) { style.textContent += css + '\n'; (document.head || document.documentElement).appendChild(style); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true }); else apply();
  window.addEventListener('load', apply, { once: true });
})();
"""

  /** Exposed to pages as `__bayCosmetic`; it only answers with CSS selectors. */
  class Bridge {
    @JavascriptInterface
    fun css(pageUrl: String, classes: String, ids: String): String = runCatching { cosmeticCss(pageUrl, classes, ids) }.getOrDefault("")
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
