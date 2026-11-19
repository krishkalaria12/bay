package bay.app.browser

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import bay.app.AppModel
import bay.app.Strings
import bay.core.HistoryEntry
import bay.core.PinKind
import bay.core.PinnedSite
import bay.design.BayText
import bay.design.Radius
import bay.design.Row as RowToken
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.baySurface
import bay.design.overWallpaper
import bay.design.pressFeedback
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import kotlinx.coroutines.delay

private const val PINS = 8
private const val COLUMNS = 4
private val PIN_TILE = 64.dp
private val PIN_ICON = 32.dp
private const val RECENT = 3
private val RECENT_ICON = 28.dp

/** Below this height the greeting gives its room to a full grid of pins and the recent pages. */
private const val ROOM_FOR_GREETING = 700

/** A greeting, the pinned sites and the last few pages, over the wallpaper above "Tap to search". */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun StartPage(app: AppModel, strings: Strings, onOpen: (String) -> Unit, onUnpin: (PinnedSite) -> Unit, modifier: Modifier = Modifier) {
    val essentials = app.pins.filter { it.kind == PinKind.ESSENTIAL }.take(PINS)
    val seen = essentials.mapTo(HashSet()) { siteName(it.url) }
    val recent = mutableListOf<HistoryEntry>()
    for (entry in app.recentHistory) {
        if (recent.size == RECENT) break
        if (seen.add(siteName(entry.url))) recent += entry
    }
    val greet = LocalConfiguration.current.screenHeightDp >= ROOM_FOR_GREETING || essentials.size <= COLUMNS || recent.isEmpty()
    Column(modifier.fillMaxWidth().padding(horizontal = Space.gutter).testTag("start-page"), verticalArrangement = Arrangement.spacedBy(Space.section)) {
        if (greet) Greeting(strings)
        if (essentials.isNotEmpty()) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val columnGap = maxOf((maxWidth - PIN_TILE * COLUMNS) / (COLUMNS - 1), Space.sm)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(columnGap), verticalArrangement = Arrangement.spacedBy(Space.lg), maxItemsInEachRow = COLUMNS) {
                    essentials.forEachIndexed { index, site ->
                        val name = site.title.ifEmpty { siteName(site.url) }
                        Column(
                            Modifier.width(PIN_TILE)
                                .testTag("start-pin-$index")
                                .semantics { contentDescription = strings.t("start.openSite", mapOf("name" to name)) }
                                .combinedClickable(remember { MutableInteractionSource() }, null, onLongClick = { onUnpin(site) }) { onOpen(site.url) },
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(Space.sm),
                        ) {
                            Box(Modifier.size(PIN_TILE).baySurface(Radius.tile), contentAlignment = Alignment.Center) {
                                SiteIcon(app, site.url, PIN_ICON, bare = true)
                            }
                            BayText(name, Modifier.width(PIN_TILE + columnGap - Space.xs), variant = TextVariant.CAPTION, maxLines = 1, textAlign = TextAlign.Center)
                        }
                    }
                }
            }
        }
        if (recent.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                BayText(strings.t("start.recent"), variant = TextVariant.FOOTNOTE, weight = FontWeight.SemiBold, color = Theme.colors.overWallpaper)
                Column(Modifier.fillMaxWidth().baySurface(Radius.card).padding(vertical = Space.xs)) {
                    recent.forEachIndexed { index, entry ->
                        if (index > 0) {
                            Box(Modifier.fillMaxWidth().padding(start = Space.lg + RECENT_ICON + Space.md).height(1.dp).background(Theme.colors.foreground.copy(alpha = 0.1f)))
                        }
                        val name = entry.title.ifEmpty { siteName(entry.url) }
                        Row(
                            Modifier.fillMaxWidth()
                                .testTag("start-recent-$index")
                                .semantics { contentDescription = strings.t("start.openSite", mapOf("name" to name)) }
                                .pressFeedback { onOpen(entry.url) }
                                .heightIn(min = RowToken.height)
                                .padding(horizontal = Space.lg, vertical = Space.sm),
                            horizontalArrangement = Arrangement.spacedBy(Space.md),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            SiteIcon(app, entry.url, RECENT_ICON)
                            Column(Modifier.weight(1f)) {
                                BayText(name, variant = TextVariant.CALLOUT, weight = FontWeight.Medium, maxLines = 1)
                                BayText(siteName(entry.url), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Greeting(strings: Strings) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(60_000)
            now = System.currentTimeMillis()
        }
    }
    val hour = Calendar.getInstance().apply { timeInMillis = now }.get(Calendar.HOUR_OF_DAY)
    val key = when (hour) {
        in 5..11 -> "start.morning"
        in 12..16 -> "start.afternoon"
        else -> "start.evening"
    }
    val locale = Locale.forLanguageTag(strings.locale)
    val pattern = android.text.format.DateFormat.getBestDateTimePattern(locale, "EEEEdMMMM")
    val date = SimpleDateFormat(pattern, locale).format(now)
    Column(Modifier.semantics(mergeDescendants = true) { heading() }.testTag("start-greeting")) {
        BayText(strings.t(key), variant = TextVariant.DISPLAY)
        BayText(date, variant = TextVariant.SUBHEAD, weight = FontWeight.Medium, color = Theme.colors.overWallpaper)
    }
}
