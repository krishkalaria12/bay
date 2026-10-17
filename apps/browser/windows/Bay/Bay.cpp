#include "Bay.h"
#include "AutolinkedNativeModules.g.h"
#include "BayWindows.h"
#include "pch.h"
#include <ReactContext.h>
#include <winrt/Microsoft.ReactNative.Composition.h>

struct BayPackageProvider
    : winrt::implements<BayPackageProvider,
                        winrt::Microsoft::ReactNative::IReactPackageProvider> {
  void CreatePackage(winrt::Microsoft::ReactNative::IReactPackageBuilder const
                         &builder) noexcept {
    AddAttributedModules(builder, true);
  }
};

// CEF 154 bootstrap ABI. The version-info pointer is opaque to the RN host.
extern "C" __declspec(dllexport) int RunWinMain(HINSTANCE, LPWSTR, int,
                                                void *sandboxInfo, void *) {
  try {
    auto subprocessExit = bay::PrepareEngineProcess(sandboxInfo);
    if (subprocessExit >= 0)
      return subprocessExit;
    winrt::init_apartment(winrt::apartment_type::single_threaded);
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    SetCurrentProcessExplicitAppUserModelID(L"Bay.Browser");
    auto queue = winrt::Microsoft::UI::Dispatching::DispatcherQueueController::
        CreateOnCurrentThread();
    auto compositor = winrt::Microsoft::UI::Composition::Compositor();
    auto host = winrt::Microsoft::ReactNative::ReactNativeHost();
    auto settings = host.InstanceSettings();
    settings.Properties().Set(winrt::Microsoft::ReactNative::
                                  ReactDispatcherHelper::UIDispatcherProperty(),
                              winrt::Microsoft::ReactNative::
                                  ReactDispatcherHelper::UIThreadDispatcher());
    winrt::Microsoft::ReactNative::Composition::CompositionUIService::
        SetCompositor(settings, compositor);
    RegisterAutolinkedNativeModulePackages(settings.PackageProviders());
    settings.PackageProviders().Append(winrt::make<BayPackageProvider>());
#if BUNDLE
    settings.BundleRootPath(
        (L"file://" + bay::ExecutableDirectory().wstring() + L"\\Bundle\\")
            .c_str());
    settings.JavaScriptBundleFile(L"index.windows");
    settings.UseFastRefresh(false);
#else
    settings.JavaScriptBundleFile(L"index.windows");
    settings.UseFastRefresh(true);
#endif
#ifdef _DEBUG
    settings.UseDirectDebugger(true);
    settings.UseDeveloperSupport(true);
#else
    settings.UseDirectDebugger(false);
    settings.UseDeveloperSupport(false);
#endif
    bay::ConfigureHost(host, compositor);
    host.ReloadInstance();
    queue.DispatcherQueue().RunEventLoop();
    host.UnloadInstance();
    bay::ShutdownEngine();
    compositor.Close();
    queue.ShutdownQueue();
    return 0;
  } catch (winrt::hresult_error const &error) {
    MessageBoxW(nullptr, error.message().c_str(), L"Bay could not start",
                MB_OK | MB_ICONERROR);
    return 1;
  } catch (std::exception const &error) {
    MessageBoxW(nullptr, winrt::to_hstring(error.what()).c_str(),
                L"Bay could not start", MB_OK | MB_ICONERROR);
    return 1;
  }
}
