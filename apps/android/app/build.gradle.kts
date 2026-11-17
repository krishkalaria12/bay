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

dependencies {
    implementation(project(":core:bindings"))
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
}
