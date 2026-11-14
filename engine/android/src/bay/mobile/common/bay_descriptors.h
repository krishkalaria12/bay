// Copyright 2026 Bay authors. Adapted from content/shell/android/shell_descriptors.h, Copyright 2012 The Chromium Authors.
// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.

#ifndef BAY_MOBILE_COMMON_BAY_DESCRIPTORS_H_
#define BAY_MOBILE_COMMON_BAY_DESCRIPTORS_H_

#include "content/public/common/content_descriptors.h"

// File descriptors the browser process hands each child process. Child processes run sandboxed and can't open the
// APK, so the engine's resource pack arrives already open.
enum {
  kBayEnginePakDescriptor = kContentIPCDescriptorMax + 1,
};

#endif  // BAY_MOBILE_COMMON_BAY_DESCRIPTORS_H_
