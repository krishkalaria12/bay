package expo.modules.bayengine

import android.content.Context
import android.util.Log
import java.io.File
import java.io.IOException

/** Tab snapshots (the switcher's page images), one JPEG per capture in the app cache. */
internal object BayEngineSnapshots {
  fun directory(context: Context) = File(context.cacheDir, "bay-engine-snapshots")

  fun clear(context: Context) {
    val directory = directory(context)
    if (directory.exists() && !directory.deleteRecursively()) throw IOException("Couldn't clear the snapshot cache.")
  }
}

/**
 * Tab state files (B6): each tab's saved page state (BayTab.saveState), by tab id, so a relaunch or a remounted tab
 * gets its back/forward history back. Private tabs never write one.
 */
internal object BayEngineTabStates {
  private const val DIRECTORY = "bay-engine-tab-states-chromium"
  /** Where the system WebView's states were kept, in versions before Bay's own engine; Chromium can't read them. */
  private const val WEBVIEW_DIRECTORY = "bay-engine-tab-states"

  private fun directory(context: Context) = File(context.filesDir, DIRECTORY)

  /** Tab ids are the key; anything else is refused, so a key can never name a file outside the directory. */
  private fun isSafeKey(key: String): Boolean =
    key.isNotEmpty() && key.length <= 120 && Regex("^[A-Za-z0-9._-]+$").matches(key)

  private fun file(context: Context, key: String): File? =
    if (isSafeKey(key)) File(directory(context), "$key.state") else null

  fun save(context: Context, key: String, bytes: ByteArray) {
    val target = file(context, key) ?: return
    try {
      val directory = directory(context)
      if (!directory.isDirectory && !directory.mkdirs()) return
      // Written beside the old file and renamed over it, so a crash mid-write never leaves half a state.
      val draft = File(directory, "$key.state.tmp")
      draft.writeBytes(bytes)
      if (!draft.renameTo(target)) draft.delete()
    } catch (error: Exception) {
      Log.w("BayEngine", "Couldn't save tab state for $key", error)
    }
  }

  fun load(context: Context, key: String): ByteArray? {
    val source = file(context, key) ?: return null
    if (!source.isFile) return null
    return try {
      source.readBytes()
    } catch (error: Exception) {
      null
    }
  }

  /** Deletes states whose tab ids aren't in `keep`. Recent files stay: their tab may not have been told yet. */
  fun prune(context: Context, keep: List<String>) {
    File(context.filesDir, WEBVIEW_DIRECTORY).deleteRecursively()
    val names = keep.filter(::isSafeKey).toHashSet()
    val cutoff = System.currentTimeMillis() - 30_000
    directory(context).listFiles()?.forEach { file ->
      val key = file.name.removeSuffix(".tmp").removeSuffix(".state")
      if (key !in names && file.lastModified() < cutoff) file.delete()
    }
  }

  fun clear(context: Context) {
    for (name in listOf(DIRECTORY, WEBVIEW_DIRECTORY)) {
      val directory = File(context.filesDir, name)
      if (directory.exists() && !directory.deleteRecursively()) throw IOException("Couldn't clear saved tab states.")
    }
  }
}
