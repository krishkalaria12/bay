package bay.app.settings

import androidx.compose.foundation.layout.size
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bay.app.browser.Wallpaper
import bay.core.Action
import bay.core.Pairing
import bay.core.PreferencesUpdate
import bay.core.SettingsPage
import bay.core.SyncStatus
import bay.core.WallpaperId
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Radius
import bay.design.RowGroup
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style
import kotlinx.coroutines.launch

/** An update that changes only the page zoom. */
private fun textSizeUpdate(value: Double) = PreferencesUpdate(null, value, null, null, null, null, null, null, null, null, null, null)

private const val TEXT_MIN = 80
private const val TEXT_MAX = 200
private const val TEXT_STEP = 10

/** What a page draws below its rows: the custom engine's field, the wallpapers, the page zoom, joining sync. */
@Composable
fun DrawnBody(settings: SettingsModel, page: SettingsPage) {
    when (page) {
        SettingsPage.WALLPAPER -> WallpaperPicker(settings)
        SettingsPage.APP_ICON -> AppIconPicker(settings)
        SettingsPage.TEXT_SIZE -> TextSizeBody(settings)
        SettingsPage.CUSTOM_ENGINE -> CustomEngineBody(settings)
        SettingsPage.SYNC_JOIN -> SyncJoinBody(settings)
        SettingsPage.SYNC_PHRASE -> SyncPhraseBody(settings)
        else -> {}
    }
}

/** Three columns of start-page previews, then the user's photo. */
@Composable
private fun WallpaperPicker(settings: SettingsModel) {
    val app = settings.app
    val strings = settings.strings
    val current = app.preferences.wallpaper
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val width = (maxWidth - Space.md * 2) / 3 - 0.5.dp
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalArrangement = Arrangement.spacedBy(Space.lg), maxItemsInEachRow = 3) {
            WallpaperId.entries.forEach { id ->
                val selected = id == current
                val empty = id == WallpaperId.PHOTO && app.preferences.wallpaperPhoto == null
                val name = if (empty) strings.t("settings.wallpaper.choose") else strings.t("settings.wallpapers.${id.name.lowercase()}")
                Column(
                    Modifier.width(width).testTag("settings-wallpaper-${id.name.lowercase()}")
                        .clearAndSetSemantics { contentDescription = if (empty) strings.t("settings.wallpaper.chooseLabel") else name; role = Role.RadioButton; this.selected = selected }
                        // Your photo needs the system photo picker, which comes with the onboarding's (N6).
                        .pressFeedback { if (id != WallpaperId.PHOTO || !empty) app.dispatch(Action.Wallpaper(id, null)) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    val shape = RoundedCornerShape(Radius.tile)
                    Box(
                        Modifier.fillMaxWidth().aspectRatio(0.62f).clip(shape)
                            .border(if (selected) 2.dp else 1.dp, if (selected) Theme.colors.accent else Theme.colors.foreground.copy(alpha = 0.1f), shape),
                        contentAlignment = Alignment.Center,
                    ) { if (empty) BayIconView(BayIcon.ADD, size = 28.dp) else Wallpaper(id) }
                    BayText(name, variant = TextVariant.SUBHEAD, weight = if (selected) FontWeight.Medium else null, tone = if (selected) TextTone.ACCENT else TextTone.DEFAULT)
                }
            }
        }
    }
}

