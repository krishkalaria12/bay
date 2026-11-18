package bay.app.welcome

import android.app.Activity
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.invisibleToUser
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import bay.app.AppModel
import bay.app.R
import bay.app.Strings
import bay.core.Action
import bay.core.PreferencesUpdate
import bay.core.StageRect
import bay.core.WelcomeForward
import bay.core.WelcomeLink
import bay.core.WelcomeSpring
import bay.core.WelcomeStep
import bay.core.WelcomeWay
import bay.core.asksAboutLinks
import bay.core.hero
import bay.core.skipOpensField
import bay.core.stageNeeds
import bay.core.welcomeBack
import bay.core.welcomeContent
import bay.core.welcomeForward
import bay.core.welcomePageCount
import bay.core.welcomePageOf
import bay.design.BayIcon
import bay.design.BayIconView
import bay.design.BayText
import bay.design.BayToggle
import bay.design.Haptics
import bay.design.IconSize
import bay.design.Space
import bay.design.TextVariant
import bay.design.pressFeedback
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

// The first launch, ported from Yab's first run (Phone/Sources/Welcome/FirstRun.swift, Apache-2.0) with Bay's pages,
// drawn the way Bay's Android surfaces are: flat translucent plates with a hairline edge and no imitation glass. One
// plate goes through every page and becomes the next page's thing: the name squeezes into the desktop link, that
// becomes the field, the private field, a tab, and at the end the real search field. Which page follows which, the
// stage's numbers and the demonstrations' content come from the core (`welcomeForward`, `hero`, `welcomeContent`).

/** The welcome's state: the page on screen and the pages' own life. */
class FirstRun(private val strings: Strings, val asksLinks: Boolean, val reduced: Boolean, private val scope: CoroutineScope) {
    var step by mutableStateOf(WelcomeStep.WELCOME)
        private set
    /** The private page's glasses are on: the page is night. */
    var privateOn by mutableStateOf(false)
        private set
    /** A finger on the name: its jelly, counted. */
    var pokes by mutableIntStateOf(0)
        private set
    /** The field page: what the field is typing, what landed in each way, and the way just lit. */
    var typed by mutableStateOf("")
        private set
    val landed = mutableStateListOf("", "", "")
    var lit by mutableStateOf<Int?>(null)
        private set
    /** The links page: the tab in front, and a link on its way in from another app. */
    var linkShown by mutableIntStateOf(0)
        private set
    var linkComing by mutableStateOf<Int?>(null)
        private set
    var linkLanding by mutableStateOf(false)
        private set
    /** The welcome is fading off the browser. */
    var leaving by mutableStateOf(false)
        private set

    val content = welcomeContent()
    private var loop: Job? = null
    private var phrase = 0
    private var finished = false

    val pages: Int get() = welcomePageCount(asksLinks).toInt()
    val page: Int get() = welcomePageOf(step, asksLinks).toInt()

    fun go(next: WelcomeStep) {
        loop?.cancel()
        step = next
        if (next != WelcomeStep.PRIVATE) privateOn = false
        when (next) {
            WelcomeStep.FIELD -> startTyping(now = false)
            WelcomeStep.LINKS -> startLinks()
            else -> {}
        }
    }

    /** Where the page's one button goes: on, or the end (the links page asks its own question first). */
    fun forward(): WelcomeForward = welcomeForward(step, asksLinks)

    fun back(): Boolean {
        val previous = welcomeBack(step) ?: return false
        go(previous)
        return true
    }

    /** Ends the welcome: `openField` when skipped early, so the glass hands over to the real field. */
    fun finish(openField: Boolean, onDone: (Boolean) -> Unit) {
        if (finished) return
        finished = true
        loop?.cancel()
        if (openField) go(WelcomeStep.END)
        scope.launch {
            // The plate reaches the field's place before the welcome fades off it.
            if (openField && !reduced) delay(420)
            leaving = true
            delay(if (reduced) 150 else 300)
            onDone(openField)
        }
    }

    fun skipOpensField(): Boolean = skipOpensField(step)

    fun poke() {
        pokes += 1
    }

    fun togglePrivate() {
        privateOn = !privateOn
    }

    fun tapField() = startTyping(now = true)

    /** The field types a phrase, and the phrase lands in its way. A tap on the field types the next one at once. */
    private fun startTyping(now: Boolean) {
        loop?.cancel()
        typed = ""
        val phrases = content.phrases
        if (reduced) {
            phrases.take(3).forEachIndexed { i, it -> landed[i] = strings.t(it.landed) }
            return
        }
        loop = scope.launch {
            if (!now) delay(500)
            while (isActive && step == WelcomeStep.FIELD) {
                val next = phrases[phrase % phrases.size]
                phrase += 1
                for (letter in strings.t(next.typed)) {
                    typed += letter
                    delay(42)
                }
                delay(380)
                val way = when (next.way) {
                    WelcomeWay.SEARCH -> 0
                    WelcomeWay.GO_TO_SITE -> 1
                    WelcomeWay.YOUR_TABS -> 2
                }
                landed[way] = strings.t(next.landed)
                typed = ""
                lit = way
                delay(450)
                lit = null
                delay(900)
            }
        }
    }

    /** A link comes in from another app every couple of seconds and becomes the tab in front. */
    private fun startLinks() {
        loop?.cancel()
        if (reduced) return
        loop = scope.launch {
            while (isActive && step == WelcomeStep.LINKS) {
                delay(1100)
                val next = (linkShown + 1) % content.links.size
                linkComing = next
                linkLanding = false
                delay(900)
                linkLanding = true
                delay(380)
                linkShown = next
                linkComing = null
                linkLanding = false
            }
        }
    }
}

/** A spring from the prototype's numbers: how long it takes to settle and how much it bounces. */
private fun <T> WelcomeSpring.spec(reduced: Boolean): FiniteAnimationSpec<T> =
    if (reduced) {
        tween(200)
    } else {
        spring(dampingRatio = dampingRatio.toFloat(), stiffness = ((2 * PI / response) * (2 * PI / response)).toFloat())
    }

