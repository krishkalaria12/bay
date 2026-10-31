extension CefModule {
  /// The //chrome/browser/bay exports the JS may call through `engineCall`, as packages/cef's NNEngineBridge
  /// allows them (history, favicons, closed tabs, bookmarks, the prefs nn_prefs allows). The app's own services call the rest natively.
  static let engineCalls: Set<String> = [
    "nn_history_query", "nn_history_add", "nn_history_import", "nn_history_delete_urls", "nn_history_watch",
    "nn_favicons_get", "nn_favicons_set",
    "nn_tab_restore_load",
    "nn_bookmarks_tree", "nn_bookmarks_apply", "nn_bookmarks_watch",
    "nn_prefs_get", "nn_prefs_set",
    "nn_cli_control",
  ]
}
