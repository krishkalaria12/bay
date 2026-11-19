package bay.design

import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp

/** What the text is for, which picks its colour from the theme. */
enum class TextTone { DEFAULT, MUTED, ACCENT, DANGER }

/**
 * The step's style in Inter. It follows the phone's font size up to the step's limit, where labels in fixed shapes
 * would spill out of them.
 */
@Composable
fun TextVariant.style(weight: FontWeight? = null, color: Color = Color.Unspecified): TextStyle {
    val fontScale = LocalDensity.current.fontScale
    // sp is multiplied by the font scale: shrink the step so the product stops at the step's limit.
    val factor = minOf(fontScale, maxScale) / fontScale
    return TextStyle(
        fontFamily = Inter,
        fontWeight = weight ?: this.weight,
        fontSize = (size * factor).sp,
        lineHeight = (lineHeight * factor).sp,
        letterSpacing = trackingSp,
        color = color,
        lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None),
    )
}

/** Every piece of text in Bay: one type scale and one font. */
@Composable
fun BayText(
    text: String,
    modifier: Modifier = Modifier,
    variant: TextVariant = TextVariant.BODY,
    weight: FontWeight? = null,
    tone: TextTone = TextTone.DEFAULT,
    color: Color? = null,
    maxLines: Int = Int.MAX_VALUE,
    textAlign: TextAlign? = null,
) {
    val colors = Theme.colors
    val toneColor = when (tone) {
        TextTone.DEFAULT -> colors.foreground
        TextTone.MUTED -> colors.muted
        TextTone.ACCENT -> colors.accent
        TextTone.DANGER -> colors.danger
    }
    val style = variant.style(weight, color ?: toneColor)
        .let { if (textAlign != null) it.copy(textAlign = textAlign) else it }
        .let { if (text.trackable) it else it.copy(letterSpacing = 0.sp) }
    BasicText(text, modifier = modifier, style = style, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

/**
 * Whether the type scale's tracking suits the text: it's tuned for Inter's Latin, Greek and Cyrillic. Other scripts come
 * from the system's fallback fonts, where the tight tracking squeezes shaped clusters and throws off the width the text
 * measures, so a short Hindi heading broke mid-word or ellipsized ("भाषा" as "भा / षा").
 */
private val String.trackable: Boolean
    get() = all { it.code < 0x0530 || it.isWhitespace() || it in '\u2000'..'\u206F' }

/**
 * Secondary text straight on a wallpaper (the start page, the tab switcher): the muted grey is tuned for plain
 * surfaces and fell under 3:1 on the brighter wallpapers, so this is the foreground, softened.
 */
val BayColors.overWallpaper: Color
    get() = foreground.copy(alpha = 0.7f)
