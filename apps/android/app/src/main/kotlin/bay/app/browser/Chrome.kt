package bay.app.browser

import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import android.graphics.BitmapFactory
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.invisibleToUser
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import bay.app.AppModel
import bay.app.Strings
import bay.core.PageErrorId
import bay.core.PageErrorKind
import bay.core.WallpaperId
import bay.core.describePageError
import bay.core.pageErrorId
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Haptics
import bay.design.IconSize
import bay.design.PillButton
import bay.design.Radius
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.baySurface
import bay.design.pressFeedback
import bay.design.style
import bay.design.wallpaperPalette
import bay.engine.NavigationState

/**
 * The browser's pages: the loaded tabs' views in one container, the one showing on top. The views are kept across
 * recompositions, so a page isn't reloaded when the screen around it changes. A page view is made only once the
 * container is in a window, as on iOS. Under the tab switcher the host is transparent and no page is active.
 */
@Composable
fun PagesHost(browser: BrowserModel, reachable: Boolean, modifier: Modifier = Modifier, visible: Boolean = reachable) {
    // `visible`: the page shows (not under the switcher or Settings); `reachable`: TalkBack can reach it (no sheet over it).
    val shown = visible
    val mounted = browser.mounted
    val tabs = browser.app.tabs
    AndroidView(
        factory = { context -> FrameLayout(context) },
        modifier = modifier,
        update = { container ->
            container.importantForAccessibility =
                if (reachable) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            fun sync() {
                for ((index, id) in mounted.withIndex()) {
                    val tab = tabs.firstOrNull { it.id == id } ?: continue
                    val view = browser.view(tab)
                    if (view.parent !== container) {
                        (view.parent as? ViewGroup)?.removeView(view)
                        container.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    }
                    // Hidden pages stay visible to Android, only transparent: the tab on screen takes the window's one
                    // compositor (isActive), and a page made INVISIBLE stops drawing for good.
                    val showing = shown && index == 0
                    view.alpha = if (showing) 1f else 0f
                    view.isActive = showing
                    if (showing) view.bringToFront()
                }
            }
            if (container.isAttachedToWindow) sync() else container.post { sync() }
        },
    )
}

private val tints = listOf(0xFFDCE8F5, 0xFFF3E2D6, 0xFFE3EEDF, 0xFFECE1F2, 0xFFF5E9C9, 0xFFDDEEEE).map { Color(it) }

/**
 * The site's saved icon on a tile, else a monogram on a tint picked from its name. Icons are local files, so this
 * never loads anything from the network. It always sits beside the site's name, so TalkBack skips it.
 */
@Composable
fun SiteIcon(app: AppModel, url: String, size: Dp = 28.dp, bare: Boolean = false, color: Color? = null) {
    val host = hostOf(url)
    val file = app.favicons[host]
    val pixels = with(LocalDensity.current) { size.roundToPx() }
    val bitmap = remember(file, pixels) { fileImageNow(file, pixels) }
    val corner = RoundedCornerShape(size * 0.28f)
    val modifier = Modifier.clearAndSetSemantics {}
    if (bitmap != null) {
        if (bare) {
            Image(bitmap, null, modifier.size(size).clip(RoundedCornerShape(size * 0.14f)))
        } else {
            Box(
                modifier.size(size).background(if (isSystemInDarkTheme()) Color(0xFF2C2C2E) else Color.White, corner)
                    .border(1.dp, Color.Black.copy(alpha = 0.05f), corner),
                contentAlignment = Alignment.Center,
            ) {
                Image(bitmap, null, Modifier.size(size * 0.72f).clip(RoundedCornerShape(size * 0.14f)))
            }
        }
        return
    }
    val letter = host.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "•"
    // The monogram follows the tile's size, not the phone's font size, which would push it out of a small tile.
    val density = LocalDensity.current
    if (bare) {
        Box(modifier.size(size), contentAlignment = Alignment.Center) {
            Monogram(letter, with(density) { (size * 0.6f).toSp() }, color ?: Theme.colors.foreground)
        }
    } else {
        var hash = 0
        host.forEach { hash = hash * 31 + it.code }
        Box(
            modifier.size(size).background(tints[Math.floorMod(hash, tints.size)], corner).border(1.dp, Color.Black.copy(alpha = 0.05f), corner),
            contentAlignment = Alignment.Center,
        ) {
            Monogram(letter, with(density) { (size * 0.46f).toSp() }, Color(0xFF26313D))
        }
    }
}