/** The first run's colours: Bay's paper and ink, with the icon's evening in it, as the Expo app drew them. */
private class WelcomeColors(
    val ground: Color,
    val groundTop: Color,
    val glow: Color,
    val dot: Color,
    val ink: Color,
    val words: Color,
    val faint: Color,
    val accent: Color,
    val button: Color,
    val buttonText: Color,
    val tile: Color,
    val plate: Color,
    val hairline: Color,
) {
    companion object {
        val light = WelcomeColors(
            ground = Color(0xFFF4F0E8), groundTop = Color(0xFFF7E6DC), glow = Color(0xFFE8613C), dot = Color(0x0F1C1B19),
            ink = Color(0xFF1C1B19), words = Color(0xFF4A4741), faint = Color(0x521C1B19), accent = Color(0xFFE8613C),
            button = Color(0xFF1C1B19), buttonText = Color(0xFFF4F0E8), tile = Color.White, plate = Color(0xDBFFFFFF),
            hairline = Color(0x1A1C1B19),
        )
        val dark = WelcomeColors(
            ground = Color(0xFF121216), groundTop = Color(0xFF1C1A2A), glow = Color(0xFF6A5A9A), dot = Color(0x0BF3F2EF),
            ink = Color(0xFFF3F2EF), words = Color(0xFFD1CDC6), faint = Color(0x52F3F2EF), accent = Color(0xFFF0784F),
            button = Color(0xFFF3F2EF), buttonText = Color(0xFF121216), tile = Color(0x1FFFFFFF), plate = Color(0xE626252C),
            hairline = Color(0x1AF3F2EF),
        )
        /** Private's night: the ground once the glasses are on. */
        val night = Color(0xFF060608)
        val green = Color(0xFF34C759)
    }
}

private val nightInk = Color(0xE0FFFFFF)
private val NameFace = FontFamily(Font(R.font.inter_black, FontWeight.Black))
private val PenFace = FontFamily(Font(R.font.caveat_semibold, FontWeight.SemiBold))

/** How a plate reads: `clear` lets what's behind show, `solid` hides it, `night` is the private page at night. */
private enum class Tone { CLEAR, SOLID, NIGHT }

/** A flat translucent plate with a hairline edge, Android's stand-in for iOS's glass. */
private fun Modifier.plate(colors: WelcomeColors, radius: Dp, tone: Tone = Tone.CLEAR): Modifier {
    val shape = RoundedCornerShape(radius)
    val fill = when (tone) {
        Tone.NIGHT -> Color(0xEB1A1A1E)
        Tone.SOLID -> colors.tile
        Tone.CLEAR -> colors.plate
    }
    val edge = if (tone == Tone.NIGHT) Color(0x1FFFFFFF) else colors.hairline
    return this.background(fill, shape).border(0.5.dp, edge, shape)
}

/** The welcome's own parts read this: the run, its colours and the phone's lean. */
private class Run(val run: FirstRun, val colors: WelcomeColors, val strings: Strings, val tilt: Tilt)

/** How the phone leans: -1 to 1 on each axis, followed slowly as the way it's held changes. */
private class Tilt {
    var x by mutableFloatStateOf(0f)
    var y by mutableFloatStateOf(0f)
}

/** A layer of the drawing at `depth`: positive comes toward the hand, negative lies behind. */
private fun Modifier.parallax(tilt: Tilt, depth: Float): Modifier =
    graphicsLayer {
        translationX = tilt.x * depth * density
        translationY = -tilt.y * depth * density
    }

/** Device motion's gravity, while the welcome is on screen; off with animations off and where there's no sensor. */
@Composable
private fun rememberTilt(enabled: Boolean): Tilt {
    val context = LocalContext.current
    val tilt = remember { Tilt() }
    DisposableEffect(enabled) {
        val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val gravity = sensors?.getDefaultSensor(Sensor.TYPE_GRAVITY)
        if (!enabled || sensors == null || gravity == null) return@DisposableEffect onDispose {}
        var rest: Pair<Float, Float>? = null
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                // Gravity in g: the screen's sideways and upward axes.
                val gx = -event.values[0] / 9.81f
                val gy = event.values[1] / 9.81f
                val middle = rest ?: (gx to gy)
                // A new way of holding it becomes the middle over a few seconds.
                val mx = middle.first + (gx - middle.first) * 0.012f
                val my = middle.second + (gy - middle.second) * 0.012f
                rest = mx to my
                // A quarter of a turn's gravity (about 15°) is the whole way; smoothed, so the hand's tremor never shows.
                val nx = ((gx - mx) / 0.26f).coerceIn(-1f, 1f)
                val ny = ((gy - my) / 0.26f).coerceIn(-1f, 1f)
                tilt.x += (nx - tilt.x) * 0.16f
                tilt.y += (ny - tilt.y) * 0.16f
            }

            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
        }
        sensors.registerListener(listener, gravity, SensorManager.SENSOR_DELAY_GAME)
        onDispose {
            sensors.unregisterListener(listener)
            tilt.x = 0f
            tilt.y = 0f
        }
    }
    return tilt
}

