package bay.app.browser

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.text.TextRange
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import bay.app.AppModel
import bay.app.Strings
import bay.core.HttpRequest
import bay.core.SearchScope
import bay.core.Suggestion
import bay.core.addressFor
import bay.core.parseScopeSuggestions
import bay.core.parseSuggestionsBody
import bay.core.scopeSuggestRequest
import bay.core.scopedSearchUrl
import bay.core.suggestionsRequestUrl
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.Haptics
import bay.design.Motion
import bay.design.Radius
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style
import bay.engine.Engine
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** The search sheet's measures (U4): it sits on the keyboard, holding the field and four rows. */
private object SearchSheet {
    val topInset = 16.dp
    val fieldHeight = 48.dp
    val rowsTopGap = 6.dp
    val rowHeight = 56.dp
    const val VISIBLE_ROWS = 4
    val bottomInset = 8.dp
    val cornerRadius = 38.dp
    val height = topInset + fieldHeight + rowsTopGap + rowHeight * VISIBLE_ROWS + bottomInset
}

/** How long typing has to pause before the engine is asked for suggestions. */
private const val SUGGEST_DELAY_MS = 120L

/** How many sites the row under the empty field holds. */
private const val SHORTCUT_PLACES = 5

/** How long Go waits for the keyboard's last edits. */
private const val GO_SETTLE_MS = 80L

/** A site's chip colours: its own colour, and black or white on it, whichever reads. */
private class ScopeColors(val fill: Color) {
    /** A light colour (Wikipedia's white) needs an edge to show on a light sheet; past 0.4 black text reads better. */
    val light = fill.luminance() > 0.4f
    val ink = if (light) Color.Black else Color.White

    companion object {
        fun of(hex: String?): ScopeColors? {
            if (hex == null || hex.length != 7 || !hex.startsWith("#")) return null
            val value = hex.drop(1).toLongOrNull(16) ?: return null
            return ScopeColors(Color(0xFF000000 or value))
        }
    }
}

/**
 * The search card: a field that grows out of the bar's capsule, with the rows for what's typed, on the keyboard. Typing
 * a site's name offers it ("Search IMDb"); choosing it, or a space after its keyword ("yt "), turns the field into the
 * site's chip, and the rows become the site's own.
 */
