// Copyright 2026 Bay. Apache-2.0.
//
// Plugins (apps/browser lib/plugins) on Windows and Linux: a folder with a
// manifest and a script, copied into <user data>/BayPlugins. bay-plugins
// (packages/rust/bay-plugins) checks the manifest, copies and lists the
// folders, and decides which files a plugin's sandbox may read; the Mac's
// glue is packages/chromium/ios/PluginsModule.swift.
//
// Each plugin runs in a frame of the coordinator's document at
// chrome-untrusted://bay-plugin/<id>/__bay/host.html, which BayPluginUI serves
// from the plugin's own folder under bay-plugins' content security policy: a
// sandboxed, unique origin with no network of its own, in a renderer process
// apart from Bay's. The frame and the app talk by postMessage
// (packages/chromium/src/pluginSandbox.web.ts).

#ifndef CHROME_BROWSER_BAY_WEBUI_PLUGINS_H_
#define CHROME_BROWSER_BAY_WEBUI_PLUGINS_H_

#include <string>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/values.h"
#include "content/public/browser/webui_config.h"
#include "ui/webui/untrusted_web_ui_controller.h"

namespace bay {

inline constexpr char kPluginHost[] = "bay-plugin";

class Plugins {
 public:
  using Response = base::OnceCallback<void(const std::string&)>;

  static base::ListValue SupportedMethods();
  // <user data>/BayPlugins.
  static base::FilePath Root();

  // list and remove (install needs a window's folder picker and reveal the
  // host's profile: both are the host's). False leaves `response` untouched.
  static bool Dispatch(const std::string& module,
                       const std::string& method,
                       const base::ListValue& args,
                       Response& response);

  // Copies the plugin folder the person picked into Root(); install's reply
  // envelope with bay_plugins_install's JSON. Blocks on the disk.
  static std::string Install(const base::FilePath& source);
};

// chrome-untrusted://bay-plugin/: plugins' sandboxes.
class BayPluginUI : public ui::UntrustedWebUIController {
 public:
  explicit BayPluginUI(content::WebUI* web_ui);
  ~BayPluginUI() override;
  BayPluginUI(const BayPluginUI&) = delete;
  BayPluginUI& operator=(const BayPluginUI&) = delete;
};

class BayPluginUIConfig : public content::DefaultWebUIConfig<BayPluginUI> {
 public:
  BayPluginUIConfig();
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_PLUGINS_H_
