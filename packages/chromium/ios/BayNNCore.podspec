# The web engine's native side (Expo modules BayCEF, BayExtensions, BaySwipe, BayChromeUI and
# BayWebKit, the names the JS in ../src uses), on our own Chromium layer (engine/nncore), and WebKit
# (WKWebView) for the pages that open there (WebKit*.swift).
#
# The engine is Chrome's framework built with engine/nncore ("Chromium Framework.framework"). The app
# target stages a copy of it (packages/chromium/scripts/stage-framework.sh), links that and embeds it
# (scripts/embed.sh); this pod only needs NNCore's public header.
#
# The content blocker is Bay's Rust crate (packages/adblock): scripts/adblock.sh builds it as a static library before
# the pod compiles, and the app links it.
engine_public = File.expand_path('../../../engine/nncore/src/bay/core/public', __dir__)
adblock = File.expand_path('../../adblock', __dir__)

Pod::Spec.new do |s|
  s.name           = 'BayNNCore'
  s.version        = '0.0.0'
  s.summary        = 'Bay on NNCore (our own Chromium layer) for React Native macOS'
  s.author         = ''
  s.homepage       = 'https://github.com/bay'
  s.license        = 'Apache-2.0'
  s.platforms      = { :osx => '14.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'WebKit'
  s.source_files   = '*.{h,mm,swift}'
  s.public_header_files = 'NNCoreHost.h', 'NNCoreWebView.h', 'NNCoreTabStrip.h', 'NNCoreEngineBridge.h', 'NNCoreServices.h', 'NNSwipe.h', 'NNChromeWindow.h'
  s.resources      = 'page_script.js', 'filter_lists.json'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => "\"#{engine_public}\" \"#{adblock}/include\"",
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }
  # A search path and -l, not the archive's path in OTHER_LDFLAGS: CocoaPods drops the quotes when it merges that, and the
  # checkout's path may have spaces in it.
  s.user_target_xcconfig = {
    'LIBRARY_SEARCH_PATHS' => "\"#{adblock}/target/desktop\"",
    'OTHER_LDFLAGS' => '-l"bay_adblock"',
  }
  s.script_phases = [{
    :name => 'Build the content blocker (packages/adblock)',
    :script => "\"#{File.expand_path('../scripts/adblock.sh', __dir__)}\"",
    :execution_position => :before_compile,
    # Every build: cargo knows what changed in the crate.
    :always_out_of_date => '1',
  }]
end
