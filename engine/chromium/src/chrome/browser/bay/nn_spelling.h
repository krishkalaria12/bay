// Copyright 2026 Bay. Apache-2.0.
//
// Spelling's own words: the profile's custom dictionary (Chromium's
// SpellcheckCustomDictionary), which "Add to Dictionary" fills and Settings ›
// General › Spelling edits. Each space's profile keeps its own.
//
//   nn_spell_words {} -> {words: [string], loaded: bool}
//   nn_spell_word {word, add: bool} -> {changed: bool}

#ifndef CHROME_BROWSER_BAY_NN_SPELLING_H_
#define CHROME_BROWSER_BAY_NN_SPELLING_H_

#include "chrome/browser/bay/nn_engine.h"

NN_ENGINE_CALL(nn_spell_words);
NN_ENGINE_CALL(nn_spell_word);

#endif  // CHROME_BROWSER_BAY_NN_SPELLING_H_
