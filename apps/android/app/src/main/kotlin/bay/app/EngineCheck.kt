package bay.app

import android.net.Uri
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import bay.core.MediaReport
import bay.core.NavigationReport
import bay.core.initialTiming
import bay.core.parseMediaMessage
import bay.core.scriptsFor
import bay.engine.BayEngineView
import bay.engine.Engine
import bay.engine.EngineEvent
import bay.engine.MediaControl
import bay.engine.PageScript
import bay.engine.runScript
import bay.engine.NavigationState
import java.io.File
import kotlinx.coroutines.launch

/**
 * A debug screen for the engine host (plan N3): opens an address, moves through history, runs a page script, blocks
 * with a small test list, downloads, and shows the page's media in the media notification, to check Bay's Chromium on
 * its own.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun EngineCheck(model: AppModel, close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf("https://www.bbc.com/news") }
    var state by remember { mutableStateOf(NavigationState.EMPTY) }
    var failure by remember { mutableStateOf<String?>(null) }
    var blocked by remember { mutableIntStateOf(0) }
    var blocking by remember { mutableStateOf("off") }
    var scriptResult by remember { mutableStateOf("") }
    var media by remember { mutableStateOf<MediaReport?>(null) }
    val timing = remember { arrayOf(initialTiming()) }
    val view = remember {
        BayEngineView(context).apply {
            stateKey = "engine-check"
            onEvent = { event ->
                when (event) {
                    is EngineEvent.Navigation -> {
                        state = event.state
                        if (event.state.isLoading) failure = null
                        // The media watcher goes on each new document, as the browser screen will run it.
                        val report = NavigationReport(event.state.url, event.state.progress, event.state.isLoading)
                        val plan = scriptsFor(timing[0], report, false)
                        timing[0] = plan.timing
                        if (plan.watchMedia) scope.launch { runCatching { runScript(PageScript.WATCH_MEDIA) } }
                    }
                    is EngineEvent.PageMessage -> parseMediaMessage(event.message)?.let { report ->
                        media = report
                        // The media notification shows it, and its buttons come back through `mediaControl`.
                        Engine.setMediaSession(context, report.title, Uri.parse(state.url).host.orEmpty(), report.playing)
                    }
                    is EngineEvent.Failure -> failure = "${event.code}: ${event.message}"
                    is EngineEvent.BlockedCount -> blocked = event.count
                    // The debug screen has no sheet: it turns every request down so the page doesn't wait.
                    is EngineEvent.Request -> answerPageRequest(event.request.id, false, null, null, null)
                    else -> {}
                }
            }
            loadInitial(address)
        }
    }
    fun control(action: MediaControl) {
        val (script, args) = when (action) {
            MediaControl.TOGGLE -> PageScript.TOGGLE_MEDIA to null
            MediaControl.STOP -> PageScript.PAUSE_MEDIA to null
            MediaControl.SKIP_FORWARD -> PageScript.SEEK_MEDIA to mapOf("seconds" to 10)
            MediaControl.SKIP_BACKWARD -> PageScript.SEEK_MEDIA to mapOf("seconds" to -10)
        }
        scope.launch { runCatching { view.runScript(script, args) } }
    }
    DisposableEffect(view) {
        // The browser's handler for the system's media controls, given back when the check closes.
        val browserControl = model.mediaControl
        model.mediaControl = ::control
        onDispose {
            model.mediaControl = browserControl
            Engine.setMediaSession(context, null, "", false)
            view.dispose()
        }
    }

    fun go() {
        val typed = address.trim()
        runCatching { view.load(if ("://" in typed) typed else "https://$typed") }
    }

    val link = TextStyle(fontSize = 15.sp, color = Color(0xFF3478F6))
    val small = TextStyle(fontSize = 12.sp)
    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().semantics { testTagsAsResourceId = true },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(modifier = Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            BasicText("Close", modifier = Modifier.testTag("engine-close").clickable(onClick = close), style = link)
            BasicTextField(
                value = address,
                onValueChange = { address = it },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { go() }),
                modifier = Modifier.weight(1f).border(1.dp, Color.Gray).padding(4.dp).testTag("engine-address"),
            )
            BasicText("Go", modifier = Modifier.testTag("engine-go").clickable { go() }, style = link)
        }
        Row(modifier = Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            BasicText("Back", modifier = Modifier.testTag("engine-back").clickable(enabled = state.canGoBack) { view.goBack() }, style = link)
            BasicText("Forward", modifier = Modifier.clickable(enabled = state.canGoForward) { view.goForward() }, style = link)
            BasicText("Reload", modifier = Modifier.testTag("engine-reload").clickable { view.reload() }, style = link)
            BasicText(
                "Title",
                modifier = Modifier.testTag("engine-script").clickable {
                    scope.launch { scriptResult = runCatching { view.evaluate("return document.title") }.getOrDefault("failed") }
                },
                style = link,
            )
            BasicText(
                "Block",
                modifier = Modifier.testTag("engine-block").clickable {
                    blocking = "compiling"
                    scope.launch {
                        // A few ad and tracker hosts, written to a file the engine's blocker reads.
                        val file = File(context.cacheDir, "engine-check-list.txt")
                        file.writeText(TEST_LIST)
                        blocking = runCatching {
                            Engine.setContentBlocking(context, listOf(file.toURI().toString()), "engine-check-1")
                            view.reload()
                            "on"
                        }.getOrElse { "failed: ${it.message}" }
                    }
                },
                style = link,
            )
        }
        Column(modifier = Modifier.padding(horizontal = 12.dp).fillMaxWidth()) {
            val title = if (state.isLoading) "Loading ${(state.progress * 100).toInt()}%" else state.title.ifEmpty { state.url }
            BasicText(title, modifier = Modifier.testTag("engine-state"), style = small, maxLines = 1)
            BasicText("Blocking: $blocking · blocked $blocked", modifier = Modifier.testTag("engine-blocked"), style = small)
            if (scriptResult.isNotEmpty()) {
                BasicText("Script: $scriptResult", modifier = Modifier.testTag("engine-script-result"), style = small, maxLines = 1)
            }
            media?.let {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    BasicText(
                        "Media: ${if (it.playing) "playing" else "paused"} · ${it.title}",
                        modifier = Modifier.weight(1f, fill = false).testTag("engine-media"),
                        style = small,
                        maxLines = 1,
                    )
                    BasicText(
                        if (it.playing) "Pause" else "Play",
                        modifier = Modifier.testTag("engine-media-toggle").clickable { control(MediaControl.TOGGLE) },
                        style = link,
                    )
                }
            }
            model.downloads.firstOrNull()?.let { download ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    BasicText(
                        "Download: ${download.filename} · ${download.state} · ${download.received}/${download.total}",
                        modifier = Modifier.weight(1f, fill = false).testTag("engine-download"),
                        style = small,
                        maxLines = 1,
                    )
                    download.path?.let { path ->
                        BasicText(
                            "Open",
                            modifier = Modifier.testTag("engine-download-open").clickable {
                                scope.launch { runCatching { Engine.openDownload(context, path) } }
                            },
                            style = link,
                        )
                    }
                }
            }
            failure?.let { BasicText(it, modifier = Modifier.testTag("engine-failure"), style = small.copy(color = Color.Red), maxLines = 2) }
        }
        AndroidView(factory = { view }, modifier = Modifier.fillMaxWidth().weight(1f))
    }
}

private const val TEST_LIST = """||doubleclick.net^
||googlesyndication.com^
||googletagmanager.com^
||google-analytics.com^
||scorecardresearch.com^
||chartbeat.com^
||chartbeat.net^
||optimizely.com^
"""
