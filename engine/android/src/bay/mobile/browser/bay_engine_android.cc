// Copyright 2026 Bay authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

// JNI for org.bay.engine.BayProfile: the browsing sessions tabs live in.

#include <memory>

#include "base/android/jni_android.h"
#include "bay/mobile/browser/bay_browser_context.h"
#include "bay/mobile/browser/bay_browser_main_parts.h"

// Must come after the headers above.
#include "bay/mobile/jni_headers/BayProfile_jni.h"

namespace bay {

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

DEFINE_JNI(BayProfile)
