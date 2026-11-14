// Copyright 2026 Bay authors. Adapted from content/shell/android/shell_library_loader.cc, Copyright 2012 The
// Chromium Authors. Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#include "base/android/jni_android.h"
#include "base/android/library_loader/library_loader_hooks.h"
#include "bay/mobile/app/bay_main_delegate.h"
#include "content/public/app/content_jni_onload.h"
#include "content/public/app/content_main.h"

namespace {

bool NativeInitializationHook(base::android::LibraryProcessType library_process_type) {
  if (!content::android::OnJNIOnLoadInit()) {
    return false;
  }
  content::SetContentMainDelegate(new bay::BayMainDelegate());
  return true;
}

}  // namespace

// Called by the VM when libbay_engine.so loads, in the app's process and in each child process.
JNI_EXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {
  base::android::InitVM(vm);
  base::android::SetNativeInitializationHook(NativeInitializationHook);
  return JNI_VERSION_1_4;
}
