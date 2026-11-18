package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.FontKind
import bay.core.InspectedFont
import bay.core.fontOrigin
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.PanelSheet
import bay.design.PillButton
import bay.design.Radius
import bay.design.SectionLabel
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style

/** The element picker's card in the bar's place: what's picked, in words, with its tag and size, over its actions. */
@Composable
fun PickerCard(browser: BrowserModel, strings: Strings, mode: PickMode) {
    val colors = Theme.colors
    val picked = browser.picked
    val hint = if (mode == PickMode.HIDE) strings.t("picker.hideHint") else strings.t("picker.inspectHint")
    val shape = RoundedCornerShape(Radius.card)
    // Solid, not the bar's translucent surface: it sits over page text.
    Column(
        Modifier.fillMaxWidth().clip(shape).background(colors.surface, shape).border(1.dp, colors.hairline, shape).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(40.dp).background(colors.accent.copy(alpha = 0.15f), CircleShape), contentAlignment = Alignment.Center) {
                BayIconView(if (mode == PickMode.HIDE) BayIcon.HIDE else BayIcon.INSPECT, size = IconSize.row, color = colors.accent)
            }
            Column(Modifier.weight(1f)) {
                BayText(
                    picked?.label ?: hint,
                    Modifier.testTag(if (mode == PickMode.HIDE) "hide-instructions" else "inspect-instructions"),
                    variant = TextVariant.CALLOUT,
                    weight = FontWeight.Medium,
                    maxLines = 1,
                )
                BayText(
                    picked?.let { "${it.tag} · ${it.width} × ${it.height}" } ?: strings.t("picker.linksClosed"),
                    variant = TextVariant.FOOTNOTE,
                    tone = TextTone.MUTED,
                    maxLines = 1,
                )
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            if (mode == PickMode.HIDE) {
                if (picked != null) {
                    ToolButton("hide-parent", strings.t("picker.parent"), BayIcon.UP, onClick = browser::pickParent)
                    ToolButton("hide-zap", strings.t("picker.hide"), primary = true, onClick = browser::hidePicked)
                } else {
                    val none = browser.activeHidden.isEmpty()
                    ToolButton("hide-undo", strings.t("picker.undo"), enabled = !none, onClick = browser::undoHide)
                    ToolButton("hide-reset", strings.t("picker.resetSite"), enabled = !none, onClick = browser::showHidden)
                }
                ToolButton("hide-done", strings.t("picker.done"), onClick = browser::endPicking)
            } else {
                if (picked != null) {
                    ToolButton("inspect-parent-pick", strings.t("picker.parent"), BayIcon.UP, onClick = browser::pickParent)
                    ToolButton("inspect-open", strings.t("picker.details"), primary = true, onClick = browser::inspectPicked)
                }
                ToolButton("inspect-done", strings.t("picker.done"), onClick = browser::endPicking)
            }
        }
    }
}

@Composable
private fun RowScope.ToolButton(id: String, label: String, icon: BayIcon? = null, primary: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = Theme.colors
    val content = if (primary) Color.White else colors.foreground
    Row(
        Modifier.weight(1f).heightIn(min = 44.dp).alpha(if (enabled) 1f else 0.4f).testTag(id)
            .clearAndSetSemantics {
                contentDescription = label
                role = Role.Button
                if (!enabled) disabled()
            }
            .pressFeedback(enabled = enabled, onClick = onClick)
            .background(if (primary) colors.accent else colors.fill, CircleShape)
            .padding(horizontal = Space.md),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) BayIconView(icon, size = IconSize.small, color = content)
        BayText(label, variant = TextVariant.CALLOUT, weight = if (primary) FontWeight.SemiBold else FontWeight.Normal, color = content, maxLines = 1)
    }
}

