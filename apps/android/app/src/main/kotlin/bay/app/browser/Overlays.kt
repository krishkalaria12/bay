package bay.app.browser

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import bay.app.Strings
import bay.core.BrowserTab
import bay.core.hostOf
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.Radius
import bay.design.Space
import bay.design.TextTone
import bay.design.TextVariant
import bay.design.Theme
import bay.design.baySurface
import bay.design.pressFeedback

/** One short message above the bar, with its action (Undo) when it has one. TalkBack reads it as it appears. */
@Composable
fun Toast(toast: ToastMessage, onDone: () -> Unit) {
    val view = LocalView.current
    LaunchedEffect(toast.id) { view.announceForAccessibility(toast.actionLabel?.let { "${toast.text}. $it" } ?: toast.text) }
    Row(
        Modifier.fillMaxWidth().baySurface(Radius.card)
            .padding(start = Space.lg, end = if (toast.action == null) Space.lg else Space.xs + 2.dp, top = if (toast.action == null) Space.md else Space.xs + 2.dp, bottom = if (toast.action == null) Space.md else Space.xs + 2.dp),
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        BayText(toast.text, Modifier.weight(1f).testTag("toast").semantics { liveRegion = LiveRegionMode.Polite }, variant = TextVariant.CALLOUT, maxLines = 2)
        val label = toast.actionLabel
        val action = toast.action
        if (label != null && action != null) {
            Box(
                Modifier.heightIn(min = 44.dp).testTag("toast-action")
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button }
                    .pressFeedback {
                        onDone()
                        action()
                    }
                    .padding(horizontal = Space.lg),
                contentAlignment = Alignment.Center,
            ) { BayText(label, variant = TextVariant.CALLOUT, weight = FontWeight.SemiBold, tone = TextTone.ACCENT) }
        }
    }
}

/** Media playing in a tab that isn't on screen: tap to go back to it, play or pause it, skip ten seconds, or stop it. */
@Composable
fun MiniPlayer(browser: BrowserModel, strings: Strings, tab: BrowserTab, media: TabMedia) {
    val title = media.report.title.ifEmpty { tab.title }
    val playing = media.report.playing
    Row(
        Modifier.fillMaxWidth().baySurface(Radius.card).padding(start = Space.md + 2.dp, end = Space.xs + 2.dp, top = Space.xs + 2.dp, bottom = Space.xs + 2.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            Modifier.weight(1f).testTag("mini-player")
                .clearAndSetSemantics {
                    contentDescription = "$title, ${if (playing) strings.t("player.playing") else strings.t("player.paused")}. ${strings.t("player.goToTab")}"
                    role = Role.Button
                }
                .pressFeedback { browser.activate(tab.id) }
                .padding(vertical = 4.dp),
        ) {
            BayText(title, variant = TextVariant.CALLOUT, weight = FontWeight.Medium, maxLines = 1)
            BayText(hostOf(tab.url), variant = TextVariant.FOOTNOTE, tone = TextTone.MUTED, maxLines = 1)
        }
        PlayerButton("mini-player-back", strings.t("player.backTen"), BayIcon.BACK) { browser.seekMedia(tab.id, -10) }
        PlayerButton("mini-player-toggle", if (playing) strings.t("player.pause") else strings.t("player.play"), if (playing) BayIcon.PAUSE else BayIcon.PLAY, strong = true) {
            browser.toggleMedia(tab.id)
        }
        PlayerButton("mini-player-forward", strings.t("player.forwardTen"), BayIcon.FORWARD) { browser.seekMedia(tab.id, 10) }
        if (media.report.video) PlayerButton("mini-player-pip", strings.t("player.pictureInPicture"), BayIcon.PIP) { browser.pictureInPicture(tab.id) }
        PlayerButton("mini-player-close", strings.t("player.stopAndClose"), BayIcon.CLOSE) { browser.stopMedia(tab.id) }
    }
}

@Composable
private fun PlayerButton(id: String, label: String, icon: BayIcon, strong: Boolean = false, onClick: () -> Unit) {
    val size: Dp = if (strong) 22.dp else 20.dp
    Box(
        Modifier.size(44.dp).testTag(id).clearAndSetSemantics { contentDescription = label; role = Role.Button }.pressFeedback(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { BayIconView(icon, size = size, color = if (strong) Theme.colors.foreground else Theme.colors.muted) }
}

/** Covers a private page after Bay has been in the background, until the fingerprint, face or screen lock unlocks it. */
@Composable
fun PrivateLock(strings: Strings, onUnlock: () -> Unit) {
    val ink = Color(0xFFF4F4F5)
    Column(
        Modifier.fillMaxSize().background(Color(0xFF0A0A0A)).testTag("private-lock"),
        verticalArrangement = Arrangement.spacedBy(Space.lg, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        BayIconView(BayIcon.LOCK, size = 34.dp, color = ink)
        BayText(strings.t("lock.title"), Modifier.semantics { heading() }, variant = TextVariant.HEADLINE, color = ink)
        Box(
            Modifier.heightIn(min = 48.dp).testTag("private-unlock")
                .clearAndSetSemantics { contentDescription = strings.t("lock.unlock"); role = Role.Button }
                .pressFeedback(onClick = onUnlock)
                .background(Color.White.copy(alpha = 0.15f), CircleShape)
                .padding(horizontal = Space.xl),
            contentAlignment = Alignment.Center,
        ) { BayText(strings.t("lock.unlock"), color = ink) }
    }
}
