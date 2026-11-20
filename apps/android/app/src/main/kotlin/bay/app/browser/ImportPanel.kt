package bay.app.browser

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.ChosenExport
import bay.core.ExportReadException
import bay.core.ImportChoice
import bay.core.ImportCounts
import bay.core.ImportMethod
import bay.core.InstalledBrowser
import bay.core.PhoneBrowser
import bay.core.androidBrowsers
import bay.core.historyLimit
import bay.core.importedLinkCount
import bay.core.importedTabs
import bay.core.readExportFile
import bay.core.takeoutUrl
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayText
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.PillButton
import bay.design.Radius
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.style
import java.io.ByteArrayOutputStream
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where the import sheet is: the ways in, a browser's steps, pasted tabs, a read file's review, or what was added. */
private sealed interface ImportStep {
    data object Sources : ImportStep
    data class Guide(val browser: PhoneBrowser) : ImportStep
    data object Paste : ImportStep
    data class Review(val browser: PhoneBrowser, val chosen: ChosenExport, val choice: ImportChoice) : ImportStep
    data class Done(val counts: ImportCounts) : ImportStep
}

/** "Another browser": any that can save its bookmarks as a file. */
private val ANOTHER = PhoneBrowser("other", "", ImportMethod.BOOKMARKS_FILE, null)

private const val IMPORT_FRACTION = 0.85f

/**
 * Bringing bookmarks, history and favorites from another browser. A phone's browsers keep their data to themselves, so
 * the sheet lists the ones on this phone and walks through how each hands its data over: Google Takeout for Chrome, a
 * bookmarks file for the rest, or a pasted list of tabs. The chosen file is read on the phone (the core reads only its
 * bookmark pages and history files); what it held is reviewed before anything is added.
 */
