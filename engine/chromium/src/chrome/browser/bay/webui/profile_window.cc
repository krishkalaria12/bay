// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/profile_window.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/browser_window_features.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_bubble_hide_callback.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_manager.h"
#include "chrome/browser/ui/exclusive_access/fullscreen_controller.h"
#include "chrome/browser/ui/interaction/browser_elements.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/unload_controller.h"
#include "chrome/browser/ui/views/find_bar_host.h"
#include "chrome/browser/ui/views/find_bar_owner.h"
#include "chrome/browser/ui/webui_browser/browser_elements_webui_browser.h"
#include "chrome/browser/ui/webui_browser/webui_browser_exclusive_access_context.h"
#include "chrome/browser/ui/webui_browser/webui_browser_window.h"
#include "content/public/browser/eye_dropper.h"
#include "content/public/browser/keyboard_event_processing_result.h"

namespace bay {

ProfileBrowserWindow::ProfileBrowserWindow(
    base::WeakPtr<BrowserWindowInterface> frame)
    : frame_(std::move(frame)) {}

ProfileBrowserWindow::~ProfileBrowserWindow() {
  // As BrowserView: features holding references into the window go first.
  if (browser_)
    browser_->GetFeatures().TearDownPreBrowserWindowDestruction();
}

void ProfileBrowserWindow::AttachBrowser(Browser* browser) {
  browser_ = browser;
  auto* frame = FrameWindow();
  if (!frame)
    return;
  // Anchors are the frame's widget's, the one on screen.
  if (auto* elements = BrowserElements::From(browser)) {
    if (auto* webui = elements->AsA<BrowserElementsWebUiBrowser>())
      webui->Init(frame->widget());
  }
}

void ProfileBrowserWindow::FrameShowStateChanged() {
  if (!browser_)
    return;
  if (auto* manager = browser_->GetFeatures().exclusive_access_manager())
    manager->fullscreen_controller()->WindowFullscreenStateChanged();
}

WebUIBrowserWindow* ProfileBrowserWindow::FrameWindow() const {
  return frame_ ? WebUIBrowserWindow::FromBrowser(frame_.get()) : nullptr;
}
BrowserWindow* ProfileBrowserWindow::Frame() const {
  return FrameWindow();
}

WebUIBrowserExclusiveAccessContext* ProfileBrowserWindow::FrameAccess() const {
  return frame_ ? WebUIBrowserExclusiveAccessContext::From(frame_.get())
                : nullptr;
}

void ProfileBrowserWindow::DeleteBrowserWindow() {
  delete this;
}

bool ProfileBrowserWindow::IsActive() const {
  return Frame() && Frame()->IsActive();
}
bool ProfileBrowserWindow::IsMaximized() const {
  return Frame() && Frame()->IsMaximized();
}
bool ProfileBrowserWindow::IsMinimized() const {
  return Frame() && Frame()->IsMinimized();
}
bool ProfileBrowserWindow::IsFullscreen() const {
  return Frame() && Frame()->IsFullscreen();
}
gfx::NativeWindow ProfileBrowserWindow::GetNativeWindow() const {
  return Frame() ? Frame()->GetNativeWindow() : gfx::NativeWindow();
}
gfx::Rect ProfileBrowserWindow::GetRestoredBounds() const {
  return Frame() ? Frame()->GetRestoredBounds() : gfx::Rect();
}
ui::mojom::WindowShowState ProfileBrowserWindow::GetRestoredState() const {
  return Frame() ? Frame()->GetRestoredState()
                 : ui::mojom::WindowShowState::kDefault;
}
gfx::Rect ProfileBrowserWindow::GetBounds() const {
  return Frame() ? Frame()->GetBounds() : gfx::Rect();
}
void ProfileBrowserWindow::Show() {
  if (auto* frame = Frame())
    frame->Show();
}
bool ProfileBrowserWindow::IsVisible() const {
  return Frame() && Frame()->IsVisible();
}
void ProfileBrowserWindow::Close() {
  // As NNBrowserWindow::Close: beforeunload, then every tab closes; Chrome
  // calls back here once the strip is empty and then destroys the Browser.
  if (browser_)
    UnloadController::From(browser_)->OnWindowClosing();
}
void ProfileBrowserWindow::Activate() {
  if (auto* frame = Frame())
    frame->Activate();
}
ui::ZOrderLevel ProfileBrowserWindow::GetZOrderLevel() const {
  return Frame() ? Frame()->GetZOrderLevel() : ui::ZOrderLevel::kNormal;
}

bool ProfileBrowserWindow::IsOnCurrentWorkspace() const {
  return !Frame() || Frame()->IsOnCurrentWorkspace();
}
bool ProfileBrowserWindow::IsVisibleOnScreen() const {
  return Frame() && Frame()->IsVisibleOnScreen();
}
bool ProfileBrowserWindow::DoBrowserControlsShrinkRendererSize(
    const content::WebContents* contents) const {
  return false;
}
ui::NativeTheme* ProfileBrowserWindow::GetNativeTheme() {
  return Frame() ? Frame()->GetNativeTheme() : nullptr;
}
const ui::ThemeProvider* ProfileBrowserWindow::GetThemeProvider() const {
  return Frame() ? Frame()->GetThemeProvider() : nullptr;
}
const ui::ColorProvider* ProfileBrowserWindow::GetColorProvider() const {
  return Frame() ? Frame()->GetColorProvider() : nullptr;
}
int ProfileBrowserWindow::GetTopControlsHeight() const {
  return 0;
}
std::vector<StatusBubble*> ProfileBrowserWindow::GetStatusBubbles() {
  return Frame() ? Frame()->GetStatusBubbles() : std::vector<StatusBubble*>();
}
gfx::Size ProfileBrowserWindow::GetContentsSize() const {
  return Frame() ? Frame()->GetContentsSize() : gfx::Size();
}
autofill::AutofillBubbleHandler*
ProfileBrowserWindow::GetAutofillBubbleHandler() {
  return Frame() ? Frame()->GetAutofillBubbleHandler() : nullptr;
}
LocationBar* ProfileBrowserWindow::GetLocationBar() const {
  return Frame() ? Frame()->GetLocationBar() : nullptr;
}
void ProfileBrowserWindow::SetFocusToLocationBar(bool is_user_initiated) {
  if (auto* frame = Frame())
    frame->SetFocusToLocationBar(is_user_initiated);
}
bool ProfileBrowserWindow::UpdateToolbarSecurityState() {
  return false;
}
bool ProfileBrowserWindow::IsTabStripEditable() const {
  return true;
}
bool ProfileBrowserWindow::IsToolbarVisible() const {
  return false;
}
bool ProfileBrowserWindow::IsToolbarShowing() const {
  return false;
}
bool ProfileBrowserWindow::IsLocationBarVisible() const {
  return false;
}
ShowTranslateBubbleResult ProfileBrowserWindow::ShowTranslateBubble(
    content::WebContents* contents,
    translate::TranslateStep step,
    const std::string& source_language,
    const std::string& target_language,
    translate::TranslateErrors error_type,
    bool is_user_gesture) {
  return ShowTranslateBubbleResult::kBrowserWindowNotValid;
}
DownloadBubbleUIController*
ProfileBrowserWindow::GetDownloadBubbleUIController() {
  return nullptr;
}
void ProfileBrowserWindow::ConfirmBrowserCloseWithPendingDownloads(
    int download_count,
    UnloadController::DownloadCloseType dialog_type,
    base::OnceCallback<void(bool)> callback) {
  // The frame's close already asked; a profile's downloads outlive its window.
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(std::move(callback), true));
}
content::KeyboardEventProcessingResult
ProfileBrowserWindow::PreHandleKeyboardEvent(
    const input::NativeWebKeyboardEvent& event) {
  // Bay's shortcuts are the window's, whichever profile's page has the keys.
  return Frame() ? Frame()->PreHandleKeyboardEvent(event)
                 : content::KeyboardEventProcessingResult::NOT_HANDLED;
}
bool ProfileBrowserWindow::HandleKeyboardEvent(
    const input::NativeWebKeyboardEvent& event) {
  return Frame() && Frame()->HandleKeyboardEvent(event);
}
std::unique_ptr<FindBar> ProfileBrowserWindow::CreateFindBar() {
  // Chrome's features register the Browser's owner (BrowserWindowFeatures).
  auto* owner = browser_ ? FindBarOwner::From(browser_) : nullptr;
  return owner ? std::make_unique<FindBarHost>(owner) : nullptr;
}
web_modal::WebContentsModalDialogHost*
ProfileBrowserWindow::GetWebContentsModalDialogHost() {
  return Frame() ? Frame()->GetWebContentsModalDialogHost() : nullptr;
}
web_modal::WebContentsModalDialogHost*
ProfileBrowserWindow::GetWebContentsModalDialogHostFor(
    content::WebContents* web_contents) {
  return Frame() ? Frame()->GetWebContentsModalDialogHostFor(web_contents)
                 : nullptr;
}
ExclusiveAccessContext* ProfileBrowserWindow::GetExclusiveAccessContext() {
  return this;
}
std::string ProfileBrowserWindow::GetWorkspace() const {
  return Frame() ? Frame()->GetWorkspace() : std::string();
}
bool ProfileBrowserWindow::IsVisibleOnAllWorkspaces() const {
  return Frame() && Frame()->IsVisibleOnAllWorkspaces();
}
void ProfileBrowserWindow::ShowEmojiPanel() {
  if (auto* frame = Frame())
    frame->ShowEmojiPanel();
}
std::unique_ptr<content::EyeDropper> ProfileBrowserWindow::OpenEyeDropper(
    content::RenderFrameHost* frame,
    content::EyeDropperListener* listener) {
  return Frame() ? Frame()->OpenEyeDropper(frame, listener) : nullptr;
}
bool ProfileBrowserWindow::IsUnframedModeEnabled() const {
  return false;
}
bool ProfileBrowserWindow::GetCanResize() {
  return Frame() && Frame()->GetCanResize();
}
ui::mojom::WindowShowState ProfileBrowserWindow::GetWindowShowState() const {
  return Frame() ? Frame()->GetWindowShowState()
                 : ui::mojom::WindowShowState::kDefault;
}
BrowserView* ProfileBrowserWindow::AsBrowserView() {
  return nullptr;
}

