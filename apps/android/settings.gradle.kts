pluginManagement {
    includeBuild("build-logic")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Bay's Chromium (bay-engine.aar), which apps/mobile/scripts/fetch-android-engine.mjs installs as a local Maven
// repository. Shared with the Expo app's install until it goes (plan N8); -PbayEngineDir points elsewhere.
val bayEngineDir = file(providers.gradleProperty("bayEngineDir").getOrElse("../mobile/modules/bay-engine/android/engine"))
gradle.extra["bayEngineDir"] = bayEngineDir

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url = bayEngineDir.resolve("repo").toURI() }
    }
}

rootProject.name = "Bay"

include(":app")
include(":core:bindings")
include(":core:designsystem")
include(":engine")
