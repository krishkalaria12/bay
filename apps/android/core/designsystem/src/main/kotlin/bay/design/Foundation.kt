package bay.design

import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import kotlin.math.PI
import kotlin.math.pow

/** A spring by how long one period takes and how damped it is; 1 is critically damped (no overshoot). Unit mass. */
data class BaySpring(val response: Float, val dampingRatio: Float) {
    val stiffness: Float get() = (2 * PI / response).pow(2).toFloat()

    fun <T> spec(visibilityThreshold: T? = null): FiniteAnimationSpec<T> =
        spring(dampingRatio = dampingRatio, stiffness = stiffness, visibilityThreshold = visibilityThreshold)
}

/** Inter, the closest match to San Francisco, so both apps read the same: one face per weight, never a faked bold. */
val Inter = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)

private val LocalBayColors = staticCompositionLocalOf { LightColors }

/** Provides the theme's colours for the system's appearance. Every Bay screen sits inside it. */
@Composable
fun BayTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalBayColors provides if (dark) DarkColors else LightColors, content = content)
}

/** The theme's colours where they're read: `Theme.colors.foreground`. */
object Theme {
    val colors: BayColors
        @Composable @ReadOnlyComposable
        get() = LocalBayColors.current
}
