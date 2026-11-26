// Copyright 2026 Bay. Apache-2.0.
//
// The spare page: one renderer process started ahead of a page that will want
// it, so a new tab or a typed address opens without waiting for one. Chrome
// warms it when its own omnibox takes focus; Bay's address bar and command bar
// are the app's, so the app asks for it when one opens or a new tab shows.
// Chrome's spare manager keeps at most one per profile, gives it to the next
// navigation that fits, and drops it under memory pressure; this skips it
// while battery saver is on.
//
//   nn_spare_warmup {} -> {warmed: bool, reason?: "batterySaver"|"failed"}

#ifndef CHROME_BROWSER_BAY_NN_SPARE_H_
#define CHROME_BROWSER_BAY_NN_SPARE_H_

#include "chrome/browser/bay/nn_engine.h"

NN_ENGINE_CALL(nn_spare_warmup);

#endif  // CHROME_BROWSER_BAY_NN_SPARE_H_