@Composable
fun SearchCard(browser: BrowserModel, strings: Strings, initialText: String, startPrivately: Boolean) {
    val app = browser.app
    val scope = rememberCoroutineScope()
    // A prefilled address starts selected, so typing replaces it. The field keeps the keyboard's edits itself, so
    // fast typing isn't lost while the rows are worked out.
    val field = rememberTextFieldState(initialText, TextRange(0, initialText.length))
    val query = field.text.toString()
    var privately by remember { mutableStateOf(startPrivately) }
    // No inline completion over a prefilled address, or straight after deleting.
    var suppressed by remember { mutableStateOf(initialText.isNotEmpty()) }
    // The text was just filled in from a row, not typed.
    var filling by remember { mutableStateOf(false) }
    var remote by remember { mutableStateOf(emptyList<String>()) }
    var fetch by remember { mutableStateOf<Job?>(null) }
    // The site the field searches, shown as a chip at its start, and that site's own results.
    var site by remember { mutableStateOf<SearchScope?>(null) }
    var siteResults by remember { mutableStateOf(emptyList<Suggestion>()) }
    // The chip has just arrived: the field shows the site's colour in full for a moment.
    var flash by remember { mutableStateOf(false) }
    val shortcuts = remember { app.store.scopeShortcuts(SHORTCUT_PLACES.toUInt()) }
    val view = LocalView.current
    var dragged by remember { mutableFloatStateOf(0f) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val engine = browser.engine
    val grown by animateFloatAsState(1f, Motion.settle.spec(), label = "grow")

    val now = AppModel.now().toDouble()
    val chosen = site
    val rows: List<Suggestion>
    val completion: String
    if (chosen != null) {
        // Inside a chip: the site's rows, and nothing to complete.
        rows = app.store.scopedSuggestions(chosen, query, siteResults, now)
        completion = ""
    } else {
        val result = app.store.suggestions(query, remote, initialText.ifEmpty { null }, now)
        rows = result.items.filter { it is Suggestion.Page || it is Suggestion.Search || it is Suggestion.Calc || it is Suggestion.Scope }
        completion = if (suppressed) "" else result.completion
    }
    val colors = ScopeColors.of(chosen?.color)
    val fieldFill by animateColorAsState(
        when {
            colors != null -> colors.fill.copy(alpha = if (flash) 0.85f else 0.2f)
            privately -> Color.White.copy(alpha = 0.1f)
            else -> Theme.colors.fill
        },
        tween(if (flash) 0 else 600, delayMillis = if (flash) 0 else 250),
        label = "field",
    )
    val placeholder = chosen?.let { strings.t("search.withEngine", mapOf("engine" to it.name)) } ?: strings.t("search.placeholder")
    // What the screen shows now, for Go, which reads it a moment after it's pressed.
    val shown by rememberUpdatedState(Triple(query, completion, rows))
    val text = if (privately) Color(0xFFF4F4F5) else Theme.colors.foreground
    val secondary = if (privately) Color(0xFFA1A1AA) else Theme.colors.muted

    fun dismiss() {
        keyboard?.hide()
        browser.dismissSearch()
    }

    fun open(target: OpenTarget) {
        keyboard?.hide()
        browser.open(target, privately)
    }

    fun fill(next: String) {
        filling = true
        field.setTextAndPlaceCursorAtEnd(next)
        focus.requestFocus()
    }

    fun enter(next: SearchScope) {
        Haptics.press(view)
        fetch?.cancel()
        remote = emptyList()
        siteResults = emptyList()
        flash = true
        site = next
        fill("")
        scope.launch {
            delay(16)
            flash = false
        }
    }

    fun leave() {
        fetch?.cancel()
        siteResults = emptyList()
        site = null
        focus.requestFocus()
    }

    /**
     * What follows a change to the field: inline completion stops after deleting, a space after a site's keyword brings
     * its chip, and the engine's suggestions (or the site's results, inside a chip) refetch.
     */
    fun changed(next: String, before: String) {
        suppressed = next.length < before.length
        if (site == null && next.endsWith(" ") && !next.dropLast(1).contains(' ')) {
            app.store.searchScope(next.dropLast(1))?.let {
                enter(it)
                return
            }
        }
        fetch?.cancel()
        val inside = site
        val enabled = app.preferences.searchSuggestions && next.isNotBlank()
        val url = when {
            !enabled -> null
            inside != null -> scopeSuggestRequest(inside, next)
            else -> suggestionsRequestUrl(engine, next)
        }
        if (url == null) {
            remote = emptyList()
            siteResults = emptyList()
            return
        }
        fetch = scope.launch {
            delay(SUGGEST_DELAY_MS)
            val response = runCatching { app.http.send(HttpRequest("GET", url, emptyMap(), null, true, 4000u)) }.getOrNull()
            if (response?.status?.toInt() != 200) return@launch
            val body = response.body.decodeToString()
            if (inside != null) siteResults = parseScopeSuggestions(inside, body) else remote = parseSuggestionsBody(body)
        }
    }

    fun choose(row: Suggestion) {
        val place = (row as? Suggestion.Page)?.takeIf { it.tabId == null && it.cleanedId == null }?.location
        when {
            row is Suggestion.Scope -> enter(row.scope)
            // A bookmark from another space opens in that space.
            place != null && place.spaceId != app.activeSpaceId && row is Suggestion.Page -> {
                keyboard?.hide()
                browser.selectSpace(place.spaceId)
                browser.open(OpenTarget.Url(row.url), privately)
            }
            else -> open(targetFor(row))
        }
    }

    LaunchedEffect(Unit) { focus.requestFocus() }
    // Opened from the widget's microphone (C7): listens at once, and what's heard replaces the field, like a paste.
    // Voice search (B16): the engine listens once, and what it hears replaces the field, like a paste.
    var listening by remember { mutableStateOf(false) }
    fun listen() {
        if (listening) return
        listening = true
        scope.launch {
            val heard = Engine.listen()
            listening = false
            if (!heard.isNullOrEmpty()) fill(heard)
        }
    }
    LaunchedEffect(browser.searchListening) {
        if (!browser.searchListening) return@LaunchedEffect
        browser.searchListening = false
        listen()
    }
    LaunchedEffect(field) {
        var before = field.text.toString()
        snapshotFlow { field.text.toString() }.collect { next ->
            if (next == before) return@collect
            changed(next, before)
            // A filled-in row keeps completion off until the next keystroke.
            if (filling) suppressed = true
            filling = false
            before = next
        }
    }

    Box(Modifier.fillMaxSize().testTag("search-card")) {
        // The page stays where it is, blurred behind (BrowserScreen) and dimmed here.
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.2f)))
        Box(
            Modifier.fillMaxSize()
                .testTag("search-dismiss")
                .semantics { contentDescription = strings.t("search.close"); role = Role.Button }
                .clickable(remember { MutableInteractionSource() }, null) { dismiss() },
        )
        Column(
            Modifier.align(Alignment.BottomCenter)
                .fillMaxWidth()
                .offset { androidx.compose.ui.unit.IntOffset(0, dragged.toInt()) }
                .background(if (privately) Color(0xFF171717) else Theme.colors.background, RoundedCornerShape(topStart = SearchSheet.cornerRadius, topEnd = SearchSheet.cornerRadius))
                .navigationBarsPadding()
                .imePadding()
                .height(SearchSheet.height)
                .testTag(if (privately) "search-card-private" else "search-sheet"),
        ) {
            Row(
                Modifier.padding(top = SearchSheet.topInset, start = Space.lg, end = Space.lg)
                    .graphicsLayer { scaleX = 0.5f + 0.5f * grown; alpha = grown }
                    .fillMaxWidth()
                    .height(SearchSheet.fieldHeight)
                    .background(fieldFill, CircleShape)
                    .pointerInput(Unit) {
                        detectVerticalDragGestures(
                            onDragEnd = { if (dragged > 80.dp.toPx()) dismiss() else dragged = 0f },
                            onVerticalDrag = { _, amount -> dragged = maxOf(0f, dragged + amount) },
                        )
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AnimatedVisibility(chosen != null, enter = scaleIn(initialScale = 0.6f) + fadeIn(), exit = scaleOut(targetScale = 0.6f) + fadeOut()) {
                    chosen?.let { Chip(app, strings, it, colors, text, privately, ::leave) }
                }
                val fieldStyle = TextVariant.HEADLINE.style(FontWeight.Normal, text)
                BasicTextField(
                    state = field,
                    lineLimits = TextFieldLineLimits.SingleLine,
                    textStyle = fieldStyle,
                    cursorBrush = SolidColor(Theme.colors.accent),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    onKeyboardAction = {
                        // A hardware or injected Enter can arrive before the keyboard's last edits do; they land within
                        // a moment, so Go reads the field once they have.
                        scope.launch {
                            delay(GO_SETTLE_MS)
                            val typed = field.text.toString()
                            val (shownQuery, shownCompletion, shownRows) = shown
                            val first = shownRows.firstOrNull()
                            val inside = site
                            when {
                                inside != null -> open(OpenTarget.Url(scopedSearchUrl(inside, typed, engine.url)))
                                typed == shownQuery && shownCompletion.isNotEmpty() && first != null -> open(targetFor(first))
                                // A bang ("font !w") goes where its row says.
                                first is Suggestion.Search && !first.suggested && first.engine != engine.name && typed.contains('!') ->
                                    open(OpenTarget.Url(first.url))
                                else -> addressFor(typed, engine)?.let { open(OpenTarget.Url(it)) }
                            }
                        }
                    },
                    modifier = Modifier.weight(1f).padding(start = if (chosen == null) Space.lg else Space.sm).focusRequester(focus).testTag("address-input")
                        // Backspace on an empty field gives the chip back.
                        .onPreviewKeyEvent { event ->
                            val back = event.type == KeyEventType.KeyDown && event.key == Key.Backspace && site != null && field.text.isEmpty()
                            if (back) leave()
                            back
                        }
                        .semantics { contentDescription = placeholder },
                    decorator = { inner ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (query.isEmpty()) BayText(placeholder, variant = TextVariant.HEADLINE, weight = FontWeight.Normal, color = secondary, maxLines = 1)
                            if (completion.isNotEmpty()) {
                                val annotated = buildAnnotatedString {
                                    withStyle(SpanStyle(color = Color.Transparent)) { append(query) }
                                    withStyle(SpanStyle(background = if (privately) Color.White.copy(alpha = 0.18f) else Color(0x380A84FF))) { append(completion) }
                                }
                                androidx.compose.foundation.text.BasicText(annotated, Modifier.testTag("address-completion"), style = fieldStyle, maxLines = 1)
                            }
                            inner()
                        }
                    },
                )
                // Clears the words first, then the chip.
                if (query.isNotEmpty() || chosen != null) {
                    FieldButton("clear-address", strings.t("search.clear"), BayIcon.CLOSE, secondary, IconSize.row) {
                        if (query.isEmpty()) leave() else fill("")
                    }
                }
                FieldButton(
                    "voice-search", strings.t(if (listening) "search.listening" else "search.voice"), BayIcon.MIC,
                    if (listening) text else secondary, IconSize.control,
                ) { listen() }
                FieldButton("private-toggle", strings.t("search.private"), BayIcon.PRIVATE, if (privately) text else secondary, IconSize.control, selected = privately) {
                    privately = !privately
                }
            }
            Column(Modifier.padding(top = SearchSheet.rowsTopGap).weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = Space.sm)) {
                if (privately) {
                    BayText(strings.t("search.privateNotice"), Modifier.padding(start = Space.lg, top = 2.dp).testTag("private-notice"), variant = TextVariant.FOOTNOTE, color = secondary)
                }
                if (chosen == null && query.isEmpty() && shortcuts.isNotEmpty()) {
                    Shortcuts(app, strings, shortcuts, privately, { enter(it) }) { open(OpenTarget.Url(it.home)) }
                }
                rows.forEachIndexed { index, row ->
                    SuggestionRow(app, strings, row, index, engine.name, text, secondary, { choose(row) }, ::fill)
                }
            }
        }
    }
}

