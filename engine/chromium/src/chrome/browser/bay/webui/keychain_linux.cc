// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/keychain.h"

#include <libsecret/secret.h>

#include <utility>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_writer.h"
#include "base/strings/string_util.h"
#include "crypto/secure_util.h"

namespace bay {
namespace {
// This schema is separate from Chromium Safe Storage and Bay's sync keys.
// Values are base64-encoded UTF-8 so embedded NULs survive libsecret's C API.
const SecretSchema kSchema = {"app.bay.ConnectedAccounts",
                              SECRET_SCHEMA_NONE,
                              {{"account", SECRET_SCHEMA_ATTRIBUTE_STRING},
                               {nullptr, SECRET_SCHEMA_ATTRIBUTE_STRING}},
                              0,
                              nullptr,
                              nullptr,
                              nullptr,
                              nullptr,
                              nullptr,
                              nullptr,
                              nullptr};
std::string Success(base::Value value = {}) {
  return base::WriteJson(base::DictValue().Set("value", std::move(value)))
      .value_or("{}");
}
std::string Failure() {
  // Never include the account, secret or backend's error text in a reply.
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue()
                     .Set("code", "credential_error")
                     .Set("message",
                          "Secret Service could not access this credential")))
      .value_or("{}");
}
}  // namespace

std::string Keychain::Credential(const std::string& method,
                                 const std::string& account,
                                 std::string secret) {
  base::ScopedClosureRunner wipe(base::BindOnce(
      [](std::string* value) {
        crypto::SecureZeroBuffer(base::as_writable_byte_span(*value));
      },
      &secret));
  GError* error = nullptr;
  if (method == "get" || method == "delete") {
    GHashTable* attributes =
        secret_attributes_build(&kSchema, "account", account.c_str(), nullptr);
    const auto flags = static_cast<SecretSearchFlags>(SECRET_SEARCH_ALL |
                                                      SECRET_SEARCH_UNLOCK);
    GList* items = secret_service_search_sync(nullptr, &kSchema, attributes,
                                              flags, nullptr, &error);
    g_hash_table_unref(attributes);
    base::ScopedClosureRunner release(base::BindOnce(
        [](GList* list) { g_list_free_full(list, g_object_unref); }, items));
    if (error) {
      g_error_free(error);
      return Failure();
    }
    // Unlock cancellation can succeed as a search while leaving locked items.
    // Never confuse those with missing credentials or a successful deletion.
    for (GList* it = items; it; it = it->next) {
      if (secret_item_get_locked(static_cast<SecretItem*>(it->data)))
        return Failure();
    }
    if (method == "delete") {
      for (GList* it = items; it; it = it->next) {
        const bool removed = secret_item_delete_sync(
            static_cast<SecretItem*>(it->data), nullptr, &error);
        if (error)
          g_error_free(error);
        if (!removed)
          return Failure();
      }
      return Success(base::Value(true));
    }
    if (!items)
      return Success();
    auto* item = static_cast<SecretItem*>(items->data);
    const bool loaded = secret_item_load_secret_sync(item, nullptr, &error);
    if (error)
      g_error_free(error);
    if (!loaded)
      return Failure();
    SecretValue* password = secret_item_get_secret(item);
    if (!password)
      return Failure();
    const char* text = secret_value_get_text(password);
    std::string value;
    const bool valid =
        text && base::Base64Decode(text, &value) && base::IsStringUTF8(value);
    secret_value_unref(password);
    if (!valid) {
      crypto::SecureZeroBuffer(base::as_writable_byte_span(value));
      return Failure();
    }
    return Success(base::Value(std::move(value)));
  }
  std::string encoded = base::Base64Encode(secret);
  const bool saved = secret_password_store_sync(
      &kSchema, SECRET_COLLECTION_DEFAULT, "Bay Connected Accounts",
      encoded.c_str(), nullptr, &error, "account", account.c_str(), nullptr);
  crypto::SecureZeroBuffer(base::as_writable_byte_span(encoded));
  if (error) {
    g_error_free(error);
    return Failure();
  }
  return Success(base::Value(saved));
}
}  // namespace bay
