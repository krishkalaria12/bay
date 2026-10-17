#include "WindowsHost.h"
#include "../../import/windows/ImportCore.h"
#include "pch.h"
#include <algorithm>
#include <commctrl.h>
#include <commdlg.h>
#include <dwmapi.h>
#include <fstream>
#include <map>
#include <mutex>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <stdexcept>
#include <wincred.h>
#include <winrt/Windows.Globalization.h>
#include <winrt/Windows.System.Profile.h>
#include <winrt/Windows.System.h>

namespace bay {
namespace {
winrt::Microsoft::ReactNative::ReactNativeHost g_host{nullptr};
winrt::Microsoft::UI::Composition::Compositor g_compositor{nullptr};
std::map<std::string, winrt::Microsoft::ReactNative::ReactNativeWindow>
    g_windows;
EventSink g_sink;
std::mutex g_sinkMutex;
Object g_menuState;
std::vector<std::string> g_pendingURLs;
std::filesystem::path KnownFolder(REFKNOWNFOLDERID id) {
  PWSTR value = nullptr;
  winrt::check_hresult(SHGetKnownFolderPath(id, 0, nullptr, &value));
  std::filesystem::path result(value);
  CoTaskMemFree(value);
  return result;
}
std::wstring Environment(std::wstring const &name) {
  auto length = GetEnvironmentVariableW(name.c_str(), nullptr, 0);
  if (!length)
    return {};
  std::wstring result(length, L'\0');
  GetEnvironmentVariableW(name.c_str(), result.data(), length);
  result.resize(length - 1);
  return result;
}
std::filesystem::path Document(std::string const &name) {
  std::filesystem::path leaf = winrt::to_hstring(name).c_str();
  if (leaf.empty() || leaf.is_absolute() || leaf.has_parent_path() ||
      name.find(':') != std::string::npos)
    throw std::invalid_argument(
        "Document name must be a filename inside BAY_DATA_DIR");
  return DataDirectory() / leaf;
}
void WriteDocument(std::string const &name, std::string const &contents) {
  auto path = Document(name);
  std::filesystem::create_directories(path.parent_path());
  auto temporary = path;
  temporary += L"." + std::to_wstring(GetCurrentProcessId()) + L".tmp";
  {
    std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
    stream.exceptions(std::ios::failbit | std::ios::badbit);
    stream.write(contents.data(), contents.size());
    stream.flush();
  }
  if (!MoveFileExW(temporary.c_str(), path.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    auto error = GetLastError();
    DeleteFileW(temporary.c_str());
    winrt::throw_hresult(HRESULT_FROM_WIN32(error));
  }
}
bool Open(std::wstring const &target, std::wstring const &parameters = {}) {
  return reinterpret_cast<INT_PTR>(
             ShellExecuteW(WindowHandle(), L"open", target.c_str(),
                           parameters.empty() ? nullptr : parameters.c_str(),
                           nullptr, SW_SHOWNORMAL)) > 32;
}
std::string ActiveId() {
  HWND active = GetForegroundWindow();
  for (auto const &[id, window] : g_windows)
    if (winrt::Microsoft::UI::GetWindowFromWindowId(window.AppWindow().Id()) ==
        active)
      return id;
  return g_windows.empty() ? "" : g_windows.begin()->first;
}
LRESULT CALLBACK WindowProcedure(HWND hwnd, UINT message, WPARAM wp, LPARAM lp,
                                 UINT_PTR, DWORD_PTR) {
  std::string id;
  for (auto const &pair : g_windows)
    if (winrt::Microsoft::UI::GetWindowFromWindowId(
            pair.second.AppWindow().Id()) == hwnd) {
      id = pair.first;
      break;
    }
  if (message == WM_GETMINMAXINFO) {
    auto info = reinterpret_cast<MINMAXINFO *>(lp);
    const auto dpi = GetDpiForWindow(hwnd);
    info->ptMinTrackSize = {MulDiv(420, dpi, 96), MulDiv(300, dpi, 96)};
    return 0;
  }
  if (message == WM_CLOSE) {
    Object event;
    event.SetNamedValue(L"type", String("closeRequest"));
    event.SetNamedValue(L"id", String(id));
    Emit("BayShell", "onWindowEvent", event);
    return 0;
  }
  if (message == WM_SETFOCUS) {
    Object event;
    event.SetNamedValue(L"type", String("focus"));
    event.SetNamedValue(L"id", String(id));
    Emit("BayShell", "onWindowEvent", event);
  }
  if (message == WM_EXITSIZEMOVE) {
    RECT r;
    GetWindowRect(hwnd, &r);
    auto dpi = GetDpiForWindow(hwnd);
    Array frame;
    for (auto value : {r.left, r.top, r.right - r.left, r.bottom - r.top})
      frame.Append(Number(value * 96.0 / dpi));
    Object event;
    event.SetNamedValue(L"type", String("frame"));
    event.SetNamedValue(L"id", String(id));
    event.SetNamedValue(L"frame", frame);
    Emit("BayShell", "onWindowEvent", event);
  }
  if (message == WM_DPICHANGED) {
    auto r = reinterpret_cast<RECT *>(lp);
    SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left,
                 r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
  }
  return DefSubclassProc(hwnd, message, wp, lp);
}
void OpenWindow(std::string const &id, Object const &options) {
  if (g_windows.count(id)) {
    SetForegroundWindow(WindowHandle(id));
    return;
  }
  auto window =
      winrt::Microsoft::ReactNative::ReactNativeWindow::CreateFromCompositor(
          g_compositor);
  auto app = window.AppWindow();
  auto hwnd = winrt::Microsoft::UI::GetWindowFromWindowId(app.Id());
  app.Title(options.GetNamedString(L"title", L"Bay"));
  app.Resize({1200, 800});
  if (options.HasKey(L"frame") &&
      options.GetNamedValue(L"frame").ValueType() ==
          winrt::Windows::Data::Json::JsonValueType::Array) {
    auto f = options.GetNamedArray(L"frame");
    if (f.Size() == 4) {
      auto dpi = GetDpiForWindow(hwnd);
      app.MoveAndResize(
          {int(f.GetNumberAt(0) * dpi / 96), int(f.GetNumberAt(1) * dpi / 96),
           int(f.GetNumberAt(2) * dpi / 96), int(f.GetNumberAt(3) * dpi / 96)});
    }
  }
  winrt::Microsoft::ReactNative::ReactViewOptions view;
  view.ComponentName(L"main");
  view.InitialProps([id](auto const &writer) {
    writer.WriteObjectBegin();
    writer.WritePropertyName(L"windowId");
    writer.WriteString(winrt::to_hstring(id));
    writer.WriteObjectEnd();
  });
  window.ReactNativeIsland().ReactViewHost(
      winrt::Microsoft::ReactNative::ReactCoreInjection::MakeViewHost(g_host,
                                                                      view));
  g_windows.emplace(id, window);
  SetWindowSubclass(hwnd, WindowProcedure, 1, 0);
  BOOL dark = FALSE;
  DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark,
                        sizeof(dark));
  DWM_SYSTEMBACKDROP_TYPE backdrop = DWMSBT_MAINWINDOW;
  DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop,
                        sizeof(backdrop));
  if (Environment(L"BAY_BACKGROUND") != L"1")
    app.Show(!options.HasKey(L"focus") || options.GetNamedBoolean(L"focus"));
  if (!g_pendingURLs.empty()) {
    Object event;
    Array urls;
    for (auto const &url : g_pendingURLs)
      urls.Append(String(url));
    g_pendingURLs.clear();
    event.SetNamedValue(L"urls", urls);
    Emit("BayShell", "onOpenURLs", event);
  }
}
std::wstring CredentialTarget(std::string const &account) {
  // Isolated test profiles must never read or replace the user's main
  // credentials.
  auto isolation = Environment(L"BAY_DATA_DIR");
  return L"Bay/ConnectedAccounts/" +
         (isolation.empty() ? L"default" : DataDirectory().wstring()) + L"/" +
         winrt::to_hstring(account).c_str();
}
Json Keychain(std::string const &method, Array const &args) {
  auto target = CredentialTarget(ArgText(args, 0));
  if (method == "get") {
    PCREDENTIALW credential = nullptr;
    if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &credential)) {
      if (GetLastError() == ERROR_NOT_FOUND)
        return Null();
      winrt::throw_last_error();
    }
    std::string result(reinterpret_cast<char *>(credential->CredentialBlob),
                       credential->CredentialBlobSize);
    CredFree(credential);
    return String(result);
  }
  if (method == "delete") {
    if (!CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0) &&
        GetLastError() != ERROR_NOT_FOUND)
      winrt::throw_last_error();
    return Boolean(true);
  }
  if (method == "set") {
    auto secret = ArgText(args, 1);
    if (secret.size() > CRED_MAX_CREDENTIAL_BLOB_SIZE)
      throw std::invalid_argument("Credential exceeds Windows limit");
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target.data();
    credential.CredentialBlobSize = DWORD(secret.size());
    credential.CredentialBlob = reinterpret_cast<LPBYTE>(secret.data());
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.UserName = const_cast<wchar_t *>(L"Bay");
    winrt::check_bool(CredWriteW(&credential, 0));
    return Boolean(true);
  }
  throw std::invalid_argument("Unsupported keychain method: " + method);
}
Json ShowMenu(Array const &items) {
  HMENU menu = CreatePopupMenu();
  if (!menu)
    winrt::throw_last_error();
  std::map<UINT, std::string> actions;
  UINT next = 1;
  std::function<void(HMENU, Array const &)> append = [&](HMENU parent,
                                                         Array const &entries) {
    for (auto const &value : entries) {
      auto item = value.GetObject();
      if (item.GetNamedBoolean(L"separator", false)) {
        AppendMenuW(parent, MF_SEPARATOR, 0, nullptr);
        continue;
      }
      auto flags = MF_STRING;
      if (!item.GetNamedBoolean(L"enabled", true))
        flags |= MF_GRAYED;
      if (item.GetNamedBoolean(L"checked", false))
        flags |= MF_CHECKED;
      auto title = item.GetNamedString(L"title", L"");
      if (item.HasKey(L"children")) {
        auto child = CreatePopupMenu();
        append(child, item.GetNamedArray(L"children"));
        AppendMenuW(parent, flags | MF_POPUP, reinterpret_cast<UINT_PTR>(child),
                    title.c_str());
      } else {
        auto command = next++;
        actions[command] = winrt::to_string(item.GetNamedString(L"id", L""));
        AppendMenuW(parent, flags, command, title.c_str());
      }
    }
  };
  append(menu, items);
  POINT point;
  GetCursorPos(&point);
  auto command = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON,
                                  point.x, point.y, WindowHandle(), nullptr);
  DestroyMenu(menu);
  return command ? String(actions.at(command)) : Null();
}
} // namespace
std::filesystem::path ExecutableDirectory() {
  std::wstring path(32768, L'\0');
  auto size = GetModuleFileNameW(nullptr, path.data(), DWORD(path.size()));
  if (!size || size >= path.size())
    winrt::throw_last_error();
  path.resize(size);
  return std::filesystem::path(path).parent_path();
}
std::filesystem::path DataDirectory() {
  static auto path = []() {
    auto overridePath = Environment(L"BAY_DATA_DIR");
    return overridePath.empty() ? KnownFolder(FOLDERID_LocalAppData) / L"Bay"
                                : std::filesystem::absolute(overridePath);
  }();
  return path;
}
void ConfigureHost(
    winrt::Microsoft::ReactNative::ReactNativeHost const &host,
    winrt::Microsoft::UI::Composition::Compositor const &compositor) {
  g_host = host;
  g_compositor = compositor;
  int count = 0;
  auto arguments = CommandLineToArgvW(GetCommandLineW(), &count);
  if (arguments) {
    for (int index = 1; index < count; ++index) {
      std::wstring argument(arguments[index]);
      if (argument.empty() || argument.front() == L'-')
        continue;
      if (PathIsURLW(argument.c_str()))
        g_pendingURLs.push_back(winrt::to_string(argument));
      else if (std::filesystem::exists(argument)) {
        std::wstring url(32768, L'\0');
        DWORD size = static_cast<DWORD>(url.size());
        if (SUCCEEDED(
                UrlCreateFromPathW(std::filesystem::absolute(argument).c_str(),
                                   url.data(), &size, 0))) {
          url.resize(size);
          g_pendingURLs.push_back(winrt::to_string(url));
        }
      }
    }
    LocalFree(arguments);
  }
  importer::SetEventSink(
      [](auto const &module, auto const &event, auto const &payload) {
        Emit(module, event,
             winrt::Windows::Data::Json::JsonValue::Parse(
                 winrt::to_hstring(payload)));
      });
  importer::SetImportWriter([](std::string const &profile,
                               std::vector<std::string> const &kinds,
                               importer::SensitiveImport const &data) {
    importer::Json totals = {{"cookies", 0},
                             {"addresses", 0},
                             {"cards", 0},
                             {"existing", 0},
                             {"rejected", 0}};
    auto apply = [&](char const *service, char const *property,
                     importer::Json const &values) {
      for (std::size_t start = 0; start < values.size(); start += 500) {
        importer::Json chunk = importer::Json::array();
        for (auto i = start; i < std::min(start + 500, values.size()); ++i)
          chunk.push_back(values[i]);
        importer::Json arguments = {{property, chunk}};
        auto encoded = arguments.dump();
        auto request = Object::Parse(winrt::to_hstring(encoded));
        auto result = EngineCall(service, profile, request).GetObject();
        SecureZeroMemory(encoded.data(), encoded.size());
        importer::wipeJson(arguments);
        importer::wipeJson(chunk);
        for (auto const &field : result)
          if (field.Value().ValueType() ==
              winrt::Windows::Data::Json::JsonValueType::Number) {
            auto name = winrt::to_string(field.Key());
            if (name == "imported")
              name = property;
            if (totals.contains(name))
              totals[name] =
                  totals[name].get<double>() + field.Value().GetNumber();
          }
      }
    };
    if (std::find(kinds.begin(), kinds.end(), "cookies") != kinds.end())
      apply("nn_cookies_import", "cookies", data.cookies);
    if (std::find(kinds.begin(), kinds.end(), "autofill") != kinds.end()) {
      apply("nn_autofill_import", "addresses", data.addresses);
      apply("nn_autofill_import", "cards", data.cards);
    }
    return totals;
  });
}
void SetEventSink(EventSink sink) {
  std::lock_guard<std::mutex> lock(g_sinkMutex);
  g_sink = std::move(sink);
}
void Emit(std::string const &module, std::string const &event,
          Json const &value) {
  EventSink sink;
  {
    std::lock_guard<std::mutex> lock(g_sinkMutex);
    sink = g_sink;
  }
  if (sink)
    sink(module, event, value);
}
HWND WindowHandle(std::string const &id) {
  auto key = id.empty() ? ActiveId() : id;
  auto found = g_windows.find(key);
  return found == g_windows.end() ? nullptr
                                  : winrt::Microsoft::UI::GetWindowFromWindowId(
                                        found->second.AppWindow().Id());
}
Json InvokeShell(std::string const &module, std::string const &method,
                 Array const &args) {
  if (module == "BayKeychain")
    return Keychain(method, args);
  if (module == "BayShell") {
    if (method == "readDocument") {
      auto path = Document(ArgText(args, 0));
      if (!std::filesystem::exists(path))
        return Null();
      std::ifstream stream(path, std::ios::binary);
      if (!stream)
        throw std::runtime_error("Cannot read document");
      return String(std::string(std::istreambuf_iterator<char>(stream), {}));
    }
    if (method == "writeDocument" || method == "saveDocument") {
      WriteDocument(ArgText(args, 0), ArgText(args, 1));
      return Null();
    }
    if (method == "removeDocument") {
      std::filesystem::remove(Document(ArgText(args, 0)));
      return Null();
    }
    if (method == "copyText") {
      auto text = winrt::to_hstring(ArgText(args, 0));
      winrt::check_bool(OpenClipboard(nullptr));
      if (!EmptyClipboard()) {
        CloseClipboard();
        winrt::throw_last_error();
      }
      auto data =
          GlobalAlloc(GMEM_MOVEABLE, (text.size() + 1) * sizeof(wchar_t));
      if (!data) {
        CloseClipboard();
        throw std::bad_alloc();
      }
      auto buffer = GlobalLock(data);
      memcpy(buffer, text.c_str(), (text.size() + 1) * sizeof(wchar_t));
      GlobalUnlock(data);
      if (!SetClipboardData(CF_UNICODETEXT, data)) {
        GlobalFree(data);
        CloseClipboard();
        winrt::throw_last_error();
      }
      CloseClipboard();
      return Null();
    }
    if (method == "copyImage")
      return Boolean(false);
    if (method == "openWindow") {
      OpenWindow(ArgText(args, 0),
                 args.Size() > 1 ? args.GetObjectAt(1) : Object());
      return Null();
    }
    if (method == "closeWindow") {
      auto id = ArgText(args, 0);
      auto found = g_windows.find(id);
      if (found != g_windows.end()) {
        auto window = found->second;
        RemoveWindowSubclass(WindowHandle(id), WindowProcedure, 1);
        g_windows.erase(found);
        window.AppWindow().Destroy();
        Object event;
        event.SetNamedValue(L"type", String("close"));
        event.SetNamedValue(L"id", String(id));
        Emit("BayShell", "onWindowEvent", event);
        if (g_windows.empty()) {
          Object quitting;
          quitting.SetNamedValue(L"type", String("willQuit"));
          Emit("BayShell", "onAppEvent", quitting);
        }
      }
      return Null();
    }
    if (method == "focusWindow") {
      auto hwnd = WindowHandle(ArgText(args, 0));
      if (hwnd) {
        ShowWindow(hwnd, SW_RESTORE);
        SetForegroundWindow(hwnd);
      }
      return Null();
    }
    if (method == "windowIds") {
      Array ids;
      for (auto const &pair : g_windows)
        ids.Append(String(pair.first));
      return ids;
    }
    if (method == "setWindowTitle") {
      winrt::check_bool(
          SetWindowTextW(WindowHandle(ArgText(args, 0)),
                         winrt::to_hstring(ArgText(args, 1)).c_str()));
      return Null();
    }
    if (method == "windowFrame") {
      RECT r;
      if (!GetWindowRect(WindowHandle(ArgText(args, 0)), &r))
        return Null();
      auto dpi = GetDpiForWindow(WindowHandle(ArgText(args, 0)));
      Array result;
      for (auto value : {r.left, r.top, r.right - r.left, r.bottom - r.top})
        result.Append(Number(value * 96.0 / dpi));
      return result;
    }
    if (method == "beginWindowDrag") {
      auto hwnd = WindowHandle();
      ReleaseCapture();
      SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
      return Null();
    }
    if (method == "showMenu")
      return ShowMenu(args.GetArrayAt(0));
    if (method == "confirm") {
      auto options = args.GetObjectAt(0);
      auto answer =
          MessageBoxW(WindowHandle(winrt::to_string(
                          options.GetNamedString(L"windowId", L""))),
                      options.GetNamedString(L"message", L"").c_str(),
                      options.GetNamedString(L"title", L"Bay").c_str(),
                      MB_OKCANCEL | MB_ICONQUESTION);
      Object result;
      result.SetNamedValue(L"confirmed", Boolean(answer == IDOK));
      result.SetNamedValue(L"suppressed", Boolean(false));
      return result;
    }
    if (method == "pickFiles") {
      winrt::com_ptr<IFileOpenDialog> dialog;
      winrt::check_hresult(CoCreateInstance(CLSID_FileOpenDialog, nullptr,
                                            CLSCTX_INPROC_SERVER,
                                            IID_PPV_ARGS(dialog.put())));
      dialog->SetOptions(FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST |
                         FOS_FORCEFILESYSTEM);
      Array files;
      auto status = dialog->Show(WindowHandle());
      if (status == HRESULT_FROM_WIN32(ERROR_CANCELLED))
        return files;
      winrt::check_hresult(status);
      winrt::com_ptr<IShellItemArray> selected;
      winrt::check_hresult(dialog->GetResults(selected.put()));
      DWORD count;
      selected->GetCount(&count);
      for (DWORD index = 0; index < count; ++index) {
        winrt::com_ptr<IShellItem> item;
        selected->GetItemAt(index, item.put());
        PWSTR path = nullptr;
        winrt::check_hresult(item->GetDisplayName(SIGDN_FILESYSPATH, &path));
        files.Append(String(winrt::to_string(path)));
        CoTaskMemFree(path);
      }
      return files;
    }
    if (method == "setAppearance") {
      auto dark = ArgText(args, 0) == "dark";
      for (auto const &pair : g_windows) {
        BOOL value = dark;
        DwmSetWindowAttribute(WindowHandle(pair.first),
                              DWMWA_USE_IMMERSIVE_DARK_MODE, &value,
                              sizeof(value));
      }
      return Null();
    }
    if (method == "isDarkAppearance") {
      DWORD value = 1, size = sizeof(value);
      RegGetValueW(
          HKEY_CURRENT_USER,
          L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
          L"AppsUseLightTheme", RRF_RT_REG_DWORD, nullptr, &value, &size);
      return Boolean(value == 0);
    }
    if (method == "setMenuState") {
      g_menuState = args.GetObjectAt(0);
      return Null();
    }
    if (method == "setMenuBookmarks")
      return Null();
    if (method == "replyToTerminate") {
      if (args.GetBooleanAt(0))
        PostQuitMessage(0);
      return Null();
    }
  }
  if (module == "BaySystem") {
    if (method == "fileExists")
      return Boolean(
          std::filesystem::exists(winrt::to_hstring(ArgText(args, 0)).c_str()));
    if (method == "downloadsFolder")
      return String(
          winrt::to_string(KnownFolder(FOLDERID_Downloads).wstring()));
    if (method == "openFile")
      return Boolean(Open(winrt::to_hstring(ArgText(args, 0)).c_str()));
    if (method == "revealFile")
      return Boolean(
          Open(L"explorer.exe",
               L"/select,\"" +
                   std::wstring(winrt::to_hstring(ArgText(args, 0))) + L"\""));
    if (method == "setAsDefaultBrowser")
      return Boolean(Open(L"ms-settings:defaultapps?registeredAppUser=Bay"));
    if (method == "isDefaultBrowser") {
      DWORD size = 0;
      auto key = L"Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssoci"
                 L"ations\\https\\UserChoice";
      RegGetValueW(HKEY_CURRENT_USER, key, L"ProgId", RRF_RT_REG_SZ, nullptr,
                   nullptr, &size);
      std::wstring value(size / sizeof(wchar_t), L'\0');
      if (!size ||
          RegGetValueW(HKEY_CURRENT_USER, key, L"ProgId", RRF_RT_REG_SZ,
                       nullptr, value.data(), &size) != ERROR_SUCCESS)
        return Boolean(false);
      return Boolean(value.compare(0, 8, L"Bay.HTML") == 0);
    }
    if (method == "moveToTrash") {
      winrt::com_ptr<IFileOperation> operation;
      winrt::check_hresult(CoCreateInstance(CLSID_FileOperation, nullptr,
                                            CLSCTX_INPROC_SERVER,
                                            IID_PPV_ARGS(operation.put())));
      operation->SetOperationFlags(FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE |
                                   FOF_NOCONFIRMATION | FOF_NOERRORUI |
                                   FOF_SILENT);
      winrt::com_ptr<IShellItem> item;
      winrt::check_hresult(SHCreateItemFromParsingName(
          winrt::to_hstring(ArgText(args, 0)).c_str(), nullptr,
          IID_PPV_ARGS(item.put())));
      winrt::check_hresult(operation->DeleteItem(item.get(), nullptr));
      winrt::check_hresult(operation->PerformOperations());
      BOOL aborted = FALSE;
      operation->GetAnyOperationsAborted(&aborted);
      return Boolean(!aborted);
    }
    if (method == "launchAtLoginStatus") {
      DWORD size = 0;
      auto status =
          RegGetValueW(HKEY_CURRENT_USER,
                       L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                       L"Bay", RRF_RT_REG_SZ, nullptr, nullptr, &size);
      return String(status == ERROR_SUCCESS ? "enabled" : "notRegistered");
    }
    if (method == "setLaunchAtLogin") {
      HKEY key;
      winrt::check_win32(RegCreateKeyExW(
          HKEY_CURRENT_USER,
          L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, nullptr, 0,
          KEY_SET_VALUE, nullptr, &key, nullptr));
      auto command =
          L"\"" + (ExecutableDirectory() / L"Bay.exe").wstring() + L"\"";
      auto result =
          args.GetBooleanAt(0)
              ? RegSetValueExW(key, L"Bay", 0, REG_SZ,
                               reinterpret_cast<BYTE const *>(command.c_str()),
                               DWORD((command.size() + 1) * sizeof(wchar_t)))
              : RegDeleteValueW(key, L"Bay");
      RegCloseKey(key);
      if (result != ERROR_SUCCESS && result != ERROR_FILE_NOT_FOUND)
        winrt::throw_hresult(HRESULT_FROM_WIN32(result));
      return Null();
    }
    if (method == "hapticTick")
      return Null(); // Windows has no desktop haptic device contract.
  }
  if (module == "BayApp") {
    if (method == "launchEnvironment") {
      auto value = Environment(winrt::to_hstring(ArgText(args, 0)).c_str());
      return value.empty() ? Null() : String(winrt::to_string(value));
    }
    if (method == "openExternalURL")
      return Boolean(Open(winrt::to_hstring(ArgText(args, 0)).c_str()));
    if (method == "systemInfo") {
      Object result;
      MEMORYSTATUSEX memory{sizeof(memory)};
      GlobalMemoryStatusEx(&memory);
      result.SetNamedValue(L"appName", String("Bay"));
      result.SetNamedValue(L"appVersion", String("0.0.0"));
      result.SetNamedValue(L"appBuild", String("0"));
      result.SetNamedValue(L"bundleId", String("Bay.Browser"));
      result.SetNamedValue(L"configuration", String(
#ifdef _DEBUG
                                                 "Debug"
#else
                                                 "Release"
#endif
                                                 ));
      result.SetNamedValue(
          L"osVersion",
          String(winrt::to_string(
              winrt::Windows::System::Profile::AnalyticsInfo::VersionInfo()
                  .DeviceFamilyVersion())));
      result.SetNamedValue(L"osBuild", result.GetNamedValue(L"osVersion"));
      result.SetNamedValue(L"arch", String("x64"));
      result.SetNamedValue(L"model", String("Windows desktop"));
      result.SetNamedValue(L"memoryGB",
                           Number(memory.ullTotalPhys / 1073741824.0));
      result.SetNamedValue(
          L"locale",
          String(winrt::to_string(winrt::Windows::Globalization::Language::
                                      CurrentInputMethodLanguageTag())));
      result.SetNamedValue(L"updates", Boolean(false));
      result.SetNamedValue(L"isolatedInstance",
                           Boolean(!Environment(L"BAY_DATA_DIR").empty()));
      return result;
    }
    if (method == "updaterState") {
      Object result;
      result.SetNamedValue(L"available", Boolean(false));
      return result;
    }
  }
  throw std::invalid_argument("Unsupported Windows native method: " + module +
                              "." + method);
}
} // namespace bay
