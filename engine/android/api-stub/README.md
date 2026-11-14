# Engine API stub

Compile-only copies of the public `org.bay.engine` API in `bay-engine.aar`, with no bodies. The app's Chromium
flavour (`apps/mobile/modules/bay-engine/android/src/chromium`) builds against them without downloading the engine:

```sh
cd apps/mobile/android && ./gradlew :bay-engine:compileDebugKotlin -PbayEngineApiStub=true
```

A build with the stub can't run: it is for checking the Kotlin compiles. `scripts/android/test_api_stub.py` checks
every declaration here against the engine's real Java (`engine/android/src/bay/mobile/java`), so change both together.
