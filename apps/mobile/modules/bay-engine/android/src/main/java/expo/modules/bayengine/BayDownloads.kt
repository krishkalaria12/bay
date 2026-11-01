package expo.modules.bayengine

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.webkit.URLUtil
import expo.modules.kotlin.Promise

/**
 * Page downloads through the system's DownloadManager, into the public Downloads folder with the system's
 * notification. The page's cookies and user agent go with the request, so signed-in downloads work. Progress is polled
 * while anything is downloading and goes to JavaScript as the module's `onDownload` event.
 */
object BayDownloads {
  /** Set by the module: sends an `onDownload` event. */
  var emit: ((Map<String, Any>) -> Unit)? = null

  private const val POLL_MS = 500L
  private val handler = Handler(Looper.getMainLooper())
  private val active = mutableMapOf<Long, String>()
  private val privateIds = mutableSetOf<Long>()
  private var appContext: Context? = null
  private var polling = false

  fun start(context: Context, url: String, userAgent: String?, contentDisposition: String?, mimeType: String?, cookies: String?, isPrivate: Boolean) {
    val filename = URLUtil.guessFileName(url, contentDisposition, mimeType)
    val uri = Uri.parse(url)
    if (uri.scheme?.lowercase() !in listOf("http", "https")) {
      // blob: and data: addresses live inside the page; the system downloader can't fetch them.
      emit?.invoke(mapOf("id" to "unsupported-${System.nanoTime()}", "url" to url.take(200), "filename" to filename,
        "state" to "failed", "received" to 0.0, "total" to 0.0, "private" to isPrivate, "error" to "Bay can't save this kind of download yet."))
      return
    }
    val manager = context.getSystemService(DownloadManager::class.java) ?: return
    val request = DownloadManager.Request(uri)
      .setTitle(filename)
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
      .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename)
    if (!mimeType.isNullOrEmpty()) request.setMimeType(mimeType)
    if (!cookies.isNullOrEmpty()) request.addRequestHeader("Cookie", cookies)
    if (!userAgent.isNullOrEmpty()) request.addRequestHeader("User-Agent", userAgent)
    val id = try {
      manager.enqueue(request)
    } catch (error: Exception) {
      emit?.invoke(mapOf("id" to "failed-${System.nanoTime()}", "url" to url, "filename" to filename, "state" to "failed",
        "received" to 0.0, "total" to 0.0, "private" to isPrivate, "error" to (error.message ?: "The download couldn't start.")))
      return
    }
    appContext = context.applicationContext
    active[id] = url
    if (isPrivate) privateIds += id
    emit?.invoke(mapOf("id" to id.toString(), "url" to url, "filename" to filename, "state" to "started", "received" to 0.0, "total" to 0.0, "private" to isPrivate))
    if (!polling) {
      polling = true
      handler.postDelayed(::poll, POLL_MS)
    }
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
        val received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble()
        val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).coerceAtLeast(0).toDouble()
        val filename = cursor.getString(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)) ?: "download"
        val state = when (status) {
          DownloadManager.STATUS_SUCCESSFUL -> "finished"
          DownloadManager.STATUS_FAILED -> "failed"
          else -> "progress"
        }
        val body = mutableMapOf<String, Any>("id" to id.toString(), "url" to (active[id] ?: ""), "filename" to filename,
          "state" to state, "received" to received, "total" to total, "private" to (id in privateIds))
        if (state == "finished") manager.getUriForDownloadedFile(id)?.let { body["path"] = it.toString() }
        if (state == "failed") body["error"] = "The download failed."
        emit?.invoke(body)
        if (state != "progress") {
          active.remove(id)
          privateIds.remove(id)
        }
      }
      // Removed from the system's list (the user cancelled it from the notification).
      (active.keys - seen).forEach { id ->
        emit?.invoke(mapOf("id" to id.toString(), "url" to (active[id] ?: ""), "filename" to "download", "state" to "cancelled",
          "received" to 0.0, "total" to 0.0, "private" to (id in privateIds)))
        active.remove(id)
        privateIds.remove(id)
      }
    }
    handler.postDelayed(::poll, POLL_MS)
  }

  fun cancel(context: Context, id: String) {
    val number = id.toLongOrNull() ?: return
    context.getSystemService(DownloadManager::class.java)?.remove(number)
  }

  /** Opens a finished download in the app the system picks for its type. */
  fun open(context: Context, id: String, promise: Promise) {
    val manager = context.getSystemService(DownloadManager::class.java)
    val number = id.toLongOrNull()
    val uri = number?.let { manager?.getUriForDownloadedFile(it) }
    if (manager == null || number == null || uri == null) {
      promise.reject("E_DOWNLOAD_MISSING", "The file isn't there anymore.", null)
      return
    }
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, manager.getMimeTypeForDownloadedFile(number) ?: "*/*")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
      promise.resolve(null)
    } catch (error: ActivityNotFoundException) {
      promise.reject("E_NO_APP", "No app on this phone opens this kind of file.", error)
    }
  }
}
