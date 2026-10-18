// Copyright 2026 Bay. Apache-2.0.
// Portable NNCore service calls. This header can be included from C, C++, or
// Objective-C without importing Chromium or the platform's UI framework.
#ifndef BAY_CORE_PUBLIC_NNCORE_ENGINE_H_
#define BAY_CORE_PUBLIC_NNCORE_ENGINE_H_

#if defined(_WIN32)
#if defined(NNCORE_ENGINE_IMPLEMENTATION)
#define NNCORE_ENGINE_EXPORT __declspec(dllexport)
#else
#define NNCORE_ENGINE_EXPORT __declspec(dllimport)
#endif
#else
#define NNCORE_ENGINE_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif
#define NNCORE_ENGINE_ABI_VERSION 1

typedef void (*nncore_engine_reply_t)(void* context, const char* json);
typedef void (*nncore_engine_event_t)(void* context,
                                      const char* topic,
                                      const char* json);

NNCORE_ENGINE_EXPORT int nncore_engine_abi_version(void);
// Resolves only Bay's registered nn_* profile-service functions, never
// arbitrary exported symbols. profile_path is an absolute UTF-8 directory that
// Chrome has already loaded. args_json must be a JSON object, or NULL for {}.
// Inputs are copied before this function returns. Calls from other threads are
// posted to Chrome's UI thread. Replies normally run there and may run before
// this call returns; if the UI thread is unavailable the failure reply runs on
// the calling thread. The reply string is valid only during the callback.
// Results match nn_engine.h, including {"error":"message"} failures.
// Outstanding work may be cancelled without a reply during process shutdown.
NNCORE_ENGINE_EXPORT void nncore_engine_call(const char* name,
                                             const char* profile_path,
                                             const char* args_json,
                                             nncore_engine_reply_t reply,
                                             void* context);
// Replaces the engine's current event sink. Call on the browser UI thread.
// This preserves nn_engine_set_event_sink's single-subscriber convention;
// callers needing fan-out should subscribe once and distribute events.
NNCORE_ENGINE_EXPORT void nncore_engine_set_event_sink(
    nncore_engine_event_t sink,
    void* context);
#ifdef __cplusplus
}  // extern "C"
#endif
#endif  // BAY_CORE_PUBLIC_NNCORE_ENGINE_H_