@Composable
fun ImportPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<ImportStep>(ImportStep.Sources) }
    var browsers by remember { mutableStateOf(emptyList<PhoneBrowser>()) }
    var reading by remember { mutableStateOf(false) }
    var readError by remember { mutableStateOf<String?>(null) }
    val close = { browser.panel = null }

    // Each opening starts at the list, which looks at the phone again: a browser may have been installed meanwhile.
    LaunchedEffect(visible) {
        if (!visible) return@LaunchedEffect
        step = ImportStep.Sources
        readError = null
        browsers = withContext(Dispatchers.IO) { runCatching { androidBrowsers(installedBrowsers(context)) }.getOrDefault(emptyList()) }
    }

    val choose = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val guide = step as? ImportStep.Guide
        if (uri == null || guide == null) return@rememberLauncherForActivityResult
        reading = true
        scope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { readChosen(context, uri) } }
            reading = false
            result.fold(
                onSuccess = { chosen ->
                    val contents = chosen.contents
                    step = ImportStep.Review(
                        guide.browser, chosen,
                        ImportChoice(importedLinkCount(contents.bookmarks) > 0u, contents.favorites.isNotEmpty(), contents.history.isNotEmpty()),
                    )
                },
                onFailure = { error ->
                    readError = when (error) {
                        is ExportReadException.NothingToImport ->
                            strings.t(if (error.tooLarge) "import.error.tooLarge" else "import.error.nothing", mapOf("name" to error.name))
                        else -> strings.t("import.error.unreadable")
                    }
                },
            )
        }
    }

    fun nameOf(phone: PhoneBrowser) = phone.name.ifEmpty { strings.t("import.another") }
    val back = {
        readError = null
        step = ImportStep.Sources
    }

    when (val current = step) {
        is ImportStep.Paste -> {
            val title = strings.t("import.paste.title")
            PanelSheet(visible, title, "import-screen", strings.sheetWords(title), close, onBack = back, maxFraction = IMPORT_FRACTION) {
                PasteTabs(browser, strings)
            }
        }
        is ImportStep.Guide -> {
            val title = nameOf(current.browser)
            PanelSheet(visible, title, "import-screen", strings.sheetWords(title), close, onBack = if (reading) null else back, maxFraction = IMPORT_FRACTION) {
                Guide(strings, current.browser.method, title, current.browser.name.isNotEmpty())
                readError?.let { message ->
                    BayText(
                        message, Modifier.padding(top = Space.md).testTag("import-error").semantics { liveRegion = LiveRegionMode.Assertive },
                        variant = TextVariant.SUBHEAD, tone = TextTone.DANGER,
                    )
                }
                Row(Modifier.fillMaxWidth().padding(top = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.End)) {
                    if (current.browser.method == ImportMethod.TAKEOUT) {
                        PillButton(
                            strings.t("import.takeout.open"),
                            Modifier.testTag("import-takeout").semantics { contentDescription = strings.t("import.takeout.openLabel") },
                            enabled = !reading,
                        ) {
                            close()
                            browser.openListed(takeoutUrl())
                        }
                    }
                    PillButton(
                        if (reading) strings.t("import.reading") else strings.t("import.choose"),
                        Modifier.testTag("import-choose").semantics { contentDescription = strings.t("import.chooseLabel") },
                        enabled = !reading,
                    ) {
                        readError = null
                        choose.launch(arrayOf("*/*"))
                    }
                }
            }
        }
        is ImportStep.Review -> {
            val title = strings.t("import.review.title")
            PanelSheet(visible, title, "import-screen", strings.sheetWords(title), close, onBack = back, maxFraction = IMPORT_FRACTION) {
                Review(strings, current) { step = it }
                Row(Modifier.fillMaxWidth().padding(top = Space.lg), horizontalArrangement = Arrangement.End) {
                    val choice = current.choice
                    PillButton(
                        strings.t("import.review.import"),
                        Modifier.testTag("import-confirm").semantics { contentDescription = strings.t("import.review.importLabel") },
                        enabled = choice.bookmarks || choice.favorites || choice.history,
                    ) {
                        val folder = current.browser.name.ifEmpty { strings.t("import.importedFolder") }
                        step = ImportStep.Done(browser.importExport(current.chosen, choice, folder))
                    }
                }
            }
        }
        is ImportStep.Done -> {
            val title = strings.t("import.done.title")
            PanelSheet(visible, title, "import-screen", strings.sheetWords(title), close, maxFraction = IMPORT_FRACTION) {
                Done(browser, strings, current.counts, close)
            }
        }
        is ImportStep.Sources -> {
            val title = strings.t("import.title")
            PanelSheet(visible, title, "import-screen", strings.sheetWords(title), close, maxFraction = IMPORT_FRACTION) {
                BayText(strings.t("import.help"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
                RowGroup(strings.t("import.onThisPhone"), Modifier.padding(top = Space.md).testTag("import-browsers")) {
                    browsers.forEach { phone ->
                        ActionRow(
                            phone.name, "import-browser-${phone.id}", detail = strings.t(methodDetail(phone.method)), chevron = true,
                            leading = { BrowserIcon(phone) },
                        ) {
                            readError = null
                            step = ImportStep.Guide(phone)
                        }
                        RowDivider()
                    }
                    ActionRow(strings.t("import.another"), "import-browser-other", icon = BayIcon.IMPORT, detail = strings.t("import.method.file"), chevron = true) {
                        readError = null
                        step = ImportStep.Guide(ANOTHER)
                    }
                    RowDivider()
                    ActionRow(strings.t("import.pasteTabs"), "import-paste-tabs", icon = BayIcon.TABS, detail = strings.t("import.method.paste"), chevron = true) {
                        step = ImportStep.Paste
                    }
                }
                Column(
                    Modifier.fillMaxWidth().padding(top = Space.lg).background(Theme.colors.fill, RoundedCornerShape(Radius.card)).padding(Space.lg)
                        .testTag("import-passwords"),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    BayText(strings.t("import.passwords.title"), variant = TextVariant.CALLOUT, weight = FontWeight.SemiBold)
                    BayText(strings.t("import.passwords.android"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
                }
            }
        }
    }
}

/** What each way in says under its name in the list. */
private fun methodDetail(method: ImportMethod): String = when (method) {
    ImportMethod.SAFARI -> "import.method.safari"
    ImportMethod.TAKEOUT -> "import.method.takeout"
    ImportMethod.BOOKMARKS_FILE -> "import.method.file"
    ImportMethod.PASTE -> "import.method.paste"
}

/** A browser's own icon, from Android; its initial on a tile when it has none. */
@Composable
private fun BrowserIcon(phone: PhoneBrowser) {
    val size = IconSize.control + 6.dp
    val bitmap = remember(phone.icon) {
        phone.icon?.substringAfter("base64,", "")?.takeIf { it.isNotEmpty() }?.let { data ->
            runCatching { Base64.decode(data, Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) } }.getOrNull()
        }
    }
    if (bitmap != null) {
        Image(bitmap.asImageBitmap(), contentDescription = null, modifier = Modifier.size(size))
    } else {
        Box(Modifier.size(size).background(Theme.colors.foreground.copy(alpha = 0.1f), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
            BayText(phone.name.take(1).uppercase(), variant = TextVariant.FOOTNOTE, weight = FontWeight.SemiBold)
        }
    }
}

/** The steps that get a browser's data into a file Bay can open. */
@Composable
private fun Guide(strings: Strings, method: ImportMethod, name: String, named: Boolean) {
    val steps = when (method) {
        ImportMethod.SAFARI -> listOf("import.safari.step1", "import.safari.step2", "import.safari.step3").map { strings.t(it) }
        ImportMethod.TAKEOUT -> listOf("import.takeout.step1", "import.takeout.step2", "import.takeout.step3").map { strings.t(it) }
        else -> listOf(
            if (named) strings.t("import.file.step1", mapOf("name" to name)) else strings.t("import.file.step1Any"),
            strings.t("import.file.step2"),
            strings.t("import.file.step3"),
        )
    }
    Column(Modifier.testTag("import-guide"), verticalArrangement = Arrangement.spacedBy(Space.md)) {
        steps.forEachIndexed { index, text ->
            Row(horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                Box(Modifier.size(26.dp).background(Theme.colors.fill, CircleShape), contentAlignment = Alignment.Center) {
                    BayText("${index + 1}", variant = TextVariant.FOOTNOTE, weight = FontWeight.SemiBold)
                }
                BayText(text, Modifier.weight(1f), variant = TextVariant.CALLOUT)
            }
        }
    }
}

/** What the chosen file held, each part switched on or off before it's added. */
@Composable
private fun Review(strings: Strings, review: ImportStep.Review, onChange: (ImportStep.Review) -> Unit) {
    val contents = review.chosen.contents
    val notes = review.chosen.notes
    val choice = review.choice
    val folder = review.browser.name.ifEmpty { strings.t("import.importedFolder") }
    val bookmarks = importedLinkCount(contents.bookmarks).toInt()
    val favorites = contents.favorites.size
    val history = contents.history.size
    val limit = historyLimit().toInt()
    BayText(
        strings.t("import.review.from", mapOf("name" to review.chosen.name)), Modifier.testTag("import-review-file"),
        variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, maxLines = 2,
    )
    RowGroup(modifier = Modifier.padding(top = Space.md)) {
        var first = true
        if (bookmarks > 0) {
            first = false
            ActionRow(
                if (bookmarks == 1) strings.t("bookmarks.folderOne") else strings.t("bookmarks.folderCount", mapOf("count" to "$bookmarks")),
                "import-review-bookmarks", icon = BayIcon.BOOKMARK,
                detail = strings.t("import.review.bookmarksDetail", mapOf("folder" to folder)), toggle = choice.bookmarks,
            ) { onChange(review.copy(choice = choice.copy(bookmarks = !choice.bookmarks))) }
        }
        if (favorites > 0) {
            if (!first) RowDivider()
            first = false
            ActionRow(
                if (favorites == 1) strings.t("import.review.favoriteOne") else strings.t("import.review.favorites", mapOf("count" to "$favorites")),
                "import-review-favorites", icon = BayIcon.PIN, detail = strings.t("import.review.favoritesDetail"), toggle = choice.favorites,
            ) { onChange(review.copy(choice = choice.copy(favorites = !choice.favorites))) }
        }
        if (history > 0) {
            if (!first) RowDivider()
            ActionRow(
                if (history == 1) strings.t("settings.historyOnePage") else strings.t("settings.historyPages", mapOf("count" to "$history")),
                "import-review-history", icon = BayIcon.HISTORY,
                detail = if (history > limit) strings.t("import.review.historyNewest", mapOf("count" to "$limit")) else strings.t("import.review.historyDetail"),
                toggle = choice.history,
            ) { onChange(review.copy(choice = choice.copy(history = !choice.history))) }
        }
    }
    val left = when {
        notes.passwords && notes.cards -> "import.left.both"
        notes.passwords -> "import.left.passwords"
        notes.cards -> "import.left.cards"
        else -> null
    }
    if (left != null) {
        BayText(strings.t(left), Modifier.padding(top = Space.md).testTag("import-review-left"), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED)
    }
}

/** What the import added, with the way to the bookmarks when it brought some. */
@Composable
private fun Done(browser: BrowserModel, strings: Strings, counts: ImportCounts, close: () -> Unit) {
    fun count(value: UInt, one: String, many: String) =
        if (value == 0u) null else if (value == 1u) strings.t(one) else strings.t(many, mapOf("count" to "$value"))
    val lines = listOfNotNull(
        count(counts.bookmarks, "bookmarks.folderOne", "bookmarks.folderCount"),
        count(counts.favorites, "import.review.favoriteOne", "import.review.favorites"),
        count(counts.history, "settings.historyOnePage", "settings.historyPages"),
    )
    Column(Modifier.testTag("import-done").semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }) {
        BayText(if (lines.isEmpty()) strings.t("import.done.nothing") else strings.t("import.done.added"), variant = TextVariant.HEADLINE)
        lines.forEach { BayText(it, Modifier.padding(top = 4.dp), tone = TextTone.MUTED) }
    }
    Row(Modifier.fillMaxWidth().padding(top = Space.xl), horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.End)) {
        if (counts.bookmarks > 0u) {
            PillButton(strings.t("import.done.showBookmarks"), Modifier.testTag("import-show-bookmarks")) { browser.openDrawer() }
        }
        PillButton(strings.t("import.done.finish"), Modifier.testTag("import-finish"), onClick = close)
    }
}

/** A list of tabs pasted from another browser (Arc Search shares its open tabs as text), opened or archived. */
@Composable
private fun PasteTabs(browser: BrowserModel, strings: Strings) {
    val context = LocalContext.current
    val colors = Theme.colors
    var text by remember { mutableStateOf("") }
    var pasteFailed by remember { mutableStateOf(false) }
    val tabs = remember(text) { importedTabs(text) }
    val count = tabs.size
    BayText(strings.t("import.paste.help"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
    Box(Modifier.fillMaxWidth().padding(top = Space.md).background(colors.fill, RoundedCornerShape(Radius.tile)).padding(Space.md)) {
        val placeholder = "https://example.com\nhttps://another.com"
        BasicTextField(
            text,
            { text = it },
            Modifier.fillMaxWidth().heightIn(min = 150.dp).testTag("import-text").semantics { contentDescription = strings.t("import.field") },
            textStyle = TextVariant.CALLOUT.style(color = colors.foreground),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
            decorationBox = { inner ->
                Box {
                    if (text.isEmpty()) BayText(placeholder, variant = TextVariant.CALLOUT, tone = TextTone.MUTED)
                    inner()
                }
            },
        )
    }
    Row(Modifier.fillMaxWidth().padding(top = Space.sm), verticalAlignment = Alignment.CenterVertically) {
        val found = when (count) {
            0 -> strings.t("import.none")
            1 -> strings.t("import.oneLink")
            else -> strings.t("import.linksFound", mapOf("count" to "$count"))
        }
        BayText(
            found, Modifier.weight(1f).testTag("import-count").semantics { liveRegion = LiveRegionMode.Polite },
            variant = TextVariant.SUBHEAD, tone = TextTone.MUTED,
        )
        PillButton(strings.t("import.paste"), Modifier.testTag("import-paste").semantics { contentDescription = strings.t("import.pasteLabel") }, compact = true) {
            pasteFailed = false
            val clip = (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            val pasted = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
            if (pasted == null) pasteFailed = true else text = pasted
        }
    }
    if (pasteFailed) {
        BayText(
            strings.t("import.pasteFailed"), Modifier.padding(top = Space.sm).testTag("import-paste-error").semantics { liveRegion = LiveRegionMode.Assertive },
            variant = TextVariant.SUBHEAD, tone = TextTone.DANGER,
        )
    }
    Row(Modifier.fillMaxWidth().padding(top = Space.lg), horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.End)) {
        PillButton(
            strings.t("import.archive"), Modifier.testTag("import-archive").semantics { contentDescription = strings.t("import.archiveLabel") }, enabled = count > 0,
        ) { browser.importLinks(tabs, archive = true) }
        PillButton(
            strings.t("import.open"), Modifier.testTag("import-open").semantics { contentDescription = strings.t("import.openLabel") }, enabled = count > 0,
        ) { browser.importLinks(tabs, archive = false) }
    }
    BayText(strings.t("import.note"), Modifier.padding(top = Space.md), variant = TextVariant.CAPTION, tone = TextTone.MUTED)
}

/** The apps that open any web address: the phone's browsers, each with its name and icon. Bay itself is left out. */
private fun installedBrowsers(context: Context): List<InstalledBrowser> {
    val manager = context.packageManager
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/")).addCategory(Intent.CATEGORY_BROWSABLE)
    @Suppress("DEPRECATION")
    return manager.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        .map { it.activityInfo }
        .filter { it.packageName != context.packageName }
        .distinctBy { it.packageName }
        .map { info -> InstalledBrowser(info.packageName, info.applicationInfo.loadLabel(manager).toString(), iconOf(info.applicationInfo.loadIcon(manager))) }
        .sortedBy { it.name.lowercase() }
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

/**
 * Copies the chosen document into Bay's cache, where the core reads it, and deletes the copy however the read ends, so
 * nothing the export held is kept outside what's imported.
 */
private fun readChosen(context: Context, uri: Uri): ChosenExport {
    val resolver = context.contentResolver
    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
    } ?: uri.lastPathSegment.orEmpty()
    val folder = File(context.cacheDir, "bay-import").apply { mkdirs() }
    val copy = File.createTempFile("export", null, folder)
    try {
        resolver.openInputStream(uri)?.use { input -> copy.outputStream().use { input.copyTo(it) } } ?: throw ExportReadException.Unreadable()
        return readExportFile(copy.path, name)
    } finally {
        copy.delete()
    }
}
