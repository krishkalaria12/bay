package bay.app.settings

import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.DisposableEffect
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import bay.app.R
import bay.core.RowKind
import bay.core.SettingsPageView
import bay.core.SettingsRow
import bay.core.SettingsSection
import bay.core.SettingsTile
import bay.core.settingsIndex
import bay.core.settingsPage
import bay.core.settingsSearch
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.Radius
import bay.design.RowDivider
import bay.design.SheetIconButton
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style

/**
 * Settings, the whole screen: the index (a search field over cards of coloured tiles) and the pages pushed over it, each
 * written by the core. Its head holds one round button (× on the index, ‹ on a page) and the title. Back goes back a
 * page, then closes it.
 */
@Composable
fun SettingsScreen(settings: SettingsModel) {
    val activity = LocalContext.current
    // Make Bay default: the system's dialog where it can still ask; refused twice, Android answers at once, so Default
    // apps settings open instead.
    val askDefault = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == android.app.Activity.RESULT_CANCELED &&
            bay.app.welcome.DefaultBrowserStatus.current(activity) != bay.core.DefaultBrowser.DEFAULT
        ) {
            runCatching { activity.startActivity(bay.app.welcome.DefaultBrowserStatus.settings()) }
        }
    }
    DisposableEffect(settings) {
        settings.makeDefault = {
            bay.app.welcome.DefaultBrowserStatus.request(activity)?.let { askDefault.launch(it) }
                ?: activity.startActivity(bay.app.welcome.DefaultBrowserStatus.settings())
        }
        onDispose { settings.makeDefault = null }
    }
    val strings = settings.strings
    val context = settings.context
    BackHandler(onBack = settings::back)
    Box(Modifier.fillMaxSize().background(Theme.colors.background).testTag("settings-screen")) {
        val page = settings.stack.lastOrNull()
        if (page == null) SettingsIndex(settings) else PageView(settings, settingsPage(page, context))
        Row(
            Modifier.fillMaxWidth().background(Theme.colors.background.copy(alpha = 0.96f)).statusBarsPadding().height(52.dp).padding(horizontal = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val back = settings.stack.isNotEmpty()
            SheetIconButton(
                if (back) BayIcon.BACK else BayIcon.CLOSE,
                if (back) strings.t("sheet.back") else strings.t("sheet.close", mapOf("title" to strings.t("settings.title"))),
                Modifier.testTag(if (back) "settings-screen-back" else "settings-screen-close"),
                muted = false,
                onClick = settings::back,
            )
            Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                if (!back) BayText(strings.t("settings.title"), Modifier.semantics { heading() }, variant = TextVariant.HEADLINE)
            }
            Box(Modifier.size(36.dp))
        }
    }
}

