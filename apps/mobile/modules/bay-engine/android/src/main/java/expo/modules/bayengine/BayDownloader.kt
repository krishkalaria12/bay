package expo.modules.bayengine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.annotation.TargetApi
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import java.io.File
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Page downloads on Android 10 and later, fetched by Bay itself and written into the public Downloads folder through
 * MediaStore, inside a data-sync foreground service with a progress notification. Not DownloadManager: it runs every
 * download as a JobScheduler job, and the system holds those back while the phone is warm (thermal status "moderate",
 * common while charging on mobile data), so a download could sit at "pending" for as long as the phone stayed warm.
 */
@TargetApi(Build.VERSION_CODES.Q)
object BayDownloader {
  private class Job(
    val id: String,
    val url: String,
    @Volatile var filename: String,
    val mimeType: String?,
    val isPrivate: Boolean,
  ) {
    @Volatile var cancelled = false
    @Volatile var connection: HttpURLConnection? = null
    @Volatile var received = 0L
    @Volatile var total = 0L
    @Volatile var lastSent = 0L
    /** For a download the page engine fetches: stops its transfer (main thread). */
    var cancelEngine: (() -> Unit)? = null
  }

  private class Cancelled : Exception()
  private class Failure(message: String) : Exception(message)

  private const val CHANNEL = "bay-downloads"
  private const val PROGRESS_MS = 250L
  private const val NOTIFY_MS = 700L

  // Three at a time; the rest wait their turn (and say "Starting…" until then).
  private val executor = Executors.newFixedThreadPool(3)
  /** Moves the engine's finished files into Downloads, one at a time, apart from Bay's own transfers. */
  private val mover = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private val jobs = ConcurrentHashMap<String, Job>()
  @Volatile internal var service: BayDownloadService? = null
  private var lastNotified = 0L

  fun start(
    context: Context,
    url: String,
    userAgent: String?,
    contentDisposition: String?,
    mimeType: String?,
    cookiesFor: (String) -> String?,
    referer: String?,
    isPrivate: Boolean,
  ) {
    val appContext = context.applicationContext
    val job = Job("b-${UUID.randomUUID()}", url, BayDownloads.filenameFor(url, contentDisposition, mimeType), mimeType, isPrivate)
    begin(appContext, job)
    executor.execute { run(appContext, job, userAgent, cookiesFor, referer) }
  }

  /**
   * A download the page engine fetches itself (Bay's Chromium): shown like Bay's own, with the engine reporting its
   * progress here, and moved from the engine's cache into Downloads when it finishes. Returns its id.
   */
  fun startFromEngine(context: Context, url: String, filename: String, mimeType: String?, total: Long, isPrivate: Boolean, cancel: () -> Unit): String {
    val job = Job("b-${UUID.randomUUID()}", url, filename, mimeType, isPrivate)
    job.total = total.coerceAtLeast(0)
    job.cancelEngine = cancel
    begin(context.applicationContext, job)
    return job.id
  }

  fun engineProgress(context: Context, id: String, received: Long, total: Long) {
    val job = jobs[id] ?: return
    job.received = received
    job.total = total.coerceAtLeast(0)
    val now = SystemClock.elapsedRealtime()
    if (now - job.lastSent < PROGRESS_MS) return
    job.lastSent = now
    send(job, "progress")
    notifyProgress(context)
  }

  /** The engine's file at `path` is complete: it moves into Downloads, and the engine's copy goes. */
  fun engineFinished(context: Context, id: String, path: String, mimeType: String?) {
    val file = File(path)
    val job = jobs[id]
    val appContext = context.applicationContext
    mover.execute {
      try {
        if (job == null) return@execute
        job.received = file.length()
        val item = writeToDownloads(appContext, job, mimeType?.takeIf { it.isNotEmpty() } ?: job.mimeType) { output ->
          file.inputStream().use { it.copyTo(output, 64 * 1024) }
        }
        finish(appContext, job, item)
      } catch (error: Exception) {
        job?.let { fail(appContext, it, error) }
      } finally {
        file.delete()
        // The engine writes each download in a directory of its own; it goes too once empty.
        file.parentFile?.delete()
        job?.let(::end)
      }
    }
  }

  fun engineFailed(context: Context, id: String, message: String) {
    val job = jobs[id] ?: return
    fail(context.applicationContext, job, Failure(message))
    end(job)
  }

  fun engineCancelled(id: String) {
    val job = jobs[id] ?: return
    send(job, "cancelled")
    end(job)
  }

  private fun begin(context: Context, job: Job) {
    jobs[job.id] = job
    send(job, "started", waiting = "Starting…")
    // Android 12+ refuses to start a foreground service while Bay is in the background (a page that starts a download
    // late); the download still runs, just without the notification keeping Bay alive.
    runCatching { context.startForegroundService(Intent(context, BayDownloadService::class.java)) }
  }

  /** True when `id` was one of Bay's own downloads (finished ones are already gone and need nothing). */
  fun cancel(id: String): Boolean {
    if (!id.startsWith("b-")) return false
    jobs[id]?.let { job ->
      job.cancelled = true
      job.cancelEngine?.let { main.post(it) }
      // Unblocks a read that's waiting on the network.
      Thread { runCatching { job.connection?.disconnect() } }.start()
    }
    return true
  }

