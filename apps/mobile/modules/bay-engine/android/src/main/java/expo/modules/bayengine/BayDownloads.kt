package expo.modules.bayengine

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.HandlerThread
import android.provider.MediaStore
import android.webkit.CookieManager
import android.webkit.MimeTypeMap
import expo.modules.kotlin.Promise
import java.net.URLDecoder
import java.util.UUID

/**
 * Page downloads. Android 10 and later use Bay's own downloader (BayDownloader); older versions fall back to the
 * system's DownloadManager, into the public Downloads folder with the system's
 * notification. The page's cookies and user agent go with the request, so signed-in downloads work. Progress is polled
 * on a background thread while anything is downloading (the query is a cross-process SQLite read) and goes to
 * JavaScript as the module's `onDownload` event, only when a download's status or byte counts change.
 *
 * `blob:` and `data:` downloads (A3) live inside the page, so neither BayDownloader nor DownloadManager can fetch
 * them. The engine view fetches them in the page and calls [saveBlob] with the bytes; iOS's WKDownload handles
 * the same anchors natively.
 */
object BayDownloads {
  /** Set by the module: sends an `onDownload` event. */
  var emit: ((Map<String, Any>) -> Unit)? = null

  private const val POLL_MS = 500L
  // Everything below the handler is touched only on its thread.
  private val handler by lazy { Handler(HandlerThread("bay-downloads").apply { start() }.looper) }
  private val active = mutableMapOf<Long, String>()
  private val privateIds = mutableSetOf<Long>()
  /** The status, reason, bytes so far and total last sent for each download, so unchanged polls send nothing. */
  private val lastSent = mutableMapOf<Long, List<Long>>()
  private var appContext: Context? = null
  private var polling = false

  fun start(context: Context, url: String, userAgent: String?, contentDisposition: String?, mimeType: String?, cookiesFor: (String) -> String?, referer: String?, isPrivate: Boolean) {
    val filename = filenameFor(url, contentDisposition, mimeType)
    val uri = Uri.parse(url)
    if (uri.scheme?.lowercase() !in listOf("http", "https")) {
      // blob: and data: addresses live inside the page and are saved through saveBlob instead (the view fetches
      // them in the page). Reaching here means an anchor slipped past the interceptor.
      emit?.invoke(mapOf("id" to "unsupported-${System.nanoTime()}", "url" to url.take(200), "filename" to filename,
        "state" to "failed", "received" to 0.0, "total" to 0.0, "private" to isPrivate, "error" to "Bay can't save this kind of download yet."))
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      BayDownloader.start(context, url, userAgent, contentDisposition, mimeType, cookiesFor, referer, isPrivate)
      return
    }
    val cookies = cookiesFor(url)
    val manager = context.getSystemService(DownloadManager::class.java) ?: return
    val request = DownloadManager.Request(uri)
      .setTitle(filename)
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
      .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
      .setAllowedOverMetered(true)
      .setAllowedOverRoaming(true)
    if (!mimeType.isNullOrEmpty()) request.setMimeType(mimeType)
    if (!cookies.isNullOrEmpty()) request.addRequestHeader("Cookie", cookies)
    if (!userAgent.isNullOrEmpty()) request.addRequestHeader("User-Agent", userAgent)
    if (referer != null && Uri.parse(referer).scheme?.lowercase() in listOf("http", "https")) request.addRequestHeader("Referer", referer)
    val id = try {
      manager.enqueue(request)
    } catch (error: Exception) {
      emit?.invoke(mapOf("id" to "failed-${System.nanoTime()}", "url" to url, "filename" to filename, "state" to "failed",
        "received" to 0.0, "total" to 0.0, "private" to isPrivate, "error" to (error.message ?: "The download couldn't start.")))
      return
    }
    emit?.invoke(mapOf("id" to id.toString(), "url" to url, "filename" to filename, "state" to "started", "received" to 0.0, "total" to 0.0, "private" to isPrivate, "waiting" to "Starting…"))
    val applicationContext = context.applicationContext
    handler.post {
      appContext = applicationContext
      active[id] = url
      if (isPrivate) privateIds += id
      if (!polling) {
        polling = true
        handler.postDelayed(::poll, POLL_MS)
      }
    }
  }

  private fun forget(id: Long) {
    active.remove(id)
    privateIds.remove(id)
    lastSent.remove(id)
  }

