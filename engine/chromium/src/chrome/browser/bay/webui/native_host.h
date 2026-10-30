// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_NATIVE_HOST_H_
#define CHROME_BROWSER_BAY_WEBUI_NATIVE_HOST_H_

#include <map>
#include <set>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/host_context.h"
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
class EngineServices;

class NativeHost final : public content::DocumentService<mojom::NativeHost> {
 public:
  NativeHost(content::RenderFrameHost& frame,
             HostContext context,
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
  BrowserWindowInterface* browser() const { return context_.window(); }
  // The Bay document this host serves.
  content::WebContents* document_contents() const;
  // A key the window's document runs as its command (BayShell.setKeyShortcuts).
  struct KeyShortcut {
    int key_code;
    bool ctrl;
    bool shift;
    bool alt;
    std::string command;
    std::optional<std::string> arg;
  };
  const std::vector<KeyShortcut>& key_shortcuts() const {
    return key_shortcuts_;
  }
  bool is_coordinator() const { return !context_.is_window(); }
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

  const HostContext context_;
  std::unique_ptr<BrowserServices> browser_services_;
  std::unique_ptr<EngineServices> engine_services_;
  mojo::Remote<mojom::NativeHostClient> client_;
  std::map<int, std::unique_ptr<TabObserver>> tabs_;
  std::vector<KeyShortcut> key_shortcuts_;
  std::map<uintptr_t, std::pair<bool, InvokeCallback>> pending_;
  // View tags whose mount waits for its profile to load.
  std::set<int> loading_mounts_;
  base::WeakPtrFactory<NativeHost> weak_factory_{this};
};
}  // namespace bay
#endif
