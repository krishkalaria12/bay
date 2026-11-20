package bay.design

import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

private const val HELD_SCALE = 0.04f
private const val HELD_DIM = 0.12f

/** Whether the system asks for less motion (animations off): every animation in Bay is then a fade or nothing. */
@Composable
fun reducedMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    return remember(resolver) { Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
}

/**
 * Bay's press feedback for tiles and rows, with no ripple: the control shrinks a little and dims while held, then
 * eases back. With reduced motion only the dim stays.
 */
fun Modifier.pressFeedback(
    enabled: Boolean = true,
    role: Role = Role.Button,
    onClickLabel: String? = null,
    onClick: () -> Unit,
): Modifier = composed {
    val interaction = remember { MutableInteractionSource() }
    val held by interaction.collectIsPressedAsState()
    val reduced = reducedMotion()
    val progress by animateFloatAsState(if (held) 1f else 0f, tween(Motion.TAP_MS), label = "press")
    this
        .graphicsLayer {
            val scale = if (reduced) 1f else 1f - HELD_SCALE * progress
            scaleX = scale
            scaleY = scale
            alpha = 1f - HELD_DIM * progress
        }
        .clickable(interaction, indication = null, enabled = enabled, onClickLabel = onClickLabel, role = role, onClick = onClick)
}

/** A short text action ("Open", "Cancel"): a flat translucent capsule. */
@Composable
fun PillButton(label: String, modifier: Modifier = Modifier, compact: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .alpha(if (enabled) 1f else 0.4f)
            .pressFeedback(enabled = enabled, onClick = onClick)
            .heightIn(min = 44.dp)
            .background(Theme.colors.fill, RoundedCornerShape(percent = 50))
            .padding(horizontal = if (compact) Space.md else Space.lg),
        contentAlignment = Alignment.Center,
    ) {
        BayText(label, variant = TextVariant.SUBHEAD)
    }
}

/**
 * A flat switch (no Material thumb shadow or ripple). The row around it handles the tap and tells TalkBack it is a
 * switch and whether it is on, so the drawing stays out of the reader.
 */
@Composable
fun BayToggle(on: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val colors = Theme.colors
    val position by animateFloatAsState(if (on) 1f else 0f, tween(Motion.TAP_MS), label = "toggle")
    val track by animateColorAsState(if (on) colors.accent else colors.foreground.copy(alpha = 0.2f), tween(Motion.TAP_MS), label = "track")
    Box(
        modifier = modifier
            .alpha(if (enabled) 1f else 0.4f)
            .size(44.dp, 26.dp)
            .background(track, RoundedCornerShape(13.dp))
            .padding(3.dp),
    ) {
        Box(Modifier.offset(x = 18.dp * position).size(20.dp).background(Color.White, CircleShape))
    }
}

/** Bay's haptics. Android has one tick of its own, so every kind answers with it. */
object Haptics {
    /** One light tick, for a committed action: closing a tab, pinning a site, opening the link menu. */
    fun tick(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    /** A softer click, for a tap that only moves something on screen. */
    fun press(view: View) = tick(view)

    /** A confirmation, for an action that finished: a link sent, a file saved. */
    fun done(view: View) {
        view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    }
}
