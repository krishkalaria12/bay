package expo.modules.bayengine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder

/**
 * A page's media playing while Bay is in the background: a media playback foreground service keeps the process (and
 * the engine playing) alive, with a media notification whose play/pause and stop go back to JavaScript as the module's
 * `onMediaControl` event. JavaScript sets what's playing with `BayMedia.update` and ends it with `BayMedia.clear`.
 */
object BayMedia {
  /** Set by the module: sends an `onMediaControl` event ("toggle" or "stop"). */
  var emit: ((String) -> Unit)? = null

  internal var title = ""
  internal var site = ""
  internal var playing = false
  internal var service: BayMediaService? = null

  fun update(context: Context, title: String, site: String, playing: Boolean) {
    this.title = title
    this.site = site
    this.playing = playing
    val running = service
    if (running != null) {
      running.refresh()
    } else if (playing) {
      // Only playing media starts the service, which Bay does while it's in the foreground.
      context.startForegroundService(Intent(context, BayMediaService::class.java))
    }
  }

  fun clear() {
    service?.finish()
  }
}

class BayMediaService : Service() {
  private lateinit var session: MediaSession

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    BayMedia.service = this
    getSystemService(NotificationManager::class.java)?.createNotificationChannel(
      NotificationChannel(CHANNEL, "Media playing", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) },
    )
    session = MediaSession(this, "Bay").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() = control(ACTION_TOGGLE)
        override fun onPause() = control(ACTION_TOGGLE)
        override fun onSkipToNext() = control(ACTION_SKIP_FORWARD)
        override fun onSkipToPrevious() = control(ACTION_SKIP_BACKWARD)
        override fun onStop() = control(ACTION_STOP)
      })
      isActive = true
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Foreground first: the system stops a service started in the foreground that doesn't say so in time.
    show()
    intent?.action?.let(::control)
    return START_NOT_STICKY
  }

  private fun control(action: String) {
    when (action) {
      ACTION_TOGGLE -> BayMedia.emit?.invoke("toggle")
      ACTION_SKIP_FORWARD -> BayMedia.emit?.invoke("skip-forward")
      ACTION_SKIP_BACKWARD -> BayMedia.emit?.invoke("skip-backward")
      ACTION_STOP -> BayMedia.emit?.invoke("stop")
    }
  }

  fun refresh() = show()

  fun finish() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    if (BayMedia.service === this) BayMedia.service = null
    session.release()
    super.onDestroy()
  }

  /** The app's own task is gone (swiped away): nothing is left to play. */
  override fun onTaskRemoved(rootIntent: Intent?) = finish()

  private fun show() {
    val playing = BayMedia.playing
    session.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, BayMedia.title)
        .putString(MediaMetadata.METADATA_KEY_ARTIST, BayMedia.site)
        .build(),
    )
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_STOP or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS,
        )
        .setState(if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
        .build(),
    )
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val notification = Notification.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(BayMedia.title)
      .setContentText(BayMedia.site)
      .setContentIntent(open)
      .setOngoing(playing)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      // The mini player's skip (B17): ten seconds either way, answering next/previous. Compact view shows the
      // transport trio; stop stays in the expanded row.
      .addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Back", action(ACTION_SKIP_BACKWARD)).build())
      .addAction(
        Notification.Action.Builder(
          null as android.graphics.drawable.Icon?,
          if (playing) "Pause" else "Play",
          action(ACTION_TOGGLE),
        ).build(),
      )
      .addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Forward", action(ACTION_SKIP_FORWARD)).build())
      .addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, "Stop", action(ACTION_STOP)).build())
      .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun action(name: String): PendingIntent =
    PendingIntent.getService(this, name.hashCode(), Intent(this, BayMediaService::class.java).setAction(name), PendingIntent.FLAG_IMMUTABLE)

  companion object {
    private const val CHANNEL = "bay-media"
    private const val NOTIFICATION_ID = 4107
    private const val ACTION_TOGGLE = "expo.modules.bayengine.media.TOGGLE"
    private const val ACTION_SKIP_FORWARD = "expo.modules.bayengine.media.SKIP_FORWARD"
    private const val ACTION_SKIP_BACKWARD = "expo.modules.bayengine.media.SKIP_BACKWARD"
    private const val ACTION_STOP = "expo.modules.bayengine.media.STOP"
  }
}
