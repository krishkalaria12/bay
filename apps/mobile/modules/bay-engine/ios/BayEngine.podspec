Pod::Spec.new do |s|
  s.name = 'BayEngine'
  s.version = '0.1.0'
  s.summary = 'Bay mobile page engine'
  s.description = 'WKWebView behind the shared Bay engine API.'
  s.license = 'Apache-2.0'
  s.author = 'Bay'
  s.homepage = 'https://github.com/krishkalaria12/bay'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => s.homepage }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'WebKit', 'QuickLook', 'BackgroundTasks'
  s.source_files = '*.swift'
  # Built by scripts/adblock from packages/adblock.
  s.vendored_frameworks = 'BayAdblock.xcframework'
  s.resources = 'BayAdblockResources/bay-adblock-resources.json'
end
