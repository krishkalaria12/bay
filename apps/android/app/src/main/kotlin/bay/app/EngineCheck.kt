package bay.app

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
import bay.engine.BayEngineView
import bay.engine.Engine
import bay.engine.EngineEvent
import bay.engine.NavigationState
import java.io.File
import kotlinx.coroutines.launch

/**
 * A debug screen for the engine host (plan N3): opens an address, moves through history, runs a page script and
 * blocks with a small test list, to prove Bay's Chromium works without Expo before the browser screen lands (N4).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun EngineCheck(close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf("https://www.bbc.com/news") }
    var state by remember { mutableStateOf(NavigationState.EMPTY) }
    var failure by remember { mutableStateOf<String?>(null) }
    var blocked by remember { mutableIntStateOf(0) }
    var blocking by remember { mutableStateOf("off") }
    var scriptResult by remember { mutableStateOf("") }
    val view = remember {
        BayEngineView(context).apply {
            stateKey = "engine-check"
            onEvent = { event ->
                when (event) {
                    is EngineEvent.Navigation -> {
                        state = event.state
                        if (event.state.isLoading) failure = null
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
    DisposableEffect(view) { onDispose { view.dispose() } }

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
