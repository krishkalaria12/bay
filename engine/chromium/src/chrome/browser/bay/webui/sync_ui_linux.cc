// Copyright 2026 Bay. Apache-2.0.
#include "chrome/browser/bay/webui/sync_ui_linux.h"

#include <optional>
#include <utility>

#include "base/base_paths.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/memory/ref_counted.h"
#include "base/path_service.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/bay/data/packages/sync/windows/SyncService.h"
#include "chrome/browser/bay/webui/host_context.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "content/public/browser/browser_thread.h"
#include "ui/base/base_window.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/selected_file_info.h"

namespace bay {
namespace {
std::string Success(std::optional<std::string> path = std::nullopt) {
  return base::WriteJson(
             base::DictValue().Set(
                 "value", path ? base::Value(std::move(*path)) : base::Value()))
      .value_or("{\"value\":null}");
}
std::string Failure(const char* code, const char* message) {
  return base::WriteJson(
             base::DictValue().Set(
                 "error",
                 base::DictValue().Set("code", code).Set("message", message)))
      .value_or("{}");
}
}  // namespace

// Match ShellUI's listener lifetime: a native picker may complete or destroy
// its host synchronously, and portal detachment must wait for that stack.
class SyncUI::FilePicker final : public base::RefCounted<FilePicker>,
                                 public ui::SelectFileDialog::Listener {
 public:
  FilePicker(bool folder,
             std::string format,
             std::uint64_t generation,
             Response response,
             base::OnceCallback<void(FilePicker*)> done)
      : folder_(folder),
        format_(std::move(format)),
        generation_(generation),
        response_(std::move(response)),
        done_(std::move(done)) {}

  void Show(gfx::NativeWindow parent, const base::FilePath& initial) {
    auto dialog = ui::SelectFileDialog::Create(this, nullptr);
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
    ui::SelectFileDialog::FileTypeInfo types;
    const bool text = format_ == "text";
    if (!folder_) {
      types.extensions = {
          {text ? FILE_PATH_LITERAL("txt") : FILE_PATH_LITERAL("pdf")}};
      types.include_all_files = false;
    }
    dialog->SelectFile(
        folder_ ? ui::SelectFileDialog::SELECT_FOLDER
                : ui::SelectFileDialog::SELECT_SAVEAS_FILE,
        folder_ ? u"Choose sync folder" : u"Save Recovery Kit", initial,
        folder_ ? nullptr : &types, folder_ ? 0 : 1,
        folder_ ? base::FilePath::StringType()
                : (text ? FILE_PATH_LITERAL("txt") : FILE_PATH_LITERAL("pdf")),
        parent, nullptr);
  }

  void Cancel() { Complete(Success()); }

  void FileSelected(const ui::SelectedFileInfo& file, int) override {
    if (!response_ || saving_)
      return;
    if (folder_) {
      Complete(Success(file.path().AsUTF8Unsafe()));
      return;
    }
    saving_ = true;
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&sync::SaveRecoveryKitToPath, format_,
                       file.path().AsUTF8Unsafe(), generation_),
        base::BindOnce(&FilePicker::Complete, base::WrapRefCounted(this)));
  }
  void FileSelectionCanceled() override { Cancel(); }

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

  const bool folder_;
  const std::string format_;
  const std::uint64_t generation_;
  bool saving_ = false;
  scoped_refptr<ui::SelectFileDialog> dialog_;
  Response response_;
  base::OnceCallback<void(FilePicker*)> done_;
};

SyncUI::SyncUI() = default;
SyncUI::~SyncUI() {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  weak_factory_.InvalidateWeakPtrs();
  auto picker = std::move(picker_);
  if (picker)
    picker->Cancel();
}

bool SyncUI::Dispatch(const HostContext& context,
                      const std::string& module,
                      const std::string& method,
                      const base::ListValue& args,
                      Response& callback) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (module != "BaySync" ||
      (method != "chooseFolder" && method != "saveRecoveryKit")) {
    return false;
  }
  const bool folder = method == "chooseFolder";
  if ((folder && (args.size() > 1 || (!args.empty() && !args[0].is_none() &&
                                      !args[0].is_string()))) ||
      (!folder &&
       (args.size() != 1 || !args[0].is_string() ||
        (args[0].GetString() != "pdf" && args[0].GetString() != "text")))) {
    std::move(callback).Run(
        Failure("invalid_arguments", "Invalid picker arguments"));
    return true;
  }
  auto* window = context.is_window() ? context.window() : nullptr;
  if (!window || !window->GetWindow() ||
      !window->GetWindow()->GetNativeWindow()) {
    std::move(callback).Run(
        Failure("window_required", "The file picker requires a window host"));
    return true;
  }
  if (picker_) {
    std::move(callback).Run(
        Failure("dialog_busy", "A sync file picker is already open"));
    return true;
  }
  const auto generation = folder ? 0 : sync::RecoveryKeyGeneration();
  if (!folder && !generation) {
    std::move(callback).Run(
        Failure("locked", "Enter your recovery phrase before exporting a kit"));
    return true;
  }
  base::FilePath initial;
  base::PathService::Get(base::DIR_HOME, &initial);
  if (folder) {
    initial = !args.empty() && args[0].is_string()
                  ? base::FilePath::FromUTF8Unsafe(args[0].GetString())
                  : initial.AppendASCII("Bay Sync");
  } else {
    initial = initial.AppendASCII(args[0].GetString() == "text"
                                      ? "Bay Recovery Kit.txt"
                                      : "Bay Recovery Kit.pdf");
  }
  auto picker = base::MakeRefCounted<FilePicker>(
      folder, folder ? std::string() : args[0].GetString(), generation,
      std::move(callback),
      base::BindOnce(&SyncUI::PickerFinished, weak_factory_.GetWeakPtr()));
  picker_ = picker;
  picker->Show(window->GetWindow()->GetNativeWindow(), initial);
  return true;
}

void SyncUI::PickerFinished(FilePicker* picker) {
  DCHECK_CALLED_ON_VALID_SEQUENCE(sequence_checker_);
  if (picker_.get() == picker)
    picker_.reset();
}
}  // namespace bay
