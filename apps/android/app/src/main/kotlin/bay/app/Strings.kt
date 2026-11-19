package bay.app

import android.content.Context
import android.os.LocaleList
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.core.catalog
import bay.core.formatMessage
import bay.core.matchLocale

/**
 * The app's words in the language Bay is showing, from the core's catalog (English behind missing keys). Changing the
 * locale swaps every word at once, as picking a language in Settings does; the language picked is kept across launches.
 */
class Strings(context: Context? = null) {
    private val prefs = context?.getSharedPreferences("bay.strings", Context.MODE_PRIVATE)

    /** The language picked in Settings, or null while Bay follows the phone. */
    val saved: String? get() = prefs?.getString(SAVED, null)

    /** The phone's own language, as Bay would show it. */
    val device: String get() = matchLocale(LocaleList.getDefault()[0]?.toLanguageTag())

    var locale by mutableStateOf(saved ?: device)
        private set
    private var table by mutableStateOf(catalog(this.locale))

    /** Keeps [locale] for the next launches and shows it now; null follows the phone again. */
    fun choose(locale: String?) {
        prefs?.edit()?.apply { if (locale == null) remove(SAVED) else putString(SAVED, locale) }?.apply()
        show(locale ?: device)
    }

    fun show(locale: String) {
        if (locale == this.locale) return
        this.locale = locale
        table = catalog(locale)
    }

    /** The message under [key], with `{name}` placeholders filled from [params]. An unknown key shows itself. */
    fun t(key: String, params: Map<String, String> = emptyMap()): String {
        val template = table[key] ?: key
        if (params.isEmpty()) return template
        // Filled in by the core, a call across the FFI: views ask for the same few each frame, so they're kept.
        val asked = buildString {
            append(template)
            params.entries.sortedBy { it.key }.forEach { (name, value) -> append('\u0000').append(name).append('=').append(value) }
        }
        return formatted.get(asked) ?: formatMessage(template, params).also { formatted.put(asked, it) }
    }

    private val formatted = android.util.LruCache<String, String>(512)

    /** A percentage written the language's way ("100%", "100 %"). */
    fun percent(value: Int): String = t("format.percent", mapOf("value" to "$value"))

    private companion object {
        const val SAVED = "locale"
    }
}