@Composable
private fun Monogram(letter: String, fontSize: TextUnit, color: Color) {
    BasicText(letter, style = TextVariant.FOOTNOTE.style(FontWeight.SemiBold, color).copy(fontSize = fontSize, lineHeight = fontSize), maxLines = 1, softWrap = false)
}

/** Bay's start-page wallpaper: a wash under a fine dot grid, the theme's background for Plain. */
@Composable
fun Wallpaper(id: WallpaperId, modifier: Modifier = Modifier) {
    val palette = wallpaperPalette(id.name.lowercase(), isSystemInDarkTheme())
    if (palette == null) {
        Box(modifier.fillMaxSize().background(Theme.colors.background).semantics { invisibleToUser() })
        return
    }
    Canvas(modifier.fillMaxSize().semantics { invisibleToUser() }) {
        drawRect(Brush.verticalGradient(0f to palette.top, 0.55f to palette.middle, 1f to palette.bottom))
        val step = 14.dp.toPx()
        val dot = palette.dot.copy(alpha = palette.dotOpacity)
        var y = step / 2
        while (y < size.height) {
            var x = step / 2
            while (x < size.width) {
                drawCircle(dot, 0.9.dp.toPx(), Offset(x, y))
                x += step
            }
            y += step
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
/** One of the bar's round buttons, or its capsule: flat and translucent with a hairline edge, as Arc Search draws them. */
@Composable
private fun BarButton(id: String, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, width: Dp = 52.dp, onLongClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val colors = Theme.colors
    Box(
        modifier = modifier
            .testTag(id)
            .let { if (onLongClick == null) it.pressFeedback(onClick = onClick) else it.combinedClickable(onLongClick = onLongClick, onClick = onClick) }
            // The label says what the button does; the icon or text inside it isn't read again.
            .clearAndSetSemantics { contentDescription = label; role = Role.Button }
            .size(width, 52.dp)
            .clip(CircleShape)
            .background(colors.flatSurface, CircleShape)
            .border(1.dp, colors.hairline, CircleShape),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** The floating bar: archive, search and settings over the start page; tabs, the site and more over a page. */
@Composable
fun BrowserBar(browser: BrowserModel, strings: Strings, onSettings: () -> Unit, modifier: Modifier = Modifier, onChecks: () -> Unit = {}) {
    val app = browser.app
    val view = androidx.compose.ui.platform.LocalView.current
    var swipe by remember { mutableFloatStateOf(0f) }
    // Dragging the bar sideways goes to the tab before (right) or after (left), as Arc Search's bar does.
    val swipeable = browser.hasPage && browser.overlay == Overlay.NONE
    var up by remember { mutableFloatStateOf(0f) }
    val dragged = if (!swipeable) modifier else modifier.pointerInput(app.activeTabId, app.tabs.size) {
        detectDragGestures(
            onDragStart = { up = 0f },
            onDragEnd = {
                val distance = swipe
                swipe = 0f
                // Up opens the tab switcher; sideways goes to the next tab.
                if (up > 110.dp.toPx() && up > kotlin.math.abs(distance)) {
                    Haptics.press(view)
                    app.dispatch(bay.core.Action.TipSeen(bay.core.TipId.BAR))
                    browser.showTabs()
                } else if (kotlin.math.abs(distance) > 24.dp.toPx()) {
                    Haptics.press(view)
                    browser.swipeTabs(if (distance < 0) 1 else -1)
                }
                up = 0f
            },
            onDragCancel = {
                swipe = 0f
                up = 0f
            },
            onDrag = { _, amount ->
                up -= amount.y
                if (up > kotlin.math.abs(swipe) * 2) return@detectDragGestures
                val index = app.tabs.indexOfFirst { it.id == app.activeTabId }
                val open = app.tabs.getOrNull(index + if (swipe + amount.x < 0) 1 else -1) != null
                swipe += amount.x * if (open) 0.4f else 0.12f
            },
        )
    }
    val slide = remember { SpaceSlide() }
    CompositionLocalProvider(LocalCapsuleShift provides swipe) { BarRow(browser, strings, onSettings, dragged, onChecks, slide) }
}

/** Holding Tabs: whether the row of spaces is up, what's under the finger, and where things are. */
private class SpaceSlide {
    var sliding by mutableStateOf(false)
    var target by mutableStateOf<SlideTarget?>(null)
    /** The row's place in the window, and the Tabs button's, to turn the finger's drag into a place in the row. */
    var row = androidx.compose.ui.geometry.Rect.Zero
    var button = Offset.Zero
    var moved = 0f
}

/** What a held Tabs button's finger is over in the row of spaces. */
private sealed interface SlideTarget {
    data class Space(val index: Int) : SlideTarget
    data object Add : SlideTarget
}

private val SLIDE_CELL = 52.dp

/** An opaque surface with the bar buttons' edge, so the page never shows through the spaces. */
@Composable
private fun Modifier.slideSurface(shape: androidx.compose.ui.graphics.Shape): Modifier {
    val colors = Theme.colors
    return shadow(12.dp, shape, clip = false).clip(shape).background(colors.background, shape).border(1.dp, colors.hairline, shape)
}

/**
 * The column of spaces above a held Tabs button: each space's glyph in a cell of its own, the nearest space at the
 * bottom, the one under the finger larger with its name over the column, the space showing on a soft circle, and a
 * new space on top.
 */
@Composable
private fun SpaceSlideColumn(browser: BrowserModel, strings: Strings, slide: SpaceSlide, modifier: Modifier) {
    val spaces = browser.app.spaces
    val targetName = when (val target = slide.target) {
        is SlideTarget.Space -> spaces.getOrNull(target.index)?.let { spaceName(it, strings) }
        SlideTarget.Add -> strings.t("tabsMenu.newSpace")
        null -> null
    }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs)) {
    // What's under the finger, named over the column: outside its rounded surface, which would cut it off.
    if (targetName != null) {
        BayText(
            targetName, Modifier.slideSurface(CircleShape).padding(horizontal = Space.sm, vertical = 2.dp),
            variant = TextVariant.FOOTNOTE, weight = androidx.compose.ui.text.font.FontWeight.SemiBold, maxLines = 1,
        )
    }
    Column(
        Modifier.width(SLIDE_CELL).slideSurface(RoundedCornerShape(SLIDE_CELL / 2)).padding(vertical = Space.sm)
            .onGloballyPositioned { slide.row = it.boundsInWindow() }
            .clearAndSetSemantics {}.testTag("space-slide-row"),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(SLIDE_CELL), contentAlignment = Alignment.Center) {
            val adding = slide.target == SlideTarget.Add
            if (adding) Box(Modifier.size(44.dp).background(Theme.colors.fill, CircleShape))
            BayIconView(BayIcon.ADD, size = if (adding) IconSize.control else IconSize.row, color = if (adding) Theme.colors.foreground else Theme.colors.muted)
        }
        spaces.withIndex().reversed().forEach { (index, space) ->
            val hovered = slide.target == SlideTarget.Space(index)
            val name = spaceName(space, strings)
            Box(Modifier.size(SLIDE_CELL), contentAlignment = Alignment.Center) {
                // The space showing sits on a soft circle; the one under the finger on a wash of its own colour.
                if (hovered) Box(Modifier.size(44.dp).background(spaceColor(space.color).copy(alpha = 0.22f), CircleShape))
                else if (space.id == browser.app.activeSpaceId) Box(Modifier.size(40.dp).background(Theme.colors.fill, CircleShape))
                SpaceGlyph(space, name, if (hovered) 30.dp else 24.dp)
            }
        }
    }
    }
}

/** The cell under a point in the window, counting up from the column's bottom; nothing far to either side of it. */
private fun SpaceSlide.targetAt(point: Offset, count: Int, cell: Float, inset: Float): SlideTarget? {
    if (row.height <= 0f || point.x < row.left - cell || point.x > row.right + cell * 2) return null
    val index = kotlin.math.floor((row.bottom - inset - point.y) / cell).toInt()
    return when {
        index == count -> SlideTarget.Add
        index in 0 until count -> SlideTarget.Space(index)
        else -> null
    }
}

/** How far the capsule follows a sideways drag on the bar. */
private val LocalCapsuleShift = androidx.compose.runtime.compositionLocalOf { 0f }

@Composable
private fun BarRow(browser: BrowserModel, strings: Strings, onSettings: () -> Unit, modifier: Modifier, onChecks: () -> Unit, slide: SpaceSlide) {
    val app = browser.app
    val view = androidx.compose.ui.platform.LocalView.current
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(Space.md, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        if (browser.overlay == Overlay.TABS) {
            BarButton("bar-archive", strings.t("bar.archive"), { browser.panel = Panel.ARCHIVE }) { BayIconView(BayIcon.ARCHIVE, size = IconSize.control) }
            SpacesCapsule(browser, strings)
            BarButton("bar-search", strings.t("bar.newTab"), { browser.search(inNewTab = true) }) { BayIconView(BayIcon.ADD, size = IconSize.control) }
        } else if (browser.hasPage) {
            TabsButton(browser, strings, slide)
            Capsule(browser, strings)
            Box(contentAlignment = Alignment.Center) {
                BarButton("bar-more", strings.t("bar.more"), {
                    app.dispatch(bay.core.Action.TipSeen(bay.core.TipId.BLOCKING))
                    browser.panel = Panel.PAGE
                }) { BayIconView(BayIcon.MORE, size = IconSize.control) }
                // The ring round the button the blocking tip means.
                if (browser.tip == bay.core.TipId.BLOCKING) Box(Modifier.size(60.dp).border(2.5.dp, Theme.colors.accent, CircleShape).clearAndSetSemantics {})
            }
        } else {
            BarButton("bar-archive", strings.t("bar.archive"), { browser.panel = Panel.ARCHIVE }) { BayIconView(BayIcon.ARCHIVE, size = IconSize.control) }
            Capsule(browser, strings)
            BarButton("bar-settings", strings.t("bar.settings"), onSettings, onLongClick = onChecks) { BayIconView(BayIcon.SETTINGS, size = IconSize.control) }
        }
    }
}

/**
 * Tabs, with the open tabs' count. Holding it brings the column of spaces, the one showing on a soft grey circle: slide
 * to one and lift to switch, or to + for a new one. Lifting without sliding puts it away. TalkBack, which can't hold and
 * slide, gets each other space and a new one as actions.
 */
@Composable
private fun TabsButton(browser: BrowserModel, strings: Strings, slide: SpaceSlide) {
    val app = browser.app
    val view = androidx.compose.ui.platform.LocalView.current
    val density = LocalDensity.current
    val count = app.tabs.size
    val spaced = app.spaces.size > 1
    val space = browser.activeSpace
    val tabsLabel = if (count > 1) strings.t("bar.tabsOpen", mapOf("count" to "$count")) else strings.t("bar.tabs")
    val label = if (spaced && space != null) strings.t("bar.inSpace", mapOf("label" to tabsLabel, "space" to spaceName(space, strings))) else tabsLabel
    // When a hold last let go, so the click its lift also makes doesn't open the tab view.
    var holdEnded by remember { mutableStateOf(0L) }
    val cell = with(density) { SLIDE_CELL.toPx() }
    val inset = with(density) { Space.sm.toPx() }
    val hold = Modifier.pointerInput(app.spaces.size) {
        detectDragGesturesAfterLongPress(
            onDragStart = {
                slide.moved = 0f
                slide.sliding = true
                Haptics.tick(view)
            },
            onDrag = { change, amount ->
                slide.moved += amount.getDistance()
                val next = if (slide.moved > 12.dp.toPx()) slide.targetAt(slide.button + change.position, app.spaces.size, cell, inset) else null
                if (next != slide.target) {
                    slide.target = next
                    if (next != null) Haptics.tick(view)
                }
            },
            onDragEnd = {
                // The row goes first: switching space can take this button away before the gesture ends.
                val target = slide.target
                slide.sliding = false
                slide.target = null
                holdEnded = android.os.SystemClock.uptimeMillis()
                when (target) {
                    is SlideTarget.Space -> browser.switchSpace(app.spaces[target.index].id)
                    SlideTarget.Add -> browser.newSpace()
                    null -> Unit
                }
            },
            onDragCancel = {
                slide.sliding = false
                slide.target = null
                holdEnded = android.os.SystemClock.uptimeMillis()
            },
        )
    }
    // A gesture cut short by the button leaving (the bar changing under it) never ends; the row goes with the button.
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose {
            slide.sliding = false
            slide.target = null
        }
    }
    Box(
        Modifier.onGloballyPositioned { slide.button = it.positionInWindow() }.then(hold)
            .semantics {
                customActions = app.spaces.filter { it.id != app.activeSpaceId }.map { other ->
                    androidx.compose.ui.semantics.CustomAccessibilityAction(strings.t("tabs.switchSpace", mapOf("name" to spaceName(other, strings)))) {
                        browser.switchSpace(other.id)
                        true
                    }
                } + androidx.compose.ui.semantics.CustomAccessibilityAction(strings.t("tabsMenu.newSpace")) {
                    browser.newSpace()
                    true
                }
            },
    ) {
        BarButton(
            "bar-tabs", label,
            {
                // A hold's lift comes as a click too.
                if (!slide.sliding && android.os.SystemClock.uptimeMillis() - holdEnded > 400) browser.showTabs()
            },
        ) { BayIconView(BayIcon.TABS, size = IconSize.control) }
        TabCount(count, Modifier.align(Alignment.TopEnd))
        // The spaces stand in a column above the button while it's held, the nearest first. It's placed without taking
        // room in the bar.
        if (slide.sliding) {
            SpaceSlideColumn(
                browser, strings, slide,
                Modifier.align(Alignment.BottomCenter).layout { measurable, _ ->
                    val column = measurable.measure(androidx.compose.ui.unit.Constraints())
                    layout(0, 0) { column.place(-column.width / 2, -column.height - (52.dp + Space.md).roundToPx()) }
                },
            )
        }
    }
}

@Composable
private fun Capsule(browser: BrowserModel, strings: Strings) {
    val url = browser.activeTab?.url.orEmpty()
    val site = if (browser.hasPage) hostOf(url).removePrefix("www.") else ""
    val insecure = url.startsWith("http:")
    val label = if (site.isEmpty()) strings.t("bar.search") else strings.t(if (insecure) "bar.searchOrEnterInsecure" else "bar.searchOrEnter", mapOf("site" to site))
    val shift = LocalCapsuleShift.current
    Box(Modifier.graphicsLayer { translationX = shift; alpha = 1f - minOf(kotlin.math.abs(shift) / 110.dp.toPx(), 0.6f) }) {
        // Just the magnifying glass: the page's address is at the top of the page menu. A page that isn't sent encrypted
        // says so with a mark beside it.
        BarButton("bar-search", label, { browser.search(inNewTab = false) }, width = 128.dp) {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.xs), verticalAlignment = Alignment.CenterVertically) {
                if (insecure && site.isNotEmpty()) BayIconView(BayIcon.ERROR, size = 16.dp, color = Theme.colors.danger)
                BayIconView(BayIcon.SEARCH, size = IconSize.control)
            }
        }
        // Drawn over the pill and sized by it, so loading never widens the pill.
        LoadProgress(if (browser.hasPage) browser.activeNavigation else NavigationState.EMPTY, Modifier.matchParentSize())
    }
}

