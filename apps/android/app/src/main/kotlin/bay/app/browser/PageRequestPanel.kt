package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.hostOf
import bay.design.BayText
import bay.design.PanelSheet
import bay.design.PillButton
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.style
import bay.engine.PageRequest

/**
 * A page's `alert`/`confirm`/`prompt`, the server's HTTP sign-in, a link to another app or a device permission, as one
 * sheet instead of Chromium's own dialogs. The page waits until this answers, so dismissing the sheet cancels the
 * dialog, as a dismissed browser dialog would.
 */
@Composable
fun PageRequestPanel(browser: BrowserModel, strings: Strings, visible: Boolean) {
    val request = browser.pageRequests.firstOrNull()?.second
    val host = request?.let { hostOf(it.url) }.orEmpty()
    val title = host.ifEmpty { strings.t("pageRequest.thisPage") }
    PanelSheet(visible && request != null, title, "page-request", strings.sheetWords(title), { browser.answerPageRequest(false) }) {
        if (request != null) androidx.compose.runtime.key(request.id) { RequestBody(browser, strings, request) }
    }
}

@Composable
private fun RequestBody(browser: BrowserModel, strings: Strings, request: PageRequest) {
    var value by remember { mutableStateOf(request.defaultValue.orEmpty()) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val submit = {
        browser.answerPageRequest(
            true,
            value.takeIf { request.kind == "prompt" },
            username.takeIf { request.kind == "auth" },
            password.takeIf { request.kind == "auth" },
        )
    }
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        when (request.kind) {
            "auth" -> BayText(
                request.realm?.let { strings.t("pageRequest.auth.realm", mapOf("realm" to it)) } ?: strings.t("pageRequest.auth.site"),
                Modifier.testTag("page-request-realm"),
                variant = TextVariant.SUBHEAD,
                tone = TextTone.MUTED,
            )
            "permission" -> BayText(strings.t(permissionMessage(request.permission)), Modifier.testTag("page-request-permission-message"))
            "external" -> {
                BayText(strings.t("pageRequest.external"), Modifier.testTag("page-request-external-message"))
                BayText(request.externalUrl.orEmpty(), Modifier.testTag("page-request-external"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, maxLines = 2)
            }
            else -> if (request.message.isNotEmpty()) BayText(request.message, Modifier.testTag("page-request-message"))
        }
        if (request.kind == "prompt") Field(value, { value = it }, strings.t("pageRequest.answer"), "page-request-input", onDone = submit)
        if (request.kind == "auth") {
            Field(username, { username = it }, strings.t("pageRequest.username"), "page-request-username", onDone = {})
            Field(password, { password = it }, strings.t("pageRequest.password"), "page-request-password", secret = true, onDone = submit)
        }
        Row(Modifier.fillMaxWidth().padding(top = Space.sm), horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.End)) {
            if (request.kind != "alert") {
                val cancel = if (request.kind == "permission") strings.t("pageRequest.dontAllow") else strings.t("pageRequest.cancel")
                PillButton(cancel, Modifier.testTag("page-request-cancel")) { browser.answerPageRequest(false) }
            }
            val ok = when (request.kind) {
                "auth" -> strings.t("pageRequest.signIn")
                "external" -> strings.t("pageRequest.open")
                "permission" -> strings.t("pageRequest.allow")
                else -> strings.t("pageRequest.ok")
            }
            val okLabel = if (request.kind == "external") strings.t("pageRequest.openElsewhere") else ok
            PillButton(ok, Modifier.testTag("page-request-ok").semantics { contentDescription = okLabel }, onClick = submit)
        }
        if (request.url.isNotEmpty()) {
            BayText(request.url, Modifier.padding(top = Space.xs).testTag("page-request-url"), variant = TextVariant.SUBHEAD, tone = TextTone.MUTED, maxLines = 1)
        }
    }
}

/** What a page asking for a device says, in Bay's own words. */
private fun permissionMessage(permission: String?): String = when (permission) {
    "microphone" -> "pageRequest.permission.microphone"
    "location" -> "pageRequest.permission.location"
    "camera-microphone" -> "pageRequest.permission.cameraMicrophone"
    else -> "pageRequest.permission.camera"
}

@Composable
private fun Field(value: String, onChange: (String) -> Unit, label: String, testID: String, secret: Boolean = false, onDone: () -> Unit) {
    val colors = Theme.colors
    Box(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).background(colors.fill, CircleShape).padding(horizontal = Space.lg),
        contentAlignment = Alignment.CenterStart,
    ) {
        BasicTextField(
            value,
            onChange,
            Modifier.fillMaxWidth().testTag(testID).semantics { contentDescription = label },
            singleLine = true,
            textStyle = TextVariant.BODY.style(color = colors.foreground),
            cursorBrush = SolidColor(colors.accent),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(
                autoCorrectEnabled = false,
                keyboardType = if (secret) KeyboardType.Password else KeyboardType.Text,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            decorationBox = { inner ->
                Box {
                    if (value.isEmpty()) BayText(label, tone = TextTone.MUTED)
                    inner()
                }
            },
        )
    }
}
