package bay.design

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Bay's Android surface, after Arc Search's: a translucent fill and a hairline edge, no elevation and no blur. */
@Composable
fun Modifier.baySurface(radius: Dp): Modifier = baySurface(RoundedCornerShape(radius))

@Composable
fun Modifier.baySurface(shape: Shape): Modifier {
    val colors = Theme.colors
    return clip(shape).background(colors.flatSurface, shape).border(1.dp, colors.hairline, shape)
}
