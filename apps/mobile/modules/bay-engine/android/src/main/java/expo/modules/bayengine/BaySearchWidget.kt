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
 * Home-screen search widget (B15): tapping it opens Bay at `bay://search`, which JavaScript answers like any
 * incoming link (B9).
 */
class BaySearchWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    for (id in ids) {
      val views = RemoteViews(context.packageName, R.layout.search_widget)
      val search = Intent(Intent.ACTION_VIEW, Uri.parse("bay://search")).setPackage(context.packageName)

      views.setOnClickPendingIntent(
        R.id.widget_search,
        PendingIntent.getActivity(context, 0, search, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
      )
      manager.updateAppWidget(id, views)
    }
  }
}
