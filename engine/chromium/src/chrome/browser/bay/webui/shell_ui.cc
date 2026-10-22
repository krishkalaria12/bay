// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/shell_ui.h"

#include <utility>
#include <vector>

#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/memory/ref_counted.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/timer/timer.h"
#include "cc/paint/paint_flags.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/icon_loader.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "components/constrained_window/constrained_window_views.h"
#include "content/public/browser/browser_thread.h"
#include "net/base/filename_util.h"
#include "skia/ext/image_operations.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/base/base_window.h"
#include "ui/base/models/image_model.h"
#include "ui/base/models/menu_separator_types.h"
#include "ui/base/mojom/dialog_button.mojom.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "ui/base/mojom/ui_base_types.mojom.h"
#include "ui/display/screen.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/image/canvas_image_source.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/image/image_skia_rep.h"
#include "ui/menus/simple_menu_model.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/views/controls/message_box_view.h"
#include "ui/views/controls/textfield/textfield.h"
#include "ui/views/layout/layout_provider.h"
#include "ui/views/widget/widget.h"
#include "ui/views/window/dialog_delegate.h"
#include "url/gurl.h"

namespace bay {
namespace {
std::string Success(std::optional<std::string> value) {
  return base::WriteJson(base::DictValue().Set(
                             "value", value ? base::Value(std::move(*value))
                                            : base::Value()))
      .value_or("{\"value\":null}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}
std::string ConfirmResult(bool confirmed, bool suppressed) {
  return base::WriteJson(
             base::DictValue().Set("value", base::DictValue()
                                                .Set("confirmed", confirmed)
                                                .Set("suppressed", suppressed)))
      .value_or("{}");
}
std::string SelectedFiles(base::ListValue files) {
  return base::WriteJson(base::DictValue().Set("value", std::move(files)))
      .value_or("{\"value\":[]}");
}
std::optional<std::string> EncodeIcon(SkBitmap bitmap, int pixels) {
  if (bitmap.drawsNothing())
    return std::nullopt;
  if (bitmap.width() != pixels || bitmap.height() != pixels)
    bitmap = skia::ImageOperations::Resize(
        bitmap, skia::ImageOperations::RESIZE_BEST, pixels, pixels);
  if (bitmap.drawsNothing())
    return std::nullopt;
  auto png = gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, false);
  return png ? std::make_optional("data:image/png;base64," +
                                  base::Base64Encode(*png))
             : std::nullopt;
}

using Completion = base::OnceCallback<void(std::string)>;

class PromptDialog final : public views::DialogDelegate {
 public:
  PromptDialog(const ShellPromptOptions& options, Completion completion)
      : completion_(std::move(completion)) {
    SetTitle(options.title);
    SetModalType(ui::mojom::ModalType::kWindow);
    SetButtons(static_cast<int>(ui::mojom::DialogButton::kOk) |
               static_cast<int>(ui::mojom::DialogButton::kCancel));
    if (!options.confirm_title.empty())
      SetButtonLabel(ui::mojom::DialogButton::kOk, options.confirm_title);
    set_margins(
        views::LayoutProvider::Get()->GetInsetsMetric(views::INSETS_DIALOG));
    auto message =
        std::make_unique<views::MessageBoxView>(options.message, true);
    message->SetMessageWidth(360);
    message->SetPromptField(options.value);
    auto* field = message->GetVisiblePromptField();
    field->SetPlaceholderText(options.placeholder);
    field->GetViewAccessibility().SetName(
        !options.placeholder.empty() ? options.placeholder
        : !options.title.empty()     ? options.title
                                     : u"Input");
    field->SelectAll(false);
    SetInitiallyFocusedView(field);
    SetContentsView(std::move(message));
    SetAcceptCallback(
        base::BindOnce(&PromptDialog::Finish, base::Unretained(this), true));
    SetCancelCallback(
        base::BindOnce(&PromptDialog::Finish, base::Unretained(this), false));
    SetCloseCallback(
        base::BindOnce(&PromptDialog::Finish, base::Unretained(this), false));
  }
  ~PromptDialog() override { Finish(false); }

 private:
  void Finish(bool accepted) {
    if (!completion_)
      return;
    auto text = accepted
                    ? NormalizeShellPromptText(
                          static_cast<views::MessageBoxView*>(GetContentsView())
                              ->GetInputText())
                    : std::nullopt;
    std::move(completion_).Run(Success(std::move(text)));
  }
  Completion completion_;
};

class ConfirmDialog final : public views::DialogDelegate {
 public:
  ConfirmDialog(const ShellConfirmOptions& options, Completion completion)
      : completion_(std::move(completion)) {
    SetTitle(options.title);
    SetModalType(ui::mojom::ModalType::kWindow);
    SetButtons(static_cast<int>(ui::mojom::DialogButton::kOk) |
               static_cast<int>(ui::mojom::DialogButton::kCancel));
    if (!options.confirm_title.empty())
      SetButtonLabel(ui::mojom::DialogButton::kOk, options.confirm_title);
    if (!options.cancel_title.empty())
      SetButtonLabel(ui::mojom::DialogButton::kCancel, options.cancel_title);
    // Views has no destructive button style. As in GNOME, Return keeps the
    // safe choice.
    if (options.destructive)
      SetDefaultButton(static_cast<int>(ui::mojom::DialogButton::kCancel));
    set_margins(
        views::LayoutProvider::Get()->GetInsetsMetric(views::INSETS_DIALOG));
    auto message =
        std::make_unique<views::MessageBoxView>(options.message, true);
    message->SetMessageWidth(360);
    if (options.suppression)
      message->SetCheckBoxLabel(*options.suppression);
    SetContentsView(std::move(message));
    SetAcceptCallback(
        base::BindOnce(&ConfirmDialog::Finish, base::Unretained(this), true));
    SetCancelCallback(
        base::BindOnce(&ConfirmDialog::Finish, base::Unretained(this), false));
    SetCloseCallback(
        base::BindOnce(&ConfirmDialog::Finish, base::Unretained(this), false));
  }
  // The contents may already be gone; report the checkbox as clear.
  ~ConfirmDialog() override { Complete(false, false); }

 private:
  // Like macOS, the checkbox reports its state with either button.
  void Finish(bool confirmed) {
    Complete(confirmed, static_cast<views::MessageBoxView*>(GetContentsView())
                            ->IsCheckBoxSelected());
  }
  void Complete(bool confirmed, bool suppressed) {
    if (completion_)
      std::move(completion_).Run(ConfirmResult(confirmed, suppressed));
  }
  Completion completion_;
};

// A menu item's color dot, drawn as macOS draws it: filled, with a 15% black
// outline.
class SwatchImage final : public gfx::CanvasImageSource {
 public:
  explicit SwatchImage(SkColor color)
      : CanvasImageSource(gfx::Size(12, 12)), color_(color) {}

  void Draw(gfx::Canvas* canvas) override {
    const gfx::PointF center(6, 6);
    cc::PaintFlags flags;
    flags.setAntiAlias(true);
    flags.setColor(color_);
    canvas->DrawCircle(center, 5.5f, flags);
    flags.setStyle(cc::PaintFlags::kStroke_Style);
    flags.setStrokeWidth(1);
    flags.setColor(SkColorSetA(SK_ColorBLACK, 0x26));
    canvas->DrawCircle(center, 5.5f, flags);
  }

 private:
  const SkColor color_;
};

// Builds `Dialog` from a copy of its options once ShellUI has its token.
template <typename Dialog, typename Options>
base::OnceCallback<std::unique_ptr<views::DialogDelegate>(Completion)>
MakeDialog(const Options& options) {
  return base::BindOnce(
      [](const Options& options,
         Completion done) -> std::unique_ptr<views::DialogDelegate> {
        return std::make_unique<Dialog>(options, std::move(done));
      },
      options);
}
}  // namespace

// SelectFile may run a nested loop or complete synchronously. Keep the listener
// and dialog alive on that stack even if the response destroys its ShellUI.
class ShellUI::FilePicker final : public base::RefCounted<FilePicker>,
                                  public ui::SelectFileDialog::Listener {
 public:
  FilePicker(Response response, base::OnceCallback<void(FilePicker*)> done)
      : response_(std::move(response)), done_(std::move(done)) {}

  void Show(gfx::NativeWindow parent) {
    auto dialog = ui::SelectFileDialog::Create(this, nullptr);
    // A factory can re-enter and destroy the owner before returning.
    if (!response_) {
      if (dialog)
        dialog->ListenerDestroyed();
      return;
    }
    if (!dialog) {
      Complete(Failure("dialog_unavailable", "The file picker is unavailable"));
      return;
    }
    dialog_ = dialog;
    dialog->SelectFile(ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE,
                       u"Open files", base::FilePath(), nullptr, 0,
                       base::FilePath::StringType(), parent, nullptr);
  }

  void FileSelected(const ui::SelectedFileInfo& file, int) override {
    Complete(SelectedFiles(
        base::ListValue().Append(net::FilePathToFileURL(file.path()).spec())));
  }
  void MultiFilesSelected(
      const std::vector<ui::SelectedFileInfo>& selected) override {
    base::ListValue files;
    for (const auto& file : selected)
      files.Append(net::FilePathToFileURL(file.path()).spec());
    Complete(SelectedFiles(std::move(files)));
  }
  void FileSelectionCanceled() override { Complete(SelectedFiles({})); }

 private:
  friend class base::RefCounted<FilePicker>;
  ~FilePicker() override {
    if (dialog_)
      dialog_->ListenerDestroyed();
  }

  void Complete(std::string result) {
    if (!response_)
      return;
    scoped_refptr<FilePicker> keep_alive(this);
    auto response = std::move(response_);
    auto done = std::move(done_);
    auto runner = base::SequencedTaskRunner::GetCurrentDefault();
    std::move(response).Run(result);
    // Windows ends the modal run after listener notification. Portal detachment
    // also releases its GTK fallback, which still uses its helper on that
    // stack. Keep both the busy slot and listener alive until the callback
    // unwinds. Post after responding so a nested loop in the response cannot
    // detach early.
    runner->PostTask(FROM_HERE,
                     base::BindOnce(
                         [](scoped_refptr<FilePicker> picker,
                            base::OnceCallback<void(FilePicker*)> done) {
                           auto dialog = std::move(picker->dialog_);
                           if (dialog)
                             dialog->ListenerDestroyed();
                           std::move(done).Run(picker.get());
                         },
                         std::move(keep_alive), std::move(done)));
  }

  scoped_refptr<ui::SelectFileDialog> dialog_;
  Response response_;
  base::OnceCallback<void(FilePicker*)> done_;
};

// Anchored at the pointer. Wayland reports it relative to the window, which
// is how Chrome's own context menus are placed there.
class ShellUI::ContextMenu final : public ui::SimpleMenuModel::Delegate {
 public:
  ContextMenu(const std::vector<ShellMenuItem>& items,
              Response response,
              base::OnceClosure done)
      : response_(std::move(response)), done_(std::move(done)), model_(this) {
    Build(items, model_);
  }

