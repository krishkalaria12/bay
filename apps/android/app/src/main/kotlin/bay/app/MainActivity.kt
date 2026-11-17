package bay.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import bay.core.Pairing
import bay.core.SyncStatus
import kotlinx.coroutines.launch
import androidx.compose.runtime.Composable
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import bay.core.Action
import bay.core.BrowserTab
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var model: AppModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val strings = Strings()
        model = AppModel(applicationContext, strings.t("sync.bar"))
        setContent { StoreCheck(model, strings) }
    }

    override fun onStart() {
        super.onStart()
        model.startSyncing()
    }

    override fun onStop() {
        super.onStop()
        model.stopSyncing()
        model.dispatch(Action.Left(AppModel.now()))
        model.flush()
    }
}

/**
 * A stand-in screen until the browser screen lands (plan N4): the space's tabs from the core's store, and a button
 * that adds one, to prove the store, its saving and the bindings work end to end.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun StoreCheck(model: AppModel, strings: Strings) {
    Column(
        modifier = Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp).semantics { testTagsAsResourceId = true },
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        BasicText("Bay", style = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.SemiBold))
        val count = model.tabs.size
        BasicText(
            if (count == 1) strings.t("tabs.one") else strings.t("tabs.count", mapOf("count" to "$count")),
            modifier = Modifier.testTag("tab-count"),
        )
        model.tabs.forEach { tab ->
            BasicText(
                tab.url.ifEmpty { "—" },
                style = TextStyle(fontSize = 13.sp, color = if (tab.id == model.activeTabId) Color.Black else Color.Gray),
            )
        }
        BasicText(
            strings.t("tabs.newTab"),
            modifier = Modifier.testTag("new-tab").clickable {
                val now = AppModel.now()
                val tab = BrowserTab(
                    id = UUID.randomUUID().toString(),
                    url = "https://example.com/$count",
                    title = "",
                    favicon = null,
                    createdAt = now,
                    lastVisit = now,
                    snapshot = null,
                    private = false,
                    spaceId = model.activeSpaceId,
                    folderId = null,
                )
                model.dispatch(Action.NewTab(tab, false))
            },
            style = TextStyle(fontSize = 17.sp, color = Color(0xFF3478F6)),
        )
        SyncCheck(model)
        BasicText(
            "Core ${bay.core.version()} · ${strings.locale}",
            modifier = Modifier.testTag("core-version"),
            style = TextStyle(fontSize = 13.sp),
        )
    }
}

/**
 * A stand-in for Settings › Sync until it lands (plan N5): the status, the devices, pairing by code and joining by the
 * recovery phrase, to prove sync works end to end against the relay.
 */
@Composable
private fun SyncCheck(model: AppModel) {
    val view = model.syncView
    var phrase by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val link = TextStyle(fontSize = 17.sp, color = Color(0xFF3478F6))
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicText("Sync: ${view.status}", modifier = Modifier.testTag("sync-status"))
        view.devices.forEach { device -> BasicText(device.name + if (device.current) " (this phone)" else "", style = TextStyle(fontSize = 13.sp)) }
        (view.pairing as? Pairing.Waiting)?.let { waiting ->
            BasicText(waiting.code, modifier = Modifier.testTag("sync-code"), style = TextStyle(fontSize = 22.sp))
            BasicText(waiting.digits, modifier = Modifier.testTag("sync-digits"))
        }
        if (view.status == SyncStatus.OFF) {
            BasicText("Pair with a computer", modifier = Modifier.testTag("sync-pair").clickable { model.pair() }, style = link)
            BasicTextField(
                value = phrase,
                onValueChange = { phrase = it },
                modifier = Modifier.fillMaxWidth().border(1.dp, Color.Gray).padding(8.dp).testTag("sync-phrase"),
            )
            BasicText("Join", modifier = Modifier.testTag("sync-join").clickable { scope.launch { problem = model.join(phrase) } }, style = link)
            problem?.let { BasicText(it, style = TextStyle(fontSize = 13.sp, color = Color.Red)) }
        } else {
            BasicText("Sync now", modifier = Modifier.testTag("sync-now").clickable { model.syncNow() }, style = link)
            BasicText("Leave", modifier = Modifier.testTag("sync-leave").clickable { model.leave() }, style = link)
        }
    }
}
