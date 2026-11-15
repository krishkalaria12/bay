package expo.modules.bayengine

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import `in`.krishkalaria.bay.engine.R

/**
 * Home-screen widget (B15, C7): search, voice and a private tab, each opening Bay at its `bay://` command, which
 * JavaScript answers like any incoming link (B9).
 */
class BaySearchWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) {
      val views = RemoteViews(context.packageName, R.layout.search_widget)

      views.setOnClickPendingIntent(R.id.widget_search, command(context, "search", 0))
      views.setOnClickPendingIntent(R.id.widget_voice, command(context, "voice", 1))
      views.setOnClickPendingIntent(R.id.widget_private, command(context, "private-tab", 2))
      manager.updateAppWidget(id, views)
    }
  }

  /** Opens Bay at `bay://<host>`; each button needs its own request code, or they would share one intent. */
  private fun command(context: Context, host: String, request: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("bay://$host")).setPackage(context.packageName)

    return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }
}
