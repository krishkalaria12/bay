# UniFFI's Kotlin calls into the Rust library through JNA, which finds classes and fields by name.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class bay.core.** { *; }
-dontwarn java.awt.**