/** Whether the phone's animations are off (Remove animations), which Bay reads as Reduce Motion. */
fun animationsOff(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

private const val STAGE_TOP = 48
private const val STAGE_GAP = 16
private const val BAR = 48
private const val COLUMN = 440
private const val MAX_SCALE = 1.1f

/**
 * The welcome over the browser. `onDone` reveals it: `true` when skipped early, so the real field takes over. Nothing
 * here asks for a permission on its own: the lock asks only once its switch is turned on.
 */
@Composable
fun FirstRunScreen(app: AppModel, strings: Strings, dark: Boolean, onDone: (Boolean) -> Unit) {
    val context = LocalContext.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val reduced = remember { animationsOff(context) }
    val run = remember { FirstRun(strings, asksAboutLinks(DefaultBrowserStatus.current(context)), reduced, scope) }
    val night = run.step == WelcomeStep.PRIVATE && run.privateOn
    // Night reads like dark mode: light ink on the dark ground.
    val colors = if (night || dark) WelcomeColors.dark else WelcomeColors.light
    val parts = Run(run, colors, strings, rememberTilt(!reduced))
    val makeDefault = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        when (DefaultBrowserStatus.current(context)) {
            bay.core.DefaultBrowser.DEFAULT -> Haptics.done(view)
            // Refused twice, Android answers at once: Default apps settings then.
            else -> if (result.resultCode == Activity.RESULT_CANCELED) runCatching { context.startActivity(DefaultBrowserStatus.settings()) }
        }
        run.finish(false, onDone)
    }
    val actions = object : WelcomeActions {
        override fun forward() {
            if (run.step == WelcomeStep.LINKS) {
                Haptics.tick(view)
                val ask = DefaultBrowserStatus.request(context)
                if (ask != null) makeDefault.launch(ask) else run.finish(false, onDone)
                return
            }
            Haptics.press(view)
            when (val next = run.forward()) {
                is WelcomeForward.To -> run.go(next.step)
                WelcomeForward.Finish -> run.finish(false, onDone)
            }
        }

        override fun back() {
            if (run.back()) Haptics.press(view)
        }

        override fun skip() {
            Haptics.press(view)
            run.finish(run.skipOpensField(), onDone)
        }
    }
    BackHandler { actions.back() }
    val fade by animateFloatAsState(if (run.leaving) 0f else 1f, tween(if (reduced) 150 else 300), label = "welcome")
    Box(
        Modifier.fillMaxSize().graphicsLayer { alpha = fade }.testTag("welcome")
            // The welcome is the screen: a tap anywhere stays in it.
            .pointerInput(Unit) { detectTapGestures {} },
    ) {
        Ground(parts, night)
        BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.TopCenter) {
            Screen(parts, app, min(maxWidth.value, COLUMN.toFloat()).dp, maxHeight, actions)
        }
    }
}

private interface WelcomeActions {
    fun forward()
    fun back()
    fun skip()
}

@Composable
private fun Screen(parts: Run, app: AppModel, width: Dp, height: Dp, actions: WelcomeActions) {
    val run = parts.run
    val density = LocalDensity.current
    var bottom by remember { mutableFloatStateOf(300f) }
    val stageWidth = run.content.stageWidth.toFloat()
    val stageHeight = run.content.stageHeight.toFloat()
    val available = height.value - bottom - STAGE_TOP - STAGE_GAP
    val needs = stageNeeds(run.step).toFloat()
    val k = max(0.45f, min(min(width.value / stageWidth, MAX_SCALE), available / needs))
    // The drawing a little above the middle of the room it has.
    val air = max(0f, (available - needs * k) * 0.4f)
    val morph = run.content.motion.morph
    val scale by animateFloatAsState(k, morph.spec(run.reduced), label = "scale")
    val top by animateFloatAsState(air, morph.spec(run.reduced), label = "air")
    Box(Modifier.width(width).fillMaxHeight()) {
        Box(
            Modifier.offset(x = ((width.value - stageWidth * scale) / 2).dp, y = (STAGE_TOP + top).dp)
                .wrapContentSize(Alignment.TopStart, unbounded = true)
                .requiredSize(stageWidth.dp, stageHeight.dp)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    transformOrigin = TransformOrigin(0f, 0f)
                },
        ) { Stage(parts) }
        Column(Modifier.fillMaxSize()) {
            Bar(parts, actions)
            Spacer(Modifier.weight(1f))
            Box(Modifier.onSizeChanged { bottom = with(density) { it.height.toDp().value } }) {
                Bottom(parts, app, actions, max(120f, height.value * 0.42f).dp)
            }
        }
    }
}

/** The ground: Bay's paper under the icon's glow, its dots barely there; Bay's night in dark mode; night once private. */
@Composable
private fun Ground(parts: Run, night: Boolean) {
    val colors = parts.colors
    val dark by animateFloatAsState(if (night) 1f else 0f, tween(if (parts.run.reduced) 0 else 450), label = "night")
    val shown by animateFloatAsState(if (parts.run.step == WelcomeStep.END) 0f else 1f, tween(450), label = "ground")
    Canvas(Modifier.fillMaxSize().graphicsLayer { alpha = shown }.clearAndSetSemantics {}) {
        drawRect(Brush.verticalGradient(0f to colors.groundTop, 0.42f to colors.ground, 1f to colors.ground))
        drawRect(
            Brush.radialGradient(
                listOf(colors.glow.copy(alpha = 0.26f), colors.glow.copy(alpha = 0f)),
                center = Offset(size.width / 2, -size.height * 0.08f),
                radius = size.width * 1.3f,
            ),
        )
        val step = 18.dp.toPx()
        var x = step / 2
        while (x < size.width) {
            var y = step / 2
            while (y < size.height) {
                drawCircle(colors.dot, radius = 1.dp.toPx(), center = Offset(x, y))
                y += step
            }
            x += step
        }
        drawRect(WelcomeColors.night.copy(alpha = dark))
    }
}

/** ‹, the dots and Skip. */
@Composable
private fun Bar(parts: Run, actions: WelcomeActions) {
    val run = parts.run
    val colors = parts.colors
    val strings = parts.strings
    val back = welcomeBack(run.step) != null
    val skip = run.step != WelcomeStep.END
    Box(Modifier.fillMaxWidth().height(BAR.dp).padding(horizontal = Space.lg).padding(top = Space.xs)) {
        Box(
            Modifier.align(Alignment.CenterStart).size(44.dp).graphicsLayer { alpha = if (back) 1f else 0f }.plate(colors, 22.dp)
                .testTag("welcome-back")
                .then(
                    if (back) Modifier.semantics { contentDescription = strings.t("welcome.back"); role = Role.Button }
                    else Modifier.clearAndSetSemantics {},
                )
                .pressFeedback(enabled = back, onClick = actions::back),
            contentAlignment = Alignment.Center,
        ) { BayIconView(BayIcon.BACK, size = IconSize.small, color = colors.ink) }
        Row(
            Modifier.align(Alignment.Center).graphicsLayer { alpha = if (skip) 1f else 0f }.clearAndSetSemantics {},
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            repeat(run.pages) { i ->
                val on = i == run.page
                val dotWidth by animateDpAsState(if (on) 22.dp else 7.dp, run.content.motion.dots.spec(run.reduced), label = "dot")
                Box(Modifier.size(dotWidth, 7.dp).background(if (on) colors.ink else colors.faint, CircleShape))
            }
        }
        Box(
            Modifier.align(Alignment.CenterEnd).height(44.dp).graphicsLayer { alpha = if (skip) 1f else 0f }.plate(colors, 22.dp)
                .testTag("welcome-skip")
                .then(if (skip) Modifier.semantics { role = Role.Button } else Modifier.clearAndSetSemantics {})
                .pressFeedback(enabled = skip, onClick = actions::skip)
                .padding(horizontal = Space.lg),
            contentAlignment = Alignment.Center,
        ) { BayText(strings.t("welcome.skip"), weight = FontWeight.Medium, color = colors.ink) }
    }
}

