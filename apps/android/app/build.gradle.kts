plugins {
    alias(libs.plugins.bay.android.application)
    alias(libs.plugins.bay.android.compose)
}

// Debug builds install as `…mobile.native` beside the Expo app; release keeps the ID the Expo app ships under, so the
// native app installs over it and takes its data (docs/mobile-native-plan.html §9).
android {
    namespace = "bay.app"

    defaultConfig {
        applicationId = "in.krishkalaria.bay.mobile"
        versionCode = 1
        versionName = "1.0.0"
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
        }
    }

    // The dex goes in compressed, for a smaller download; the runtime compiles it at install either way.
    packaging {
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
    }
}

tasks.named("preBuild") { dependsOn(":engine:generateEngineRClasses") }

dependencies {
    implementation(project(":core:bindings"))
    implementation(project(":engine"))
    // Android's window extensions (foldable postures) come with the system: compiled against, not shipped, so R8 keeps
    // what Chromium implements of them (an unseen Consumer once cost the first page load an AbstractMethodError).
    compileOnly("androidx.window.extensions.core:core:1.0.0")
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
}