@Composable
private fun SettingsIndex(settings: SettingsModel) {
    val strings = settings.strings
    val context = settings.context
    var query by remember { mutableStateOf("") }
    val rows = settingsIndex(context, settings.counts)
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding()
            .padding(horizontal = Space.gutter).padding(top = 52.dp + Space.sm, bottom = 40.dp).testTag("settings-index"),
        verticalArrangement = Arrangement.spacedBy(Space.section),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).background(Theme.colors.surface, RoundedCornerShape(Radius.card)).padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BayIconView(BayIcon.SEARCH, size = IconSize.small, color = Theme.colors.muted)
            BasicTextField(
                query,
                { query = it },
                Modifier.weight(1f).testTag("settings-search-field").semantics { contentDescription = strings.t("settings.search.placeholder") },
                singleLine = true,
                textStyle = TextVariant.BODY.style(color = Theme.colors.foreground),
                cursorBrush = SolidColor(Theme.colors.accent),
                decorationBox = { inner ->
                    Box {
                        if (query.isEmpty()) BayText(strings.t("settings.search.placeholder"), tone = TextTone.MUTED)
                        inner()
                    }
                },
            )
            if (query.isNotEmpty()) {
                Box(
                    Modifier.size(24.dp).testTag("settings-search-clear").clearAndSetSemantics { contentDescription = strings.t("settings.search.clear"); role = Role.Button }
                        .pressFeedback { query = "" }.background(Theme.colors.foreground.copy(alpha = 0.15f), CircleShape),
                    contentAlignment = Alignment.Center,
                ) { BayIconView(BayIcon.CLOSE, size = IconSize.inline) }
            }
        }
        if (query.isBlank()) {
            rows.forEach { group ->
                IndexCard {
                    group.forEachIndexed { index, row ->
                        if (index > 0) RowDivider()
                        IndexEntryRow(row.tile, row.title, row.value, "settings-${row.id}") { settings.open(row.entry) }
                    }
                }
            }
        } else {
            val matches = settingsSearch(query, context)
            if (matches.isEmpty()) {
                BayText(strings.t("settings.search.empty"), Modifier.fillMaxWidth().testTag("settings-search-empty"), tone = TextTone.MUTED, textAlign = TextAlign.Center)
            } else {
                IndexCard(Modifier.testTag("settings-search-results")) {
                    matches.forEachIndexed { index, match ->
                        if (index > 0) RowDivider()
                        val row = rows.flatten().firstOrNull { it.entry == match.entry }
                        IndexEntryRow(row?.tile ?: SettingsTile("settings", null), row?.title.orEmpty(), match.detail, "settings-result-${match.id}") {
                            settings.open(match.entry, match)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun IndexCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier.fillMaxWidth().background(Theme.colors.surface, RoundedCornerShape(Radius.card)).padding(vertical = Space.xs)) { content() }
}

/** An index entry's tile: a white glyph on its colour, or Bay's own mark. */
@Composable
fun SettingsTileView(tile: SettingsTile, size: Dp = 30.dp) {
    val shape = RoundedCornerShape(size * 0.26f)
    if (tile.icon == "mark") {
        Image(painterResource(R.drawable.bay_mark), null, Modifier.size(size).clip(shape))
        return
    }
    Box(Modifier.size(size).background(tile.tint?.let(::hexColor) ?: Theme.colors.muted, shape).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        BayIconView(BayIcon.named(tile.icon) ?: BayIcon.SETTINGS, size = size * 0.58f, color = Color.White)
    }
}

/** A colour written as `#RRGGBB`. */
fun hexColor(hex: String): Color = Color(0xFF000000 or hex.removePrefix("#").toLong(16))

@Composable
private fun IndexEntryRow(tile: SettingsTile, title: String, detail: String?, testID: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().testTag(testID)
            .semantics(mergeDescendants = true) { role = Role.Button; detail?.let { stateDescription = it } }
            .pressFeedback(onClick = onClick)
            .heightIn(min = 50.dp).padding(horizontal = Space.md, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SettingsTileView(tile)
        Column(Modifier.weight(1f)) {
            BayText(title)
            if (detail != null) BayText(detail, Modifier.testTag("$testID-value"), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
        }
    }
}

/** A page: its header (tile, name, one line), its sections of rows, and what it draws itself. */
@Composable
private fun PageView(settings: SettingsModel, view: SettingsPageView) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().navigationBarsPadding()
            .padding(horizontal = Space.gutter).padding(top = 52.dp, bottom = 40.dp).testTag("settings-page-${view.page.id}"),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(top = Space.xs), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
            view.tile?.let { SettingsTileView(it, 56.dp) }
            BayText(view.title, Modifier.testTag("settings-page-title").semantics { heading() }, variant = TextVariant.TITLE, textAlign = TextAlign.Center)
            view.blurb?.let { BayText(it, Modifier.padding(horizontal = Space.xl), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, textAlign = TextAlign.Center) }
        }
        view.sections.forEach { section -> SettingsSectionView(section, settings.focus) { row -> tap(settings, row) } }
        if (view.drawn) DrawnBody(settings, view.page)
    }
}

private fun tap(settings: SettingsModel, row: SettingsRow) {
    when (val kind = row.kind) {
        is RowKind.Page -> settings.push(listOf(kind.page))
        is RowKind.Choice -> settings.perform(kind.action)
        is RowKind.Action -> settings.perform(kind.action)
        is RowKind.Toggle -> settings.perform(if (kind.on) kind.whenOff else kind.whenOn)
        RowKind.Info -> {}
    }
}

/** A section: its title in small capitals, the card of rows, the words under it. */
@Composable
fun SettingsSectionView(section: SettingsSection, lit: String?, tap: (SettingsRow) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        section.title?.let {
            BayText(it.uppercase(), Modifier.padding(horizontal = Space.sm).semantics { heading() }, variant = TextVariant.CAPTION, tone = TextTone.MUTED)
        }
        if (section.rows.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.card)).background(Theme.colors.surface)) {
                section.rows.forEachIndexed { index, row ->
                    if (index > 0) RowDivider(afterIcon = row.icon != null)
                    val kind = row.kind
                    Box(Modifier.background(if (lit == row.id) Theme.colors.accent.copy(alpha = 0.15f) else Color.Transparent)) {
                        ActionRow(
                            row.label,
                            row.testId,
                            icon = row.icon?.takeIf { it != "mark" }?.let { BayIcon.named(it) },
                            detail = row.detail,
                            value = row.value,
                            chevron = kind is RowKind.Page,
                            toggle = (kind as? RowKind.Toggle)?.on,
                            selected = (kind as? RowKind.Choice)?.selected == true || (kind as? RowKind.Page)?.checked == true,
                            destructive = row.danger,
                            enabled = !row.disabled,
                        ) { tap(row) }
                    }
                }
            }
        }
        section.footer?.let {
            BayText(it, Modifier.padding(horizontal = Space.sm).testTag(section.footerTestId ?: ""), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED)
        }
    }
}
