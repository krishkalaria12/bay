package expo.modules.bayimport

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import java.util.zip.ZipException
import java.util.zip.ZipFile

/**
 * Unpacks a file another browser exported (a Takeout archive, a bookmarks file) into Bay's cache, so JavaScript can
 * read the parts it knows (src/import/exports.ts), and lists the other browsers on the phone. Only bookmark pages and
 * history files come out of an archive: passwords and everything else stay in it and are only named, so no secret
 * reaches JavaScript. The rules match the iOS side (ios/BayExport.swift).
 */
class BayImportModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BayImport")

    AsyncFunction("readExport") { path: String -> BayExport.read(context, path) }

    AsyncFunction("discardExport") { BayExport.discard(context) }

    AsyncFunction("installedBrowsers") { installedBrowsers(context) }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "Bay isn't ready", null)

  /** The apps that open any web address: the phone's browsers, each with its name and icon. Bay itself is left out. */
  private fun installedBrowsers(context: Context): List<Map<String, String>> {
    val manager = context.packageManager
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/")).addCategory(Intent.CATEGORY_BROWSABLE)
    @Suppress("DEPRECATION")
    val found = manager.queryIntentActivities(intent, PackageManager.MATCH_ALL)

    return found
      .map { it.activityInfo }
      .filter { it.packageName != context.packageName }
      .distinctBy { it.packageName }
      .map { info ->
        mapOf(
          "id" to info.packageName,
          "name" to info.applicationInfo.loadLabel(manager).toString(),
          "icon" to iconOf(info.applicationInfo.loadIcon(manager)),
        )
      }
      .sortedBy { it["name"]?.lowercase() }
  }

  /** An app icon as a PNG data URL, drawn at the size the sheet shows it (with room for the screen's density). */
  private fun iconOf(drawable: android.graphics.drawable.Drawable): String {
    val size = 96
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    drawable.setBounds(0, 0, size, size)
    drawable.draw(Canvas(bitmap))
    val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    bitmap.recycle()

    return "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
  }
}

object BayExport {
  /** The largest file Bay unpacks: a year of Takeout history is a few tens of megabytes. */
  private const val MAX_FILE_SIZE = 64L * 1024 * 1024
  private const val MAX_FILES = 64
  /** How many names of left-out files are reported: enough to tell what an archive held. */
  private const val MAX_SKIPPED = 200

  private fun folder(context: Context) = File(context.cacheDir, "bay-import")

  fun discard(context: Context) {
    folder(context).deleteRecursively()
  }

  /** Whether an archive entry is one Bay reads: a bookmarks page, or a history file by its name. */
  fun wanted(name: String): Boolean {
    val lower = name.lowercase()
    val ext = lower.substringAfterLast('.', "")
    if (ext == "html" || ext == "htm") return true
    if (ext != "json") return false
    val squashed = lower.replace(Regex("[ _-]"), "")

    return squashed.startsWith("history") || squashed.startsWith("browserhistory")
  }

  private fun isZip(file: File): Boolean =
    file.inputStream().use { input ->
      val head = ByteArray(4)
      input.read(head) == 4 && head.contentEquals(byteArrayOf(0x50, 0x4B, 0x03, 0x04))
    }

  fun read(context: Context, path: String): Map<String, Any> {
    val source = File(if (path.startsWith("file://")) Uri.parse(path).path ?: path else path)
    if (!source.isFile) throw CodedException("ERR_NOT_FOUND", "The file isn't there any more", null)

    // A single file (a bookmarks page, a history file) is read where it is.
    if (!isZip(source)) {
      if (source.length() > MAX_FILE_SIZE) return mapOf("files" to emptyList<Any>(), "skipped" to emptyList<Any>(), "tooLarge" to listOf(source.name))
      return mapOf("files" to listOf(mapOf("name" to source.name, "path" to source.absolutePath)), "skipped" to emptyList<Any>(), "tooLarge" to emptyList<Any>())
    }

    discard(context)
    val destination = File(folder(context), UUID.randomUUID().toString()).apply { mkdirs() }
    val files = mutableListOf<Map<String, String>>()
    val skipped = mutableListOf<String>()
    val tooLarge = mutableListOf<String>()

    try {
      ZipFile(source).use { zip ->
        for (entry in zip.entries()) {
          if (entry.isDirectory || entry.name.startsWith("__MACOSX/")) continue
          val name = entry.name.substringAfterLast('/')
          if (name.isEmpty() || name.startsWith(".")) continue
          if (!wanted(name)) {
            if (skipped.size < MAX_SKIPPED) skipped.add(name)
            continue
          }
          if (entry.size > MAX_FILE_SIZE || files.size >= MAX_FILES) {
            tooLarge.add(name)
            continue
          }
          val target = File(destination, "${files.size}-$name")
          zip.getInputStream(entry).use { input ->
            target.outputStream().use { output ->
              // An entry whose header understates its size is cut off at the limit rather than filling the disk.
              val buffer = ByteArray(64 * 1024)
              var total = 0L
              while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > MAX_FILE_SIZE) throw CodedException("ERR_TOO_LARGE", "$name is too large to import", null)
                output.write(buffer, 0, read)
              }
            }
          }
          files.add(mapOf("name" to name, "path" to target.absolutePath))
        }
      }
    } catch (error: ZipException) {
      throw CodedException("ERR_UNREADABLE", "This archive is damaged or isn't a zip file", error)
    }

    return mapOf("files" to files, "skipped" to skipped, "tooLarge" to tooLarge)
  }
}
