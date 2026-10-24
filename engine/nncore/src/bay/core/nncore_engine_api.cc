// Copyright 2026 Bay. Apache-2.0.
#define NNCORE_ENGINE_IMPLEMENTATION
#include "bay/core/public/nncore_engine.h"

#include <string>

#include "base/functional/bind.h"
#include "chrome/browser/bay/nn_dispatch.h"
#include "chrome/browser/bay/public/nn_engine.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"

extern "C" int nn_engine_abi_version();
extern "C" void nn_engine_set_event_sink(nn_engine_event_t sink, void* context);

namespace {
void Dispatch(std::string name,
              std::string profile,
              std::string args,
              nncore_engine_reply_t reply,
              void* context) {
  if (!bay::DispatchEngineCall(name, profile.c_str(), args.c_str(), reply,
                               context) &&
      reply) {
    reply(context, "{\"error\":\"unknown engine call\"}");
  }
}
}  // namespace

extern "C" NNCORE_ENGINE_EXPORT int nncore_engine_abi_version() {
  // Both APIs currently share conventions. Detect an accidental skew rather
  // than advertising a version whose envelope the linked engine cannot honor.
  return nn_engine_abi_version() == NN_ENGINE_ABI_VERSION
             ? NNCORE_ENGINE_ABI_VERSION
             : 0;
}
extern "C" NNCORE_ENGINE_EXPORT void nncore_engine_call(
    const char* name,
    const char* profile_path,
    const char* args_json,
    nncore_engine_reply_t reply,
    void* context) {
  if (!name || !*name) {
    if (reply)
      reply(context, "{\"error\":\"engine call name required\"}");
    return;
  }
  if (!content::BrowserThread::IsThreadInitialized(
          content::BrowserThread::UI)) {
    if (reply)
      reply(context, "{\"error\":\"browser UI thread is unavailable\"}");
    return;
  }
  if (content::BrowserThread::CurrentlyOn(content::BrowserThread::UI)) {
    Dispatch(name, profile_path ? profile_path : "",
             args_json ? args_json : "{}", reply, context);
    return;
  }
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&Dispatch, std::string(name),
                                std::string(profile_path ? profile_path : ""),
                                std::string(args_json ? args_json : "{}"),
                                reply, context));
}
extern "C" NNCORE_ENGINE_EXPORT void nncore_engine_set_event_sink(
    nncore_engine_event_t sink,
    void* context) {
  nn_engine_set_event_sink(sink, context);
}
