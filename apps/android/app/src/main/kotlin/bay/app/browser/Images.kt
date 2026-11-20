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
fun rememberFileImage(uri: String?, width: Int): ImageBitmap? {
    val key = uri?.let { "$it@$width" }
    var image by remember(key) { mutableStateOf(key?.let(decoded::get)) }
    LaunchedEffect(key) {
        if (key == null || image != null) return@LaunchedEffect
        image = withContext(Dispatchers.IO) { decode(uri, width) }?.also { decoded.put(key, it) }
    }
    return image
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

/**
 * A small picture (a site icon) at once, from memory after the first time: one this small decodes in well under a
 * frame, and drawing the monogram first would flash before it.
 */
fun fileImageNow(uri: String?, width: Int): ImageBitmap? {
    val key = uri?.let { "$it@$width" } ?: return null
    return decoded.get(key) ?: decode(uri, width)?.also { decoded.put(key, it) }
}
