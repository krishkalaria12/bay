package bay.app.browser

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.zIndex
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.BrowserSpace
import bay.core.BrowserTab
import bay.core.PinKind
import bay.core.PinnedSite
import bay.core.SpaceColor
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Haptics
import bay.design.IconSize
import bay.design.Motion
import bay.design.Radius
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.overWallpaper
import bay.design.pressFeedback
import bay.design.style
import kotlin.math.abs
import kotlinx.coroutines.launch

/** A space's colour: its glyph, its dot in the bar and the wash at the top of its page. */
fun spaceColor(color: SpaceColor): Color = when (color) {
    SpaceColor.GRAY -> Color(0xFF9CA3AF)
    SpaceColor.BLUE -> Color(0xFF3B82F6)
    SpaceColor.GREEN -> Color(0xFF22C55E)
    SpaceColor.ORANGE -> Color(0xFFF97316)
    SpaceColor.RED -> Color(0xFFEF4444)
    SpaceColor.VIOLET -> Color(0xFF8B5CF6)
}

/** A space's name as the user sees it: the first space shows in the current language while it keeps its first name. */
fun spaceName(space: BrowserSpace, strings: Strings): String =
    if (space.id == "personal" && space.name == "Personal") strings.t("space.personal") else space.name

/**
 * A space's mark: its emoji, or its first letter on its colour in a rounded square. The mark is drawn to the square's
 * size rather than the phone's font size, which would push a large emoji out of it (an ellipsis in its place).
 */
@Composable
fun SpaceGlyph(space: BrowserSpace, name: String, size: Dp) {
    val icon = space.icon
    val density = LocalDensity.current
    if (icon != null) {
        Box(Modifier.size(size).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
            val glyph = with(density) { (size * 0.73f).toSp() }
            BasicText(icon, style = TextVariant.TITLE.style().copy(fontSize = glyph, lineHeight = glyph), maxLines = 1, softWrap = false)
        }
    } else {
        Box(
            Modifier.size(size).background(spaceColor(space.color), RoundedCornerShape(size * 0.3f)).clearAndSetSemantics {},
            contentAlignment = Alignment.Center,
        ) {
            val letter = with(density) { (size * 0.57f).toSp() }
            BasicText(
                name.trim().take(1).uppercase().ifEmpty { "•" },
                style = TextVariant.HEADLINE.style(FontWeight.Bold, Color.White).copy(fontSize = letter, lineHeight = letter),
                maxLines = 1, softWrap = false,
            )
        }
    }
}

private const val COLUMNS = 2
private const val ESSENTIAL_COLUMNS = 3
private val GAP = 10.dp

/** A card is a little taller than wide, like a phone's page shrunk down. */
private const val CARD_RATIO = 1.32f

