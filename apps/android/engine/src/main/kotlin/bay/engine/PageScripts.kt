package bay.engine

import android.content.Context
import org.json.JSONObject

/**
 * The page scripts Bay runs in pages: one copy of each, shared with iOS (packages/mobile-pagescripts, D13), bundled
 * as the asset `pagescripts.json`. A script that takes arguments reads them from `args`.
 */
enum class PageScript(val key: String) {
  CLOSE_READER("close-reader"),
  FAVICON("favicon"),
  FIND("find"),
  FIND_CLEAR("find-clear"),
  FIND_STEP("find-step"),
  FORCE_DARK("force-dark"),
  HIDE_ELEMENTS("hide-elements"),
  INSPECT("inspect"),
  MARKDOWN("markdown"),
  OPEN_READER("open-reader"),
  PAGE_COLOR("page-color"),
  PAGE_FONT("page-font"),
  PAGE_TWEAKS("page-tweaks"),
  PAUSE_MEDIA("pause-media"),
  PICK_PARENT("pick-parent"),
  PIP_MEDIA("pip-media"),
  SEEK_MEDIA("seek-media"),
  START_PICKER("start-picker"),
  STOP_PICKER("stop-picker"),
  TOGGLE_MEDIA("toggle-media"),
  UPDATE_READER("update-reader"),
  WATCH_IMAGES("watch-images"),
  WATCH_MEDIA("watch-media");

  /** The script's text, with `args` declared ahead of it as JSON when it takes arguments. */
  fun source(context: Context, args: Map<String, Any?>? = null): String {
    val body = sources(context).optString(key, "return null;")
    return if (args == null) body else "const args = ${JSONObject(args)};\n$body"
  }

  private companion object {
    @Volatile private var table: JSONObject? = null

    fun sources(context: Context): JSONObject =
      table ?: synchronized(this) {
        table ?: JSONObject(context.assets.open("pagescripts.json").bufferedReader().use { it.readText() }).also { table = it }
      }
  }
}

/** Runs one of Bay's page scripts and answers with its result as JSON text (see `evaluate`). */
suspend fun BayEngineView.runScript(script: PageScript, args: Map<String, Any?>? = null): String = evaluate(script.source(context, args))
