import java.io.File
import java.util.Properties
import java.util.zip.ZipFile
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

// The page engine: Bay's own Chromium (org.bay.engine, from bay-engine.aar) behind BayEngineView and Engine, ported
// from the Expo module (apps/mobile/modules/bay-engine/android). There is no other engine on Android, so a build
// without it stops here and says how to fetch it.

plugins {
    alias(libs.plugins.bay.android.library)
}

val engineDir = gradle.extra["bayEngineDir"] as File
val engineVersion: String = Properties().run {
    val file = engineDir.resolve("engine.properties")
    if (file.isFile) file.inputStream().use(::load)
    getProperty("version")
        ?: throw GradleException("Bay's engine isn't installed. From apps/mobile, run: node scripts/fetch-android-engine.mjs")
}
val engineAar = engineDir.resolve("repo/org/bay/engine/bay-engine/$engineVersion/bay-engine-$engineVersion.aar")
val engineRClasses = layout.buildDirectory.dir("generated/source/bayEngineR")

android {
    namespace = "bay.engine"

    sourceSets {
        getByName("main") {
            // Scriptlet and $redirect stand-ins for the blocker (uBlock Origin's and Brave's), as resources.json.
            assets.srcDir(rootDir.resolve("../../packages/adblock/resources"))
        }
    }
}

// Chromium's Java refers to R classes such as org.chromium.ui.R, which Chromium only makes when it builds a whole APK.
// The AAR lists the packages (bay-engine/r-packages.txt) and carries every resource (R.txt) under org.bay.engine.R;
// this writes each listed package's R as a view of that one. The app compiles them, because a library's jars leave
// every R class out.
abstract class GenerateEngineRClasses : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val aar: RegularFileProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @TaskAction
    fun generate() {
        val out = output.get().asFile
        out.deleteRecursively()
        ZipFile(aar.get().asFile).use { zip ->
            fun read(name: String) = zip.getEntry(name)?.let { zip.getInputStream(it).bufferedReader().readText() }.orEmpty()
            val entries = linkedMapOf<String, MutableList<Pair<Boolean, String>>>()
            read("R.txt").lineSequence().forEach { line ->
                val parts = line.trim().split(' ', limit = 4)
                if (parts.size >= 3) entries.getOrPut(parts[1]) { mutableListOf() } += (parts[0] == "int[]") to parts[2]
            }
            read("bay-engine/r-packages.txt").lineSequence().map(String::trim).filter { it.isNotEmpty() && it != "org.bay.engine" }.forEach { pkg ->
                val source = StringBuilder("package $pkg;\n\n/** Generated from bay-engine.aar: $pkg's resources, as org.bay.engine.R has them. */\npublic final class R {\n")
                entries.forEach { (type, fields) ->
                    source.append("  public static final class $type {\n")
                    fields.forEach { (array, name) ->
                        source.append("    public static ${if (array) "int[]" else "int"} $name = org.bay.engine.R.$type.$name;\n")
                    }
                    source.append("  }\n")
                }
                source.append("}\n")
                val file = out.resolve(pkg.replace('.', '/') + "/R.java")
                file.parentFile.mkdirs()
                file.writeText(source.toString())
            }
        }
    }
}

val generateEngineRClasses by tasks.registering(GenerateEngineRClasses::class) {
    aar.set(engineAar)
    output.set(engineRClasses)
}

tasks.named("preBuild") { dependsOn(generateEngineRClasses) }

dependencies {
    // Downloads report the store's DownloadEvent.
    implementation(project(":core:bindings"))
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.annotation:annotation:1.9.1")
    // api: the app's Application starts the engine (org.bay.engine.BayEngineApplication).
    api("org.bay.engine:bay-engine:$engineVersion")
    // Classes the engine's code uses but leaves to the app (bay-engine/app-classes.txt), at the versions the pinned
    // Chromium builds against or newer.
    implementation("androidx.collection:collection:1.4.5")
    implementation("androidx.core:core:1.15.0")
    implementation("androidx.fragment:fragment:1.8.5")
    implementation("androidx.lifecycle:lifecycle-common:2.8.7")
    implementation("androidx.window:window:1.3.0")
    // Geolocation, WebOTP's SMS retriever, digital credentials and the Shape Detection API go through Play services.
    implementation("com.google.android.gms:play-services-auth-api-phone:18.3.1")
    implementation("com.google.android.gms:play-services-identity-credentials:16.0.0-alpha12")
    implementation("com.google.android.gms:play-services-location:21.4.0")
    implementation("com.google.android.gms:play-services-vision:20.1.3")
    implementation("com.google.guava:guava:33.7.1-android")
    implementation("com.google.protobuf:protobuf-javalite:4.36.0")
}