private fun targetFor(row: Suggestion): OpenTarget = when (row) {
    is Suggestion.Page -> row.tabId?.let { OpenTarget.Tab(it) } ?: row.cleanedId?.let { OpenTarget.Archived(it) } ?: OpenTarget.Url(row.url)
    is Suggestion.Search -> OpenTarget.Url(row.url)
    is Suggestion.Calc -> OpenTarget.Url(row.url)
    is Suggestion.Result -> OpenTarget.Url(row.url)
    is Suggestion.Scope -> OpenTarget.Url(row.scope.home)
    else -> OpenTarget.Url("")
}

/** The site's chip at the field's start; tapping it goes back to searching everything. */
@Composable
private fun Chip(app: AppModel, strings: Strings, site: SearchScope, colors: ScopeColors?, text: Color, privately: Boolean, leave: () -> Unit) {
    val ink = colors?.ink ?: text
    Row(
        Modifier.padding(start = 8.dp)
            .height(32.dp)
            .background(colors?.fill ?: if (privately) Color.White.copy(alpha = 0.18f) else Theme.colors.background, CircleShape)
            .border(1.dp, Color.Black.copy(alpha = if (colors?.light != false) 0.1f else 0f), CircleShape)
            .testTag("scope-chip")
            .semantics(mergeDescendants = true) { contentDescription = strings.t("search.leaveSite", mapOf("name" to site.name)); role = Role.Button }
            .clickable(remember { MutableInteractionSource() }, null, onClick = leave)
            .padding(start = 8.dp, end = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SiteIcon(app, site.home, size = 18.dp, bare = true)
        BayText(site.name, variant = TextVariant.SUBHEAD, weight = FontWeight.SemiBold, color = ink, maxLines = 1)
    }
}

/** The sites the field can search, before anything is typed: a tap brings the site's chip, holding opens the site. */
@Composable
private fun Shortcuts(app: AppModel, strings: Strings, sites: List<SearchScope>, privately: Boolean, enter: (SearchScope) -> Unit, openSite: (SearchScope) -> Unit) {
    val view = LocalView.current
    Row(Modifier.fillMaxWidth().padding(horizontal = Space.sm, vertical = Space.xs).testTag("search-shortcuts"), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        sites.forEach { site ->
            Box(
                Modifier.weight(1f)
                    .heightIn(min = 44.dp)
                    .clip(RoundedCornerShape(Radius.control))
                    .background(if (privately) Color.White.copy(alpha = 0.1f) else Theme.colors.fill)
                    .testTag("search-shortcut-${site.host}")
                    .semantics { contentDescription = strings.t("search.withEngine", mapOf("engine" to site.name)); role = Role.Button }
                    .combinedClickable(onLongClickLabel = strings.t("search.shortcutHint"), onLongClick = {
                        Haptics.tick(view)
                        openSite(site)
                    }) { enter(site) },
                contentAlignment = Alignment.Center,
            ) { SiteIcon(app, site.home, size = 26.dp, bare = true) }
        }
        // Always five places, so one site's tile is as wide as five sites' tiles.
        repeat(SHORTCUT_PLACES - sites.size) { androidx.compose.foundation.layout.Spacer(Modifier.weight(1f)) }
    }
}

/** A button in the field, as big as Android's smallest touch target (48dp) whatever its icon. */
@Composable
private fun FieldButton(id: String, label: String, icon: BayIcon, color: Color, size: androidx.compose.ui.unit.Dp, selected: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.size(48.dp).testTag(id)
            .semantics { contentDescription = label; this.selected = selected }
            .clickable(remember { MutableInteractionSource() }, null, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayIconView(icon, size = size, color = color) }
}

/** One suggestion: a page, a search or a sum, with a button that fills its text into the field. */
@Composable
private fun SuggestionRow(
    app: AppModel,
    strings: Strings,
    row: Suggestion,
    index: Int,
    engineName: String,
    text: Color,
    secondary: Color,
    open: () -> Unit,
    fill: (String) -> Unit,
) {
    // Where the row's page is saved as a bookmark: "Personal · Watchlist", or the space alone at its top level.
    val place = (row as? Suggestion.Page)?.takeIf { it.tabId == null }?.location?.let { place ->
        val space = app.spaces.firstOrNull { it.id == place.spaceId }?.let { spaceName(it, strings) }.orEmpty()
        listOf(space, place.folder).filter { it.isNotEmpty() }.joinToString(" · ")
    }
    val (title, detail, fillText) = when (row) {
        is Suggestion.Page -> {
            val address = displayUrl(row.url)
            val detail = if (row.tabId == null) place ?: address else strings.t("search.switchToTab", mapOf("address" to address))
            Triple(row.title.ifEmpty { address }, detail, row.url)
        }
        is Suggestion.Search -> Triple(row.query, strings.t("search.withEngine", mapOf("engine" to row.engine.ifEmpty { engineName })), row.query)
        is Suggestion.Calc -> Triple("= ${row.value}", row.expression, null)
        is Suggestion.Scope -> Triple(strings.t("search.withEngine", mapOf("engine" to row.scope.name)), displayUrl(row.scope.home), null)
        is Suggestion.Result -> Triple(row.title, row.detail.ifEmpty { displayUrl(row.url) }, null)
        else -> Triple("", "", null)
    }
    Row(
        Modifier.fillMaxWidth()
            .testTag("suggestion-$index")
            .semantics(mergeDescendants = true) { contentDescription = "$title, $detail" }
            .pressFeedback(onClick = open)
            .heightIn(min = SearchSheet.rowHeight)
            .padding(start = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
            when (row) {
                is Suggestion.Page -> SiteIcon(app, row.url)
                is Suggestion.Scope -> SiteIcon(app, row.scope.home)
                is Suggestion.Result -> {
                    val pixels = with(LocalDensity.current) { 28.dp.roundToPx() }
                    val poster = rememberWebImage(app, row.image, pixels)
                    if (poster != null) {
                        Image(poster, null, Modifier.size(28.dp, 40.dp).clip(RoundedCornerShape(4.dp)), contentScale = ContentScale.Crop)
                    } else {
                        SiteIcon(app, row.url)
                    }
                }
                else -> BayIconView(BayIcon.SEARCH, size = IconSize.row, color = secondary)
            }
        }
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            BayText(title, color = text, maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(Space.xs), verticalAlignment = Alignment.CenterVertically) {
                if (place != null) BayIconView(BayIcon.BOOKMARKED, size = IconSize.inline, color = secondary)
                BayText(detail, variant = TextVariant.FOOTNOTE, color = secondary, maxLines = 1)
            }
        }
        if (fillText != null) {
            FieldButton("suggestion-fill-$index", strings.t("search.fillIn", mapOf("title" to title)), BayIcon.FILL, secondary, IconSize.small) { fill(fillText) }
        }
    }
}
