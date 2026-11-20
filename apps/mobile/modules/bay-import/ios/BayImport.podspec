Pod::Spec.new do |s|
  s.name = 'BayImport'
  s.version = '0.1.0'
  s.summary = 'Bay mobile import'
  s.description = "Unpacks other browsers' export files for Bay to read."
  s.license = 'Apache-2.0'
  s.author = 'Bay'
  s.homepage = 'https://github.com/krishkalaria12/bay'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => s.homepage }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
