// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_NN_DISPATCH_H_
#define CHROME_BROWSER_BAY_NN_DISPATCH_H_
#include <string_view>
#include "chrome/browser/bay/public/nn_engine.h"
namespace bay {
// The generic JS bridge has the same restricted store access as macOS.
bool IsWebEngineCall(std::string_view name);
bool DispatchEngineCall(std::string_view name,
                        const char* profile,
                        const char* args,
                        nn_engine_reply_t reply,
                        void* context);
}
#endif
