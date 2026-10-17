// Copyright 2026 Bay. Apache-2.0.
// Stable host ABI. No Chromium, Objective-C, C++, or Windows headers required.
#ifndef BAY_CORE_PUBLIC_NNCORE_C_H_
#define BAY_CORE_PUBLIC_NNCORE_C_H_

#if defined(_WIN32)
#if defined(NNCORE_IMPLEMENTATION)
#define NNCORE_C_EXPORT __declspec(dllexport)
#else
#define NNCORE_C_EXPORT __declspec(dllimport)
#endif
#else
#define NNCORE_C_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define NNCORE_C_ABI_VERSION 1
// Browser ids are caller-supplied positive integers. HWNDs are decimal strings
// in JSON, never pointers or JavaScript numbers. Every string is UTF-8.
// Reply/event strings live only during the callback. Copy before posting them
// to another thread. Callbacks must not throw or block waiting for the UI thread.
typedef void (*nncore_reply_t)(void* context, const char* json);
typedef void (*nncore_event_t)(void* context, const char* topic, const char* json);

NNCORE_C_EXPORT int nncore_abi_version(void);
// Sink replacement must be serialized by the host. Events/replies run on the
// Chromium UI thread, except engine.schedulePump which can run on any thread.
NNCORE_C_EXPORT void nncore_set_event_sink(nncore_event_t sink, void* context);

// Windows: initialize once, from the application's main thread. Options:
// {cachePath: absolute directory unique to Bay, subprocessPath: absolute exe,
//  resourcesPath?: absolute directory, localesPath?: absolute directory,
//  messageLoop?: "external" | "threaded", remoteDebuggingPort?: 1024..65535}.
// Returns 1 if accepted, 0 if CEF initialization failed, -1 for invalid options.
// Wait for engine.ready before submitting calls. No restart after shutdown.
// External mode: marshal engine.schedulePump {delayMs} to the initialization
// thread and invoke nncore_do_message_loop_work. A new scheduling event replaces
// the previous timer. Threaded mode owns a separate Chromium UI loop.
NNCORE_C_EXPORT int nncore_initialize(const char* options_json);
// Production Windows entry: pass the sandbox_info received by the host DLL's
// RunWinMain from CEF bootstrap.exe. The plain initializer fails without it,
// unless allowUnsafeNoSandbox:true is explicitly set for a development test.
NNCORE_C_EXPORT int nncore_initialize_with_sandbox(const char* options_json,
                                                void* sandbox_info);
// Call before initializing RN/COM. Returns >=0 for a child process (exit with
// that code), -1 for the browser process. Uses the process command line.
NNCORE_C_EXPORT int nncore_execute_process(void* sandbox_info);
NNCORE_C_EXPORT void nncore_do_message_loop_work(void);
// First request engine.close, wait engine.readyToShutdown, then call from the
// initialization thread. Returns 1 on completion, 0 while browsers are alive,
// -1 on the wrong thread. Never unload either DLL before completion.
NNCORE_C_EXPORT int nncore_shutdown(void);

// Calls may come from any thread after engine.ready. Arguments are copied
// before return. Exactly one JSON-object reply, possibly synchronous on failure.
// Errors are {error: string}. Unknown methods fail rather than silently succeed.
//
// engine.call {name: "nn_<domain>_<verb>", profile: absolute directory,
//              args: object|string|null} -> nn_engine.h JSON result
// engine.close {} -> {ok:true}, then engine.readyToShutdown once all tabs close
// engine.info {} -> {abi, engine, messageLoop}
// tab.create {id,parent,url?,profile?,x?,y?,width,height,private?} -> {id}
// tab.bounds {id,x,y,width,height}; tab.parent {id,parent}; tab.visible {id,visible}
// tab.navigate {id,url}; tab.back/forward/reload/stop/focus/close {id}
// tab.reload also accepts bypassCache. tab.close optionally force (default false).
// tab.devtools {id,open}; tab.zoom {id,level}; tab.mute {id,muted}
// tab.execute {id,code}; tab.find {id,text,forward?,matchCase?,findNext?}
// tab.stopFind {id,clearSelection?}; tab.print {id}
// permission.resolve {id: decimal prompt id, result:"accept"|"deny"|"dismiss"}
//
// Events: engine.ready, engine.schedulePump, engine.readyToShutdown;
// tab.created {id,browserId}, tab.closed {id}, tab.changed {id,...changed fields};
// tab.popup {id,url,disposition,userGesture}; tab.findResult;
// permission.requested {id,browserId,origin,permissions:uint32}, permission.dismissed;
// and engine.event {topic,payload} from the nn_* engine services.
NNCORE_C_EXPORT void nncore_call(const char* method, const char* args_json,
                                nncore_reply_t reply, void* context);

#ifdef __cplusplus
}  // extern "C"
#endif
#endif  // BAY_CORE_PUBLIC_NNCORE_C_H_
