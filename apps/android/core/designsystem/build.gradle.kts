// Bay's design system for Android (plan D8, D12): tokens generated from packages/mobile-core/design, Inter, and the
// Foundation-only components every screen is built from. No Material.

plugins {
    alias(libs.plugins.bay.android.library)
    alias(libs.plugins.bay.android.compose)
}

android {
    namespace = "bay.design"
}
