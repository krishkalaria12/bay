plugins {
    alias(libs.plugins.bay.android.application)
    alias(libs.plugins.bay.android.compose)
}

// Debug builds install as `…mobile.native`, beside a release build; release keeps the store ID.
android {
    namespace = "bay.app"

    defaultConfig {
        applicationId = "in.krishkalaria.bay.mobile"
        // CI passes its run number (-PbayVersionCode), so each APK it publishes installs over the last as an update.
        versionCode = providers.gradleProperty("bayVersionCode").orNull?.toInt() ?: 1
        versionName = "1.0.0"
        // Bay's engine is built for arm64 only; JNA's libraries for other ABIs would ship unused.
        ndk { abiFilters += "arm64-v8a" }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Chromium maps its resource packs, ICU data and snapshots straight out of the APK, so they stay stored.
    androidResources {
        noCompress += listOf("pak", "dat", "bin")
    }

    // Chromium's R classes (org.chromium.ui.R and the like), written by :engine from bay-engine.aar: the app compiles
    // them, because a library's jars leave every R class out and Chromium's code needs them at run time.
    sourceSets {
        getByName("main") {
            java.srcDir(rootDir.resolve("engine/build/generated/source/bayEngineR"))
            // The fonts pages can show in (packages/mobile-core/design/fonts), the same files the iPhone app bundles.
            assets.srcDir(rootDir.resolve("../../packages/mobile-core/design/fonts"))
        }
    }

    // The engine's library and the dex go in compressed, for a smaller download (274 → 122 MB when it was measured):
    // the system extracts the libraries at install, and the runtime compiles the dex either way.
    packaging {
        jniLibs.useLegacyPackaging = true
        dex.useLegacyPackaging = true
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".native"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // Release's code (R8, no interpreter) under the debug app's id and key, and profileable: what the profiler
        // measures (a debuggable build runs Kotlin interpreted, which swamps the timings). `./gradlew :app:assembleProfile`.
        create("profile") {
            initWith(getByName("release"))
            applicationIdSuffix = ".native"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
        }
    }
    // The debug app's shortcuts, which name its package.
    sourceSets.getByName("profile").res.srcDir("src/debug/res")
}

tasks.named("preBuild") { dependsOn(":engine:generateEngineRClasses") }

dependencies {
    implementation(project(":core:bindings"))
    implementation(project(":core:designsystem"))
    implementation(project(":engine"))
    // Android's window extensions (foldable postures) come with the system: compiled against, not shipped, so R8 keeps
    // what Chromium implements of them (an unseen Consumer once cost the first page load an AbstractMethodError).
    compileOnly("androidx.window.extensions.core:core:1.0.0")
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)

    // The accessibility audit (Accessibility Test Framework checks over the main screens).
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.compose.ui.test.junit4.accessibility)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.espresso.core)
}
