import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputDirectory
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations
import javax.inject.Inject

// The Rust core (packages/mobile-core) for Android: cargo-ndk builds libbay_core.so for arm64-v8a, the only ABI Bay
// ships (its Chromium is arm64 only), and UniFFI generates the Kotlin API from that library. Both are generated
// sources of this module, so the app just depends on :core:bindings.

plugins {
    alias(libs.plugins.bay.android.library)
}

android {
    namespace = "bay.core"
}

dependencies {
    // UniFFI's Kotlin calls the library through JNA.
    api("${libs.jna.get()}@aar")
    testImplementation(libs.junit)
}

val core = rootDir.resolve("../../packages/mobile-core").canonicalFile
val home = System.getProperty("user.home")
// rustup's cargo has the Android targets; Homebrew's, often earlier on PATH, has only the host's.
val cargoPath = "$home/.cargo/bin:${System.getenv("PATH")}"

abstract class CargoNdk @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) abstract val crates: DirectoryProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.RELATIVE) abstract val lockfile: org.gradle.api.file.RegularFileProperty
    @get:Input abstract val ndk: Property<String>
    @get:Input abstract val searchPath: Property<String>
    @get:Input abstract val minSdk: Property<Int>
    @get:OutputDirectory abstract val jniLibs: DirectoryProperty

    @TaskAction
    fun build() {
        exec.exec {
            workingDir = lockfile.get().asFile.parentFile
            environment("PATH", searchPath.get())
            environment("ANDROID_NDK_HOME", ndk.get())
            commandLine(
                "cargo", "ndk", "-t", "arm64-v8a", "--platform", minSdk.get().toString(),
                "-o", jniLibs.get().asFile.absolutePath,
                "build", "--release", "--locked", "--package", "bay-core", "--lib",
            )
        }
    }
}

abstract class UniffiKotlin @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) abstract val jniLibs: DirectoryProperty
    @get:Input abstract val workspace: Property<String>
    @get:Input abstract val searchPath: Property<String>
    @get:OutputDirectory abstract val sources: DirectoryProperty

    @TaskAction
    fun generate() {
        val out = sources.get().asFile
        out.deleteRecursively()
        exec.exec {
            workingDir = File(workspace.get())
            environment("PATH", searchPath.get())
            commandLine(
                "cargo", "run", "--quiet", "--locked", "--package", "uniffi-bindgen", "--",
                "generate", "--library", jniLibs.get().file("arm64-v8a/libbay_core.so").asFile.absolutePath,
                "--language", "kotlin", "--no-format", "--out-dir", out.absolutePath,
            )
        }
    }
}

val cargoNdk = tasks.register<CargoNdk>("cargoNdk") {
    crates.set(core.resolve("crates"))
    lockfile.set(core.resolve("Cargo.lock"))
    ndk.set(androidComponents.sdkComponents.ndkDirectory.map { it.asFile.absolutePath })
    searchPath.set(cargoPath)
    minSdk.set(29)
    jniLibs.set(layout.buildDirectory.dir("rust/jniLibs"))
}

val uniffiKotlin = tasks.register<UniffiKotlin>("uniffiKotlin") {
    jniLibs.set(cargoNdk.flatMap { it.jniLibs })
    workspace.set(core.absolutePath)
    searchPath.set(cargoPath)
    sources.set(layout.buildDirectory.dir("generated/uniffi"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(cargoNdk, CargoNdk::jniLibs)
        variant.sources.kotlin?.addGeneratedSourceDirectory(uniffiKotlin, UniffiKotlin::sources)
    }
}
