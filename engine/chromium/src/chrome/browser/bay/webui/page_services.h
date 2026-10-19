// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PAGE_SERVICES_H_
#define CHROME_BROWSER_BAY_WEBUI_PAGE_SERVICES_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace bay {
using PageResponse = base::OnceCallback<void(const std::string&)>;

// Shared snapshot for the explicit getter and native security-change events.
base::DictValue GetPageSecurityInfo(content::WebContents* contents);

// Runs on the UI sequence. Returns false without consuming the callback when
// the command is not implemented here. Every handled command replies once with
// the NativeHost JSON wire envelope, including after its page is destroyed.
bool DispatchPageMethod(content::WebContents* contents,
                        const std::string& command,
                        const base::ListValue& params,
                        PageResponse& callback);
}  // namespace bay
#endif  // CHROME_BROWSER_BAY_WEBUI_PAGE_SERVICES_H_
