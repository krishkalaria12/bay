package bay.app

import android.os.LocaleList
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.core.catalog
import bay.core.formatMessage
import bay.core.matchLocale

/**
 * The app's words in the language Bay is showing, from the core's catalog (English behind missing keys). Changing the
 * locale swaps every word at once, as picking a language in Settings does.
 */
class Strings(locale: String? = null) {
    var locale by mutableStateOf(locale ?: matchLocale(LocaleList.getDefault()[0]?.toLanguageTag()))
        private set
    private var table by mutableStateOf(catalog(this.locale))

    fun show(locale: String) {
        if (locale == this.locale) return
        this.locale = locale
        table = catalog(locale)
    }

    /** The message under [key], with `{name}` placeholders filled from [params]. An unknown key shows itself. */
    fun t(key: String, params: Map<String, String> = emptyMap()): String {
        val template = table[key] ?: key
        return if (params.isEmpty()) template else formatMessage(template, params)
    }
}