/** What the picked element is: its font first, then size, colours and the CSS that matches. */
@Composable
fun InspectPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val element = browser.inspected
    val title = strings.t("inspect.title")
    val colors = Theme.colors
    PanelSheet(visible && element != null, title, "inspect-panel", strings.sheetWords(title), { browser.panel = null }, maxFraction = 0.7f) {
        if (element == null) return@PanelSheet
        val font = element.font
        browser.picked?.label?.let { label ->
            BayText(label, Modifier.padding(bottom = Space.xs).testTag("inspect-title").semantics { heading() }, variant = TextVariant.HEADLINE, maxLines = 2)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Mono(element.name, Modifier.weight(1f).testTag("inspect-name"), color = colors.muted)
            BayText("${Math.round(element.width)} × ${Math.round(element.height)}", Modifier.testTag("inspect-size"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
        }
        Row(Modifier.padding(top = Space.md), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            PillButton(strings.t("inspect.parent"), Modifier.testTag("inspect-parent"), onClick = browser::pickParent)
            PillButton(strings.t("inspect.copy"), Modifier.testTag("inspect-copy"), onClick = browser::copyInspected)
        }
        SectionLabel(strings.t("inspect.font"))
        BayText(font.rendered, Modifier.testTag("inspect-font"), variant = TextVariant.HEADLINE)
        BayText(fontKind(font, strings), Modifier.testTag("inspect-font-kind"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
        Detail(strings.t("inspect.size"), "${font.size} / ${font.lineHeight}")
        Detail(strings.t("inspect.weight"), if (font.style == "normal") font.weight else "${font.weight} ${font.style}")
        if (font.letterSpacing != "normal") Detail(strings.t("inspect.spacing"), font.letterSpacing)
        Detail(strings.t("inspect.stack"), font.stack.joinToString(", "))
        font.source?.let { Detail(strings.t("inspect.file"), it) }
        SectionLabel(strings.t("inspect.colour"))
        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
            Swatch(element.swatches.color)
            Mono(element.color, Modifier.testTag("inspect-color"))
            BayText(strings.t("inspect.on"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
            Swatch(element.swatches.background)
            Mono(element.background)
        }
        if (element.rules.isNotEmpty()) SectionLabel(strings.t("inspect.css"))
        element.rules.forEach { rule ->
            Column(
                Modifier.fillMaxWidth().padding(bottom = Space.sm).background(colors.fill, RoundedCornerShape(Radius.tile)).padding(Space.md),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Row {
                    Mono(rule.selector, Modifier.weight(1f), small = true, bold = true)
                    if (rule.source.isNotEmpty()) BayText(rule.source, variant = TextVariant.CAPTION, tone = TextTone.MUTED, maxLines = 1)
                }
                rule.decls.forEach { decl ->
                    BasicText(
                        buildAnnotatedString {
                            withStyle(SpanStyle(color = colors.muted)) { append("${decl.property}: ") }
                            append("${decl.value};")
                        },
                        style = TextVariant.CAPTION.style(color = colors.foreground).copy(fontFamily = FontFamily.Monospace),
                        maxLines = 2,
                    )
                }
            }
        }
    }
}

/** Where the rendered font comes from, and why it isn't the page's first choice when it isn't. */
private fun fontKind(font: InspectedFont, strings: Strings): String {
    val origin = fontOrigin(font)
    val kind = when (origin.kind) {
        FontKind.WEB -> strings.t("inspect.webFont")
        FontKind.SYSTEM -> strings.t("inspect.systemFont")
        FontKind.INSTALLED -> strings.t("inspect.installedFont")
    }
    return origin.missing?.let { strings.t("inspect.fontMissing", mapOf("kind" to kind, "first" to it)) } ?: kind
}

@Composable
private fun Detail(label: String, value: String) {
    Row(Modifier.padding(top = Space.xs), horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        BayText(label, Modifier.width(64.dp), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED)
        BayText(value, Modifier.weight(1f), variant = TextVariant.SUBHEAD, maxLines = 2)
    }
}

@Composable
private fun Mono(text: String, modifier: Modifier = Modifier, color: Color = Theme.colors.foreground, small: Boolean = false, bold: Boolean = false) {
    BasicText(
        text,
        modifier,
        style = (if (small) TextVariant.CAPTION else TextVariant.SUBHEAD).style(color = color)
            .copy(fontFamily = FontFamily.Monospace, fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal),
        maxLines = 1,
    )
}

// The colour's value is written beside it, so TalkBack skips the swatch.
@Composable
private fun Swatch(css: String) {
    val shape = RoundedCornerShape(4.dp)
    Spacer(Modifier.size(16.dp).background(cssColor(css), shape).border(1.dp, Theme.colors.foreground.copy(alpha = 0.15f), shape).clearAndSetSemantics {})
}

/** A swatch's colour from the inspector's sRGB value: `#rrggbb`, or `rgb()`/`rgba()`. */
private fun cssColor(value: String): Color {
    if (value.startsWith("#") && value.length == 7) return Color(0xFF000000 or value.substring(1).toLong(16))
    val numbers = Regex("[0-9.]+").findAll(value).mapNotNull { it.value.toFloatOrNull() }.toList()
    if (numbers.size < 3) return Color.Transparent
    return Color(numbers[0] / 255f, numbers[1] / 255f, numbers[2] / 255f, numbers.getOrElse(3) { 1f })
}
