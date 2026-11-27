# bay-import's C ABI (packages/rust/bay-import), imported as BayImportFFI; the app links the library (BayNNCore.podspec).
ffi = File.expand_path('../ffi', __dir__)

Pod::Spec.new do |s|
  s.name           = 'BayImport'
  s.version        = '0.0.0'
  s.summary        = 'Import bookmarks, history, tabs and logins from other browsers'
  s.author         = ''
  s.homepage       = 'https://github.com/bay'
  s.license        = 'MIT'
  s.platforms      = { :osx => '14.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Imported cookies and cards go straight to the engine (NNCoreEngineBridge), never through JS.
  s.dependency 'BayNNCore'
  s.frameworks     = 'AppKit', 'Security'
  s.libraries      = 'sqlite3'
  # Core/ is plain Swift with no Expo dependency; it's also built and tested on its own by
  # ../Package.swift (`pnpm --filter @bay/import test`).
  s.source_files   = 'ImportModule.swift', 'ImportWriter.swift', 'ExtensionImportWriter.swift', 'Core/**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_INCLUDE_PATHS' => "\"#{ffi}\"" }
  # The app imports BayImport, whose module depends on BayImportFFI, so it needs the path too.
  s.user_target_xcconfig = { 'SWIFT_INCLUDE_PATHS' => "\"#{ffi}\"" }
end