/** The tab view's spaces between archive and new tab: each space's emoji or a dot in its colour, the one showing larger. */
@Composable
private fun SpacesCapsule(browser: BrowserModel, strings: Strings) {
    val app = browser.app
    val view = androidx.compose.ui.platform.LocalView.current
    val colors = Theme.colors
    // Hold the spaces, then slide: the space under the finger shows, with a tick as each one comes and its name above.
    var scrubLabel by remember { mutableStateOf<String?>(null) }
    var scrubbed by remember { mutableStateOf(-1) }
    Box {
    scrubLabel?.let { label ->
        BayText(
            label,
            Modifier.align(Alignment.TopCenter).offset(y = (-44).dp).baySurface(RoundedCornerShape(Radius.control))
                .padding(horizontal = Space.md, vertical = Space.xs).testTag("bar-space-scrub-label"),
            variant = TextVariant.FOOTNOTE,
            weight = FontWeight.SemiBold,
            maxLines = 1,
        )
    }
    Row(
        Modifier.height(52.dp).clip(CircleShape).background(colors.flatSurface, CircleShape).border(1.dp, colors.hairline, CircleShape)
            .padding(horizontal = Space.sm).testTag("bar-spaces"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.widthIn(max = SPACE_TARGET * 5).horizontalScroll(rememberScrollState()).pointerInput(app.spaces.size) {
                fun reach(x: Float) {
                    val index = (x / size.width * app.spaces.size).toInt().coerceIn(0, app.spaces.size - 1)
                    if (index == scrubbed) return
                    scrubbed = index
                    Haptics.press(view)
                    scrubLabel = spaceName(app.spaces[index], strings)
                    browser.selectSpace(app.spaces[index].id)
                }
                detectDragGesturesAfterLongPress(
                    onDragStart = { if (app.spaces.size > 1) reach(it.x) },
                    onDrag = { change, _ -> if (app.spaces.size > 1) reach(change.position.x) },
                    onDragEnd = { scrubbed = -1; scrubLabel = null },
                    onDragCancel = { scrubbed = -1; scrubLabel = null },
                )
            },
        ) {
            app.spaces.forEach { space ->
                val active = space.id == app.activeSpaceId
                // A tab card dragged over it lights it in its colour: let go, and the tab moves here.
                val dropping = browser.cardDropSpace == space.id
                val grow by androidx.compose.animation.core.animateFloatAsState(if (dropping) 1.25f else 1f, label = "drop")
                Box(
                    Modifier.size(SPACE_TARGET).testTag("bar-space-${space.id}")
                        .onGloballyPositioned { browser.spaceDropFrames[space.id] = it.boundsInWindow() }
                        .graphicsLayer { scaleX = grow; scaleY = grow }
                        .background(if (dropping) spaceColor(space.color).copy(alpha = 0.35f) else Color.Transparent, CircleShape)
                        .pressFeedback {
                            Haptics.press(view)
                            browser.selectSpace(space.id)
                        }
                        .clearAndSetSemantics { contentDescription = strings.t("tabs.switchSpace", mapOf("name" to spaceName(space, strings))); role = Role.Button; selected = active },
                    contentAlignment = Alignment.Center,
                ) {
                    val icon = space.icon
                    if (icon != null) {
                        BayText(icon, Modifier.alpha(if (active) 1f else 0.55f), variant = if (active) TextVariant.TITLE else TextVariant.CALLOUT)
                    } else {
                        Box(Modifier.size(if (active) 16.dp else 9.dp).background(spaceColor(space.color), if (active) RoundedCornerShape(4.dp) else CircleShape))
                    }
                }
            }
        }
        Box(
            Modifier.size(SPACE_TARGET).testTag("bar-new-space")
                .pressFeedback { browser.newSpace() }
                .clearAndSetSemantics { contentDescription = strings.t("tabsMenu.newSpace"); role = Role.Button },
            contentAlignment = Alignment.Center,
        ) { BayIconView(BayIcon.ADD, size = IconSize.small, color = colors.muted) }
    }
    }
}

