plugins {
    `kotlin-dsl`
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    compileOnly(libs.android.gradlePlugin)
    compileOnly(libs.kotlin.gradlePlugin)
    compileOnly(libs.compose.gradlePlugin)
}

gradlePlugin {
    plugins {
        register("androidApplication") {
            id = "bay.android.application"
            implementationClass = "bay.buildlogic.AndroidApplicationConventionPlugin"
        }
        register("androidLibrary") {
            id = "bay.android.library"
            implementationClass = "bay.buildlogic.AndroidLibraryConventionPlugin"
        }
        register("androidCompose") {
            id = "bay.android.compose"
            implementationClass = "bay.buildlogic.AndroidComposeConventionPlugin"
        }
    }
}
