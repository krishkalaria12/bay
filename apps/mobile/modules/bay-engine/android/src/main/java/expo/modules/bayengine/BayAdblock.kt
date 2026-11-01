package expo.modules.bayengine

/** JNI binding to Bay's Rust content blocker (packages/adblock, built into jniLibs by scripts/adblock). */
internal object BayAdblock {
  init {
    System.loadLibrary("bay_adblock")
  }

  /**
   * The engine cached at `cache` for `version`, or built from the list files and cached, with the scriptlet and
   * redirect resources file loaded ("" for none); 0 when the lists can't be read.
   */
  @JvmStatic external fun nativeLoad(files: Array<String>, cache: String, version: String, resources: String): Long
  /** "" to load the request, "block", or a `data:` URL to answer it with. */
  @JvmStatic external fun nativeCheck(handle: Long, url: String, source: String, kind: String): String
  /** The page's scriptlets as one script ("" when none). */
  @JvmStatic external fun nativeScriptlets(handle: Long, url: String): String
  @JvmStatic external fun nativeFree(handle: Long)
  /** JSON `{ hide, exceptions, generichide }`. */
  @JvmStatic external fun nativeCosmetic(handle: Long, url: String): String
  /** JSON array of selectors. Arguments are JSON arrays of strings. */
  @JvmStatic external fun nativeHiddenSelectors(handle: Long, classes: String, ids: String, exceptions: String): String
  @JvmStatic external fun nativeSetTracking(json: String): Boolean
  @JvmStatic external fun nativeCleanUrl(url: String): String?
}