  void Show(views::Widget* parent) {
    if (model_.GetItemCount() == 0) {
      Closed();
      return;
    }
    runner_ = std::make_unique<views::MenuRunner>(
        &model_, views::MenuRunner::CONTEXT_MENU,
        base::BindRepeating(&ContextMenu::Closed, base::Unretained(this)));
    runner_->RunMenuAt(
        parent, nullptr,
        gfx::Rect(display::Screen::Get()->GetCursorScreenPoint(), gfx::Size()),
        views::MenuAnchorPosition::kTopLeft, ui::mojom::MenuSourceType::kMouse);
  }
  // The owner is going away. Releasing the runner detaches it from this
  // delegate, so Closed() cannot run afterwards.
  void Cancel() {
    if (response_)
      std::move(response_).Run(Success(std::nullopt));
  }

  bool IsCommandIdEnabled(int command_id) const override {
    auto it = commands_.find(command_id);
    return it != commands_.end() && it->second.enabled;
  }
  bool IsCommandIdChecked(int command_id) const override {
    auto it = commands_.find(command_id);
    return it != commands_.end() && it->second.checked;
  }
  void ExecuteCommand(int command_id, int) override {
    auto it = commands_.find(command_id);
    if (it != commands_.end() && it->second.enabled)
      selected_ = it->second.id;
  }

