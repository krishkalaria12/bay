package bay.design

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

private val vectors = HashMap<BayIcon, ImageVector>()

/** The icon as a vector on its 960-unit grid; newer symbols sit a grid's height up and are moved down onto it. */
val BayIcon.vector: ImageVector
    get() = vectors.getOrPut(this) {
        ImageVector.Builder(name.lowercase(), 24.dp, 24.dp, 960f, 960f)
            .addGroup(translationY = if (lifted) 960f else 0f)
            .addPath(PathParser().parsePathString(path).toNodes(), fill = SolidColor(Color.Black))
            .clearGroup()
            .build()
    }

/** A Material Symbol in a `size` square, tinted. Decorative: the control around it carries the label. */
@Composable
fun BayIconView(icon: BayIcon, modifier: Modifier = Modifier, size: Dp = 24.dp, color: Color? = null) {
    Image(
        painter = rememberVectorPainter(icon.vector),
        contentDescription = null,
        modifier = modifier.size(size),
        colorFilter = ColorFilter.tint(color ?: Theme.colors.foreground),
    )
}
