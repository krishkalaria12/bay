pluginManagement {
    includeBuild("build-logic")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

// Bay's Chromium (bay-engine.aar), which scripts/fetch-engine.mjs installs as a local Maven repository in .engine;
// -PbayEngineDir points elsewhere.
val bayEngineDir = file(providers.gradleProperty("bayEngineDir").getOrElse(".engine"))
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
