package bay.app

import android.view.View
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.accessibility.enableAccessibilityChecks
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.tryPerformAccessibilityChecks
import androidx.test.ext.junit.runners.AndroidJUnit4
import bay.engine.BayEngineView
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityCheckResultUtils.matchesViews
import com.google.android.apps.common.testing.accessibility.framework.integrations.espresso.AccessibilityValidator
import org.hamcrest.Description
import org.hamcrest.TypeSafeMatcher
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The accessibility audit (plan N6): runs Google's Accessibility Test Framework, the checks behind Android's
 * Accessibility Scanner, over the main screens: the search card, a page's menu, the tab switcher, Settings and the start
 * page. Any error (an unlabelled control, a touch target under 48dp, low contrast, duplicate labels) fails the test.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
class AccessibilityAuditTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    private val validator = AccessibilityValidator()
        .setRunChecksFromRootView(true)
        // The page is the site's own content, which Bay can't fix: the engine's views are left out.
        .setSuppressingResultMatcher(matchesViews(engineViews))

    @Test
    fun mainScreens() {
        rule.enableAccessibilityChecks(validator)
        tag("welcome-skip").takeIf { exists("welcome-skip") }?.performClick()

        // Bay opens ready to type; else the bar's field opens the card.
        if (!exists("address-input")) tag("bar-search").performClick()
        await("address-input")
        check("search card")

        tag("address-input").performTextReplacement("https://example.com")
        tag("address-input").performImeAction()
        await("bar-more")
        tag("bar-more").performClick()
        await("page-menu")
        check("page menu")

        // Sheets have no close button: Back closes them.
        androidx.test.espresso.Espresso.pressBack()
        await("bar-tabs")
        tag("bar-tabs").performClick()
        await("tab-switcher-settings")
        check("tab switcher")

        tag("tab-switcher-settings").performClick()
        await("settings-general")
        check("Settings")

        tag("settings-screen-close").performClick()
        await("tab-close-0")
        tag("tab-close-0").performClick()
        await("tab-card-0")
        tag("tab-card-0").performClick()
        await("start-screen")
        check("start page")
    }

    private fun tag(tag: String): SemanticsNodeInteraction = rule.onNode(hasTestTag(tag), useUnmergedTree = true)

    private fun exists(tag: String) = rule.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun await(tag: String) = rule.waitUntil(15_000) { exists(tag) }

    private fun check(screen: String) {
        rule.waitForIdle()
        runCatching { rule.onRoot(useUnmergedTree = true).tryPerformAccessibilityChecks() }
            .onFailure { throw AssertionError("$screen: ${it.message}", it) }
    }
}

/** The page engine's views, and what's inside them. */
private val engineViews = object : TypeSafeMatcher<View>() {
    override fun describeTo(description: Description) {
        description.appendText("a view of the page engine")
    }

    override fun matchesSafely(view: View) =
        generateSequence(view) { it.parent as? View }.any { it is BayEngineView || it.javaClass.name.startsWith("org.chromium.") }
}
