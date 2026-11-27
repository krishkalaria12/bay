// Copyright 2026 Bay. Apache-2.0.

#include "chrome/browser/bay/nn_spelling.h"

#include <string>

#include "base/strings/string_util.h"
#include "chrome/browser/spellchecker/spellcheck_custom_dictionary.h"
#include "chrome/browser/spellchecker/spellcheck_factory.h"
#include "chrome/browser/spellchecker/spellcheck_service.h"
#include "components/spellcheck/common/spellcheck_common.h"

namespace {

SpellcheckCustomDictionary* DictionaryOf(Profile* profile) {
  SpellcheckService* service =
      profile ? SpellcheckServiceFactory::GetForContext(profile) : nullptr;
  return service ? service->GetCustomDictionary() : nullptr;
}

}  // namespace

NN_ENGINE_CALL(nn_spell_words) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call) {
    return;
  }
  SpellcheckCustomDictionary* dictionary = DictionaryOf(call.profile());
  if (!dictionary) {
    return call.TakeReply().Error(
        "Spell checking isn't available in this profile");
  }
  base::ListValue words;
  for (const std::string& word : dictionary->GetWords()) {
    words.Append(word);
  }
  call.TakeReply().Send(base::DictValue()
                            .Set("words", std::move(words))
                            .Set("loaded", dictionary->IsLoaded()));
}

NN_ENGINE_CALL(nn_spell_word) {
  bay::Call call(profile_dir, args_json, reply, context);
  if (!call) {
    return;
  }
  const std::string* raw = call.args().FindString("word");
  const std::optional<bool> add = call.args().FindBool("add");
  const std::string word =
      raw ? std::string(base::TrimWhitespaceASCII(*raw, base::TRIM_ALL))
          : std::string();
  // The dictionary's own limits: one word, no spaces, short enough to keep.
  if (word.empty() || !add.has_value() ||
      word.size() > spellcheck::kMaxCustomDictionaryWordBytes ||
      !base::IsStringUTF8(word) ||
      word.find_first_of(" \t\r\n") != std::string::npos) {
    return call.TakeReply().Error("A word is one word of at most 99 bytes");
  }
  SpellcheckCustomDictionary* dictionary = DictionaryOf(call.profile());
  if (!dictionary || !dictionary->IsLoaded()) {
    return call.TakeReply().Error("The dictionary isn't loaded yet");
  }
  const bool changed =
      *add ? dictionary->AddWord(word) : dictionary->RemoveWord(word);
  call.TakeReply().Send(base::DictValue().Set("changed", changed));
}