/** The home screen icons, three to a row; the one on the home screen is ringed. */
@Composable
private fun AppIconPicker(settings: SettingsModel) {
    val strings = settings.strings
    BoxWithConstraints(Modifier.fillMaxWidth().padding(top = Space.xs)) {
        val width = (maxWidth - Space.md * 2) / 3 - 0.5.dp
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalArrangement = Arrangement.spacedBy(Space.lg), maxItemsInEachRow = 3) {
            AppIcon.entries.forEach { icon ->
                val selected = icon == settings.appIcon
                val name = strings.t(icon.label)
                Column(
                    Modifier.width(width).testTag(icon.testID)
                        .clearAndSetSemantics { contentDescription = name; role = Role.RadioButton; this.selected = selected }
                        .pressFeedback { settings.chooseAppIcon(icon) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    val ring = RoundedCornerShape(Radius.tile + 5.dp)
                    Box(Modifier.border(2.dp, if (selected) Theme.colors.accent else Color.Transparent, ring).padding(3.dp)) {
                        androidx.compose.foundation.Image(
                            androidx.compose.ui.res.painterResource(icon.preview),
                            contentDescription = null,
                            modifier = Modifier.size(64.dp).clip(RoundedCornerShape(Radius.tile - 4.dp)),
                        )
                    }
                    BayText(name, variant = TextVariant.SUBHEAD, weight = if (selected) FontWeight.Medium else null, tone = if (selected) TextTone.ACCENT else TextTone.DEFAULT)
                }
            }
        }
    }
}

