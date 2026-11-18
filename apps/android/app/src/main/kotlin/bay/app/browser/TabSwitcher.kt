package bay.app.browser

import android.graphics.BitmapFactory
import android.net.Uri
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
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
import bay.core.displayUrl
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
import bay.design.pressFeedback
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

/** A space's mark: its emoji, or its first letter on its colour in a rounded square. */
@Composable
fun SpaceGlyph(space: BrowserSpace, name: String, size: Dp) {
    val icon = space.icon
    if (icon != null) {
        Box(Modifier.size(size).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
            BayText(icon, variant = TextVariant.TITLE)
        }
    } else {
        Box(
            Modifier.size(size).background(spaceColor(space.color), RoundedCornerShape(size * 0.3f)).clearAndSetSemantics {},
            contentAlignment = Alignment.Center,
        ) {
            BayText(name.trim().take(1).uppercase().ifEmpty { "•" }, variant = TextVariant.HEADLINE, weight = FontWeight.Bold, color = Color.White)
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
    var shift by remember { mutableFloatStateOf(0f) }
    Box(
        Modifier.fillMaxSize().testTag("tab-switcher").pointerInput(app.spaces.size, app.activeSpaceId) {
            detectHorizontalDragGestures(
                onDragEnd = {
                    val index = app.spaces.indexOfFirst { it.id == app.activeSpaceId }
                    val next = index + if (shift < 0) 1 else -1
                    if (abs(shift) > 80.dp.toPx() * 0.35f && next in app.spaces.indices) {
                        Haptics.tick(view)
                        browser.selectSpace(app.spaces[next].id)
                    }
                    shift = 0f
                },
                onDragCancel = { shift = 0f },
                onHorizontalDrag = { _, amount -> if (app.spaces.size > 1) shift += amount * 0.35f },
            )
        },
    ) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to color.copy(alpha = 0.34f), 0.55f to color.copy(alpha = 0.08f), 1f to Color.Transparent)))
        BoxWithConstraints(Modifier.fillMaxSize().statusBarsPadding().graphicsLayer { translationX = shift }) {
            val inner = maxWidth - Space.gutter * 2
            val cardWidth = (inner - GAP * (COLUMNS - 1)) / COLUMNS
            val essentialWidth = (inner - GAP * (ESSENTIAL_COLUMNS - 1)) / ESSENTIAL_COLUMNS
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.gutter).padding(top = Space.sm, bottom = 52.dp + Space.xxl),
                verticalArrangement = Arrangement.spacedBy(Space.lg),
            ) {
                if (space != null) {
                    val name = spaceName(space, strings)
                    Row(Modifier.heightIn(min = 44.dp), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                        Row(
                            Modifier.weight(1f).testTag("tab-switcher-icon").semantics { contentDescription = strings.t("space.edit.title", mapOf("name" to name)) }.pressFeedback {},
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
                            Box(
                                Modifier.size(essentialWidth, 64.dp)
                                    .testTag("tab-essential-$index")
                                    .clearAndSetSemantics { contentDescription = pin.title.ifEmpty { displayUrl(pin.url) }; role = Role.Button; selected = active }
                                    .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { unpin(browser, pin, view) }) { browser.openPin(pin) }
                                    .background(Theme.colors.fill, RoundedCornerShape(Radius.tile))
                                    .border(2.dp, if (active) Theme.colors.accent else Color.Transparent, RoundedCornerShape(Radius.tile)),
                                contentAlignment = Alignment.Center,
                            ) { SiteIcon(app, pin.url, 30.dp) }
                        }
                    }
                }
                if (rows.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        BayText(strings.t("tabs.pinned"), Modifier.padding(bottom = Space.xs), variant = TextVariant.FOOTNOTE, weight = FontWeight.Medium, tone = TextTone.MUTED)
                        rows.forEach { row ->
                            val active = row.url == activeUrl
                            Row(
                                Modifier.fillMaxWidth().testTag("tab-pinned-${row.id}")
                                    .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { unpin(browser, row, view) }) { browser.openPin(row) }
                                    .background(if (active) Theme.colors.fill else Color.Transparent, RoundedCornerShape(Radius.control))
                                    .heightIn(min = 40.dp).padding(horizontal = Space.sm),
                                horizontalArrangement = Arrangement.spacedBy(Space.md),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                SiteIcon(app, row.url, 20.dp)
                                BayText(row.title.ifEmpty { displayUrl(row.url) }, Modifier.weight(1f), variant = TextVariant.CALLOUT, weight = if (active) FontWeight.SemiBold else null, maxLines = 1)
                            }
                        }
                    }
                }
                if (tabs.isNotEmpty() || (essentials.isEmpty() && rows.isEmpty())) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically) {
                        BayText(
                            if (tabs.size == 1) strings.t("tabs.one") else strings.t("tabs.count", mapOf("count" to "${tabs.size}")),
                            Modifier.testTag("tab-switcher-count"),
                            variant = TextVariant.FOOTNOTE,
                            weight = FontWeight.Medium,
                            tone = TextTone.MUTED,
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
                                tone = TextTone.MUTED,
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

private fun unpin(browser: BrowserModel, site: PinnedSite, view: android.view.View) {
    Haptics.tick(view)
    browser.app.dispatch(bay.core.Action.RemovePin(site.id))
}

/** A tab's card: its picture (or icon, or the wallpaper for a new tab), a close button, and its site below. A flick up closes it into the archive. */
@Composable
private fun TabCard(browser: BrowserModel, strings: Strings, tab: BrowserTab, index: Int, count: Int, width: Dp, active: Boolean) {
    val app = browser.app
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val lift = remember { Animatable(0f) }
    val height = width * CARD_RATIO
    val title = tab.title.ifEmpty { if (tab.url.isEmpty()) strings.t("tabs.newTab") else displayUrl(tab.url) }
    val site = if (tab.url.isEmpty()) title else displayUrl(tab.url).removePrefix("www.").substringBefore('/')
    val shape = RoundedCornerShape(Radius.tile)
    fun close() {
        Haptics.tick(view)
        browser.close(tab.id)
    }
    Column(
        Modifier.width(width)
            .graphicsLayer { translationY = lift.value; alpha = 1f - minOf(1f, -lift.value / 600f) }
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
                    }
                    .pressFeedback { browser.activate(tab.id) }
                    .clip(shape)
                    .background(if (tab.private) Color(0xFF171717) else Theme.colors.surface, shape)
                    .border(if (active) 2.5.dp else 1.dp, if (active) Theme.colors.accent else Theme.colors.hairline, shape),
                contentAlignment = Alignment.Center,
            ) {
                val bitmap = remember(tab.snapshot) { tab.snapshot?.let { Uri.parse(it).path }?.let { runCatching { BitmapFactory.decodeFile(it) }.getOrNull() } }
                when {
                    bitmap != null -> Image(bitmap.asImageBitmap(), null, Modifier.fillMaxSize(), alignment = Alignment.TopCenter, contentScale = ContentScale.Crop)
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
        }
        Row(Modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (tab.url.isNotEmpty()) SiteIcon(app, tab.url, 14.dp)
            BayText(site, Modifier.weight(1f), variant = TextVariant.CAPTION, tone = TextTone.MUTED, maxLines = 1)
        }
    }
}
