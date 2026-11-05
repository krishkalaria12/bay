// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_PROFILE_WINDOW_H_
#define CHROME_BROWSER_BAY_WEBUI_PROFILE_WINDOW_H_

#include <memory>
#include <string>
#include <vector>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "chrome/browser/ui/browser_window.h"
#include "chrome/browser/ui/exclusive_access/exclusive_access_context.h"

class Browser;
class WebUIBrowserExclusiveAccessContext;
class WebUIBrowserWindow;

namespace bay {

// The window of a profile's Browser inside a Bay window whose own Browser (the
// frame, a BayWebUIBrowserWindow) is another profile's. As on macOS (nncore's
// WindowHost and NNBrowserWindow), one window holds a Browser per profile it
// shows: a space's tabs keep their own profile while every space shares the
// window, so switching spaces never replaces it. This window has no widget;
// what a page asks of its window (bounds, activation, dialogs, bubbles,
// fullscreen, keys) is the frame's.
class ProfileBrowserWindow final : public BrowserWindow,
                                   public ExclusiveAccessContext {
 public:
  explicit ProfileBrowserWindow(base::WeakPtr<BrowserWindowInterface> frame);
  ProfileBrowserWindow(const ProfileBrowserWindow&) = delete;
  ProfileBrowserWindow& operator=(const ProfileBrowserWindow&) = delete;

  // Called once Browser::Create has returned with this window.
  void AttachBrowser(Browser* browser);
  // The frame's widget changed show state: Chrome's fullscreen bookkeeping
  // for this Browser follows it.
  void FrameShowStateChanged();

  // ui::BaseWindow:
  bool IsActive() const override;
  bool IsMaximized() const override;
  bool IsMinimized() const override;
  bool IsFullscreen() const override;
  gfx::NativeWindow GetNativeWindow() const override;
  gfx::Rect GetRestoredBounds() const override;
  ui::mojom::WindowShowState GetRestoredState() const override;
  gfx::Rect GetBounds() const override;
  void Show() override;
  void Hide() override {}
  bool IsVisible() const override;
  void ShowInactive() override {}
  void Close() override;
  void Activate() override;
  void Deactivate() override {}
  void Maximize() override {}
  void Minimize() override {}
  void Restore() override {}
  void SetBounds(const gfx::Rect& bounds) override {}
  void FlashFrame(bool flash) override {}
  ui::ZOrderLevel GetZOrderLevel() const override;
  void SetZOrderLevel(ui::ZOrderLevel order) override {}

  // BrowserWindow:
  bool IsOnCurrentWorkspace() const override;
  bool IsVisibleOnScreen() const override;
  void SetTopControlsShownRatio(content::WebContents* web_contents,
                                float ratio) override {}
  bool DoBrowserControlsShrinkRendererSize(
      const content::WebContents* contents) const override;
  ui::NativeTheme* GetNativeTheme() override;
  const ui::ThemeProvider* GetThemeProvider() const override;
  const ui::ColorProvider* GetColorProvider() const override;
  int GetTopControlsHeight() const override;
  void SetTopControlsGestureScrollInProgress(bool in_progress) override {}
  std::vector<StatusBubble*> GetStatusBubbles() override;
  void UpdateTitleBar() override {}
  void UpdateLoadingAnimations(bool is_visible) override {}
  void OnActiveTabChanged(content::WebContents* old_contents,
                          content::WebContents* new_contents,
                          int index,
                          int reason) override {}
  void OnTabDetached(content::WebContents* contents, bool was_active) override {
  }
  gfx::Size GetContentsSize() const override;
  void SetContentsSize(const gfx::Size& size) override {}
  autofill::AutofillBubbleHandler* GetAutofillBubbleHandler() override;
  LocationBar* GetLocationBar() const override;
  void SetFocusToLocationBar(bool is_user_initiated) override;
  void UpdateReloadStopState(bool is_loading, bool force) override {}
  void UpdateToolbar(content::WebContents* contents) override {}
  bool UpdateToolbarSecurityState() override;
  void UpdateCustomTabBarVisibility(bool visible, bool animate) override {}
  void ResetToolbarTabState(content::WebContents* contents) override {}
  void FocusToolbar() override {}
  void ToolbarSizeChanged(bool is_animating) override {}
  void TabDraggingStatusChanged(bool is_dragging) override {}
  void LinkOpeningFromGesture(WindowOpenDisposition disposition) override {}
  void FocusAppMenu() override {}
  bool IsTabStripEditable() const override;
  void DisableTabStripEditingForTesting() override {}
  bool IsToolbarVisible() const override;
  bool IsToolbarShowing() const override;
  bool IsLocationBarVisible() const override;
  void ShowUpdateChromeDialog() override {}
  void ShowIntentPickerBubble(
      std::vector<apps::IntentPickerAppInfo> app_info,
      bool show_stay_in_chrome,
      bool show_remember_selection,
      apps::IntentPickerBubbleType bubble_type,
      const std::optional<url::Origin>& initiating_origin,
      IntentPickerResponse callback) override {}
  void ShowBookmarkBubble(const GURL& url, bool already_bookmarked) override {}
  ShowTranslateBubbleResult ShowTranslateBubble(
      content::WebContents* contents,
      translate::TranslateStep step,
      const std::string& source_language,
      const std::string& target_language,
      translate::TranslateErrors error_type,
      bool is_user_gesture) override;
  DownloadBubbleUIController* GetDownloadBubbleUIController() override;
  void ConfirmBrowserCloseWithPendingDownloads(
      int download_count,
      UnloadController::DownloadCloseType dialog_type,
      base::OnceCallback<void(bool)> callback) override;
  void ShowAppMenu() override {}
  void PreHandleDragUpdate(const content::DropData& drop_data,
                           const gfx::PointF& point) override {}
  void PreHandleDragExit() override {}
  void HandleDragEnded() override {}
  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      const input::NativeWebKeyboardEvent& event) override;
  bool HandleKeyboardEvent(const input::NativeWebKeyboardEvent& event) override;
  std::unique_ptr<FindBar> CreateFindBar() override;
  web_modal::WebContentsModalDialogHost* GetWebContentsModalDialogHost()
      override;
  web_modal::WebContentsModalDialogHost* GetWebContentsModalDialogHostFor(
      content::WebContents* web_contents) override;
  void ShowAvatarBubbleFromAvatarButton(bool is_source_accelerator) override {}
  void MaybeShowProfileSwitchIPH() override {}
  void MaybeShowSupervisedUserProfileSignInIPH() override {}
  void ShowHatsDialog(
      const std::string& site_id,
      const std::optional<std::string>& hats_histogram_name,
      const std::optional<uint64_t> hats_survey_ukm_id,
      base::OnceClosure success_callback,
      base::OnceClosure failure_callback,
      const SurveyBitsData& product_specific_bits_data,
      const SurveyStringData& product_specific_string_data) override {}
  ExclusiveAccessContext* GetExclusiveAccessContext() override;
  std::string GetWorkspace() const override;
  bool IsVisibleOnAllWorkspaces() const override;
  void ShowEmojiPanel() override;
  std::unique_ptr<content::EyeDropper> OpenEyeDropper(
      content::RenderFrameHost* frame,
      content::EyeDropperListener* listener) override;
  void ShowCaretBrowsingDialog() override {}
  void CreateTabSearchBubble() override {}
  void CloseTabSearchBubble() override {}
  void ShowIncognitoClearBrowsingDataDialog() override {}
  void ShowIncognitoHistoryDisclaimerDialog() override {}
  bool IsUnframedModeEnabled() const override;
  bool GetCanResize() override;
  ui::mojom::WindowShowState GetWindowShowState() const override;
  void ShowChromeLabs() override {}
  BrowserView* AsBrowserView() override;

