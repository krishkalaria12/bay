package expo.modules.bayengine

import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import kotlin.math.abs
import kotlin.math.min

/**
 * Pull to refresh, and edge swipe back/forward (A4), over a page view: the gestures iOS's WebKit view has, for both
 * Android engines. The host view forwards its touch interception, touch events and drawing here.
 */
internal class BayPageGestures(private val host: ViewGroup, private val page: Page) {
  /** The page the gestures act on. */
  interface Page {
    /** The view that follows the finger. */
    val view: View
    /** False while there's no page yet: the gestures stay out of the way. */
    val hasPage: Boolean
    val isLoading: Boolean
    val pullToRefreshEnabled: Boolean
    fun canGoBack(): Boolean
    fun canGoForward(): Boolean
    fun goBack()
    fun goForward()
    fun reload()
  }

  private val density = host.resources.displayMetrics.density
  private val touchSlop = ViewConfiguration.get(host.context).scaledTouchSlop
  private val threshold = 64 * density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    // Mid grey reads on light and dark pages alike; the gap behind it is the page's own top colour (TabPage).
    color = Color.rgb(142, 142, 147)
    strokeWidth = 2.5f * density
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
  }
  private var pullStartX = 0f
  private var pullStartY = 0f
  private var pulling = false
  /** Past the trigger point in the current pull (one haptic tick when it's crossed). */
  private var pullArmed = false
  /** Released past the trigger: the page stays down with a spinning arc until the reload has started and finished. */
  private var refreshing = false
  private var refreshStartedAt = 0L
  private var refreshSawLoading = false
  /** Where the finger went down for an edge swipe, which edge, and whether it is being dragged. */
  private var edgeStartX = 0f
  private var edgeStartY = 0f
  /** -1: left edge, swipe right to go back; 1: right edge, swipe left to go forward; 0: neither. */
  private var edgeDirection = 0
  private var edgeSwiping = false
  /** Past the trigger point in the current edge swipe (one haptic tick when it's crossed). */
  private var edgeArmed = false
  private val spinner = ValueAnimator.ofFloat(0f, 360f).apply {
    duration = 750
    repeatCount = ValueAnimator.INFINITE
    interpolator = LinearInterpolator()
    addUpdateListener { onSpin() }
  }

  /** True to take the gesture from the page; null to let the host's default decide. */
  fun onInterceptTouchEvent(event: MotionEvent): Boolean? {
    if (!page.hasPage) return null
    // A second finger is a pinch, never a pull or an edge swipe.
    if (event.pointerCount > 1) {
      if (edgeSwiping) {
        edgeSwiping = false
        edgeArmed = false
        settleEdge()
      }
      return null
    }
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        pullStartX = event.x
        pullStartY = event.y
        pulling = false
        pullArmed = false
        edgeStartX = event.x
        edgeStartY = event.y
        edgeSwiping = false
        edgeArmed = false
        // The first 24dp at each side, matching iOS's allowsBackForwardNavigationGestures. A direction is only armed
        // when there's history that way, so a swipe without history stays the page's.
        val edgeWidth = 24 * density
        edgeDirection = when {
          event.x < edgeWidth && page.canGoBack() -> -1
          event.x > host.width - edgeWidth && page.canGoForward() -> 1
          else -> 0
        }
      }
      MotionEvent.ACTION_MOVE -> {
        // Pull to refresh and edge swipe each take the gesture once the movement is clearly theirs, and only if the
        // other hasn't started first.
        if (!pulling && !edgeSwiping && page.pullToRefreshEnabled && !page.isLoading && !refreshing) {
          val distance = event.y - pullStartY
          if (!page.view.canScrollVertically(-1) && distance > touchSlop * 2 && distance > abs(event.x - pullStartX) * 1.5) {
            pulling = true
            host.parent?.requestDisallowInterceptTouchEvent(true)
            return true
          }
        }
        if (!edgeSwiping && !pulling && edgeDirection != 0) {
          val dx = event.x - edgeStartX
          val dy = event.y - edgeStartY
          val towardHistory = if (edgeDirection == -1) dx > 0 else dx < 0
          if (towardHistory && abs(dx) > touchSlop * 2 && abs(dx) > abs(dy) * 1.5) {
            edgeSwiping = true
            host.parent?.requestDisallowInterceptTouchEvent(true)
            return true
          }
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        if (pulling || edgeSwiping) return true
      }
    }
    return null
  }

  /** True when the event was a gesture's; null to let the host's default handle it. */
  fun onTouchEvent(event: MotionEvent): Boolean? {
    if (edgeSwiping) {
      when (event.actionMasked) {
        MotionEvent.ACTION_MOVE -> {
          val dx = event.x - edgeStartX
          // The page follows the finger a little, like WebKit's edge preview. Capped so the edge stays put.
          val follow = (dx * 0.4f).coerceIn(-56 * density, 56 * density)
          val distance = if (edgeDirection == -1) dx else -dx
          page.view.translationX = follow
          page.view.translationY = 0f
          val armed = distance >= threshold
          if (armed && !edgeArmed) host.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
          edgeArmed = armed
          host.invalidate()
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          val dx = event.x - edgeStartX
          val distance = if (edgeDirection == -1) dx else -dx
          val navigate = event.actionMasked == MotionEvent.ACTION_UP && distance >= threshold
          val direction = edgeDirection
          edgeSwiping = false
          edgeArmed = false
          host.parent?.requestDisallowInterceptTouchEvent(false)
          if (navigate) {
            if (direction == -1) page.goBack() else page.goForward()
          }
          settleEdge()
        }
      }
      return true
    }
    if (!pulling) return null
    val view = page.view
    when (event.actionMasked) {
      MotionEvent.ACTION_MOVE -> {
        view.translationY = ((event.y - pullStartY) * 0.5f).coerceIn(0f, threshold * 1.5f)
        val armed = view.translationY >= threshold
        if (armed && !pullArmed) host.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        pullArmed = armed
        host.invalidate()
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val shouldReload = event.actionMasked == MotionEvent.ACTION_UP && view.translationY >= threshold
        pulling = false
        pullArmed = false
        host.parent?.requestDisallowInterceptTouchEvent(false)
        if (shouldReload) {
          // Hold the page just below the spinner while it reloads, as iOS does.
          refreshing = true
          refreshSawLoading = false
          refreshStartedAt = SystemClock.uptimeMillis()
          view.animate().translationY(threshold).setDuration(180).setInterpolator(DecelerateInterpolator()).start()
          spinner.start()
          page.reload()
        } else {
          settlePage()
        }
      }
    }
    return true
  }

  /** The pull's arc, above the page; the host calls this after drawing its children. */
  fun draw(canvas: Canvas) {
    val offset = page.view.translationY
    if (offset <= 0f) return
    val radius = 10 * density
    val x = host.width * 0.5f
    val y = offset * 0.5f
    val progress = min(1f, offset / threshold)
    if (refreshing) {
      paint.alpha = 255
      canvas.drawArc(x - radius, y - radius, x + radius, y + radius, spinner.animatedValue as Float - 90f, 270f, false, paint)
    } else {
      // Fades in and draws itself as the page comes down, turning a little so it feels alive.
      paint.alpha = (255 * progress).toInt()
      canvas.drawArc(x - radius, y - radius, x + radius, y + radius, -90f + 120f * progress, 300f * progress, false, paint)
    }
  }

  /** Stops everything at once (the view is going, or its page is being replaced). */
  fun cancel() {
    refreshing = false
    spinner.cancel()
    edgeSwiping = false
    pulling = false
    page.view.animate().cancel()
  }

  private fun settlePage() {
    page.view.animate().translationY(0f).setDuration(240).setInterpolator(DecelerateInterpolator()).withEndAction { host.invalidate() }.start()
  }

  private fun settleEdge() {
    page.view.animate().translationX(0f).setDuration(240).setInterpolator(DecelerateInterpolator()).withEndAction { host.invalidate() }.start()
  }

  /** Each spinner frame: ends the refresh once the reload has run (shown at least briefly), or gives up on one that never starts. */
  private fun onSpin() {
    if (!refreshing) return
    if (page.isLoading) refreshSawLoading = true
    val shown = SystemClock.uptimeMillis() - refreshStartedAt
    if ((refreshSawLoading && !page.isLoading && shown >= 450) || (!refreshSawLoading && shown >= 4_000) || shown >= 20_000) endRefresh()
    host.invalidate()
  }

  private fun endRefresh() {
    refreshing = false
    spinner.cancel()
    settlePage()
  }
}