/** Each page's title and words, its one setting, and its button. */
@Composable
private fun Bottom(parts: Run, app: AppModel, actions: WelcomeActions, maxWords: Dp) {
    val run = parts.run
    val colors = parts.colors
    val strings = parts.strings
    val keys = when (run.step) {
        WelcomeStep.WELCOME -> "welcome.title.welcome" to "welcome.words.welcome"
        WelcomeStep.DESKTOP -> "welcome.title.desktop" to "welcome.words.desktop"
        WelcomeStep.FIELD -> "welcome.title.field" to "welcome.words.field"
        WelcomeStep.PRIVATE -> "welcome.title.private" to "welcome.words.private"
        WelcomeStep.LINKS -> "welcome.title.links" to "welcome.words.links.android"
        WelcomeStep.END -> null
    }
    val shown by animateFloatAsState(if (run.step == WelcomeStep.END) 0f else 1f, tween(200), label = "bottom")
    Column(Modifier.padding(horizontal = Space.section).padding(bottom = Space.sm).graphicsLayer { alpha = shown }) {
        AnimatedContent(keys, transitionSpec = { fadeIn(tween(300, 80)) togetherWith fadeOut(tween(140)) }, label = "words") { words ->
            if (words != null) {
                Column(
                    Modifier.padding(horizontal = 6.dp).heightIn(max = maxWords).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(Space.sm + 2.dp),
                ) {
                    BayText(
                        strings.t(words.first), Modifier.testTag("welcome-title").semantics { heading() },
                        variant = TextVariant.DISPLAY, weight = FontWeight.Bold, color = colors.ink,
                    )
                    BayText(strings.t(words.second), Modifier.testTag("welcome-words"), color = colors.words)
                }
            }
        }
        SettingRow(parts, app)
        CallButton(parts, actions)
    }
}

/** The page's one setting, on a plate: the field page's keyboard, the private page's lock. */
@Composable
private fun SettingRow(parts: Run, app: AppModel) {
    val run = parts.run
    val colors = parts.colors
    val strings = parts.strings
    val context = LocalContext.current
    val view = LocalView.current
    val step = run.step
    AnimatedVisibility(step == WelcomeStep.FIELD || step == WelcomeStep.PRIVATE, enter = fadeIn(tween(240, 100)), exit = fadeOut(tween(120))) {
        val keyboard = step == WelcomeStep.FIELD
        val on = if (keyboard) app.preferences.openSearchOnLaunch else app.preferences.lockPrivateTabs
        val label = strings.t(if (keyboard) "settings.searchOnLaunch" else "settings.lockPrivate")
        val detail = strings.t(if (keyboard) "settings.searchOnLaunch.detail" else "settings.lockPrivate.detail")
        Row(
            Modifier.padding(top = 22.dp).fillMaxWidth().heightIn(min = 64.dp).plate(colors, 30.dp)
                .testTag(if (keyboard) "welcome-keyboard" else "welcome-lock")
                .clearAndSetSemantics {
                    contentDescription = "$label. $detail"
                    role = Role.Switch
                    toggleableState = ToggleableState(on)
                }
                .pressFeedback {
                    Haptics.tick(view)
                    if (keyboard) {
                        app.dispatch(Action.Preferences(PreferencesUpdate(null, null, null, null, null, null, null, null, !on, null, null)))
                    } else if (on) {
                        app.dispatch(Action.LockPrivateTabs(false))
                    } else {
                        // Turning the lock on proves the fingerprint, face or screen lock works before relying on it.
                        (context as? Activity)?.let { prove(it, strings) { app.dispatch(Action.LockPrivateTabs(true)) } }
                    }
                }
                .padding(start = Space.section, end = Space.lg, top = Space.sm + 2.dp, bottom = Space.sm + 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
                BayText(label, weight = FontWeight.Medium, color = colors.ink)
                BayText(detail, variant = TextVariant.FOOTNOTE, color = colors.words)
            }
            BayToggle(on)
        }
    }
}

private fun prove(activity: Activity, strings: Strings, then: () -> Unit) {
    val builder = BiometricPrompt.Builder(activity).setTitle(strings.t("lock.prompt"))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        builder.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
    } else {
        @Suppress("DEPRECATION")
        builder.setDeviceCredentialAllowed(true)
    }
    builder.build().authenticate(CancellationSignal(), activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult?) = then()
    })
}

/** The page's one button, in ink. */
@Composable
private fun CallButton(parts: Run, actions: WelcomeActions) {
    val run = parts.run
    val colors = parts.colors
    val (key, id) = when (run.step) {
        WelcomeStep.WELCOME -> "welcome.start" to "welcome-start"
        WelcomeStep.LINKS -> "welcome.makeDefault" to "welcome-make-default"
        else -> "welcome.continue" to "welcome-next"
    }
    val label = parts.strings.t(key)
    Box(
        Modifier.padding(top = Space.lg).fillMaxWidth().height(56.dp).background(colors.button, CircleShape).testTag(id)
            .semantics { role = Role.Button; contentDescription = label }
            .pressFeedback(enabled = run.step != WelcomeStep.END, onClick = actions::forward),
        contentAlignment = Alignment.Center,
    ) {
        AnimatedContent(label, transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(120)) }, label = "call") {
            BayText(it, Modifier.clearAndSetSemantics {}, variant = TextVariant.HEADLINE, color = colors.buttonText)
        }
    }
}

// The stage: the drawing above the words, 402 wide in its own units.

private fun Modifier.at(rect: StageRect): Modifier = offset(rect.x.toFloat().dp, rect.y.toFloat().dp).size(rect.width.toFloat().dp, rect.height.toFloat().dp)