 private:
  struct Command {
    std::string id;
    bool enabled;
    bool checked;
  };

  void Build(const std::vector<ShellMenuItem>& items,
             ui::SimpleMenuModel& model) {
    for (const auto& item : items) {
      if (item.separator) {
        model.AddSeparator(ui::NORMAL_SEPARATOR);
        continue;
      }
      const int command_id = static_cast<int>(commands_.size()) + 1;
      commands_.emplace(command_id, Command{item.id, item.enabled,
                                            item.checked.value_or(false)});
      if (item.children) {
        auto submenu = std::make_unique<ui::SimpleMenuModel>(this);
        Build(*item.children, *submenu);
        model.AddSubMenu(command_id, item.title, submenu.get());
        submenus_.push_back(std::move(submenu));
      } else if (item.checked) {
        model.AddCheckItem(command_id, item.title);
      } else {
        model.AddItem(command_id, item.title);
      }
      const size_t index = model.GetItemCount() - 1;
      if (!item.shortcut.empty())
        model.SetMinorText(index, item.shortcut);
      if (item.swatch)
        model.SetIcon(index,
                      ui::ImageModel::FromImageSkia(
                          gfx::CanvasImageSource::MakeImageSkia<SwatchImage>(
                              static_cast<SkColor>(*item.swatch))));
    }
  }
  void Closed() {
    if (!response_)
      return;
    // The runner calls this from its own stack; release it afterwards.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             std::move(done_));
    std::move(response_).Run(Success(selected_));
  }

