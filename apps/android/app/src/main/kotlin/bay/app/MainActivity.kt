package bay.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.BasicText
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class MainActivity : ComponentActivity() {
    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val strings = Strings()
        setContent {
            Column(
                modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true },
                verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                BasicText("Bay", style = TextStyle(fontSize = 34.sp, fontWeight = FontWeight.SemiBold))
                BasicText(strings.t("start.tapToSearch"), modifier = Modifier.testTag("start-hint"))
                BasicText(
                    "Core ${bay.core.version()} · ${strings.locale}",
                    modifier = Modifier.testTag("core-version"),
                    style = TextStyle(fontSize = 13.sp),
                )
            }
        }
    }
}