@Composable
private fun Stage(parts: Run) {
    val run = parts.run
    val step = run.step
    Box(Modifier.fillMaxSize()) {
        AnimatedVisibility(step == WelcomeStep.WELCOME, enter = fadeIn(tween(300)), exit = fadeOut(tween(300))) {
            DriftRows(parts, Modifier.offset(y = 48.dp).parallax(parts.tilt, -12f))
        }
        AnimatedVisibility(step == WelcomeStep.DESKTOP, enter = fadeIn(tween(400)), exit = fadeOut(tween(200))) {
            DesktopPicture(parts, Modifier.offset(31.dp, 90.dp).parallax(parts.tilt, -7f))
        }
        AnimatedVisibility(step == WelcomeStep.FIELD, enter = fadeIn(tween(340, 120)), exit = fadeOut(tween(150))) {
            FieldWays(parts, Modifier.offset(20.dp, 160.dp).parallax(parts.tilt, 3f))
        }
        AnimatedVisibility(step == WelcomeStep.PRIVATE, enter = fadeIn(tween(300)), exit = fadeOut(tween(150))) {
            PrivateAround(parts, Modifier.parallax(parts.tilt, -6f))
        }
        AnimatedVisibility(step == WelcomeStep.LINKS, enter = fadeIn(tween(300)), exit = fadeOut(tween(150))) {
            LinksBehind(parts, Modifier.parallax(parts.tilt, -8f))
        }
        Name(parts)
        Hero(parts)
        LinkPill(parts)
    }
}

/** The one plate, in this page's shape, with this page's thing on it. */
@Composable
private fun Hero(parts: Run) {
    val run = parts.run
    val step = run.step
    val target = hero(step)
    val spec = run.content.motion.morph
    val x by animateFloatAsState(target.x.toFloat(), spec.spec(run.reduced), label = "x")
    val y by animateFloatAsState(target.y.toFloat(), spec.spec(run.reduced), label = "y")
    val w by animateFloatAsState(target.width.toFloat(), spec.spec(run.reduced), label = "w")
    val h by animateFloatAsState(target.height.toFloat(), spec.spec(run.reduced), label = "h")
    // Only the fade waits for the letters to start squeezing; the shape itself moves on the page's spring.
    val shown by animateFloatAsState(
        if (step == WelcomeStep.WELCOME) 0f else 1f,
        if (step == WelcomeStep.WELCOME) tween(200) else tween(300, 120), label = "hero",
    )
    val tone = when {
        step == WelcomeStep.PRIVATE && run.privateOn -> Tone.NIGHT
        step == WelcomeStep.LINKS || step == WelcomeStep.END -> Tone.SOLID
        else -> Tone.CLEAR
    }
    val radius = target.radius.toFloat().dp
    Box(
        Modifier.offset(x.dp, y.dp).size(w.dp, h.dp).parallax(parts.tilt, 6f).graphicsLayer { alpha = shown }
            .plate(parts.colors, radius, tone).clip(RoundedCornerShape(radius))
            .then(if (step == WelcomeStep.WELCOME) Modifier.clearAndSetSemantics {} else Modifier),
    ) {
        AnimatedContent(
            if (step == WelcomeStep.LINKS) "links.${run.linkShown}" else step.name,
            transitionSpec = { fadeIn(tween(280)) togetherWith fadeOut(tween(140)) }, label = "hero",
        ) {
            when (step) {
                WelcomeStep.WELCOME -> Box(Modifier.fillMaxSize())
                WelcomeStep.DESKTOP -> DesktopLink(parts)
                WelcomeStep.FIELD -> TypingField(parts)
                WelcomeStep.PRIVATE -> PrivateField(parts)
                WelcomeStep.LINKS -> TabCard(parts, run.content.links[run.linkShown])
                WelcomeStep.END -> EndField(parts)
            }
        }
    }
}

/**
 * The name in solid ink: iOS draws it in glass that bends the sites behind; a plate-coloured name vanished into the
 * ground here. A finger on it: jelly. Get started: it squeezes into the next page's plate and fades.
 */
@Composable
private fun Name(parts: Run) {
    val run = parts.run
    val letters = run.content.letters
    val into = hero(WelcomeStep.DESKTOP)
    val melt by animateFloatAsState(if (run.step == WelcomeStep.WELCOME) 0f else 1f, run.content.motion.morph.spec(run.reduced), label = "melt")
    var squishX by remember { mutableFloatStateOf(1f) }
    var squishY by remember { mutableFloatStateOf(1f) }
    val jellyX by animateFloatAsState(squishX, tween(100), label = "jellyX")
    val jellyY by animateFloatAsState(squishY, tween(100), label = "jellyY")
    LaunchedEffect(run.pokes) {
        if (run.pokes == 0 || run.reduced) return@LaunchedEffect
        for ((x, y, ms) in listOf(Triple(1.1f, 0.86f, 100L), Triple(0.93f, 1.08f, 130L), Triple(1.04f, 0.97f, 130L), Triple(0.985f, 1.015f, 120L), Triple(1f, 1f, 220L))) {
            squishX = x
            squishY = y
            delay(ms)
        }
    }
    if (melt >= 0.999f) return
    val view = LocalView.current
    val density = LocalDensity.current
    // The letters as large as the box takes them: measured once at a known size, then scaled to fit its width and height.
    val measurer = rememberTextMeasurer()
    val name = parts.strings.t("welcome.name.text")
    val probe = remember(name) {
        measurer.measure(name, TextStyle(fontFamily = NameFace, fontWeight = FontWeight.Black, fontSize = with(density) { 100.dp.toSp() }, letterSpacing = (-0.045).em))
    }
    val fit = with(density) {
        min(letters.width.toFloat().dp.toPx() / probe.size.width, letters.height.toFloat().dp.toPx() * 1.25f / probe.size.height)
    }
    val size = with(density) { (100f * fit).dp.toSp() }
    val dx = (into.x + into.width / 2 - (letters.x + letters.width / 2)).toFloat()
    val dy = (into.y + into.height / 2 - (letters.y + letters.height / 2)).toFloat()
    Box(
        Modifier.at(letters).parallax(parts.tilt, 5f)
            .graphicsLayer {
                alpha = 1 - melt
                translationX = dx * melt * density.density
                translationY = dy * melt * density.density
                scaleX = (1 + (into.width.toFloat() / letters.width.toFloat() - 1) * melt) * jellyX
                scaleY = (1 + (into.height.toFloat() / letters.height.toFloat() - 1) * melt) * jellyY
                transformOrigin = TransformOrigin(0.5f, 1f)
            }
            .testTag("welcome-name")
            .semantics { contentDescription = parts.strings.t("welcome.name"); role = Role.Button }
            .pressFeedback(enabled = run.step == WelcomeStep.WELCOME) {
                Haptics.tick(view)
                run.poke()
            },
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.text.BasicText(
            name,
            // The descender may reach below the box, as the letters' own outline does on iOS.
            Modifier.wrapContentSize(unbounded = true).clearAndSetSemantics {},
            style = TextStyle(fontFamily = NameFace, fontWeight = FontWeight.Black, fontSize = size, letterSpacing = (-0.045).em, color = parts.colors.ink, textAlign = TextAlign.Center),
            maxLines = 1,
            softWrap = false,
        )
    }
}