  Response response_;
  base::OnceClosure done_;
  std::map<int, Command> commands_;
  std::optional<std::string> selected_;
  std::vector<std::unique_ptr<ui::SimpleMenuModel>> submenus_;
  ui::SimpleMenuModel model_;
  // Destroy the runner before its model and delegate.
  std::unique_ptr<views::MenuRunner> runner_;
};

struct ShellUI::PendingDialog {
  base::WeakPtr<BrowserWindowInterface> window;
  base::WeakPtr<views::Widget> widget;
  std::string cancelled;
  Response callback;
};
struct ShellUI::PendingIcon {
  Response callback;
  base::OneShotTimer deadline;
};
ShellUI::ShellUI() = default;
ShellUI::~ShellUI() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  if (auto menu = std::move(context_menu_))
    menu->Cancel();
  auto picker = std::move(file_picker_);
  if (picker)
    picker->FileSelectionCanceled();
  // Close() is asynchronous. Dialog callbacks carry only a weak owner and
  // cannot re-enter a destroyed service when the widget later goes away.
  auto dialogs = std::exchange(dialogs_, {});
  for (auto& [token, dialog] : dialogs) {
    if (dialog->widget && !dialog->widget->IsClosed())
      dialog->widget->CloseWithReason(
          views::Widget::ClosedReason::kUnspecified);
    std::move(dialog->callback).Run(dialog->cancelled);
  }
  auto icons = std::exchange(icons_, {});
  for (auto& [token, icon] : icons)
    std::move(icon->callback).Run(Success(std::nullopt));
}

bool ShellUI::Dispatch(const HostContext& context,
                       const std::string& module,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& callback) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module == "BayShell" && method == "pickFiles") {
    if (!args.empty()) {
      std::move(callback).Run(
          Failure("invalid_args", "The file picker takes no arguments"));
      return true;
    }
    // There is no windowId in this contract. In particular, coordinators must
    // never borrow the last active window to open a file picker.
    auto* window = context.is_window() ? context.window() : nullptr;
    if (!window || !window->GetWindow() ||
        !window->GetWindow()->GetNativeWindow()) {
      std::move(callback).Run(
          Failure("window_required", "The file picker requires a window host"));
      return true;
    }
    if (file_picker_) {
      std::move(callback).Run(
          Failure("dialog_busy", "A file picker is already open"));
      return true;
    }
    auto picker = base::MakeRefCounted<FilePicker>(
        std::move(callback), base::BindOnce(&ShellUI::FilePickerFinished,
                                            weak_factory_.GetWeakPtr()));
    file_picker_ = picker;
    picker->Show(window->GetWindow()->GetNativeWindow());
    return true;
  }
  if (module == "BayShell" && method == "showMenu") {
    auto items = ParseShellMenuArgs(args);
    if (!items) {
      std::move(callback).Run(Failure("invalid_args", "Invalid menu items"));
      return true;
    }
    // Like the file picker, a menu opens only in its own document's window.
    auto* window = context.is_window() ? context.window() : nullptr;
    auto* widget = window && window->GetWindow()
                       ? views::Widget::GetWidgetForNativeWindow(
                             window->GetWindow()->GetNativeWindow())
                       : nullptr;
    if (!widget) {
      std::move(callback).Run(
          Failure("window_required", "A context menu requires a window host"));
      return true;
    }
    if (context_menu_) {
      std::move(callback).Run(
          Failure("menu_busy", "A context menu is already open"));
      return true;
    }
    context_menu_ = std::make_unique<ContextMenu>(
        *items, std::move(callback),
        base::BindOnce(&ShellUI::ContextMenuFinished,
                       weak_factory_.GetWeakPtr()));
    context_menu_->Show(widget);
    return true;
  }
  if (module == "BayShell" && method == "prompt") {
    auto options = args.size() == 1 && args[0].is_dict()
                       ? ParseShellPromptOptions(args[0].GetDict())
                       : std::nullopt;
    if (!options) {
      std::move(callback).Run(
          Failure("invalid_args", "Invalid prompt options"));
      return true;
    }
    ShowDialog(context, options->window_id, Success(std::nullopt), callback,
               MakeDialog<PromptDialog>(*options));
    return true;
  }
  if (module == "BayShell" && method == "confirm") {
    auto options = args.size() == 1 && args[0].is_dict()
                       ? ParseShellConfirmOptions(args[0].GetDict())
                       : std::nullopt;
    if (!options) {
      std::move(callback).Run(
          Failure("invalid_args", "Invalid confirmation options"));
      return true;
    }
    ShowDialog(context, options->window_id, ConfirmResult(false, false),
               callback, MakeDialog<ConfirmDialog>(*options));
    return true;
  }
  if (module == "BaySystem" && method == "fileIcon") {
    auto request = ParseShellFileIconArgs(args);
    if (!request) {
      std::move(callback).Run(
          Failure("invalid_args", "Invalid file icon request"));
      return true;
    }
    // Callers display their document fallback when an icon is unavailable.
    if (icons_.size() >= 128) {
      std::move(callback).Run(Success(std::nullopt));
      return true;
    }
    const auto token = next_token_++;
    auto pending = std::make_unique<PendingIcon>();
    pending->callback = std::move(callback);
    pending->deadline.Start(
        FROM_HERE, base::Seconds(10),
        base::BindOnce(&ShellUI::IconFinished, weak_factory_.GetWeakPtr(),
                       token, std::nullopt));
    icons_.emplace(token, std::move(pending));
    // IconLoader resolves the file group off-UI. Linux theme lookup returns
    // to UI; Windows embedded icons use Chrome's sandboxed icon service.
    IconLoader::LoadIcon(
        request->path,
        request->pixels <= 32 ? IconLoader::SMALL : IconLoader::LARGE,
        static_cast<float>(request->pixels) / (request->pixels <= 32 ? 16 : 48),
        base::BindOnce(
            [](base::WeakPtr<ShellUI> owner, uint64_t token, int pixels,
               gfx::Image image, const IconLoader::IconGroup&) {
              if (owner)
                owner->IconLoaded(token, pixels, image);
            },
            weak_factory_.GetWeakPtr(), token, request->pixels));
    return true;
  }
  return false;
}
void ShellUI::ShowDialog(const HostContext& context,
                         const std::optional<std::string>& window_id,
                         std::string cancelled,
                         Response& callback,
                         DialogFactory create) {
  auto* window =
      window_id ? WindowRegistry::Get().Find(*window_id) : context.window();
  if (!window || !window->GetWindow() ||
      !window->GetWindow()->GetNativeWindow()) {
    std::move(callback).Run(
        Failure("window_required", "The dialog's window is unavailable"));
    return;
  }
  if (context.is_window() && window != context.window()) {
    std::move(callback).Run(Failure(
        "forbidden", "A window cannot open a dialog in another window"));
    return;
  }
  for (const auto& [token, dialog] : dialogs_) {
    if (dialog->window.get() == window) {
      std::move(callback).Run(
          Failure("busy", "This window already has an open dialog"));
      return;
    }
  }
  if (dialogs_.size() >= 16) {
    std::move(callback).Run(Failure("busy", "Too many open dialogs"));
    return;
  }
  const auto token = next_token_++;
  auto pending = std::make_unique<PendingDialog>();
  pending->window = window->GetWeakPtr();
  pending->cancelled = cancelled;
  pending->callback = std::move(callback);
  dialogs_.emplace(token, std::move(pending));
  auto dialog = std::move(create).Run(base::BindOnce(
      &ShellUI::DialogFinished, weak_factory_.GetWeakPtr(), token));
  auto alive = weak_factory_.GetWeakPtr();
  auto* widget = constrained_window::CreateBrowserModalDialogViews(
      std::move(dialog), window->GetWindow()->GetNativeWindow());
  if (!alive) {
    if (widget && !widget->IsClosed())
      widget->Close();
    return;
  }
  const auto found = dialogs_.find(token);
  if (!widget || found == dialogs_.end()) {
    if (widget && !widget->IsClosed())
      widget->Close();
    DialogFinished(token, std::move(cancelled));
    return;
  }
  found->second->widget = widget->GetWeakPtr();
  widget->Show();
}
void ShellUI::ContextMenuFinished() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  context_menu_.reset();
}
void ShellUI::FilePickerFinished(FilePicker* picker) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (file_picker_.get() == picker)
    file_picker_.reset();
}
void ShellUI::DialogFinished(uint64_t token, std::string response) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const auto found = dialogs_.find(token);
  if (found == dialogs_.end())
    return;
  auto pending = std::move(found->second);
  dialogs_.erase(found);
  std::move(pending->callback).Run(response);
}
void ShellUI::IconLoaded(uint64_t token, int pixels, const gfx::Image& image) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (!icons_.contains(token))
    return;
  if (image.IsEmpty()) {
    IconFinished(token, std::nullopt);
    return;
  }
  SkBitmap bitmap;
  const auto skia_image = image.AsImageSkia();
  for (const auto& representation : skia_image.image_reps()) {
    if (representation.pixel_width() > bitmap.width())
      bitmap = representation.GetBitmap();
  }
  if (bitmap.drawsNothing())
    bitmap = image.AsBitmap();
  bitmap.setImmutable();
  // Snapshot the native image on its UI sequence, then resize/encode the
  // immutable pixels off-UI. PostTaskAndReply returns on the owning sequence.
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&EncodeIcon, std::move(bitmap), pixels),
      base::BindOnce(&ShellUI::IconFinished, weak_factory_.GetWeakPtr(),
                     token));
}
void ShellUI::IconFinished(uint64_t token, std::optional<std::string> image) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const auto found = icons_.find(token);
  if (found == icons_.end())
    return;
  auto pending = std::move(found->second);
  icons_.erase(found);
  std::move(pending->callback).Run(Success(std::move(image)));
}
}  // namespace bay
