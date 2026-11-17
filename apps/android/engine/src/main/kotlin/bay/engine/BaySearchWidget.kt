package bay.engine

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews

/**
 * Home-screen widget (B15, C7): search, voice and a private tab, each opening Bay at its `bay://` command, which
 * JavaScript answers like any incoming link (B9). Like the iOS widgets it has a layout per size: the one-row bar, a
 * 2×2 square and a 4×2 with labelled buttons.
 */
class BaySearchWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) manager.updateAppWidget(id, views(context, manager.getAppWidgetOptions(id)))
  }

  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
    manager.updateAppWidget(id, views(context, options))
  }

  /** Android 12 and later pick the layout as the widget resizes; older launchers say the size here. */
  private fun views(context: Context, options: Bundle): RemoteViews {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return RemoteViews(WidgetSize.entries.associate { SizeF(it.width, it.height) to layout(context, it) })
    }

    // In portrait, the widget is its minimum width by its maximum height.
    val width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
    val height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)

    return layout(context, WidgetSize.fitting(width.toFloat(), height.toFloat()))
  }

  private fun layout(context: Context, size: WidgetSize): RemoteViews {
    val views = RemoteViews(context.packageName, size.layout)

    views.setOnClickPendingIntent(R.id.widget_search, command(context, "search", 0))
    views.setOnClickPendingIntent(R.id.widget_voice, command(context, "voice", 1))
    views.setOnClickPendingIntent(R.id.widget_private, command(context, "private-tab", 2))
    if (size == WidgetSize.Medium) views.setOnClickPendingIntent(R.id.widget_search_button, command(context, "search", 0))
    if (size == WidgetSize.Compact) views.setViewVisibility(R.id.widget_private, View.GONE)

    return views
  }

  /** Opens Bay at `bay://<host>`; each command needs its own request code, or they would share one intent. */
  private fun command(context: Context, host: String, request: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("bay://$host")).setPackage(context.packageName)

    return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}

/** The smallest size, in dp, each layout needs. The launcher shows the largest that fits. */
private enum class WidgetSize(val width: Float, val height: Float, val layout: Int) {
  Compact(110f, 40f, R.layout.widget_bar),
  Bar(220f, 40f, R.layout.widget_bar),
  Small(110f, 130f, R.layout.widget_small),
  Medium(250f, 120f, R.layout.widget_medium);

  companion object {
    /** The largest layout that fits; the bar when the launcher has not said the size yet. */
    fun fitting(width: Float, height: Float): WidgetSize {
      if (width <= 0f || height <= 0f) return Bar

      return entries.filter { width >= it.width && height >= it.height }.maxByOrNull { it.width * it.height } ?: Compact
    }
  }
}