/** Each space's button in the capsule, and the new-space button: Android's smallest touch target. */
private val SPACE_TARGET = 48.dp

/** The number of open tabs on the corner of the Tabs button. The button's label says it, so TalkBack skips it. */
@Composable
fun TabCount(count: Int, modifier: Modifier = Modifier) {
    if (count < 2) return
    val colors = Theme.colors
    Box(
        modifier.offset(4.dp, (-4).dp).sizeIn(minWidth = 20.dp, minHeight = 20.dp).background(colors.foreground, CircleShape).padding(horizontal = 4.dp)
            .testTag("tab-count").clearAndSetSemantics {},
        contentAlignment = Alignment.Center,
    ) {
        BayText(if (count > 99) "99+" else "$count", variant = TextVariant.MICRO, weight = FontWeight.Bold, color = colors.background)
    }
}

/** The thin line along the capsule's edge: it fills as the page loads and fades once the page is there. */
@Composable
fun LoadProgress(state: NavigationState, modifier: Modifier = Modifier) {
    val filled by animateFloatAsState(maxOf(state.progress.toFloat(), 0.04f), tween(240), label = "progress")
    val shown by animateFloatAsState(if (state.isLoading) 1f else 0f, tween(if (state.isLoading) 120 else 220), label = "shown")
    if (shown == 0f) return
    Box(modifier.alpha(shown).testTag("page-progress").clearAndSetSemantics {}) {
        Box(Modifier.align(Alignment.BottomStart).padding(start = 24.dp, end = 24.dp, bottom = 2.dp).fillMaxWidth().height(2.dp)) {
            Box(Modifier.fillMaxWidth(filled).height(2.dp).background(Theme.colors.accent, RoundedCornerShape(1.dp)))
        }
    }
}

