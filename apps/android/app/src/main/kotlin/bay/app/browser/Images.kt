package bay.app.browser

import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Pictures from the app's files (tab snapshots, site icons), decoded on a background thread at about the width they're
 * drawn and kept in memory, so a card shown again draws at once. Decoding a 640 px snapshot during composition held up
 * the frame that opened the tab switcher, once per card. A file is never rewritten under its name (each snapshot gets a
 * new one), so the file and width are the key.
 */
private val decoded = object : LruCache<String, ImageBitmap>(32 * 1024 * 1024) {
    override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
}

/** The picture at `uri` (a file address), at least `width` pixels wide where it is that wide; null until it's read. */
@Composable
fun rememberFileImage(uri: String?, width: Int): ImageBitmap? = rememberFileImageResult(uri, width).image

/** A file's picture so far: null while it decodes, and `failed` once it can't be read (or there's no file). */
class FileImageResult(val image: ImageBitmap?, val failed: Boolean)

@Composable
fun rememberFileImageResult(uri: String?, width: Int): FileImageResult {
    val key = uri?.let { "$it@$width" }
    var result by remember(key) { mutableStateOf(FileImageResult(key?.let(decoded::get), key == null)) }
    LaunchedEffect(key) {
        if (key == null || result.image != null) return@LaunchedEffect
        val image = withContext(Dispatchers.IO) { decode(uri, width) }?.also { decoded.put(key, it) }
        result = FileImageResult(image, image == null)
    }
    return result
}

/** Decodes a picture at the first halving of its size that is still at least `width` wide. */
private fun decode(uri: String, width: Int): ImageBitmap? = runCatching {
    val path = Uri.parse(uri).path ?: uri
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    var sample = 1
    while (width > 0 && bounds.outWidth / (sample * 2) >= width) sample *= 2
    BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}.getOrNull()

/** Pictures from the web (a site's result posters), kept in memory for the session; never written to disk. */
private val fetched = object : LruCache<String, ImageBitmap>(8 * 1024 * 1024) {
    override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
}

/** The picture at an https `url`, fetched once through Bay's own client and decoded off the main thread. */
@Composable
fun rememberWebImage(app: bay.app.AppModel, url: String?, width: Int): ImageBitmap? {
    val key = url?.let { "$it@$width" }
    var image by remember(key) { mutableStateOf(key?.let(fetched::get)) }
    LaunchedEffect(key) {
        if (url == null || key == null || image != null || !url.startsWith("https://")) return@LaunchedEffect
        val request = bay.core.HttpRequest("GET", url, emptyMap(), null, true, 4000u)
        val body = runCatching { app.http.send(request) }.getOrNull()?.takeIf { it.status.toInt() == 200 }?.body ?: return@LaunchedEffect
        image = withContext(Dispatchers.Default) {
            runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(body, 0, body.size, bounds)
                var sample = 1
                while (width > 0 && bounds.outWidth / (sample * 2) >= width) sample *= 2
                BitmapFactory.decodeByteArray(body, 0, body.size, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
            }.getOrNull()
        }?.also { fetched.put(key, it) }
    }
    return image
}