  // ExclusiveAccessContext: the frame's widget goes fullscreen and shows the
  // bubble; the page and Chrome's state for it are this Browser's.
  Profile* GetProfile() override;
  void EnterFullscreen(const url::Origin& origin,
                       ExclusiveAccessBubbleType bubble_type,
                       FullscreenTabParams fullscreen_tab_params) override;
  void ExitFullscreen() override;
  void UpdateExclusiveAccessBubble(
      const ExclusiveAccessBubbleParams& params,
      ExclusiveAccessBubbleHideCallback first_hide_callback) override;
  bool IsExclusiveAccessBubbleDisplayed() const override;
  void OnExclusiveAccessUserInput() override;
  content::WebContents* GetWebContentsForExclusiveAccess() override;
  bool CanUserEnterFullscreen() const override;
  bool CanUserExitFullscreen() const override;

 protected:
  void DeleteBrowserWindow() override;

 private:
  ~ProfileBrowserWindow() override;
  // The frame's window: its WebUI one, and as the interface pages call.
  WebUIBrowserWindow* FrameWindow() const;
  BrowserWindow* Frame() const;
  WebUIBrowserExclusiveAccessContext* FrameAccess() const;

  const base::WeakPtr<BrowserWindowInterface> frame_;
  raw_ptr<Browser> browser_ = nullptr;
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_PROFILE_WINDOW_H_
