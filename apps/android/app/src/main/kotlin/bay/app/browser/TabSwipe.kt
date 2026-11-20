package bay.app.browser

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import bay.core.BrowserTab
import bay.core.pageTitle
import bay.design.BayText
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import androidx.compose.ui.platform.AndroidUiDispatcher
import kotlinx.coroutines.launch

/**
 * Sliding the bar sideways to the tab before or after, as Arc Search does: the page follows the finger and the next
 * tab's picture comes in beside it; let go far or fast enough and it carries on to that tab, else it springs back.
 * One compositor draws the window (BayTabView), so only the page on screen is live: the tab coming in is its picture,
 * left over the live page for a moment once it's shown, until the page has drawn.
 */
class TabSwipe(private val browser: BrowserModel) {
    /** Runs on the UI's frames, which the animations need. */
    private val scope = CoroutineScope(SupervisorJob() + AndroidUiDispatcher.Main)

    /** How far the page showing has moved sideways, in pixels: negative to the left. */
    val offset = Animatable(0f)

    /** The tab coming in beside the page, while there is one that way. */
    var incoming by mutableStateOf<BrowserTab?>(null)
        private set

    /** The tab just swiped to, its picture over its page until the page draws. */
    var cover by mutableStateOf<BrowserTab?>(null)
        private set
    val coverAlpha = Animatable(0f)

    /** The page's width, in pixels; set by the screen. */
    var width = 1f

    private var dragged = 0f
    private var settling: Job? = null

    /** The tab the other side of the page, in the switcher's order: left of the page for a drag right, and so on. */
    private fun neighbour(towards: Float): BrowserTab? {
        val tabs = browser.app.tabs
        val index = tabs.indexOfFirst { it.id == browser.app.activeTabId }
        if (index < 0 || towards == 0f) return null
        return tabs.getOrNull(index + if (towards < 0) 1 else -1)
    }

    fun drag(amount: Float) {
        settling?.cancel()
        dragged += amount
        val next = neighbour(dragged)
        incoming = next
        // Past the first or last tab the page gives a little, and comes back.
        val shown = if (next != null) dragged else dragged * 0.18f
        scope.launch { offset.snapTo(shown) }
    }

    /** The finger left at `velocity` pixels a second: on to the tab coming in, or back. */
    fun release(velocity: Float) {
        val distance = dragged
        dragged = 0f
        val target = neighbour(distance)
        val fast = kotlin.math.abs(velocity) > width * 1.2f && kotlin.math.sign(velocity) == kotlin.math.sign(distance)
        val go = target != null && (kotlin.math.abs(distance) > width * 0.28f || fast)
        settling?.cancel()
        settling = scope.launch {
            if (!go || target == null) {
                offset.animateTo(0f, spring(dampingRatio = 0.86f, stiffness = 520f), velocity)
                incoming = null
                return@launch
            }
            offset.animateTo(if (distance < 0) -width else width, spring(dampingRatio = 1f, stiffness = 700f), velocity)
            cover = target
            coverAlpha.snapTo(1f)
            incoming = null
            offset.snapTo(0f)
            browser.swipedTo(target.id)
            // The page has its surface back by now and draws within a few frames; the picture fades off it.
            kotlinx.coroutines.delay(COVER_MS)
            coverAlpha.animateTo(0f, tween(180))
            cover = null
        }
    }

    /** A drag cut short (the bar went away under it): the page goes back. */
    fun cancel() = release(0f)

    /** A tab shown some other way takes the swipe's pictures away at once. */
    fun reset() {
        settling?.cancel()
        dragged = 0f
        incoming = null
        cover = null
        scope.launch {
            offset.snapTo(0f)
            coverAlpha.snapTo(0f)
        }
    }

    private companion object {
        /** How long the picture of the tab swiped to stays over it while its page takes the surface and draws. */
        const val COVER_MS = 140L
    }
}

/** A tab's picture where its page would be, or its title on a plain page when it has none yet. */
@Composable
fun TabPicture(browser: BrowserModel, tab: BrowserTab, modifier: Modifier = Modifier) {
    val picture = rememberFileImage(tab.snapshot, PICTURE_WIDTH)
    val rgb = browser.pageColors[tab.id]
    val back = rgb?.takeIf { it.size >= 3 }?.let { Color(it[0].toFloat() / 255, it[1].toFloat() / 255, it[2].toFloat() / 255) } ?: Theme.colors.background
    Box(modifier.fillMaxSize().statusBarsPadding().background(back).clearAndSetSemantics {}) {
        if (picture != null) {
            Image(picture, null, Modifier.fillMaxSize(), contentScale = ContentScale.FillWidth, alignment = Alignment.TopCenter)
        } else {
            Column(
                Modifier.align(Alignment.Center).padding(Space.xl),
                verticalArrangement = Arrangement.spacedBy(Space.md),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                SiteIcon(browser.app, tab.url, size = 48.dp)
                BayText(pageTitle(tab.title, tab.url), variant = TextVariant.HEADLINE, textAlign = TextAlign.Center, maxLines = 2)
                BayText(displayUrl(tab.url), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
            }
        }
    }
}

/** The pictures for a swipe: the tab coming in beside the moving page, then over the page it became. */
@Composable
fun TabSwipeLayer(browser: BrowserModel) {
    val swipe = browser.tabSwipe
    // Decoded ahead, so the picture is there the moment a drag starts.
    val tabs = browser.app.tabs
    val index = tabs.indexOfFirst { it.id == browser.app.activeTabId }
    tabs.getOrNull(index - 1)?.let { rememberFileImage(it.snapshot, PICTURE_WIDTH) }
    tabs.getOrNull(index + 1)?.let { rememberFileImage(it.snapshot, PICTURE_WIDTH) }
    swipe.incoming?.let { tab ->
        TabPicture(browser, tab, Modifier.graphicsLayer {
            val moved = swipe.offset.value
            translationX = if (moved < 0) moved + swipe.width + GAP.toPx() else moved - swipe.width - GAP.toPx()
        })
    }
    swipe.cover?.let { tab -> TabPicture(browser, tab, Modifier.graphicsLayer { alpha = swipe.coverAlpha.value }) }
}

/** The gap between the page and the tab coming in. */
private val GAP = 12.dp

/** Tab pictures are this wide (BaySnapshotWriter.MAX_WIDTH): decoded as they are. */
private const val PICTURE_WIDTH = 640
