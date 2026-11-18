package bay.app.browser

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.text.KeyboardActions
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
import bay.core.Suggestion
import bay.core.addressFor
import bay.core.displayUrl
import bay.core.parseSuggestionsBody
import bay.core.suggestionsRequestUrl
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.IconSize
import bay.design.Motion
import bay.design.Space
import bay.design.TextVariant
import bay.design.Theme
import bay.design.pressFeedback
import bay.design.style
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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

/** The search card: a field that grows out of the bar's capsule, with the rows for what's typed, on the keyboard. */
@Composable
fun SearchCard(browser: BrowserModel, strings: Strings, initialText: String, startPrivately: Boolean) {
    val app = browser.app
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf(initialText) }
    var privately by remember { mutableStateOf(startPrivately) }
    // No inline completion over a prefilled address, or straight after deleting.
    var suppressed by remember { mutableStateOf(initialText.isNotEmpty()) }
    var remote by remember { mutableStateOf(emptyList<String>()) }
    var fetch by remember { mutableStateOf<Job?>(null) }
    var dragged by remember { mutableFloatStateOf(0f) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val engine = browser.engine
    val grown by animateFloatAsState(1f, Motion.settle.spec(), label = "grow")

    val result = app.store.suggestions(query, remote, initialText.ifEmpty { null }, AppModel.now().toDouble())
    val rows = result.items.filter { it is Suggestion.Page || it is Suggestion.Search || it is Suggestion.Calc }
    val completion = if (suppressed) "" else result.completion
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

    fun change(next: String) {
        suppressed = next.length < query.length
        query = next
        fetch?.cancel()
        val url = if (app.preferences.searchSuggestions && next.isNotBlank()) suggestionsRequestUrl(engine, next) else null
        if (url == null) {
            remote = emptyList()
            return
        }
        fetch = scope.launch {
            delay(SUGGEST_DELAY_MS)
            val response = runCatching { app.http.send(HttpRequest("GET", url, emptyMap(), null, true, 4000u)) }.getOrNull()
            if (response?.status?.toInt() == 200) remote = parseSuggestionsBody(response.body.decodeToString())
        }
    }

    fun fill(next: String) {
        suppressed = true
        change(next)
        suppressed = true
        focus.requestFocus()
    }

    LaunchedEffect(Unit) { focus.requestFocus() }

    Box(Modifier.fillMaxSize().testTag("search-card")) {
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
                    .background(if (privately) Color.White.copy(alpha = 0.1f) else Theme.colors.fill, CircleShape)
                    .pointerInput(Unit) {
                        detectVerticalDragGestures(
                            onDragEnd = { if (dragged > 80.dp.toPx()) dismiss() else dragged = 0f },
                            onVerticalDrag = { _, amount -> dragged = maxOf(0f, dragged + amount) },
                        )
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val fieldStyle = TextVariant.HEADLINE.style(FontWeight.Normal, text)
                BasicTextField(
                    value = query,
                    onValueChange = ::change,
                    singleLine = true,
                    textStyle = fieldStyle,
                    cursorBrush = SolidColor(Theme.colors.accent),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onGo = {
                        val first = rows.firstOrNull()
                        if (completion.isNotEmpty() && first != null) open(targetFor(first)) else addressFor(query, engine)?.let { open(OpenTarget.Url(it)) }
                    }),
                    modifier = Modifier.weight(1f).padding(start = Space.lg).focusRequester(focus).testTag("address-input")
                        .semantics { contentDescription = strings.t("search.placeholder") },
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (query.isEmpty()) BayText(strings.t("search.placeholder"), variant = TextVariant.HEADLINE, weight = FontWeight.Normal, color = secondary, maxLines = 1)
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
                if (query.isNotEmpty()) {
                    FieldButton("clear-address", strings.t("search.clear"), BayIcon.CLOSE, secondary, IconSize.row) { fill("") }
                }
                FieldButton("private-toggle", strings.t("search.private"), BayIcon.PRIVATE, if (privately) text else secondary, IconSize.control, selected = privately) {
                    privately = !privately
                }
            }
            Column(Modifier.padding(top = SearchSheet.rowsTopGap).weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = Space.sm)) {
                if (privately) {
                    BayText(strings.t("search.privateNotice"), Modifier.padding(start = Space.lg, top = 2.dp).testTag("private-notice"), variant = TextVariant.FOOTNOTE, color = secondary)
                }
                rows.forEachIndexed { index, row ->
                    SuggestionRow(app, strings, row, index, engine.name, text, secondary, { open(targetFor(row)) }, ::fill)
                }
            }
        }
    }
}

private fun targetFor(row: Suggestion): OpenTarget = when (row) {
    is Suggestion.Page -> row.tabId?.let { OpenTarget.Tab(it) } ?: row.cleanedId?.let { OpenTarget.Archived(it) } ?: OpenTarget.Url(row.url)
    is Suggestion.Search -> OpenTarget.Url(row.url)
    is Suggestion.Calc -> OpenTarget.Url(row.url)
    else -> OpenTarget.Url("")
}

@Composable
private fun FieldButton(id: String, label: String, icon: BayIcon, color: Color, size: androidx.compose.ui.unit.Dp, selected: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.size(44.dp).testTag(id)
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
    val (title, detail, fillText) = when (row) {
        is Suggestion.Page -> {
            val address = displayUrl(row.url)
            Triple(row.title.ifEmpty { address }, if (row.tabId == null) address else strings.t("search.switchToTab", mapOf("address" to address)), row.url)
        }
        is Suggestion.Search -> Triple(row.query, strings.t("search.withEngine", mapOf("engine" to engineName)), row.query)
        is Suggestion.Calc -> Triple("= ${row.value}", row.expression, null)
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
            if (row is Suggestion.Page) SiteIcon(app, row.url) else BayIconView(BayIcon.SEARCH, size = IconSize.row, color = secondary)
        }
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            BayText(title, color = text, maxLines = 1)
            BayText(detail, variant = TextVariant.FOOTNOTE, color = secondary, maxLines = 1)
        }
        if (fillText != null) {
            FieldButton("suggestion-fill-$index", strings.t("search.fillIn", mapOf("title" to title)), BayIcon.FILL, secondary, IconSize.small) { fill(fillText) }
        }
    }
}
