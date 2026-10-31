# Engine navigation acceptance

App: Bay dev client, iPhone simulator and bay-pixel Android emulator. Start with a process restart and an empty, unpersisted tab. Metro runs on port 8081.

| Action | Expected outcome | Executable evidence |
| --- | --- | --- |
| Launch and attach to Metro | Start page appears | Start hint visible |
| Tap Search | Address editor appears | address-input visible |
| Enter https://example.com and submit | Native engine loads the page | page-title equals Example Domain, page-url equals https://example.com/, page-status equals Ready |
| Open https://example.org | Second navigation completes | page-url equals https://example.org/, page-status equals Ready |
| Back | Original page returns | page-url equals https://example.com/ |
| Forward | Second page returns | page-url equals https://example.org/ |
| Reload | Current page remains usable | page-title equals Example Domain, page-status equals Ready |

Each destination is followed by an idle readiness gate. Public example.com and example.org are external network dependencies. The test changes only the process-local tab and public HTTP caches; the next launch starts with an empty tab. No accounts, fixture server, or saved user data are needed.

Before the second address, the test establishes that `clear-address` is visible, clears the input, and verifies that the same control disappears. All actions use stable IDs; no coordinate or raw-gesture exceptions remain in the saved YAML. No snapshot baselines are required.

## Verification on 31 October 2026

- Both native dev clients build and install. Typechecking, Oxlint, formatting and the address tests pass.
- `pnpm e2e` passes twice unchanged on both platforms, including navigation and smoke. The runner is the Argent CLI. Scoped Argent services were recycled before each platform's first proof pass.
- The iOS navigation test executes 30 steps; only the Android launcher setup is skipped. Android executes all 32 steps. Every acceptance check runs on both.
- Idle warnings occur around the focused editor, keyboard/page resizing, and the Android dev launcher. The focused editor has a blinking caret. Stable start-page, input, URL, title and ready-state assertions gate the behavior; idle alone is never acceptance evidence.

| Navigation | Destination identity | Readiness |
| --- | --- | --- |
| Launch | Tap to search | idle |
| Start Search | address-input | idle |
| First address | Example Domain and https://example.com/ | idle, then Ready |
| Page Search | clear-address | idle |
| Second address | https://example.org/ | idle, then Ready |
| Back | https://example.com/ | idle |
| Forward | https://example.org/ | idle |

iOS launches directly into Metro. Only Android needs the dev-client `open-url` setup. Use `type:` for address input: raw tool steps clear Argent's iOS app pin and can make later reads scan suspended background apps. The tests keep the iOS run pinned to Bay.

On this Mac, `xcode-select -p` returns `/Library/Developer/CommandLineTools`; the build scripts supply `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`. CoreSimulator 1174.21 was used for the final proof runs.
