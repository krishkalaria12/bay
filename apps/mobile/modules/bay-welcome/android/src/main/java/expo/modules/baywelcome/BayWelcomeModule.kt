package expo.modules.baywelcome

import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The welcome's native parts on Android (src/onboarding): whether Bay is the default browser, and the system's own
 * "Set Bay as your default browser?" to make it so. The name's glass is iOS's alone; Android draws it in React Native.
 */
class BayWelcomeModule : Module() {
  private var asking: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("BayWelcome")

    Function("defaultBrowser") {
      val roles = roles() ?: return@Function "unavailable"
      when {
        !roles.isRoleAvailable(RoleManager.ROLE_BROWSER) -> "unavailable"
        roles.isRoleHeld(RoleManager.ROLE_BROWSER) -> "default"
        else -> "not"
      }
    }

    /**
     * Asks in place, with the system's dialog. Android stops showing it once someone has said no twice; the request
     * then comes back at once, and Default apps settings opens instead.
     */
    AsyncFunction("makeDefaultBrowser") { promise: Promise ->
      val roles = roles()
      val activity = appContext.currentActivity
      if (roles == null || activity == null || !roles.isRoleAvailable(RoleManager.ROLE_BROWSER)) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      if (roles.isRoleHeld(RoleManager.ROLE_BROWSER)) {
        promise.resolve("default")
        return@AsyncFunction
      }
      asking?.resolve("not")
      asking = promise
      activity.startActivityForResult(roles.createRequestRoleIntent(RoleManager.ROLE_BROWSER), REQUEST_CODE)
    }

    OnActivityResult { activity, payload ->
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult
      val promise = asking ?: return@OnActivityResult
      asking = null
      when {
        roles()?.isRoleHeld(RoleManager.ROLE_BROWSER) == true -> promise.resolve("default")
        payload.resultCode == Activity.RESULT_CANCELED && openSettings(activity) -> promise.resolve("settings")
        else -> promise.resolve("not")
      }
    }
  }

  private fun roles(): RoleManager? = appContext.reactContext?.getSystemService(Context.ROLE_SERVICE) as? RoleManager

  private fun openSettings(activity: Activity): Boolean = runCatching {
    activity.startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS))
  }.isSuccess

  companion object {
    private const val REQUEST_CODE = 0xBA1
  }
}
