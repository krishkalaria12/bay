package bay.app.settings

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import bay.app.R

/**
 * An icon Bay can wear on the home screen, the same set as the desktop's. Each is a launcher alias in the manifest,
 * named after the icon; only the chosen one is enabled.
 */
enum class AppIcon(val alias: String, val label: String, val preview: Int) {
    PAPER("Default", "settings.appIcons.paper", R.drawable.app_icon_paper),
    NAVY("Navy", "settings.appIcons.navy", R.drawable.app_icon_navy),
    CORAL("Coral", "settings.appIcons.coral", R.drawable.app_icon_coral),
    NOIR("Noir", "settings.appIcons.noir", R.drawable.app_icon_noir),
    COBALT("Cobalt", "settings.appIcons.cobalt", R.drawable.app_icon_cobalt),
    BRIDGE("Bridge", "settings.appIcons.bridge", R.drawable.app_icon_bridge);

    /** The id its picker tile goes by. */
    val testID: String get() = "settings-app-icon-${alias.lowercase()}"

    private fun component(context: Context) = ComponentName(context.packageName, "in.krishkalaria.bay.mobile.MainActivity$alias")

    /** Puts this icon on the home screen: its alias on, every other off. The launcher picks it up in a moment. */
    fun apply(context: Context) {
        val packages = context.packageManager
        // On first, so Bay is never left without a launcher entry.
        packages.setComponentEnabledSetting(component(context), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
        entries.filter { it != this }.forEach {
            packages.setComponentEnabledSetting(it.component(context), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
        }
    }

    companion object {
        /** The icon on the home screen now: the alias that's on, whether by the manifest or by a choice. */
        fun current(context: Context): AppIcon {
            val packages = context.packageManager
            return entries.firstOrNull { icon ->
                when (packages.getComponentEnabledSetting(icon.component(context))) {
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
                    PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> icon == PAPER
                    else -> false
                }
            } ?: PAPER
        }
    }
}
