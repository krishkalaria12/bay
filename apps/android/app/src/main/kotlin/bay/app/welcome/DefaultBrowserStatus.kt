package bay.app.welcome

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import bay.core.DefaultBrowser

/** Whether Bay is the default browser, and the system's own "Set Bay as your default browser?" to make it so. */
object DefaultBrowserStatus {
    fun current(context: Context): DefaultBrowser {
        val roles = context.getSystemService(RoleManager::class.java) ?: return DefaultBrowser.UNAVAILABLE
        return when {
            !roles.isRoleAvailable(RoleManager.ROLE_BROWSER) -> DefaultBrowser.UNAVAILABLE
            roles.isRoleHeld(RoleManager.ROLE_BROWSER) -> DefaultBrowser.DEFAULT
            else -> DefaultBrowser.NOT
        }
    }

    /** The system's dialog asking to make Bay the default browser, or null where it can't be asked. */
    fun request(context: Context): Intent? {
        val roles = context.getSystemService(RoleManager::class.java) ?: return null
        if (!roles.isRoleAvailable(RoleManager.ROLE_BROWSER) || roles.isRoleHeld(RoleManager.ROLE_BROWSER)) return null
        return roles.createRequestRoleIntent(RoleManager.ROLE_BROWSER)
    }

    /**
     * Default apps settings: Android stops showing the dialog once someone has said no twice, so a refused request
     * opens these instead.
     */
    fun settings(): Intent = Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
}
