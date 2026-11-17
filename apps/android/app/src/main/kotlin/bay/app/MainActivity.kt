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
        model = AppModel(applicationContext)
        setContent { StoreCheck(model, strings) }
    }

    override fun onStop() {
        super.onStop()
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
        BasicText(
            "Core ${bay.core.version()} · ${strings.locale}",
            modifier = Modifier.testTag("core-version"),
            style = TextStyle(fontSize = 13.sp),
        )
    }
}