  private fun run(context: Context, job: Job, userAgent: String?, cookiesFor: (String) -> String?, referer: String?) {
    try {
      val connection = connect(job, userAgent, cookiesFor, referer)
      job.total = connection.contentLengthLong.coerceAtLeast(0)
      val type = connection.contentType?.substringBefore(';')?.trim()?.takeIf { it.isNotEmpty() && it != "application/octet-stream" }
        ?: job.mimeType
      // The response can name the file better than the link did (a redirect to the real file, a late Content-Disposition).
      connection.getHeaderField("Content-Disposition")?.let { job.filename = BayDownloads.filenameFor(connection.url.toString(), it, type) }
      val item = writeToDownloads(context, job, type) { output ->
        send(job, "progress")
        connection.inputStream.use { input ->
          val buffer = ByteArray(64 * 1024)
          var lastSent = SystemClock.elapsedRealtime()
          while (true) {
            if (job.cancelled) throw Cancelled()
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            job.received += count
            val now = SystemClock.elapsedRealtime()
            if (now - lastSent >= PROGRESS_MS) {
              lastSent = now
              send(job, "progress")
              notifyProgress(context)
            }
          }
        }
        if (job.total > 0 && job.received < job.total) throw Failure("The connection dropped before the download finished.")
      }
      finish(context, job, item)
    } catch (error: Exception) {
      fail(context, job, error)
    } finally {
      runCatching { job.connection?.disconnect() }
      end(job)
    }
  }

  /**
   * Writes a download into the public Downloads folder through `write`, and returns its MediaStore item. Nothing is
   * left behind when it fails or is cancelled.
   */
  private fun writeToDownloads(context: Context, job: Job, type: String?, write: (OutputStream) -> Unit): Uri {
    val resolver = context.contentResolver
    val item = insert(context, job.filename, type)
    try {
      resolver.openOutputStream(item)?.use(write) ?: throw Failure("Bay couldn't save to Downloads.")
      if (job.cancelled) throw Cancelled()
      resolver.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    } catch (error: Exception) {
      runCatching { resolver.delete(item, null, null) }
      throw error
    }
    // MediaStore renames a duplicate ("film (1).mkv"); show the name it really has.
    resolver.query(item, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(0)?.let { job.filename = it }
    }
    return item
  }

  private fun finish(context: Context, job: Job, item: Uri) {
    if (job.total == 0L) job.total = job.received
    send(job, "finished", path = item.toString())
    notifyDone(context, job, item, null)
  }

  private fun fail(context: Context, job: Job, error: Exception) {
    if (job.cancelled || error is Cancelled) {
      send(job, "cancelled")
      return
    }
    val message = when (error) {
      is Failure -> error.message ?: "The download failed."
      is java.net.UnknownHostException -> "No connection."
      is java.net.SocketTimeoutException -> "The site stopped responding."
      is java.io.IOException -> "The connection dropped before the download finished."
      else -> "The download failed."
    }
    send(job, "failed", error = message)
    notifyDone(context, job, null, message)
  }

  private fun end(job: Job) {
    jobs.remove(job.id)
    service?.let { running -> if (jobs.isEmpty()) running.finish() else running.refresh() }
  }

