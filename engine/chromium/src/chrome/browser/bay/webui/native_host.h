// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_NATIVE_HOST_H_
#define CHROME_BROWSER_BAY_WEBUI_NATIVE_HOST_H_

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/native_host.mojom.h"
#include "content/public/browser/document_service.h"
#include "mojo/public/cpp/bindings/remote.h"

class BrowserWindowInterface;
namespace content {
class WebContents;
class WebUI;
}  // namespace content

namespace bay {
class TabObserver;
class PlatformServices;
class BrowserServices;

class NativeHost final : public content::DocumentService<mojom::NativeHost> {
 public:
  NativeHost(content::RenderFrameHost& frame,
             BrowserWindowInterface* browser,
             mojo::PendingReceiver<mojom::NativeHost> receiver);
  ~NativeHost() override;
  void GetHostInfo(GetHostInfoCallback callback) override;
  void Invoke(const std::string& module,
              const std::string& method,
              const std::string& args_json,
              InvokeCallback callback) override;
  void SetClient(mojo::PendingRemote<mojom::NativeHostClient> client) override;
  void Emit(const char* module, const char* event, base::Value payload);
  void ViewEvent(int tag, const char* event, base::DictValue payload);
  void PublishHostInfo();
  BrowserWindowInterface* browser() const { return browser_; }
  base::WeakPtr<NativeHost> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  void InvokeView(const std::string& method,
                  const base::ListValue& args,
                  InvokeCallback callback);
  void InvokeEngine(const std::string& name,
                    const std::string& profile,
                    base::DictValue args,
                    bool raw_json,
                    InvokeCallback callback);
  void CompleteEngine(uintptr_t token, const char* json);
  void InvokeBrowserEngine(const std::string& name,
                           const std::string& profile,
                           base::DictValue args,
                           InvokeCallback callback);
  content::WebContents* ContentsForTag(int tag) const;
  base::DictValue Info() const;
#if BUILDFLAG(IS_WIN)
  void PlatformReady();
  std::unique_ptr<PlatformServices> platform_services_;
  bool platform_ready_ = false;
  std::vector<GetHostInfoCallback> host_info_callbacks_;
#endif

  raw_ptr<BrowserWindowInterface> browser_;
  std::unique_ptr<BrowserServices> browser_services_;
  mojo::Remote<mojom::NativeHostClient> client_;
  std::map<int, std::unique_ptr<TabObserver>> tabs_;
  std::map<uintptr_t, std::pair<bool, InvokeCallback>> pending_;
  base::WeakPtrFactory<NativeHost> weak_factory_{this};
};
}  // namespace bay
#endif
