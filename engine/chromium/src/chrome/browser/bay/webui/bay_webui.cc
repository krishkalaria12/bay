// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/bay_webui.h"

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/path_service.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/library_files.h"
#include "chrome/browser/bay/webui/window_registry.h"
#if BUILDFLAG(IS_LINUX)
#include "chrome/browser/bay/webui/quit_shortcut_linux.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "ui/content_accelerators/accelerator_util.h"
#endif
#include "chrome/browser/ui/webui_browser/webui_browser.h"
#include "components/input/native_web_keyboard_event.h"
#include "components/surface_embed/common/features.h"
#include "content/public/browser/keyboard_event_processing_result.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "third_party/skia/include/core/SkColor.h"
#if BUILDFLAG(IS_WIN)
#include "chrome/browser/bay/webui/frame_win.h"
#endif

namespace bay {
namespace {

base::FilePath AssetRoot() {
  base::FilePath directory;
  if (!base::PathService::Get(base::DIR_EXE, &directory))
    return {};
  return directory.AppendASCII("bay-ui");
}

scoped_refptr<base::RefCountedMemory> ReadAsset(const std::string& request) {
  std::string path = request.substr(0, request.find('?'));
  if (path.empty())
    path = "index.html";
  // Library's images: nothing but the files LibraryFiles named.
  constexpr std::string_view kLibraryMedia = "library-media/";
  if (path.starts_with(kLibraryMedia))
    return LibraryFiles::ReadAsset(
        std::string_view(path).substr(kLibraryMedia.size()));
  const base::FilePath relative = base::FilePath::FromUTF8Unsafe(path);
  // Never let a compromised WebUI read files outside the installed UI bundle.
  if (relative.IsAbsolute() || relative.ReferencesParent() ||
      path.find('\\') != std::string::npos ||
      path.find(':') != std::string::npos)
    return nullptr;
  const base::FilePath root = AssetRoot();
  if (root.empty())
    return nullptr;
  base::FilePath file = root.Append(relative);
  base::FilePath real_root;
  base::FilePath real_file;
  if (!base::NormalizeFilePath(root, &real_root) ||
      !base::NormalizeFilePath(file, &real_file) ||
      !real_root.IsParent(real_file))
    return nullptr;
  std::string bytes;
  if (!base::ReadFileToStringWithMaxSize(real_file, &bytes, 64 * 1024 * 1024))
    return nullptr;
  return base::MakeRefCounted<base::RefCountedString>(std::move(bytes));
}

}  // namespace

BayWebUIConfig::BayWebUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kBayHost) {}

bool BayWebUIConfig::IsWebUIEnabled(content::BrowserContext*) {
  return webui_browser::IsWebUIBrowserEnabled();
}

BayWebUIBrowserWindow::BayWebUIBrowserWindow(BrowserWindowInterface* browser)
    : WebUIBrowserWindow(browser, GURL(kBayURL)) {}

void BayWebUIBrowserWindow::SetFocusToLocationBar(bool is_user_initiated) {
  EmitWindowCommand(browser(), "focusCommandBar");
}
content::KeyboardEventProcessingResult
BayWebUIBrowserWindow::PreHandleKeyboardEvent(
    const input::NativeWebKeyboardEvent& event) {
#if BUILDFLAG(IS_LINUX)
  // Ahead of the page, as Chrome's reserved shortcuts are. Quitting is
  // Chrome's own user exit, so Bay's close preflight (native_host.cc) still
  // prepares the UI, the updater and the tabs first.
  if (event.GetType() == blink::WebInputEvent::Type::kRawKeyDown &&
      IsLinuxQuitShortcut(
          ui::GetAcceleratorFromNativeWebKeyboardEvent(event))) {
    chrome::AttemptUserExit();
    return content::KeyboardEventProcessingResult::HANDLED;
  }
#endif
  const auto shortcut = RunWindowShortcut(browser(), event);
  if (shortcut == WindowShortcut::kRan)
    return content::KeyboardEventProcessingResult::HANDLED;
  if (shortcut == WindowShortcut::kForDocument)
    return content::KeyboardEventProcessingResult::NOT_HANDLED;
  return WebUIBrowserWindow::PreHandleKeyboardEvent(event);
}
void BayWebUIBrowserWindow::Show() {
  if (!WindowRegistry::Get().AbsorbOnShow(browser()))
    WebUIBrowserWindow::Show();
}
void BayWebUIBrowserWindow::ShowInactive() {
  if (!WindowRegistry::Get().AbsorbOnShow(browser()))
    WebUIBrowserWindow::ShowInactive();
}

bool ConfigureBayWebUI(content::WebUI* web_ui) {
  if (!web_ui->GetWebContents()->GetVisibleURL().SchemeIs(
          content::kChromeUIScheme) ||
      web_ui->GetWebContents()->GetVisibleURL().host() != kBayHost)
    return false;
  auto* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), kBayHost);
  source->UseStringsJs();
#if BUILDFLAG(IS_WIN)
  // Mica shows through wherever a window's UI leaves its page transparent.
  if (FrameWin::BackdropEnabled() &&
      WebUIBrowserWindow::FromWebShellWebContents(web_ui->GetWebContents()))
    web_ui->GetWebContents()->SetPageBaseBackgroundColor(SK_ColorTRANSPARENT);
#endif
  // React Native Web injects style nodes and Expo loads local script chunks.
  // CSP still restricts executable code to the installed WebUI resources.
  source->DisableTrustedTypesCSP();
  source->AddString("platform",
#if BUILDFLAG(IS_WIN)
                    "windows"
#else
                    "linux"
#endif
  );
  source->AddBoolean(
      "enableSurfaceEmbed",
      base::FeatureList::IsEnabled(surface_embed::features::kSurfaceEmbed));
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ObjectSrc, "object-src 'self';");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ScriptSrc,
      "script-src 'self' chrome://resources;");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::StyleSrc,
      "style-src 'self' 'unsafe-inline' chrome://resources;");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ImgSrc,
      "img-src 'self' data: blob: https: chrome://favicon2;");
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ConnectSrc,
      "connect-src 'self' https:;");
  source->SetRequestFilter(
      base::BindRepeating([](const std::string&) { return true; }),
      base::BindRepeating([](const std::string& path,
                             content::WebUIDataSource::GotDataCallback reply) {
        base::ThreadPool::PostTaskAndReplyWithResult(
            FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
            base::BindOnce(&ReadAsset, path), std::move(reply));
      }));
  return true;
}
}  // namespace bay