  /** Follows redirects itself, so an http → https hop works and each host only gets its own cookies. */
  private fun connect(job: Job, userAgent: String?, cookiesFor: (String) -> String?, referer: String?): HttpURLConnection {
    var current = URL(job.url)
    repeat(10) {
      if (job.cancelled) throw Cancelled()
      val connection = current.openConnection() as HttpURLConnection
      job.connection = connection
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 20_000
      connection.readTimeout = 30_000
      connection.setRequestProperty("Accept-Encoding", "identity")
      userAgent?.takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("User-Agent", it) }
      referer?.takeIf { it.startsWith("http") }?.let { connection.setRequestProperty("Referer", it) }
      cookiesFor(current.toString())?.takeIf { it.isNotEmpty() }?.let { connection.setRequestProperty("Cookie", it) }
      val code = connection.responseCode
      if (code in 300..399) {
        val location = connection.getHeaderField("Location") ?: throw Failure("The site redirected nowhere.")
        connection.disconnect()
        current = URL(current, location)
        if (current.protocol != "http" && current.protocol != "https") throw Failure("Bay can't save this kind of download yet.")
        return@repeat
      }
      if (code !in 200..299) throw Failure("The site refused the download ($code).")
      return connection
    }
    throw Failure("The site redirected too many times.")
  }

  private fun insert(context: Context, filename: String, type: String?): Uri {
    val resolver = context.contentResolver
    fun values(withType: Boolean) = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, filename)
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      put(MediaStore.Downloads.IS_PENDING, 1)
      if (withType && type != null) put(MediaStore.Downloads.MIME_TYPE, type)
    }
    // A type MediaStore doesn't accept for that extension is refused; the extension alone is enough.
    val item = runCatching { resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values(true)) }.getOrNull()
      ?: resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values(false))
    return item ?: throw Failure("Bay couldn't save to Downloads.")
  }

  private fun send(job: Job, state: String, waiting: String? = null, path: String? = null, error: String? = null) {
    val body = mutableMapOf<String, Any>(
      "id" to job.id, "url" to job.url, "filename" to job.filename, "state" to state,
      "received" to job.received.toDouble(), "total" to job.total.toDouble(), "private" to job.isPrivate,
    )
    waiting?.let { body["waiting"] = it }
    path?.let { body["path"] = it }
    error?.let { body["error"] = it }
    BayDownloads.emit?.invoke(body)
  }

  // Notifications

  internal fun createChannel(context: Context) {
    context.getSystemService(NotificationManager::class.java)?.createNotificationChannel(
      NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
    )
  }

  /** The service's ongoing notification: the running download's name and percentage, or a count of several. */
  internal fun progressNotification(context: Context): Notification {
    val running = jobs.values.toList()
    val received = running.sumOf { it.received }
    val total = running.sumOf { it.total }
    val sized = running.isNotEmpty() && running.all { it.total > 0 }
    val percent = if (sized && total > 0) ((received * 100) / total).toInt().coerceIn(0, 100) else 0
    val title = when (running.size) {
      0 -> "Finishing download"
      1 -> running[0].filename
      else -> "Downloading ${running.size} files"
    }
    val text = when {
      running.isEmpty() -> ""
      running.size == 1 && running[0].received == 0L -> "Starting…"
      sized -> "$percent% · ${formatBytes(received)} of ${formatBytes(total)}"
      else -> "${formatBytes(received)} so far"
    }
    val builder = Notification.Builder(context, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setProgress(100, percent, !sized)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setContentIntent(openApp(context))
    if (running.size == 1) {
      val cancel = PendingIntent.getService(
        context, running[0].id.hashCode(),
        Intent(context, BayDownloadService::class.java).setAction(BayDownloadService.ACTION_CANCEL).putExtra("id", running[0].id),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      builder.addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Cancel", cancel).build())
    }
    if (running.any { it.isPrivate }) builder.setVisibility(Notification.VISIBILITY_PRIVATE)
    return builder.build()
  }

  @Synchronized
  private fun notifyProgress(context: Context) {
    val now = SystemClock.elapsedRealtime()
    // The system drops notification updates that come faster than a few a second.
    if (now - lastNotified < NOTIFY_MS) return
    lastNotified = now
    service?.refresh()
  }

  /** A finished download's notification opens the file; a failed one says why. */
  private fun notifyDone(context: Context, job: Job, item: Uri?, error: String?) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val builder = Notification.Builder(context, CHANNEL)
      .setSmallIcon(if (item != null) android.R.drawable.stat_sys_download_done else android.R.drawable.stat_notify_error)
      .setContentTitle(job.filename)
      .setContentText(if (item != null) "Download complete · ${formatBytes(job.received)}" else (error ?: "The download failed."))
      .setAutoCancel(true)
      .setVisibility(if (job.isPrivate) Notification.VISIBILITY_PRIVATE else Notification.VISIBILITY_PUBLIC)
    val tap = item?.let {
      val view = Intent(Intent.ACTION_VIEW)
        .setDataAndType(it, context.contentResolver.getType(it) ?: "*/*")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      PendingIntent.getActivity(context, job.id.hashCode(), Intent.createChooser(view, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
    } ?: openApp(context)
    builder.setContentIntent(tap)
    manager.notify(job.id.hashCode(), builder.build())
  }

  private fun openApp(context: Context): PendingIntent? = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
    PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  internal fun cancelAll() = jobs.keys.forEach(::cancel)

  internal fun isIdle() = jobs.isEmpty()

  private fun formatBytes(bytes: Long): String = when {
    bytes >= 1_000_000_000 -> "%.1f GB".format(bytes / 1_000_000_000.0)
    bytes >= 1_000_000 -> "%.1f MB".format(bytes / 1_000_000.0)
    bytes >= 1_000 -> "${bytes / 1_000} KB"
    else -> "$bytes bytes"
  }
}

/** Keeps Bay's process running while it downloads, with the progress notification. */
@TargetApi(Build.VERSION_CODES.Q)
class BayDownloadService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    BayDownloader.service = this
    BayDownloader.createChannel(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Foreground first: the system stops a service started in the foreground that doesn't say so in time.
    refresh()
    if (intent?.action == ACTION_CANCEL) intent.getStringExtra("id")?.let(BayDownloader::cancel)
    // Everything may have finished before the service got going.
    if (BayDownloader.isIdle()) finish()
    return START_NOT_STICKY
  }

  fun refresh() {
    val notification = BayDownloader.progressNotification(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  fun finish() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  /** Android 15 caps data-sync services at six hours a day; stop cleanly instead of being killed. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    BayDownloader.cancelAll()
    finish()
  }

  override fun onDestroy() {
    if (BayDownloader.service === this) BayDownloader.service = null
    super.onDestroy()
  }

  companion object {
    private const val NOTIFICATION_ID = 4108
    const val ACTION_CANCEL = "expo.modules.bayengine.downloads.CANCEL"
  }
}