  private fun poll() {
    val context = appContext
    val manager = context?.getSystemService(DownloadManager::class.java)
    if (manager == null || active.isEmpty()) {
      polling = false
      return
    }
    manager.query(DownloadManager.Query().setFilterById(*active.keys.toLongArray()))?.use { cursor ->
      val seen = mutableSetOf<Long>()
      while (cursor.moveToNext()) {
        val id = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID))
        seen += id
        val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        val receivedBytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        val totalBytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).coerceAtLeast(0)
        val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
        val snapshot = listOf(status.toLong(), reason.toLong(), receivedBytes, totalBytes)
        if (lastSent[id] == snapshot) continue
        lastSent[id] = snapshot
        val received = receivedBytes.toDouble()
        val total = totalBytes.toDouble()
        val filename = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)) ?: "download"
        val state = when (status) {
          DownloadManager.STATUS_SUCCESSFUL -> "finished"
          DownloadManager.STATUS_FAILED -> "failed"
          else -> "progress"
        }
        val body = mutableMapOf<String, Any>("id" to id.toString(), "url" to (active[id] ?: ""), "filename" to filename,
          "state" to state, "received" to received, "total" to total, "private" to (id in privateIds))
        if (state == "finished") manager.getUriForDownloadedFile(id)?.let { body["path"] = it.toString() }
        if (state == "failed") body["error"] = failure(reason)
        waiting(status, reason)?.let { body["waiting"] = it }
        emit?.invoke(body)
        if (state != "progress") forget(id)
      }
      // Removed from the system's list (the user cancelled it from the notification).
      (active.keys - seen).forEach { id ->
        emit?.invoke(mapOf("id" to id.toString(), "url" to (active[id] ?: ""), "filename" to "download", "state" to "cancelled",
          "received" to 0.0, "total" to 0.0, "private" to (id in privateIds)))
        forget(id)
      }
    }
    handler.postDelayed(::poll, POLL_MS)
  }

  /** Why a download that hasn't finished isn't moving, in a few words; null while it's transferring. */
  private fun waiting(status: Int, reason: Int): String? = when (status) {
    DownloadManager.STATUS_PENDING -> "Starting…"
    DownloadManager.STATUS_PAUSED -> when (reason) {
      DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "Waiting for Wi-Fi"
      DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "Waiting for a connection"
      DownloadManager.PAUSED_WAITING_TO_RETRY -> "Connection dropped, retrying…"
      else -> "Paused"
    }
    else -> null
  }

  private fun failure(reason: Int): String = when (reason) {
    DownloadManager.ERROR_INSUFFICIENT_SPACE -> "There isn't enough space on this phone."
    DownloadManager.ERROR_DEVICE_NOT_FOUND -> "Storage isn't available."
    DownloadManager.ERROR_FILE_ALREADY_EXISTS -> "A file with this name already exists."
    DownloadManager.ERROR_TOO_MANY_REDIRECTS -> "The site redirected too many times."
    DownloadManager.ERROR_HTTP_DATA_ERROR, DownloadManager.ERROR_CANNOT_RESUME -> "The connection dropped and the download couldn't resume."
    in 400..599 -> "The site refused the download ($reason)."
    else -> "The download failed."
  }

  /**
   * Writes a page-generated file (a `blob:` or `data:` download the view already fetched) into the public
   * Downloads folder: MediaStore like BayDownloader on Android 10+, a MediaStore row with a DATA path on older
   * versions; the result is a content:// URI either way, so the toast and [open] work the same.
   * The write is small and fast, so it runs on the downloads thread and reports started → finished in one go;
   * there's nothing to cancel.
   */
  fun saveBlob(context: Context, rawFilename: String, mimeType: String?, bytes: ByteArray, url: String, isPrivate: Boolean) {
    val filename = filenameForBlob(rawFilename, mimeType)
    val id = "b-${UUID.randomUUID()}"
    val appContext = context.applicationContext
    emit?.invoke(mapOf("id" to id, "url" to url.take(200), "filename" to filename, "state" to "started",
      "received" to 0.0, "total" to bytes.size.toDouble(), "private" to isPrivate, "waiting" to "Starting…"))
    handler.post {
      try {
        val (finalName, item) = insertBlob(appContext, filename, mimeType, bytes)
        emit?.invoke(mapOf("id" to id, "url" to url.take(200), "filename" to finalName, "state" to "finished",
          "received" to bytes.size.toDouble(), "total" to bytes.size.toDouble(), "private" to isPrivate, "path" to item.toString()))
      } catch (error: Exception) {
        emit?.invoke(mapOf("id" to id, "url" to url.take(200), "filename" to filename, "state" to "failed",
          "received" to 0.0, "total" to bytes.size.toDouble(), "private" to isPrivate, "error" to (error.message ?: "Bay couldn't save to Downloads.")))
      }
    }
  }

  private fun insertBlob(context: Context, filename: String, mimeType: String?, bytes: ByteArray): Pair<String, Uri> {
    val resolver = context.contentResolver
    val cleanMime = mimeType?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() && it != "application/octet-stream" }
    fun values(): ContentValues {
      val values = ContentValues()
      values.put(MediaStore.Downloads.DISPLAY_NAME, filename)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        values.put(MediaStore.Downloads.IS_PENDING, 1)
      } else {
        // Pre-Q has no RELATIVE_PATH: name the file directly in the public Downloads folder.
        val file = java.io.File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), filename)
        values.put(MediaStore.Downloads.DATA, file.absolutePath)
      }
      if (cleanMime != null) values.put(MediaStore.Downloads.MIME_TYPE, cleanMime)
      return values
    }
    val item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values())
      ?: throw java.io.IOException("Bay couldn't save to Downloads.")
    try {
      resolver.openOutputStream(item)?.use { output ->
        output.write(bytes)
      } ?: throw java.io.IOException("Bay couldn't save to Downloads.")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        resolver.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        var finalName = filename
        resolver.query(item, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0)?.let { finalName = it }
        }
        return finalName to item
      }
      return filename to item
    } catch (error: Exception) {
      runCatching { resolver.delete(item, null, null) }
      throw error
    }
  }

  /** A page-provided name (the anchor's `download` attribute), sanitized like [filenameFor]. */
  internal fun filenameForBlob(raw: String, mimeType: String?): String {
    val cleaned = raw.substringAfterLast('/').substringAfterLast('\\')
      .replace(Regex("[\\x00-\\x1f\"*:<>?|]"), "_").trim().trim('.')
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

  fun cancel(context: Context, id: String) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && BayDownloader.cancel(id)) return
    val number = id.toLongOrNull() ?: return
    context.getSystemService(DownloadManager::class.java)?.remove(number)
  }

  /**
   * Saves a web image (B13) through Bay's downloader, so its toast, the panel and the notification follow it. The
   * image's own HTTP address is required: page-local `blob:` and `data:` images have nothing to save from here.
   */
  fun saveImage(context: Context, url: String, promise: Promise) {
    val uri = Uri.parse(url)
    if (uri.scheme?.lowercase() !in listOf("http", "https")) {
      promise.reject("E_IMAGE_URL", "Bay can only save web images.", null)
      return
    }
    val extension = MimeTypeMap.getFileExtensionFromUrl(url)?.lowercase()
    val type = extension?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
    // The image may load only with its site's cookies (a signed-in gallery), so the page's cookies go along.
    BayDownloader.start(context, url, null, null, type, { CookieManager.getInstance().getCookie(url) }, null, false)
    promise.resolve(null)
  }

  /** Opens a finished download in the app the system picks for its type: a saved file's content:// URI, or a system download id. */
  fun open(context: Context, reference: String, promise: Promise) {
    val manager = context.getSystemService(DownloadManager::class.java)
    val number = reference.toLongOrNull()
    val uri = if (reference.startsWith("content://")) Uri.parse(reference) else number?.let { manager?.getUriForDownloadedFile(it) }
    val type = if (number != null) manager?.getMimeTypeForDownloadedFile(number) else runCatching { context.contentResolver.getType(uri!!) }.getOrNull()
    // A file deleted from Downloads since has no type anymore.
    if (uri == null || (number == null && type == null)) {
      promise.reject("E_DOWNLOAD_MISSING", "The file isn't there anymore.", null)
      return
    }
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, type ?: "*/*")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
      promise.resolve(null)
    } catch (error: ActivityNotFoundException) {
      promise.reject("E_NO_APP", "No app on this phone opens this kind of file.", error)
    }
  }
}
