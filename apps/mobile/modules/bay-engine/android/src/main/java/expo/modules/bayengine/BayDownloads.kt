package expo.modules.bayengine

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import expo.modules.kotlin.Promise
import java.net.URLDecoder

/**
 * Page downloads, as JavaScript sees them: the engine fetches a page's downloads and BayDownloader shows them, saves
 * them into the public Downloads folder and reports them as the module's `onDownload` event.
 */
object BayDownloads {
  /** Set by the module: sends an `onDownload` event. */
  var emit: ((Map<String, Any>) -> Unit)? = null

  /**
   * The file's name: Content-Disposition's (RFC 6266, `filename*` first), else the address's last path segment, with an
   * extension from the type when it has none. Not URLUtil.guessFileName: it cuts names at their first dot, so a link to
   * `www.host.com/...` saved a film as "www.bin".
   */
  internal fun filenameFor(url: String, contentDisposition: String?, mimeType: String?): String {
    val raw = contentDisposition?.let(::dispositionFilename) ?: Uri.parse(url).lastPathSegment
    val cleaned = raw?.substringAfterLast('/')?.substringAfterLast('\\')
      ?.replace(Regex("[\\x00-\\x1f\"*:<>?|]"), "_")?.trim()?.trim('.')
    var name: String = if (cleaned.isNullOrEmpty()) "download" else cleaned
    val type = mimeType?.substringBefore(';')?.trim()?.lowercase()
    if (!name.contains('.') && type != null && type != "application/octet-stream") {
      MimeTypeMap.getSingleton().getExtensionFromMimeType(type)?.let { name += ".$it" }
    }
    if (name.length > 150) {
      val extension = name.substringAfterLast('.', "").take(10)
      name = name.take(150 - extension.length - 1).trimEnd('.') + if (extension.isEmpty()) "" else ".$extension"
    }
    return name
  }

  private fun dispositionFilename(header: String): String? {
    Regex("""filename\*\s*=\s*([^']*)'[^']*'([^;]+)""", RegexOption.IGNORE_CASE).find(header)?.let { match ->
      val charset = match.groupValues[1].ifBlank { "UTF-8" }
      runCatching { URLDecoder.decode(match.groupValues[2].trim().trim('"').replace("+", "%2B"), charset) }.getOrNull()
        ?.takeIf { it.isNotBlank() }?.let { return it }
    }
    Regex("""filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))""", RegexOption.IGNORE_CASE).find(header)?.let { match ->
      return match.groupValues[1].ifEmpty { match.groupValues[2] }.replace(Regex("""\\(.)"""), "$1").trim().ifEmpty { null }
    }
    return null
  }

  fun cancel(id: String) {
    BayDownloader.cancel(id)
  }

  /**
   * Saves a web image (B13) through Bay's downloader, so its toast, the panel and the notification follow it. The
   * image's own HTTP address is required: page-local `blob:` and `data:` images have nothing to save from here.
   */
  fun saveImage(context: Context, url: String, cookiesFor: (String) -> String?, promise: Promise) {
    val uri = Uri.parse(url)
    if (uri.scheme?.lowercase() !in listOf("http", "https")) {
      promise.reject("E_IMAGE_URL", "Bay can only save web images.", null)
      return
    }
    val extension = MimeTypeMap.getFileExtensionFromUrl(url)?.lowercase()
    val type = extension?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
    // The image may load only with its site's cookies (a signed-in gallery), so the page's cookies go along.
    BayDownloader.start(context, url, null, null, type, cookiesFor, null, false)
    promise.resolve(null)
  }

  /** Opens a finished download (its content:// URI in Downloads) in the app the system picks for its type. */
  fun open(context: Context, reference: String, promise: Promise) {
    val uri = Uri.parse(reference)
    // A file deleted from Downloads since has no type anymore.
    val type = if (reference.startsWith("content://")) runCatching { context.contentResolver.getType(uri) }.getOrNull() else null
    if (type == null) {
      promise.reject("E_DOWNLOAD_MISSING", "The file isn't there anymore.", null)
      return
    }
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, type)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
      promise.resolve(null)
    } catch (error: ActivityNotFoundException) {
      promise.reject("E_NO_APP", "No app on this phone opens this kind of file.", error)
    }
  }
}
