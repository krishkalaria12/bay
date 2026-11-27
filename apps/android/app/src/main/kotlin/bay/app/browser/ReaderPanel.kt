package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.app.settings.hexColor
import bay.core.ReaderFont
import bay.core.ReaderSettings
import bay.core.readerSizeSteps
import bay.core.readerThemes
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayText
import bay.design.PanelSheet
import bay.design.Radius
import bay.design.RowGroup
import bay.design.SectionLabel
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback

private val FONTS = listOf(ReaderFont.SERIF to "reader.fontSerif", ReaderFont.SANS to "reader.fontSans", ReaderFont.MONO to "reader.fontMono")

/**
 * Reader's settings, over the article it shows: leaving Reader, the text size, the font and the theme. Each change
 * restyles the article at once and is kept for the next one.
 */
@Composable
fun ReaderPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val settings = browser.app.preferences.reader
    val steps = readerSizeSteps(settings.size)
    val title = strings.t("reader.title")
    val change = { next: ReaderSettings -> browser.changeReader(next) }
    PanelSheet(visible, title, "reader-settings", strings.sheetWords(title), { browser.panel = null }) {
        RowGroup { ActionRow(strings.t("reader.exit"), "reader-exit", icon = BayIcon.CLOSE, onClick = browser::exitReader) }
        SectionLabel(strings.t("reader.textSize"))
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
            Choice("reader-smaller", strings.t("reader.smaller"), enabled = steps.smaller) { change(settings.copy(size = settings.size - 1)) }
            BayText(
                "${settings.size}",
                Modifier.width(40.dp).testTag("reader-size").clearAndSetSemantics { contentDescription = "${strings.t("reader.textSize")}, ${settings.size}" },
                textAlign = TextAlign.Center,
            )
            Choice("reader-larger", strings.t("reader.larger"), enabled = steps.larger) { change(settings.copy(size = settings.size + 1)) }
        }
        SectionLabel(strings.t("reader.font"))
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            FONTS.forEach { (font, key) ->
                Choice("reader-font-${font.name.lowercase()}", strings.t(key), selected = settings.font == font) { change(settings.copy(font = font)) }
            }
        }
        SectionLabel(strings.t("reader.theme"))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            readerThemes().forEach { theme ->
                val name = theme.id.name.lowercase()
                val chosen = settings.theme == theme.id
                Box(
                    Modifier.size(44.dp).testTag("reader-theme-$name")
                        .clearAndSetSemantics {
                            contentDescription = strings.t("reader.theme${name.replaceFirstChar { it.uppercase() }}")
                            role = Role.Button
                            selected = chosen
                        }
                        .pressFeedback { change(settings.copy(theme = theme.id)) }
                        .border(2.dp, if (chosen) Theme.colors.accent else Color.Transparent, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Box(
                        Modifier.size(36.dp).background(hexColor(theme.background), CircleShape).border(1.dp, Color.Gray.copy(alpha = 0.35f), CircleShape),
                        contentAlignment = Alignment.Center,
                    ) { BayText("Aa", variant = TextVariant.SUBHEAD, color = hexColor(theme.text)) }
                }
            }
        }
    }
}

/** One of a row of choices: a font, or a step of the text size. */
@Composable
private fun RowScope.Choice(id: String, label: String, selected: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(Radius.tile)
    Box(
        Modifier.weight(1f).heightIn(min = 44.dp).alpha(if (enabled) 1f else 0.4f).testTag(id)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                if (selected) this.selected = true
                if (!enabled) disabled()
            }
            .pressFeedback(enabled = enabled, onClick = onClick)
            .background(Theme.colors.fill, shape)
            .border(2.dp, if (selected) Theme.colors.accent else Color.Transparent, shape)
            .padding(horizontal = Space.md),
        contentAlignment = Alignment.Center,
    ) { BayText(label, variant = TextVariant.SUBHEAD) }
}
