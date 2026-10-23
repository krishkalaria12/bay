// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_NATIVE_HOST_H_
#define CHROME_BROWSER_BAY_WEBUI_NATIVE_HOST_H_

#include <map>
#include <memory>
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
class DocumentStore;
class SecretStorage;
class ShellUI;
class ShellAppearance;
class ShellFiles;
class DefaultBrowser;
class Autostart;
class AppServicesLinux;
class WindowButtonLayoutLinux;

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
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
  // Host info waits for saved documents and the platform snapshots.
  void PlatformReady();
  std::unique_ptr<ShellAppearance> appearance_;
  bool platform_ready_ = false;
  std::vector<GetHostInfoCallback> host_info_callbacks_;
#endif
#if BUILDFLAG(IS_WIN)
  std::unique_ptr<PlatformServices> platform_services_;
#endif

  const HostContext context_;
#if BUILDFLAG(IS_LINUX)
  std::unique_ptr<WindowButtonLayoutLinux> button_layout_;
  // Document-scoped ownership dismisses prompts and settles pending icons.
  std::unique_ptr<ShellFiles> files_;
  std::unique_ptr<DefaultBrowser> default_browser_;
  std::unique_ptr<Autostart> autostart_;
  std::unique_ptr<AppServicesLinux> app_services_;
  bool documents_ready_ = false;
  std::unique_ptr<ShellUI> shell_ui_;
  std::unique_ptr<SecretStorage> secret_storage_;
  std::unique_ptr<DocumentStore> documents_;
#endif
  std::unique_ptr<BrowserServices> browser_services_;
  std::unique_ptr<EngineServices> engine_services_;
  mojo::Remote<mojom::NativeHostClient> client_;
  std::map<int, std::unique_ptr<TabObserver>> tabs_;
  std::map<uintptr_t, std::pair<bool, InvokeCallback>> pending_;
  base::WeakPtrFactory<NativeHost> weak_factory_{this};
};
}  // namespace bay
#endif
