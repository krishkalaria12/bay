package expo.modules.bayengine

import android.content.Context
import java.io.File

/** The content blocker's scriptlet and redirect resources, for either engine's blocker. */
internal object BayBlockerResources {
  /**
   * The scriptlet and redirect resources ship in the app's assets; the engine reads them from a file, copied (1 MB)
   * once per install or update of the app, which a stamp of its `lastUpdateTime` records.
   */
  fun file(context: Context, directory: File): File? = runCatching {
    val file = directory.resolve("resources.json")
    val stamp = directory.resolve("resources.stamp")
    @Suppress("DEPRECATION") // The flags overload is API 33+.
    val installed = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
    if (!file.exists() || !stamp.exists() || stamp.readText() != installed) {
      val draft = directory.resolve("resources.json.tmp")
      context.assets.open("bay-adblock-resources.json").use { input -> draft.outputStream().use { input.copyTo(it) } }
      check(draft.renameTo(file)) { "The blocker resources couldn't be saved." }
      stamp.writeText(installed)
    }
    file
  }.getOrNull()
}
