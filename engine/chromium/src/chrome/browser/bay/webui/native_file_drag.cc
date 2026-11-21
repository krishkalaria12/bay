// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/native_file_drag.h"

#include <utility>
#include <vector>

#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/task/current_thread.h"
#include "base/task/thread_pool.h"
#include "build/build_config.h"
#include "chrome/browser/bay/webui/local_files.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "content/public/browser/weak_document_ptr.h"
#include "ui/base/clipboard/file_info.h"
#include "ui/base/dragdrop/os_exchange_data.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/views/button_drag_utils.h"
#include "url/gurl.h"

#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
#include "ui/aura/client/drag_drop_client.h"
#include "ui/aura/env.h"
#include "ui/aura/window.h"
#include "ui/base/dragdrop/drag_drop_types.h"
#include "ui/base/dragdrop/mojom/drag_drop_types.mojom-shared.h"
#include "ui/display/screen.h"
#include "ui/events/event_constants.h"
#endif

namespace bay {
namespace {
class DragState : public content::WebContentsUserData<DragState> {
 public:
  bool pending = false;

 private:
  explicit DragState(content::WebContents* contents)
      : content::WebContentsUserData<DragState>(*contents) {}
  friend content::WebContentsUserData<DragState>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};
WEB_CONTENTS_USER_DATA_KEY_IMPL(DragState);

bool TrustedDocument(content::WebContents* contents) {
  if (!contents || !contents->GetPrimaryMainFrame() ||
      !contents->GetPrimaryMainFrame()->IsRenderFrameLive())
    return false;
  const GURL& url = contents->GetLastCommittedURL();
  return url.SchemeIs("chrome") && url.host() == "bay";
}

#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
bool MouseHeld() {
  return aura::Env::HasInstance() &&
         aura::Env::GetInstance()->IsMouseButtonDown() &&
         (aura::Env::GetInstance()->mouse_button_flags() &
          ui::EF_LEFT_MOUSE_BUTTON);
}
void Resolved(base::WeakPtr<content::WebContents> contents,
              content::WeakDocumentPtr document,
              NativeFileDrag::Callback callback,
              std::optional<base::FilePath> path) {
  NativeFileDrag::Result result;
  auto finish = [&](std::string error = {}) {
    result.error = std::move(error);
    if (contents) {
      if (auto* state = DragState::FromWebContents(contents.get()))
        state->pending = false;
    }
    std::move(callback).Run(std::move(result));
  };
  if (!contents || !document.AsRenderFrameHostIfValid() ||
      document.AsRenderFrameHostIfValid() != contents->GetPrimaryMainFrame() ||
      !TrustedDocument(contents.get()) || !MouseHeld()) {
    finish();
    return;
  }
  if (!path) {
    finish("The file could not be accessed. It may have moved or been deleted.");
    return;
  }
  aura::Window* view = contents->GetNativeView();
  aura::Window* root = view ? view->GetRootWindow() : nullptr;
  auto* client = root ? aura::client::GetDragDropClient(root) : nullptr;
  if (!client || !display::Screen::Get()) {
    finish("Native file dragging is unavailable in this window.");
    return;
  }
  if (client->IsDragDropInProgress()) {
    finish("Another file drag is already in progress.");
    return;
  }
  auto data = NativeFileDrag::CreateData(*path);
  button_drag_utils::SetDragImage(
      GURL(), path->BaseName().LossyDisplayName(), gfx::ImageSkia(), nullptr,
      data.get());
  const gfx::Point location = display::Screen::Get()->GetCursorScreenPoint();
  result.started = true;
  // Chromium's Windows drag loop is nested. Application tasks must continue
  // so a browser page can receive the file, as in DragDownloadItem().
  base::CurrentThread::ScopedAllowApplicationTasksInNativeNestedLoop allow;
  const auto operation = client->StartDragAndDrop(
      std::move(data), root, view, location,
      ui::DragDropTypes::DRAG_COPY | ui::DragDropTypes::DRAG_LINK,
      ui::mojom::DragEventSource::kMouse);
  if (operation == ui::mojom::DragOperation::kCopy)
    result.operation = "copy";
  else if (operation == ui::mojom::DragOperation::kLink)
    result.operation = "link";
  finish();
}
#endif
}  // namespace

std::optional<base::FilePath> NativeFileDrag::ResolvePath(
    const std::string& path,
    const std::optional<std::string>& relative,
    LocalFileGrants& grants) {
  if (path.empty() || path.size() > 32768 ||
      path.find('\0') != std::string::npos ||
      (relative && (relative->size() > 32768 ||
                    relative->find('\0') != std::string::npos)))
    return std::nullopt;
  std::optional<base::FilePath> resolved;
  if (relative) {
    resolved = grants.Authorized(path, *relative);
  } else {
#if BUILDFLAG(IS_LINUX)
    // Native bytes, independently of the process locale (shell_files.cc).
    const base::FilePath direct(path);
#else
    const base::FilePath direct = base::FilePath::FromUTF8Unsafe(path);
#endif
    if (!direct.IsAbsolute())
      return std::nullopt;
    resolved = base::MakeAbsoluteFilePath(direct);
  }
  base::File::Info info;
  if (!resolved || resolved->empty() ||
      !base::GetFileInfo(*resolved, &info) ||
      !base::PathIsReadable(*resolved))
    return std::nullopt;
  return resolved;
}

std::unique_ptr<ui::OSExchangeData> NativeFileDrag::CreateData(
    const base::FilePath& path) {
  auto data = std::make_unique<ui::OSExchangeData>();
  data->SetFilenames({ui::FileInfo(path, path.BaseName())});
  return data;
}

void NativeFileDrag::Start(content::WebContents* contents,
                            const std::string& path,
                            const std::optional<std::string>& relative,
                            Callback callback) {
  if (!TrustedDocument(contents)) {
    Result result;
    result.error = "Only a Bay window document can start a file drag.";
    std::move(callback).Run(std::move(result));
    return;
  }
#if BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)
  if (!contents->HasRecentInteraction() || !MouseHeld()) {
    std::move(callback).Run(Result());
    return;
  }
  DragState::CreateForWebContents(contents);
  auto* state = DragState::FromWebContents(contents);
  if (state->pending) {
    Result result;
    result.error = "Another file drag is already in progress.";
    std::move(callback).Run(std::move(result));
    return;
  }
  state->pending = true;
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(
          [](std::string path, std::optional<std::string> relative) {
            return ResolvePath(path, relative, LocalFileGrants::Get());
          },
          path, relative),
      base::BindOnce(&Resolved, contents->GetWeakPtr(),
                     contents->GetPrimaryMainFrame()->GetWeakDocumentPtr(),
                     std::move(callback)));
#else
  Result result;
  result.error = "Native file dragging is unavailable in this host.";
  std::move(callback).Run(std::move(result));
#endif
}
}  // namespace bay
