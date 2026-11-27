package bay.app.browser

import android.app.AlertDialog
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.BrowserSpace
import bay.core.spaceColors
import bay.core.spaceEmoji
import bay.design.ActionRow
import bay.design.BayIcon
import bay.design.BayText
import bay.design.PanelSheet
import bay.design.Radius
import bay.design.RowDivider
import bay.design.RowGroup
import bay.design.SectionLabel
import bay.design.SheetWords
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style

/** The words a sheet's chrome needs, for a sheet titled `title`. */
fun Strings.sheetWords(title: String) = SheetWords(t("sheet.close", mapOf("title" to title)), t("sheet.back"))

private val EMOJI = spaceEmoji()
private val COLORS = spaceColors()

/**
 * Everything about a space in one sheet, as the desktop's space settings: its name, its colour, its emoji (from the
 * desktop's set, which it syncs as), its place in the bar, and deleting it with what it kept.
 */
@Composable
fun SpaceEditPanel(browser: BrowserModel, strings: Strings, space: BrowserSpace?, visible: Boolean) {
    val app = browser.app
    val context = LocalContext.current
    val shownName = space?.let { spaceName(it, strings) }.orEmpty()
    val title = strings.t("space.edit.title", mapOf("name" to shownName))
    PanelSheet(visible && space != null, title, "space-edit", strings.sheetWords(title), onClose = { browser.panel = null }, maxFraction = 0.85f) {
        if (space == null) return@PanelSheet
        var name by remember(space.id) { mutableStateOf(space.name) }
        fun saveName() {
            val trimmed = name.trim()
            if (trimmed.isNotEmpty() && trimmed != space.name) browser.renameSpace(space.id, trimmed) else name = space.name
        }
        SectionLabel(strings.t("space.edit.name"))
        BasicTextField(
            name,
            { name = it.take(40) },
            Modifier.fillMaxWidth().background(Theme.colors.fill, CircleShape).padding(horizontal = Space.lg, vertical = 12.dp)
                .testTag("space-edit-name").onFocusChanged { if (!it.isFocused) saveName() },
            singleLine = true,
            textStyle = TextVariant.BODY.style(color = Theme.colors.foreground),
            cursorBrush = SolidColor(Theme.colors.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { saveName() }),
        )

        SectionLabel(strings.t("space.edit.color"))
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            COLORS.forEach { color ->
                val chosen = color == space.color
                Box(
                    Modifier.size(40.dp).testTag("space-edit-color-${color.name.lowercase()}")
                        .clearAndSetSemantics { contentDescription = strings.t("space.color.${color.name.lowercase()}"); role = Role.RadioButton; selected = chosen }
                        .pressFeedback { browser.setSpaceColor(space.id, color) }
                        .border(2.dp, if (chosen) spaceColor(color) else Color.Transparent, CircleShape),
                    contentAlignment = Alignment.Center,
                ) { Box(Modifier.size(28.dp).background(spaceColor(color), CircleShape)) }
            }
        }

        SectionLabel(strings.t("space.edit.icon"))
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val gap = Space.xs
            val cell = (maxWidth - gap * 6) / 7 - 0.5.dp
            FlowRow(horizontalArrangement = Arrangement.spacedBy(gap), verticalArrangement = Arrangement.spacedBy(gap), maxItemsInEachRow = 7) {
                EMOJI.forEachIndexed { at, emoji ->
                    val chosen = emoji == space.icon
                    Box(
                        Modifier.width(cell).aspectRatio(1f).testTag("space-icon-$at")
                            .clearAndSetSemantics { contentDescription = emoji; role = Role.RadioButton; selected = chosen }
                            .pressFeedback { browser.setSpaceIcon(space.id, emoji) }
                            .background(if (chosen) Theme.colors.accent.copy(alpha = 0.2f) else Theme.colors.fill, RoundedCornerShape(Radius.control)),
                        contentAlignment = Alignment.Center,
                    ) { BayText(emoji, variant = TextVariant.TITLE) }
                }
            }
        }

        val index = app.spaces.indexOfFirst { it.id == space.id }
        val personal = space.id == "personal"
        Column(Modifier.padding(top = Space.sm), verticalArrangement = Arrangement.spacedBy(Space.lg)) {
            RowGroup(strings.t("space.edit.order")) {
                ActionRow(strings.t("space.edit.moveLeft"), "space-edit-move-left", icon = BayIcon.BACK, enabled = index > 0) { browser.moveSpace(space.id, -1) }
                RowDivider()
                ActionRow(strings.t("space.edit.moveRight"), "space-edit-move-right", icon = BayIcon.FORWARD, enabled = index < app.spaces.size - 1) {
                    browser.moveSpace(space.id, 1)
                }
            }
            RowGroup {
                ActionRow(
                    strings.t("space.edit.delete", mapOf("name" to shownName)),
                    "space-edit-delete",
                    icon = BayIcon.DELETE,
                    detail = if (personal) strings.t("space.edit.delete.personal") else strings.t("space.edit.delete.detail"),
                    destructive = true,
                    enabled = !personal && app.spaces.size > 1,
                ) {
                    AlertDialog.Builder(context)
                        .setTitle(strings.t("space.edit.delete.title", mapOf("name" to shownName)))
                        .setMessage(strings.t("space.edit.delete.message"))
                        .setNegativeButton(strings.t("space.edit.delete.cancel"), null)
                        .setPositiveButton(strings.t("space.edit.delete.action")) { _, _ -> browser.deleteSpace(space.id) }
                        .show()
                }
            }
        }
    }
}