private const val TILE = 76
private const val TILE_GAP = 18

/** Sites drifting by in three rows, the middle one the other way, fading out at either side. */
@Composable
private fun DriftRows(parts: Run, modifier: Modifier) {
    val width = parts.run.content.stageWidth.toFloat()
    Box(
        modifier.size(width.dp, 300.dp).clip(RoundedCornerShape(0.dp)).graphicsLayer { alpha = 0.6f; compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                drawRect(
                    Brush.horizontalGradient(0f to Color.Transparent, 0.14f to Color.Black, 0.86f to Color.Black, 1f to Color.Transparent),
                    blendMode = BlendMode.DstIn,
                )
            }
            .clearAndSetSemantics {},
    ) {
        DriftRow(parts, first = 0, period = 26, reverse = false, top = 10)
        DriftRow(parts, first = 4, period = 31, reverse = true, top = 108)
        DriftRow(parts, first = 8, period = 22, reverse = false, top = 206)
    }
}

@Composable
private fun DriftRow(parts: Run, first: Int, period: Int, reverse: Boolean, top: Int) {
    val sites = parts.run.content.driftSites
    val span = 9 * (TILE + TILE_GAP)
    val progress = if (parts.run.reduced) {
        0.18f
    } else {
        val moving = rememberInfiniteTransition(label = "drift")
        moving.animateFloat(0f, 1f, infiniteRepeatable(tween(period * 1000, easing = LinearEasing), RepeatMode.Restart), label = "drift").value
    }
    val p = if (reverse) 1 - progress else progress
    Row(
        Modifier.offset(y = top.dp).wrapContentSize(Alignment.TopStart, unbounded = true).graphicsLayer { translationX = -p * span * density },
        horizontalArrangement = Arrangement.spacedBy(TILE_GAP.dp),
    ) {
        repeat(18) { k ->
            Box(
                Modifier.size(TILE.dp).background(parts.colors.tile, RoundedCornerShape(20.dp)),
                contentAlignment = Alignment.Center,
            ) { SiteImage(sites[(first + k % 9) % sites.size], 40.dp) }
        }
    }
}

/** A site's own icon, shipped with Bay: a fresh install has been nowhere yet, so there's no saved one. */
@Composable
private fun SiteImage(host: String, size: Dp) {
    val context = LocalContext.current
    val id = remember(host) {
        @Suppress("DiscouragedApi")
        context.resources.getIdentifier("welcome_site_" + host.replace('.', '_'), "drawable", context.packageName)
    }
    if (id != 0) {
        Image(painterResource(id), null, Modifier.size(size).clip(RoundedCornerShape(size * 0.22f)))
    } else {
        Box(Modifier.size(size))
    }
}

// The desktop.

private const val BAY_SITE = "https://bay.krishkalaria.in"

@Composable
private fun DesktopPicture(parts: Run, modifier: Modifier) {
    Image(
        painterResource(R.drawable.welcome_mac), parts.strings.t("welcome.desktop.picture"),
        modifier.size(340.dp, 202.dp).clip(RoundedCornerShape(12.dp)),
        contentScale = ContentScale.Crop,
    )
}

@Composable
private fun DesktopLink(parts: Run) {
    val colors = parts.colors
    val strings = parts.strings
    val context = LocalContext.current
    val view = LocalView.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(2000)
            copied = false
        }
    }
    Row(Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        Image(painterResource(R.drawable.bay_mark), null, Modifier.size(40.dp).clip(RoundedCornerShape(12.dp)))
        Column(Modifier.weight(1f).clearAndSetSemantics { contentDescription = strings.t("welcome.desktop.siteLabel") }) {
            BayText(strings.t("welcome.desktop.app"), weight = FontWeight.SemiBold, color = colors.ink, maxLines = 1)
            BayText(BAY_SITE.removePrefix("https://"), variant = TextVariant.SUBHEAD, color = colors.words, maxLines = 1)
        }
        val label = strings.t(if (copied) "welcome.copied" else "welcome.copy")
        Row(
            Modifier.height(36.dp).background(Color(0xE6FFFFFF), CircleShape).testTag("welcome-copy-link")
                .clearAndSetSemantics { contentDescription = label; role = Role.Button }
                .pressFeedback {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager)
                        .setPrimaryClip(android.content.ClipData.newPlainText("Bay", BAY_SITE))
                    Haptics.press(view)
                    copied = true
                }
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            BayIconView(if (copied) BayIcon.CHECK else BayIcon.COPY, size = IconSize.inline, color = Color(0xFF1C1B19))
            BayText(label, variant = TextVariant.SUBHEAD, weight = FontWeight.SemiBold, color = Color(0xFF1C1B19))
        }
    }
}

// The field and its three ways.

private val GLYPH = 24.dp
private val INSET = 18.dp