/** A page that failed to load, in plain words, and a way to try again. */
@Composable
fun PageError(message: String, strings: Strings, retry: () -> Unit, modifier: Modifier = Modifier) {
    val id = pageErrorId(message)
    val key = when (id) {
        PageErrorId.OFFLINE -> "offline"
        PageErrorId.NOT_FOUND -> "notFound"
        PageErrorId.TIMEOUT -> "timeout"
        PageErrorId.REFUSED -> "refused"
        PageErrorId.CERTIFICATE -> "certificate"
        PageErrorId.UNKNOWN -> "unknown"
    }
    Column(
        modifier.fillMaxSize().background(Theme.colors.background).padding(Space.xl).testTag("page-error"),
        verticalArrangement = Arrangement.spacedBy(Space.md, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BayIconView(if (describePageError(message).kind == PageErrorKind.OFFLINE) BayIcon.OFFLINE else BayIcon.ERROR, size = 40.dp, color = Theme.colors.muted)
        BayText(strings.t("pageError.$key.title"), variant = TextVariant.HEADLINE, textAlign = TextAlign.Center)
        BayText(if (id == PageErrorId.UNKNOWN) message else strings.t("pageError.$key.detail"), variant = TextVariant.CALLOUT, tone = TextTone.MUTED, textAlign = TextAlign.Center)
        PillButton(strings.t("pageError.tryAgain"), Modifier.testTag("page-error-retry"), onClick = retry)
    }
}
