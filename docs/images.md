# Desktop images

Bay uses `expo-image` 3.0.11, the version for its Expo SDK 54 dependency. The Windows and Linux shells render its web implementation inside Chromium. The native macOS shell uses the AppKit port in `patches/expo-image@3.0.11.patch`.

The patch adds the macOS pod platform and adapts image sizing, position, tint, animation, screen scale, bitmap drawing, and hash placeholders. Loading and caching still use SDWebImage. UIKit code remains available to the upstream iOS and tvOS targets. iOS Live Text is excluded on macOS; transition effects use a crossfade there.

Desktop components select memory caching. Favicons and Library files already have persistent storage managed by Bay, and private previews can be data URLs. Rendering these must not create a second disk cache. This policy controls the native SDWebImage cache. Web image requests use Chromium's resource cache and the host's profile rules.

Use `contentFit` for sizing and the `tintColor` prop for monochrome images. Give recycled list images a `recyclingKey` tied to their source so a reused view clears its previous picture while loading. Preserve existing failure callbacks and local source URI helpers.

When upgrading Expo Image, rebase the patch onto the SDK-compatible version, run `pnpm install` and `pnpm pods`, and compile the macOS app. Run `pnpm --filter @bay/browser test:images:macos` for native geometry, Retina pixel, and tint regression checks. Also run the browser and desktop type checks, React Compiler, browser tests, `pnpm build:web`, and `pnpm test:web-boot`. Set `CHROMIUM` to a Chromium executable when it is not installed in a standard Linux location. The web boot test requires rendered Expo Image assets to decode in both Windows and Linux modes.