/** The page zoom: a preview at the zoom, smaller and larger, and back to 100%. */
@Composable
private fun TextSizeBody(settings: SettingsModel) {
    val app = settings.app
    val strings = settings.strings
    val value = app.preferences.textSize.toInt()
    val scale = value / 100f
    Column(verticalArrangement = Arrangement.spacedBy(Space.lg)) {
        Column(Modifier.fillMaxWidth().background(Theme.colors.surface, RoundedCornerShape(Radius.card)).padding(Space.lg), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            BayText("example.com", tone = TextTone.MUTED, variant = TextVariant.FOOTNOTE)
            androidx.compose.foundation.text.BasicText(strings.t("settings.zoom.previewTitle"), style = TextVariant.TITLE.style(FontWeight.SemiBold, Theme.colors.foreground).copy(fontSize = (20 * scale).sp, lineHeight = (26 * scale).sp))
            androidx.compose.foundation.text.BasicText(strings.t("settings.zoom.previewBody"), style = TextVariant.BODY.style(color = Theme.colors.foreground).copy(fontSize = (16 * scale).sp, lineHeight = (23 * scale).sp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
            ZoomButton(settings, "text-size-smaller", strings.t("settings.zoom.out"), 16, value, -TEXT_STEP, Modifier.weight(1f))
            BayText(strings.percent(value), Modifier.width(64.dp).testTag("text-size-value"), variant = TextVariant.HEADLINE, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            ZoomButton(settings, "text-size-larger", strings.t("settings.zoom.in"), 26, value, TEXT_STEP, Modifier.weight(1f))
        }
        if (value != 100) {
            RowGroup { ActionRow(strings.t("settings.zoom.reset"), "text-size-reset") { app.dispatch(Action.Preferences(textSizeUpdate(100.0))) } }
        }
    }
}

@Composable
private fun ZoomButton(settings: SettingsModel, id: String, label: String, size: Int, value: Int, delta: Int, modifier: Modifier) {
    val next = (value + delta).coerceIn(TEXT_MIN, TEXT_MAX)
    Box(
        modifier.height(48.dp).alpha(if (next == value) 0.35f else 1f).testTag(id)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .pressFeedback(enabled = next != value) { settings.app.dispatch(Action.Preferences(textSizeUpdate(next.toDouble()))) }
            .background(Theme.colors.surface, CircleShape),
        contentAlignment = Alignment.Center,
    ) { BayIconView(BayIcon.TEXT_SIZE, size = size.dp) }
}

/** The custom search engine's address: https with `%s` where the words go. */
@Composable
private fun CustomEngineBody(settings: SettingsModel) {
    val app = settings.app
    val strings = settings.strings
    var url by remember { mutableStateOf(app.preferences.customSearchUrl.orEmpty()) }
    val trimmed = url.trim()
    val valid = trimmed.startsWith("https://") && "%s" in trimmed
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        BasicTextField(
            url,
            { url = it },
            Modifier.fillMaxWidth().background(Theme.colors.surface, RoundedCornerShape(Radius.card)).padding(horizontal = Space.lg, vertical = 12.dp)
                .testTag("settings-custom-engine-url").semantics { contentDescription = strings.t("settings.customEngine") },
            singleLine = true,
            textStyle = TextVariant.BODY.style(color = Theme.colors.foreground),
            cursorBrush = SolidColor(Theme.colors.accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        BayText(strings.t("settings.customEngine.note"), Modifier.padding(horizontal = Space.sm), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED)
        RowGroup(modifier = Modifier.padding(top = Space.sm)) {
            ActionRow(strings.t("settings.customEngine.use"), "settings-custom-engine-save", enabled = valid) {
                app.dispatch(Action.SearchEngine("custom", trimmed))
                settings.back()
            }
        }
    }
}

/** Joining sync by a code the computer shows: the phone asks every two seconds whether it has been let in. */
@Composable
private fun SyncJoinBody(settings: SettingsModel) {
    val app = settings.app
    val strings = settings.strings
    DisposableEffect(Unit) {
        app.pair()
        onDispose { app.cancelPairing() }
    }
    // Joined: back to Sync, which now shows this phone among the devices.
    LaunchedEffect(app.syncView.status) { if (app.syncView.status != SyncStatus.OFF) settings.back() }
    Column(verticalArrangement = Arrangement.spacedBy(Space.section)) {
        Column(
            Modifier.fillMaxWidth().background(Theme.colors.surface, RoundedCornerShape(Radius.card)).padding(vertical = Space.xl, horizontal = Space.gutter),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            BayText(strings.t("sync.code.title"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
            when (val pairing = app.syncView.pairing) {
                is Pairing.Waiting -> {
                    BayText(pairing.code, Modifier.testTag("sync-code"), variant = TextVariant.DISPLAY)
                    BayText(strings.t("sync.code.digits", mapOf("digits" to pairing.digits)), Modifier.testTag("sync-code-digits"), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED)
                }
                is Pairing.Expired -> BayText(strings.t("sync.code.expired"), Modifier.testTag("sync-code-state"), tone = TextTone.MUTED)
                is Pairing.Failed -> BayText(strings.t("sync.code.failed"), Modifier.testTag("sync-code-state"), tone = TextTone.DANGER)
                else -> BayText(strings.t("sync.code.starting"), Modifier.testTag("sync-code-state"), tone = TextTone.MUTED)
            }
        }
        val pairing = app.syncView.pairing
        if (pairing is Pairing.Expired || pairing is Pairing.Failed) {
            RowGroup { ActionRow(strings.t("sync.code.again"), "sync-code-again") { app.pair() } }
        }
        BayText(strings.t("sync.join.note"), Modifier.padding(horizontal = Space.sm), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED)
    }
}

/** Joining sync with the recovery phrase. */
@Composable
private fun SyncPhraseBody(settings: SettingsModel) {
    val app = settings.app
    val strings = settings.strings
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    var running by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(Space.section)) {
        BasicTextField(
            text,
            { text = it },
            Modifier.fillMaxWidth().heightIn(min = 120.dp).background(Theme.colors.surface, RoundedCornerShape(Radius.card)).padding(Space.md)
                .testTag("sync-phrase-field").semantics { contentDescription = strings.t("settings.page.syncPhrase") },
            textStyle = TextVariant.BODY.style(color = Theme.colors.foreground),
            cursorBrush = SolidColor(Theme.colors.accent),
        )
        problem?.let { BayText(it, Modifier.padding(horizontal = Space.sm).testTag("sync-phrase-problem"), variant = TextVariant.FOOTNOTE, tone = TextTone.DANGER) }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            RowGroup {
                ActionRow(strings.t("sync.phrase.join"), "sync-phrase-join", enabled = !running && text.isNotBlank()) {
                    running = true
                    scope.launch {
                        problem = app.join(text)
                        running = false
                        if (problem == null) settings.back()
                    }
                }
            }
            BayText(strings.t("sync.phrase.note"), Modifier.padding(horizontal = Space.sm), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED)
        }
    }
}