@Composable
private fun TypingField(parts: Run) {
    val run = parts.run
    val colors = parts.colors
    val view = LocalView.current
    val placeholder = parts.strings.t("search.placeholder")
    Row(
        Modifier.fillMaxSize().testTag("welcome-demo-field")
            .clearAndSetSemantics { contentDescription = placeholder; role = Role.Button }
            .pressFeedback {
                Haptics.tick(view)
                run.tapField()
            }
            .padding(horizontal = INSET),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Box(Modifier.width(GLYPH), contentAlignment = Alignment.Center) { BayIconView(BayIcon.SEARCH, size = IconSize.control, color = colors.faint) }
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(1.dp)) {
            if (run.typed.isEmpty()) {
                BayText(placeholder, variant = TextVariant.HEADLINE, weight = FontWeight.Normal, color = colors.faint, maxLines = 1)
            } else {
                BayText(run.typed, variant = TextVariant.HEADLINE, weight = FontWeight.Normal, color = colors.ink, maxLines = 1)
            }
            Caret(run, colors.accent)
        }
        BayIconView(BayIcon.PRIVATE, size = IconSize.row, color = colors.ink)
    }
}

@Composable
private fun Caret(run: FirstRun, color: Color) {
    val on = if (run.reduced) {
        1f
    } else {
        val blink = rememberInfiniteTransition(label = "caret")
        blink.animateFloat(1f, 0f, infiniteRepeatable(keyframes { durationMillis = 1060; 1f at 0; 1f at 529; 0f at 530; 0f at 1059 }), label = "caret").value
    }
    Box(Modifier.size(2.dp, 24.dp).graphicsLayer { alpha = on }.background(color, RoundedCornerShape(1.dp)))
}

