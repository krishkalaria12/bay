# bay-sync's C ABI (packages/rust/bay-sync), imported as BaySyncFFI; the app links the library (BayNNCore.podspec).
ffi = File.expand_path('../ffi', __dir__)
# BayImport's module, which this pod imports, depends on BayImportFFI.
import_ffi = File.expand_path('../../import/ffi', __dir__)

Pod::Spec.new do |s|
  s.name           = 'BaySync'
  s.version        = '0.0.0'
  s.summary        = 'End-to-end-encrypted sync through a folder the user chooses'
  s.author         = ''
  s.homepage       = 'https://github.com/bay'
  s.license        = 'MIT'
  s.platforms      = { :osx => '14.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  # Reads this app's own saved passwords with the importer's Chromium reader.
  s.dependency 'BayImport'
  s.frameworks     = 'AppKit', 'CoreImage', 'Security'
  # Core/ is plain Swift with no Expo dependency; it's also built and tested on its own by
  # ../Package.swift (`pnpm --filter @bay/sync test`).
  s.source_files   = 'SyncModule.swift', 'Core/**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_INCLUDE_PATHS' => "\"#{ffi}\" \"#{import_ffi}\"" }
  # The app imports BaySync, whose module depends on BaySyncFFI, so it needs the path too.
  s.user_target_xcconfig = { 'SWIFT_INCLUDE_PATHS' => "\"#{ffi}\"" }
end
