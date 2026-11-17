package bay.app

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import bay.core.Action
import bay.core.BrowserPreferences
import bay.core.BrowserSpace
import bay.core.BrowserStore
import bay.core.BrowserTab
import bay.core.StoreObserver
import java.util.UUID

/**
 * The app's view of the core's browser store: the slices screens read, refreshed whenever the store changes. Every
 * change goes through [dispatch]; nothing here edits state of its own.
 */
class AppModel(context: Context) {
    val store: BrowserStore = BrowserStore.open(context.filesDir.absolutePath, UUID.randomUUID().toString(), now())
    var spaces by mutableStateOf(emptyList<BrowserSpace>())
        private set
    var activeSpaceId by mutableStateOf("")
        private set
    var activeTabId by mutableStateOf("")
        private set

    /** The tabs of the space showing, in list order. */
    var tabs by mutableStateOf(emptyList<BrowserTab>())
        private set
    var preferences by mutableStateOf<BrowserPreferences>(store.preferences())
        private set

    private val main = Handler(Looper.getMainLooper())

    init {
        store.observe(object : StoreObserver {
            override fun changed(revision: ULong) {
                main.post { refresh() }
            }
        })
        refresh()
    }

    fun dispatch(action: Action): Boolean = store.dispatch(action)

    /** Saves at once: as the app leaves the foreground. */
    fun flush() {
        runCatching { store.flush() }
    }

    private fun refresh() {
        spaces = store.spaces()
        activeSpaceId = store.activeSpaceId()
        activeTabId = store.activeTabId()
        tabs = store.spaceTabs(activeSpaceId)
        preferences = store.preferences()
    }

    companion object {
        /** Milliseconds since 1970, as the store's timestamps are. */
        fun now(): Long = System.currentTimeMillis()
    }
}
