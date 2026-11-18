package bay.design

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.dp

/** The words a sheet's chrome needs, in the app's language (the design system has no catalog of its own). */
data class SheetWords(val close: String, val back: String)

/**
 * A panel: a solid sheet rising from the bottom over a dim backdrop, sized to what it holds up to `maxFraction` of the
 * screen. Its header holds the title (or a back arrow and a sub-page's title), round buttons and the close button;
 * the rows below scroll when they're taller. A tap on the backdrop, a drag down by the header or Back closes it.
 */
@Composable
fun PanelSheet(
    visible: Boolean,
    title: String,
    testID: String,
    words: SheetWords,
    onClose: () -> Unit,
    onBack: (() -> Unit)? = null,
    maxFraction: Float = 0.65f,
    accessory: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    val state = remember { MutableTransitionState(false) }
    state.targetState = visible
    if (!state.currentState && !state.targetState && state.isIdle) return
    BackHandler(enabled = visible) { onBack?.invoke() ?: onClose() }
    val colors = Theme.colors
    var dragged by remember { mutableFloatStateOf(0f) }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val tallest = maxHeight * maxFraction
        AnimatedVisibility(state, enter = fadeIn(), exit = fadeOut()) {
            Box(Modifier.fillMaxSize().background(colors.backdrop).clickable(remember { MutableInteractionSource() }, null, onClick = onClose))
        }
        AnimatedVisibility(
            state,
            modifier = Modifier.align(Alignment.BottomCenter),
            enter = slideInVertically(Motion.settle.spec()) { it },
            exit = slideOutVertically(Motion.settle.spec()) { it },
        ) {
            Column(
                Modifier.fillMaxWidth()
                    .graphicsLayer { translationY = dragged }
                    .heightIn(max = tallest + 1.dp)
                    .background(colors.surface, RoundedCornerShape(topStart = Radius.sheet, topEnd = Radius.sheet))
                    .navigationBarsPadding()
                    .testTag(testID),
            ) {
                // The grabber and header take the drag; the rows keep their own scrolling and taps.
                Column(
                    Modifier.pointerInput(Unit) {
                        detectVerticalDragGestures(
                            onDragEnd = {
                                if (dragged > 80.dp.toPx()) onClose()
                                dragged = 0f
                            },
                            onDragCancel = { dragged = 0f },
                            onVerticalDrag = { _, amount -> dragged = maxOf(0f, dragged + amount) },
                        )
                    },
                ) {
                    Box(Modifier.fillMaxWidth().padding(top = Space.sm, bottom = Space.xs), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(36.dp, 5.dp).background(colors.foreground.copy(alpha = 0.2f), CircleShape))
                    }
                    Row(
                        Modifier.fillMaxWidth().padding(start = Space.gutter, end = Space.gutter, top = Space.xs, bottom = Space.md),
                        horizontalArrangement = Arrangement.spacedBy(Space.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (onBack != null) {
                            SheetIconButton(BayIcon.BACK, words.back, Modifier.testTag("$testID-back"), muted = false, onClick = onBack)
                        }
                        BayText(title, Modifier.weight(1f).semantics { heading() }, variant = TextVariant.TITLE, maxLines = 1)
                        accessory()
                        SheetIconButton(BayIcon.CLOSE, words.close, Modifier.testTag("$testID-close"), onClick = onClose)
                    }
                }
                Column(
                    Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = Space.gutter).padding(bottom = Space.gutter + Space.md),
                    content = content,
                )
            }
        }
    }
}

/** A round button in a sheet's header: close, back, or one of the sheet's own. */
@Composable
fun SheetIconButton(icon: BayIcon, label: String, modifier: Modifier = Modifier, muted: Boolean = true, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = Theme.colors
    Box(
        modifier.size(36.dp).alpha(if (enabled) 1f else 0.4f)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .pressFeedback(enabled = enabled, onClick = onClick)
            .background(colors.fill, CircleShape),
        contentAlignment = Alignment.Center,
    ) { BayIconView(icon, size = IconSize.small, color = if (muted) colors.muted else colors.foreground) }
}

/** A section's heading: small and quiet, stepped in to the rows' inset over a group. */
@Composable
fun SectionLabel(text: String, inset: Boolean = false) {
    BayText(
        text,
        Modifier.padding(top = Space.section, bottom = Space.sm).padding(horizontal = if (inset) ROW_INSET else 0.dp).semantics { heading() },
        variant = TextVariant.FOOTNOTE,
        weight = androidx.compose.ui.text.font.FontWeight.SemiBold,
        tone = TextTone.MUTED,
    )
}

private val ROW_INSET = Space.lg
private val ROW_GAP = 14.dp

/** Rows on one rounded card, split by hairlines. */
@Composable
fun RowGroup(label: String? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier) {
        if (label != null) SectionLabel(label, inset = true)
        Column(Modifier.fillMaxWidth().background(Theme.colors.fill, RoundedCornerShape(Radius.card)), content = content)
    }
}

/** A hairline between grouped rows, starting where the rows' text does. */
@Composable
fun RowDivider(afterIcon: Boolean = true) {
    Box(
        Modifier.fillMaxWidth().padding(start = if (afterIcon) ROW_INSET + IconSize.control + ROW_GAP else ROW_INSET).height(1.dp)
            .background(Theme.colors.foreground.copy(alpha = 0.1f)),
    )
}

/** One tappable row: an icon (or a tinted square), a label with a detail line, and its value, chevron, switch or check. */
@Composable
fun ActionRow(
    label: String,
    testID: String,
    icon: BayIcon? = null,
    tint: Color? = null,
    detail: String? = null,
    value: String? = null,
    chevron: Boolean = false,
    toggle: Boolean? = null,
    selected: Boolean = false,
    destructive: Boolean = false,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = Theme.colors
    Row(
        Modifier.fillMaxWidth().alpha(if (enabled) 1f else 0.4f)
            .testTag(testID)
            .semantics(mergeDescendants = true) {
                role = if (toggle == null) Role.Button else Role.Switch
                if (toggle != null) toggleableState = ToggleableState(toggle)
                // Only a chosen row says so; a row that can't be chosen isn't "checkable".
                if (selected) this.selected = true
            }
            .pressFeedback(enabled = enabled, onClick = onClick)
            .heightIn(min = RowHeightToken)
            .padding(horizontal = ROW_INSET, vertical = Space.md),
        horizontalArrangement = Arrangement.spacedBy(ROW_GAP),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null && tint != null) {
            Box(Modifier.size(29.dp).background(tint, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                BayIconView(icon, size = IconSize.small, color = Color.White)
            }
        } else if (icon != null) {
            BayIconView(icon, size = IconSize.control, color = if (destructive) colors.danger else colors.foreground)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            BayText(label, tone = if (destructive) TextTone.DANGER else TextTone.DEFAULT)
            if (detail != null) BayText(detail, Modifier.testTag("$testID-detail"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, maxLines = 2)
        }
        if (value != null) BayText(value, Modifier.testTag("$testID-value"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, maxLines = 1)
        if (chevron) BayIconView(BayIcon.CHEVRON, size = IconSize.small, color = colors.muted)
        if (toggle != null) BayToggle(toggle, enabled = enabled)
        if (selected) BayIconView(BayIcon.TICK, size = IconSize.row, color = colors.accent)
    }
}

private val RowHeightToken = Row.height
