package bay.app

import android.content.Context
import bay.core.BrowserPreferences
import bay.core.FilterListStore
import bay.core.HttpClient
import bay.core.trackingParametersJson
import bay.engine.Engine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** What the content blocker is doing, for Settings. */
sealed interface BlockerStatus {
    data object Off : BlockerStatus
    data object Loading : BlockerStatus
    data class Ready(val lists: Int) : BlockerStatus
    data object Failed : BlockerStatus
}

/**
 * The content blocker: the engine blocks with the filter lists while "Block ads and trackers" is on, and the lists
 * stay fresh. Turning blocking on applies the lists already downloaded, then refreshes the stale ones and applies
 * again if any changed; turning it off stops a refresh still running, so nothing it was doing lands afterwards.
 */
class ContentBlocker(
    private val context: Context,
    documentsDir: String,
    private val http: HttpClient,
    private val scope: CoroutineScope,
    private val changed: (BlockerStatus) -> Unit,
) {
    private val lists = FilterListStore(documentsDir)
    private var enabled: Boolean? = null
    private var sites: String? = null
    private var work: Job? = null

    init {
        // The same table for every page, so it is set once.
        Engine.setTrackingParameters(trackingParametersJson())
    }

    /** Follows the preferences: blocking on or off, and what each site turns off on its own. */
    fun follow(preferences: BrowserPreferences) {
        val groupsOff = JSONObject()
        preferences.siteSettings.toSortedMap().forEach { (host, setting) ->
            if (setting.blockOff.isNotEmpty()) groupsOff.put(host, JSONArray(setting.blockOff.map { it.name.lowercase() }))
        }
        val json = groupsOff.toString()
        if (json != sites) {
            sites = json
            Engine.setSiteBlocking(json)
        }
        if (preferences.blockContent == enabled) return
        enabled = preferences.blockContent
        work?.cancel()
        work = scope.launch { if (preferences.blockContent) turnOn() else turnOff() }
    }

    private suspend fun turnOn() {
        apply()
        // Off the main thread: up to 7 MB of lists to fetch, compare and write.
        val refreshed = withContext(Dispatchers.IO) { lists.refresh(http, AppModel.now()) }
        if (refreshed && scope.isActive) apply()
    }

    /** Hands the engine the lists on disk, or says they are still coming when there are none yet. */
    private suspend fun apply() {
        // Off the main thread: the version comes from hashing every list's text.
        val present = withContext(Dispatchers.IO) { lists.onDisk() }
        if (present.uris.isEmpty()) {
            changed(BlockerStatus.Loading)
            return
        }
        runCatching { Engine.setContentBlocking(context, present.uris, present.version, present.groups) }
            .onSuccess { changed(BlockerStatus.Ready(present.uris.size)) }
            .onFailure { changed(BlockerStatus.Failed) }
    }

    private suspend fun turnOff() {
        runCatching { Engine.setContentBlocking(context, null, "") }
        changed(BlockerStatus.Off)
    }
}