Profile* ProfileBrowserWindow::GetProfile() {
  return browser_ ? browser_->GetProfile() : nullptr;
}
void ProfileBrowserWindow::EnterFullscreen(
    const url::Origin& origin,
    ExclusiveAccessBubbleType bubble_type,
    FullscreenTabParams fullscreen_tab_params) {
  // Chrome's state follows once the frame's widget has changed
  // (FrameShowStateChanged).
  if (auto* access = FrameAccess())
    access->EnterFullscreen(origin, bubble_type, fullscreen_tab_params);
}
void ProfileBrowserWindow::ExitFullscreen() {
  if (auto* access = FrameAccess())
    access->ExitFullscreen();
}
void ProfileBrowserWindow::UpdateExclusiveAccessBubble(
    const ExclusiveAccessBubbleParams& params,
    ExclusiveAccessBubbleHideCallback first_hide_callback) {
  if (auto* access = FrameAccess()) {
    access->UpdateExclusiveAccessBubble(params,
                                        std::move(first_hide_callback));
  } else if (first_hide_callback) {
    std::move(first_hide_callback)
        .Run(ExclusiveAccessBubbleHideReason::kNotShown);
  }
}
bool ProfileBrowserWindow::IsExclusiveAccessBubbleDisplayed() const {
  return FrameAccess() && FrameAccess()->IsExclusiveAccessBubbleDisplayed();
}
void ProfileBrowserWindow::OnExclusiveAccessUserInput() {
  if (auto* access = FrameAccess())
    access->OnExclusiveAccessUserInput();
}
content::WebContents* ProfileBrowserWindow::GetWebContentsForExclusiveAccess() {
  return browser_ ? browser_->GetTabStripModel()->GetActiveWebContents()
                  : nullptr;
}
bool ProfileBrowserWindow::CanUserEnterFullscreen() const {
  return true;
}
bool ProfileBrowserWindow::CanUserExitFullscreen() const {
  return true;
}

}  // namespace bay
