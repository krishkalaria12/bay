// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

// JNI for org.bay.engine.BayEngine (engine-wide settings: content blocking, tracking parameters) and
// org.bay.engine.BayProfile (the browsing sessions tabs live in).

#include <memory>
#include <string>
#include <vector>

#include "base/android/jni_android.h"
#include "base/android/jni_string.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/values.h"
#include "bay/mobile/browser/bay_browser_context.h"
#include "bay/mobile/browser/bay_browser_main_parts.h"
#include "bay/mobile/browser/bay_content_blocker.h"

// Must come after the headers above.
#include "bay/mobile/jni_headers/BayEngine_jni.h"
#include "bay/mobile/jni_headers/BayProfile_jni.h"

using base::android::ConvertJavaStringToUTF8;
using base::android::ConvertUTF8ToJavaString;
using base::android::JavaRef;
using base::android::ScopedJavaLocalRef;

namespace bay {

namespace {

// A JSON array of strings, as Java passes lists.
std::vector<std::string> StringList(const std::string& json) {
  std::vector<std::string> items;
  std::optional<base::Value> parsed = base::JSONReader::Read(json);
  if (parsed && parsed->is_list()) {
    for (const base::Value& item : parsed->GetList()) {
      if (item.is_string()) {
        items.push_back(item.GetString());
      }
    }
  }
  return items;
}

}  // namespace

static void JNI_BayEngine_SetContentBlocking(JNIEnv* env,
                                             const JavaRef<jstring>& files_json,
                                             const JavaRef<jstring>& version,
                                             const JavaRef<jstring>& cache_path,
                                             const JavaRef<jstring>& resources_path,
                                             int32_t request_id) {
  BayContentBlocker::SetLists(StringList(ConvertJavaStringToUTF8(env, files_json)),
                              ConvertJavaStringToUTF8(env, version), ConvertJavaStringToUTF8(env, cache_path),
                              resources_path.is_null() ? std::string() : ConvertJavaStringToUTF8(env, resources_path),
                              base::BindOnce(
                                  [](int32_t request_id, bool loaded) {
                                    Java_BayEngine_onContentBlockingApplied(base::android::AttachCurrentThread(),
                                                                            request_id, loaded);
                                  },
                                  request_id));
}

static void JNI_BayEngine_SetBlockingPausedHosts(JNIEnv* env, const JavaRef<jstring>& hosts_json) {
  BayContentBlocker::SetPausedHosts(StringList(ConvertJavaStringToUTF8(env, hosts_json)));
}

static bool JNI_BayEngine_SetTrackingParameters(JNIEnv* env, const JavaRef<jstring>& json) {
  return BayContentBlocker::SetTrackingParameters(ConvertJavaStringToUTF8(env, json));
}

// The URL without its tracking parameters, or null when it has none.
static ScopedJavaLocalRef<jstring> JNI_BayEngine_CleanUrl(JNIEnv* env, const JavaRef<jstring>& url) {
  const std::string cleaned = BayContentBlocker::CleanUrl(ConvertJavaStringToUTF8(env, url));
  return cleaned.empty() ? ScopedJavaLocalRef<jstring>() : ConvertUTF8ToJavaString(env, cleaned);
}

// The persistent profile. Owned by the browser's main parts for the life of the process.
static int64_t JNI_BayProfile_GetNormal(JNIEnv* env) {
  return reinterpret_cast<intptr_t>(BayBrowserMainParts::Get()->NormalProfile());
}

// A new private session's profile, owned by the Java BayProfile until DestroyPrivate.
static int64_t JNI_BayProfile_CreatePrivate(JNIEnv* env) {
  return reinterpret_cast<intptr_t>(BayBrowserMainParts::Get()->CreatePrivateProfile().release());
}

// Ends a private session: its cookies, storage and cache, all in memory, go with it. Its tabs must be gone first.
static void JNI_BayProfile_DestroyPrivate(JNIEnv* env, int64_t profile_ptr) {
  std::unique_ptr<BayBrowserContext> profile(reinterpret_cast<BayBrowserContext*>(profile_ptr));
  CHECK(profile->IsOffTheRecord());
}

}  // namespace bay

DEFINE_JNI(BayEngine)
DEFINE_JNI(BayProfile)