/**
 * The tab view as a space's page: its name over a wash of its colour, the pinned sites, and its tabs as a grid of
 * cards. A sideways swipe moves to the next space; the bar below switches spaces too.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TabSwitcher(browser: BrowserModel, strings: Strings, onSettings: () -> Unit) {
    val app = browser.app
    val view = LocalView.current
    val space = app.spaces.firstOrNull { it.id == app.activeSpaceId } ?: app.spaces.firstOrNull()
    val color = spaceColor(space?.color ?: SpaceColor.GRAY)
    val tabs = browser.switcherTabs
    val essentials = app.pins.filter { it.kind == PinKind.ESSENTIAL }
    val rows = app.pins.filter { it.kind == PinKind.ROW }
    val activeUrl = browser.activeTab?.url
    // A folder name being typed in the Pinned section.
    var naming by remember { mutableStateOf<FolderNaming?>(null) }
    // How far the space has been pulled sideways, following the finger; the next space comes in from that side.
    val shift = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var width by remember { mutableFloatStateOf(1f) }
    val index = app.spaces.indexOfFirst { it.id == app.activeSpaceId }
    val incoming = when {
        shift.value < 0 -> app.spaces.getOrNull(index + 1)
        shift.value > 0 -> app.spaces.getOrNull(index - 1)
        else -> null
    }
    val progress = (abs(shift.value) / width).coerceIn(0f, 1f)
    val wash = if (incoming != null) androidx.compose.ui.graphics.lerp(color, spaceColor(incoming.color), progress) else color
    Box(
        Modifier.fillMaxSize().testTag("tab-switcher").onSizeChanged { width = it.width.toFloat().coerceAtLeast(1f) }
            .pointerInput(app.spaces.size, app.activeSpaceId) {
            detectHorizontalDragGestures(
                onDragEnd = {
                    val at = app.spaces.indexOfFirst { it.id == app.activeSpaceId }
                    val step = if (shift.value < 0) 1 else -1
                    val next = app.spaces.getOrNull(at + step)
                    scope.launch {
                        if (next != null && abs(shift.value) > width * 0.25f) {
                            Haptics.tick(view)
                            // Out the rest of the way, then the new space slides in from the side it came from.
                            shift.animateTo(-step * width, tween(160))
                            browser.selectSpace(next.id)
                            shift.snapTo(step * width * 0.35f)
                            shift.animateTo(0f, spring(dampingRatio = 0.85f, stiffness = 500f))
                        } else {
                            shift.animateTo(0f, spring(dampingRatio = 0.7f, stiffness = 600f))
                        }
                    }
                },
                onDragCancel = { scope.launch { shift.animateTo(0f) } },
                onHorizontalDrag = { change, amount ->
                    change.consume()
                    val target = shift.value + amount
                    val ahead = if (target < 0) app.spaces.getOrNull(index + 1) else app.spaces.getOrNull(index - 1)
                    // A stretch at the first and last space: it gives a little and comes back.
                    scope.launch { shift.snapTo(if (ahead != null) target else shift.value + amount * 0.3f) }
                },
            )
        },
    ) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to wash.copy(alpha = 0.34f), 0.55f to wash.copy(alpha = 0.08f), 1f to Color.Transparent)))
        // The space coming in: its name at the top, a page's width beyond the edge it's pulled from.
        if (incoming != null) {
            val name = spaceName(incoming, strings)
            Row(
                Modifier.statusBarsPadding().padding(horizontal = Space.gutter).padding(top = Space.sm).heightIn(min = 44.dp)
                    .graphicsLayer { translationX = shift.value + if (shift.value < 0) width else -width }
                    .clearAndSetSemantics {},
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SpaceGlyph(incoming, name, 30.dp)
                BayText(name, variant = TextVariant.TITLE, maxLines = 1)
            }
        }
        BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding().graphicsLayer { translationX = shift.value }) {
            val inner = maxWidth - Space.gutter * 2
            // Half a point narrower than an exact fit, so rounding never wraps the last card onto a row of its own.
            val cardWidth = (inner - GAP * (COLUMNS - 1)) / COLUMNS - 0.5.dp
            val essentialWidth = (inner - GAP * (ESSENTIAL_COLUMNS - 1)) / ESSENTIAL_COLUMNS - 0.5.dp
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.gutter).padding(top = Space.sm, bottom = 52.dp + Space.xxl),
                verticalArrangement = Arrangement.spacedBy(Space.lg),
            ) {
                if (space != null) {
                    val name = spaceName(space, strings)
                    Row(Modifier.heightIn(min = 44.dp), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                        Row(
                            Modifier.weight(1f).testTag("tab-switcher-icon").semantics { contentDescription = strings.t("space.edit.title", mapOf("name" to name)) }.pressFeedback { browser.panel = Panel.SPACE_EDIT },
                            horizontalArrangement = Arrangement.spacedBy(Space.sm),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            SpaceGlyph(space, name, 30.dp)
                            BayText(name, Modifier.testTag("tab-switcher-space").semantics { heading() }, variant = TextVariant.TITLE, maxLines = 1)
                        }
                        Box(
                            Modifier.size(40.dp).testTag("tab-switcher-settings").pressFeedback(onClick = onSettings)
                                .clearAndSetSemantics { contentDescription = strings.t("bar.settings"); role = Role.Button }
                                .background(Theme.colors.fill, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) { BayIconView(BayIcon.SETTINGS, size = IconSize.small, color = Theme.colors.muted) }
                    }
                }
                if (essentials.isNotEmpty()) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(GAP), verticalArrangement = Arrangement.spacedBy(GAP), maxItemsInEachRow = ESSENTIAL_COLUMNS) {
                        essentials.forEachIndexed { index, pin ->
                            val active = pin.url == activeUrl
                            var menu by remember(pin.id) { mutableStateOf(false) }
                            Box(
                                Modifier.size(essentialWidth, 64.dp)
                                    .testTag("tab-essential-$index")
                                    .clearAndSetSemantics {
                                        contentDescription = pin.title.ifEmpty { displayUrl(pin.url) }
                                        role = Role.Button
                                        selected = active
                                        customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction(strings.t("pin.unpin")) { browser.unpin(pin); true })
                                    }
                                    .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = {
                                        Haptics.tick(view)
                                        menu = true
                                    }) { browser.openPin(pin) }
                                    .background(Theme.colors.fill, RoundedCornerShape(Radius.tile))
                                    .border(2.dp, if (active) Theme.colors.accent else Color.Transparent, RoundedCornerShape(Radius.tile)),
                                contentAlignment = Alignment.Center,
                            ) {
                                SiteIcon(app, pin.url, 30.dp)
                                if (menu) {
                                    HoldMenu(onDismiss = { menu = false }) {
                                        MenuChoice(strings.t("pin.makeRow")) { menu = false; browser.movePin(pin, PinKind.ROW, null) }
                                        MenuChoice(strings.t("pin.unpin"), destructive = true) { menu = false; browser.unpin(pin) }
                                    }
                                }
                            }
                        }
                    }
                }
                if (rows.isNotEmpty() || app.folders.isNotEmpty() || naming != null) {
                    PinnedSection(browser, strings, rows, activeUrl, naming) { naming = it }
                }
                if (tabs.isNotEmpty() || (essentials.isEmpty() && rows.isEmpty())) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
                        BayText(
                            if (tabs.size == 1) strings.t("tabs.one") else strings.t("tabs.count", mapOf("count" to "${tabs.size}")),
                            Modifier.testTag("tab-switcher-count"),
                            variant = TextVariant.FOOTNOTE,
                            weight = FontWeight.Medium,
                            color = Theme.colors.overWallpaper,
                        )
                        Box(Modifier.weight(1f).height(1.dp).background(Theme.colors.foreground.copy(alpha = 0.1f)))
                        if (tabs.size > 1) {
                            BayText(
                                strings.t("tabs.clear"),
                                Modifier.testTag("tab-switcher-archive-all")
                                    .clearAndSetSemantics { contentDescription = strings.t("tabs.archiveAllCount", mapOf("count" to "${tabs.size}")); role = Role.Button }
                                    .pressFeedback {
                                        Haptics.tick(view)
                                        browser.archiveAll()
                                    },
                                variant = TextVariant.FOOTNOTE,
                                weight = FontWeight.Medium,
                                color = Theme.colors.overWallpaper,
                            )
                        }
                    }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(GAP), verticalArrangement = Arrangement.spacedBy(Space.lg), maxItemsInEachRow = COLUMNS) {
                    tabs.forEachIndexed { index, tab ->
                        TabCard(browser, strings, tab, index, tabs.size, cardWidth, tab.id == app.activeTabId)
                    }
                }
            }
        }
    }
}

/** A tab's card: its picture (or icon, or the wallpaper for a new tab), a close button, and its site below. A flick up closes it into the archive. */
@Composable
private fun TabCard(browser: BrowserModel, strings: Strings, tab: BrowserTab, index: Int, count: Int, width: Dp, active: Boolean) {
    val app = browser.app
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val lift = remember { Animatable(0f) }
    // Where the card sits on screen, so the page can grow out of it.
    var frame by remember { mutableStateOf(Rect.Zero) }
    // Held and moved: the card follows the finger, to a space in the bar below.
    var carried by remember { mutableStateOf<androidx.compose.ui.geometry.Offset?>(null) }
    var origin by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    val dropping = carried != null && browser.cardDropSpace != null
    val shrink by androidx.compose.animation.core.animateFloatAsState(if (carried == null) 1f else if (dropping) 0.6f else 0.9f, label = "carry")
    val height = width * CARD_RATIO
    val title = tab.title.ifEmpty { if (tab.url.isEmpty()) strings.t("tabs.newTab") else displayUrl(tab.url) }
    val site = if (tab.url.isEmpty()) title else displayUrl(tab.url).removePrefix("www.").substringBefore('/')
    val shape = RoundedCornerShape(Radius.tile)
    fun close() {
        Haptics.tick(view)
        browser.archive(tab.id)
    }
    Column(
        Modifier.width(width).zIndex(if (carried != null) 1f else 0f)
            .graphicsLayer {
                translationX = carried?.x ?: 0f
                translationY = carried?.y ?: lift.value
                scaleX = shrink
                scaleY = shrink
                alpha = 1f - minOf(1f, -lift.value / 600f)
            }
            .pointerInput(tab.id) {
                detectVerticalDragGestures(
                    onDragEnd = {
                        // Thrown away when dragged far enough up.
                        if (lift.value < -120.dp.toPx()) close() else scope.launch { lift.animateTo(0f, Motion.settle.spec()) }
                    },
                    onDragCancel = { scope.launch { lift.animateTo(0f) } },
                    onVerticalDrag = { _, amount -> scope.launch { lift.snapTo(minOf(0f, lift.value + amount)) } },
                )
            },
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Box {
            Box(
                Modifier.size(width, height)
                    .testTag("tab-card-$index")
                    .clearAndSetSemantics {
                        contentDescription = strings.t("tabs.openLabel", mapOf("title" to title))
                        stateDescription = strings.t(if (tab.private) "tabs.privatePosition" else "tabs.position", mapOf("index" to "${index + 1}", "count" to "$count"))
                        role = Role.Button
                        selected = active
                        onClick { browser.pick(tab, frame); true }
                        // TalkBack can't carry a card to a space, so each card offers the other spaces.
                        customActions = app.spaces.filter { it.id != tab.spaceId }.map { space ->
                            androidx.compose.ui.semantics.CustomAccessibilityAction(strings.t("tabs.moveToSpace", mapOf("name" to spaceName(space, strings)))) {
                                browser.moveTab(tab, space.id)
                                true
                            }
                        }
                    }
                    .onGloballyPositioned {
                        frame = it.boundsInRoot()
                        if (carried == null) origin = it.positionInWindow()
                    }
                    // A tap opens the tab. Held and let go where it was, the card's sheet opens (pinning it, its space);
                    // held and moved, it follows the finger, and let go over a space in the bar below, the tab moves there.
                    .pointerInput(tab.id) {
                        awaitEachGesture {
                            val down = awaitFirstDown()
                            var cancelled = false
                            val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                                waitForUpOrCancellation().also { if (it == null) cancelled = true }
                            }
                            when {
                                up != null -> {
                                    up.consume()
                                    browser.pick(tab, frame)
                                }
                                cancelled -> {}
                                else -> {
                                    Haptics.tick(view)
                                    val start = origin + down.position
                                    var moved = androidx.compose.ui.geometry.Offset.Zero
                                    drag(down.id) { change ->
                                        moved += change.positionChange()
                                        change.consume()
                                        if (carried != null || moved.getDistance() > 10.dp.toPx()) {
                                            carried = moved
                                            if (browser.cardDragged(start + moved)) Haptics.press(view)
                                        }
                                    }
                                    val target = browser.cardDropSpace
                                    browser.cardDragged(null)
                                    when {
                                        carried == null -> browser.showPinMenu(tab)
                                        target != null -> {
                                            carried = null
                                            browser.moveTab(tab, target)
                                        }
                                        else -> carried = null
                                    }
                                }
                            }
                        }
                    }
                    .clip(shape)
                    .background(if (tab.private) Color(0xFF171717) else Theme.colors.surface, shape)
                    .border(if (active) 2.5.dp else 1.dp, if (active) Theme.colors.accent else Theme.colors.hairline, shape),
                contentAlignment = Alignment.Center,
            ) {
                val bitmap = rememberFileImage(tab.snapshot, with(LocalDensity.current) { width.roundToPx() })
                when {
                    bitmap != null -> Image(bitmap, null, Modifier.fillMaxSize(), alignment = Alignment.TopCenter, contentScale = ContentScale.Crop)
                    // The picture is on its way: the card's own surface until it lands.
                    tab.snapshot != null -> Unit
                    tab.url.isNotEmpty() -> SiteIcon(app, tab.url, 32.dp)
                    else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
                        // A new tab shows the start page, so its card shows the wallpaper.
                        if (!tab.private) Wallpaper(app.preferences.wallpaper)
                        BayIconView(BayIcon.ADD, Modifier.padding(bottom = Space.md), size = IconSize.small, color = Theme.colors.muted)
                    }
                }
            }
            Box(
                Modifier.align(Alignment.TopEnd).padding(6.dp).size(22.dp)
                    .testTag("tab-close-$index")
                    .clearAndSetSemantics { contentDescription = strings.t("tabs.closeLabel", mapOf("title" to title)); role = Role.Button }
                    .pressFeedback(onClick = ::close)
                    .background(Color.Black.copy(alpha = 0.45f), CircleShape),
                contentAlignment = Alignment.Center,
            ) { BayIconView(BayIcon.CLOSE, size = 12.dp, color = Color.White) }
            // The card says it's private already; the badge shows it.
            if (tab.private) {
                Box(
                    Modifier.align(Alignment.TopStart).padding(6.dp).size(22.dp).testTag("tab-private-$index").clearAndSetSemantics {}
                        .background(Color(0xFF171717), CircleShape),
                    contentAlignment = Alignment.Center,
                ) { BayIconView(BayIcon.PRIVATE, size = 12.dp, color = Color(0xFFF4F4F5)) }
            }
        }
        Row(Modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (tab.url.isNotEmpty()) SiteIcon(app, tab.url, 14.dp)
            BayText(site, Modifier.weight(1f), variant = TextVariant.CAPTION, tone = TextTone.MUTED, maxLines = 1)
        }
    }
}