@Composable
private fun FieldWays(parts: Run, modifier: Modifier) {
    val run = parts.run
    val colors = parts.colors
    val strings = parts.strings
    val ways = listOf(strings.t("welcome.way.search") to BayIcon.SEARCH, strings.t("welcome.way.go") to BayIcon.LINK, strings.t("welcome.way.tabs") to BayIcon.TABS)
    Column(
        modifier.width(362.dp).plate(colors, 28.dp).clip(RoundedCornerShape(28.dp))
            .clearAndSetSemantics { contentDescription = ways.joinToString(", ") { it.first } },
    ) {
        ways.forEachIndexed { i, (label, icon) ->
            if (i > 0) Box(Modifier.padding(start = INSET + GLYPH + Space.md).fillMaxWidth().height(0.5.dp).background(colors.hairline))
            val lit by animateColorAsState(colors.accent.copy(alpha = if (run.lit == i) 0.1f else 0f), tween(300), label = "lit")
            Row(
                Modifier.fillMaxWidth().height(64.dp).background(lit).padding(horizontal = INSET),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                Box(Modifier.width(GLYPH), contentAlignment = Alignment.Center) { BayIconView(icon, size = IconSize.row, color = colors.words) }
                val landed = run.landed[i]
                Column(Modifier.weight(1f)) {
                    if (landed.isEmpty()) {
                        BayText(label, variant = TextVariant.HEADLINE, weight = FontWeight.Normal, color = colors.ink)
                    } else {
                        BayText(label, variant = TextVariant.FOOTNOTE, weight = FontWeight.SemiBold, color = colors.faint)
                        AnimatedContent(landed, transitionSpec = { fadeIn(tween(320)) togetherWith fadeOut(tween(120)) }, label = "landed") {
                            BayText(it, variant = TextVariant.HEADLINE, weight = FontWeight.Normal, color = colors.ink, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}

// Private.

@Composable
private fun PrivateField(parts: Run) {
    val run = parts.run
    val colors = parts.colors
    val strings = parts.strings
    val view = LocalView.current
    val night = run.privateOn
    val word by animateFloatAsState(if (night) 1f else 0f, tween(if (run.reduced) 0 else 450), label = "word")
    Row(
        Modifier.fillMaxSize().padding(start = INSET, end = Space.sm + 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Box(Modifier.width(GLYPH), contentAlignment = Alignment.Center) {
            BayIconView(BayIcon.SEARCH, size = IconSize.row, color = if (night) Color(0xB3FFFFFF) else colors.faint)
        }
        BayText(strings.t("search.placeholder"), Modifier.weight(1f), color = if (night) Color(0x80FFFFFF) else colors.faint, maxLines = 1)
        Row(
            Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).testTag("welcome-glasses")
                .clearAndSetSemantics {
                    contentDescription = strings.t(if (night) "welcome.private.off" else "welcome.private.onLabel")
                    role = Role.Button
                }
                .pressFeedback {
                    Haptics.tick(view)
                    run.togglePrivate()
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm, Alignment.End),
        ) {
            if (word > 0f) {
                BayText(strings.t("welcome.private.label"), Modifier.graphicsLayer { alpha = word }, weight = FontWeight.Medium, color = nightInk, maxLines = 1)
            }
            BayIconView(BayIcon.PRIVATE, size = IconSize.control, color = if (night) Color.White else colors.ink)
        }
    }
}

@Composable
private fun PrivateAround(parts: Run, modifier: Modifier) {
    val run = parts.run
    val strings = parts.strings
    val colors = parts.colors
    val night = run.privateOn
    val width = run.content.stageWidth.toFloat().dp
    val chips = listOf(
        listOf(strings.t("welcome.private.chip.device"), strings.t("welcome.private.chip.closed")),
        listOf(strings.t("welcome.private.chip.history"), strings.t("welcome.private.chip.blocked")),
    )
    val heading by animateFloatAsState(if (night) 1f else 0f, tween(350, if (night) 100 else 0), label = "heading")
    val pen by animateFloatAsState(if (night) 0f else 1f, tween(300), label = "pen")
    Box(
        modifier.fillMaxSize().then(
            if (night) Modifier.clearAndSetSemantics { contentDescription = (listOf(strings.t("welcome.private.on")) + chips.flatten()).joinToString(", ") }
            else Modifier.clearAndSetSemantics { invisibleToUser() },
        ),
    ) {
        Column(Modifier.offset(y = 48.dp).width(width).graphicsLayer { alpha = heading }, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm + 2.dp)) {
            BayIconView(BayIcon.PRIVATE, size = 46.dp, color = nightInk)
            BayText(strings.t("welcome.private.on"), variant = TextVariant.HEADLINE, weight = FontWeight.Medium, color = nightInk)
        }
        Column(Modifier.offset(y = 238.dp).width(width), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.sm + 2.dp)) {
            chips.forEachIndexed { r, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    row.forEachIndexed { c, chip -> Chip(run, chip, r * 2 + c, night) }
                }
            }
        }
        Box(Modifier.offset(206.dp, 92.dp).graphicsLayer { alpha = pen }) {
            androidx.compose.foundation.text.BasicText(
                strings.t("welcome.private.pen"),
                style = TextStyle(fontFamily = PenFace, fontWeight = FontWeight.SemiBold, fontSize = with(LocalDensity.current) { 26.dp.toSp() }, color = colors.accent),
            )
            Canvas(Modifier.offset(120.dp, 22.dp).size(40.dp, 46.dp)) {
                val s = density
                val path = Path().apply {
                    moveTo(8 * s, 2 * s)
                    cubicTo(18 * s, 10 * s, 24 * s, 20 * s, 26 * s, 36 * s)
                    moveTo(18 * s, 30 * s)
                    lineTo(26 * s, 37 * s)
                    lineTo(31 * s, 28 * s)
                }
                drawPath(path, colors.accent, style = Stroke(2.4.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
    }
}

/** A chip springing in, one after another, once the glasses are on. */
@Composable
private fun Chip(run: FirstRun, text: String, index: Int, night: Boolean) {
    var on by remember { mutableStateOf(night) }
    LaunchedEffect(night) {
        if (night && !run.reduced) delay(120L + index * 70L)
        on = night
    }
    val shown by animateFloatAsState(
        if (on) 1f else 0f,
        if (on && !run.reduced) run.content.motion.chips.spec(false) else tween(200), label = "chip",
    )
    BayText(
        text,
        Modifier.graphicsLayer {
            alpha = min(1f, shown)
            scaleX = 0.7f + 0.3f * shown
            scaleY = 0.7f + 0.3f * shown
        }.height(34.dp).background(Color(0x1FFFFFFF), CircleShape).border(1.dp, Color(0x38FFFFFF), CircleShape).padding(horizontal = 14.dp, vertical = 7.dp),
        variant = TextVariant.SUBHEAD, weight = FontWeight.SemiBold, color = Color.White,
    )
}

// Links.

@Composable
private fun LinksBehind(parts: Run, modifier: Modifier) {
    val card = hero(WelcomeStep.LINKS)
    Box(modifier.fillMaxSize().clearAndSetSemantics {}) {
        for (i in 1 downTo 0) {
            val w = card.width.toFloat() * (0.92f - 0.06f * i)
            Box(
                Modifier.offset((201 - w / 2).dp, (card.y.toFloat() - 12 - 11 * i).dp).size(w.dp, card.height.toFloat().dp)
                    .graphicsLayer { alpha = 0.55f - 0.15f * i }
                    .background(parts.colors.tile, RoundedCornerShape(card.radius.toFloat().dp)),
            )
        }
    }
}

@Composable
private fun TabCard(parts: Run, link: WelcomeLink) {
    val title = parts.strings.t(link.title)
    val card = hero(WelcomeStep.LINKS)
    Box(Modifier.fillMaxSize().background(Color.White).clearAndSetSemantics { contentDescription = "$title, ${link.host}" }) {
        Column(Modifier.fillMaxSize()) {
            Box(
                Modifier.fillMaxWidth().height((card.height.toFloat() * 0.62f).dp)
                    .background(Brush.linearGradient(link.colors.map { Color(android.graphics.Color.parseColor(it)) })),
                contentAlignment = Alignment.BottomStart,
            ) { BayText(title, Modifier.padding(Space.lg), variant = TextVariant.TITLE, weight = FontWeight.Bold, color = Color.White) }
            Column(Modifier.padding(Space.lg), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                for (i in 0..2) {
                    Box(Modifier.fillMaxWidth(if (i == 2) 0.5f else 1f).height(9.dp).background(Color(0xFFECEAF1), CircleShape))
                }
            }
        }
        Row(
            Modifier.align(Alignment.BottomCenter).padding(start = 14.dp, end = 14.dp, bottom = 12.dp).fillMaxWidth().height(34.dp)
                .plate(WelcomeColors.light, 17.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
        ) {
            SiteImage(link.host, 14.dp)
            BayText(link.host, variant = TextVariant.FOOTNOTE, color = Color(0xFF1C1B19))
        }
    }
}

/** A link on its way in from another app: a pill at the top that grows into the tab in front. */
@Composable
private fun LinkPill(parts: Run) {
    val run = parts.run
    val coming = run.linkComing
    val card = hero(WelcomeStep.LINKS)
    val grown by animateFloatAsState(
        if (run.linkLanding) 1f else 0f,
        if (run.linkLanding) run.content.motion.morph.spec(run.reduced) else run.content.motion.link.spec(run.reduced), label = "pill",
    )
    if (run.step != WelcomeStep.LINKS || coming == null) return
    val link = run.content.links[coming]
    val x = 106f + (card.x.toFloat() - 106f) * grown
    val y = -6f + (card.y.toFloat() + 6f) * grown
    val w = 190f + (card.width.toFloat() - 190f) * grown
    val h = 40f + (card.height.toFloat() - 40f) * grown
    Row(
        Modifier.offset(x.dp, y.dp).size(w.dp, h.dp).parallax(parts.tilt, 10f).plate(parts.colors, if (run.linkLanding) card.radius.toFloat().dp else 20.dp)
            .clearAndSetSemantics {}.padding(start = 6.dp, end = 14.dp).graphicsLayer { alpha = 1 - grown },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Box(Modifier.size(28.dp).background(WelcomeColors.green, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
            BayIconView(if (link.from == "mail") BayIcon.SHARE else BayIcon.LINK, size = IconSize.inline, color = Color.White)
        }
        BayText(link.host, variant = TextVariant.CALLOUT, weight = FontWeight.Medium, color = parts.colors.ink, maxLines = 1)
    }
}

/** The last page: the plate is the search field, where the real one opens. */
@Composable
private fun EndField(parts: Run) {
    val colors = parts.colors
    Row(
        Modifier.fillMaxSize().padding(start = 14.dp, end = 12.dp).clearAndSetSemantics {},
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        BayIconView(BayIcon.SEARCH, size = IconSize.small, color = colors.faint)
        BayText(parts.strings.t("search.placeholder"), Modifier.weight(1f), variant = TextVariant.CALLOUT, color = colors.faint, maxLines = 1)
        BayIconView(BayIcon.PRIVATE, size = IconSize.small, color = colors.ink)
    }
}
