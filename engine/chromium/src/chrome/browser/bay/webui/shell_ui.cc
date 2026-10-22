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
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/bay/webui/window_registry.h"
#include "chrome/browser/icon_loader.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "components/constrained_window/constrained_window_views.h"
#include "content/public/browser/browser_thread.h"
#include "net/base/filename_util.h"
#include "skia/ext/image_operations.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/base/base_window.h"
#include "ui/base/mojom/dialog_button.mojom.h"
#include "ui/base/mojom/ui_base_types.mojom.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/image/image_skia_rep.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "ui/views/accessibility/view_accessibility.h"
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

class PromptDialog final : public views::DialogDelegate {
 public:
  using Completion = base::OnceCallback<void(std::optional<std::string>)>;
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
    std::move(completion_).Run(std::move(text));
  }
  Completion completion_;
};
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

struct ShellUI::PendingPrompt {
  base::WeakPtr<BrowserWindowInterface> window;
  base::WeakPtr<views::Widget> widget;
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
  auto picker = std::move(file_picker_);
  if (picker)
    picker->FileSelectionCanceled();
  // Close() is asynchronous. Dialog callbacks carry only a weak owner and
  // cannot re-enter a destroyed service when the widget later goes away.
  auto prompts = std::exchange(prompts_, {});
  for (auto& [token, prompt] : prompts) {
    if (prompt->widget && !prompt->widget->IsClosed())
      prompt->widget->CloseWithReason(
          views::Widget::ClosedReason::kUnspecified);
    std::move(prompt->callback).Run(Success(std::nullopt));
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
  if (module == "BayShell" && method == "prompt") {
    auto options = args.size() == 1 && args[0].is_dict()
                       ? ParseShellPromptOptions(args[0].GetDict())
                       : std::nullopt;
    if (!options) {
      std::move(callback).Run(
          Failure("invalid_args", "Invalid prompt options"));
      return true;
    }
    auto* window = options->window_id
                       ? WindowRegistry::Get().Find(*options->window_id)
                       : context.window();
    if (!window || !window->GetWindow() ||
        !window->GetWindow()->GetNativeWindow()) {
      std::move(callback).Run(
          Failure("window_required", "The prompt window is unavailable"));
      return true;
    }
    if (context.is_window() && window != context.window()) {
      std::move(callback).Run(
          Failure("forbidden", "A window cannot prompt in another window"));
      return true;
    }
    for (const auto& [token, prompt] : prompts_) {
      if (prompt->window.get() == window) {
        std::move(callback).Run(
            Failure("busy", "This window already has an open prompt"));
        return true;
      }
    }
    if (prompts_.size() >= 16) {
      std::move(callback).Run(Failure("busy", "Too many open prompts"));
      return true;
    }
    const auto token = next_token_++;
    auto pending = std::make_unique<PendingPrompt>();
    pending->window = window->GetWeakPtr();
    pending->callback = std::move(callback);
    prompts_.emplace(token, std::move(pending));
    auto dialog = std::make_unique<PromptDialog>(
        *options, base::BindOnce(&ShellUI::PromptFinished,
                                 weak_factory_.GetWeakPtr(), token));
    auto alive = weak_factory_.GetWeakPtr();
    auto* widget = constrained_window::CreateBrowserModalDialogViews(
        std::move(dialog), window->GetWindow()->GetNativeWindow());
    if (!alive) {
      if (widget && !widget->IsClosed())
        widget->Close();
      return true;
    }
    const auto found = prompts_.find(token);
    if (!widget || found == prompts_.end()) {
      if (widget && !widget->IsClosed())
        widget->Close();
      PromptFinished(token, std::nullopt);
      return true;
    }
    found->second->widget = widget->GetWeakPtr();
    widget->Show();
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
void ShellUI::FilePickerFinished(FilePicker* picker) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (file_picker_.get() == picker)
    file_picker_.reset();
}
void ShellUI::PromptFinished(uint64_t token, std::optional<std::string> text) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  const auto found = prompts_.find(token);
  if (found == prompts_.end())
    return;
  auto pending = std::move(found->second);
  prompts_.erase(found);
  std::move(pending->callback).Run(Success(std::move(text)));
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
