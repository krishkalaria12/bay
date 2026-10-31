package expo.modules.bayengine

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BayEngineModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BayEngine")

    View(BayEngineView::class) {
      Events("onNavigationStateChange", "onNavigationError")
      AsyncFunction("load") { view: BayEngineView, url: String -> view.load(url) }
      AsyncFunction("goBack") { view: BayEngineView -> view.webView.goBack() }
      AsyncFunction("goForward") { view: BayEngineView -> view.webView.goForward() }
      AsyncFunction("reload") { view: BayEngineView -> view.reload() }
      AsyncFunction("stop") { view: BayEngineView -> view.stop() }
      OnViewDestroys { view: BayEngineView -> view.dispose() }
    }
  }
}
