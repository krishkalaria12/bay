package bay.buildlogic

import com.android.build.api.dsl.CommonExtension
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.dependencies

/** Compose on Foundation: Bay's Android UI never takes Material (docs/mobile-native-plan.html D8). */
class AndroidComposeConventionPlugin : Plugin<Project> {
    override fun apply(target: Project) = with(target) {
        pluginManager.apply("org.jetbrains.kotlin.plugin.compose")
        extensions.getByType(CommonExtension::class.java).buildFeatures.compose = true
        dependencies {
            val bom = platform(libs.findLibrary("compose-bom").get())
            add("implementation", bom)
            add("implementation", libs.findLibrary("compose-foundation").get())
            add("implementation", libs.findLibrary("compose-ui").get())
            add("implementation", libs.findLibrary("compose-ui-tooling-preview").get())
            add("debugImplementation", libs.findLibrary("compose-ui-tooling").get())
        }
    }
}
