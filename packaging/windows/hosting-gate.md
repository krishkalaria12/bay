# Windows hosting decision record

The process check in `scripts/windows/smoke.ps1` proves only that Bay creates a
desktop window and stays alive. Phase 2 requires the checks below on real
Windows hardware or a suitable VM. A localhost preview uses a fixture transport
and cannot establish any native-host result.

Copy `hosting-gate.template.json` for each environment. Run Windows 11 at 100%
and 150% display scale, and Windows 10 at least once. Record the engine artifact
ID, staged `app-manifest.json` SHA-256, OS build, GPU and driver so a result can
be reproduced. Keep screenshots, traces and raw timing samples beside the record.

Launch the staged application directly, with no development server:

```powershell
$env:BAY_DATA_DIR = Join-Path $env:TEMP ('Bay-hosting-' + [guid]::NewGuid())
.\dist\windows-app\Bay.exe --bay-hosting-spike
```

Use a fresh profile for each run. Keep failed profiles for Chromium logs and
Crashpad dumps. Confirm the page labels the transport as native Chrome before
recording Mojo measurements.

| Check | Required observation |
| --- | --- |
| Overlay and blur | A rounded translucent panel stays over playing video during window movement and resizing. Record whether backdrop blur reaches 60 fps. |
| Input | Click, wheel, hover, text selection and dragging reach unobscured page areas. Drag a URL or text between the UI and page in both directions. |
| Focus | UI Ctrl shortcuts work from a focused page, page shortcuts still work, and F6 cycles sidebar, address field and page. |
| IME | Japanese and Chinese Microsoft IME work in both UI and page fields with correctly positioned candidate windows. |
| Accessibility | Narrator and NVDA read UI then page in order. Inspect a single connected UI Automation tree. |
| Window frame | Caption dragging, edge resize, double-click maximize, Aero Snap, Snap Layouts and mixed-DPI moves work. |
| Backdrop | On Windows 11 22H2+, Mica is visible through transparent UI areas and follows activation. On Windows 10, record the solid fallback. |
| Motion | Sidebar and peek Reanimated animations hold 60 fps while three panes load. Capture a performance trace. |
| Bridge | Measure at least 100 actual Mojo round trips after warm-up. p95 is below 2 ms. Generate 60 Hz tab events and inspect UI jank. |
| Bridge isolation | An ordinary tab and an ordinary tab navigating to `chrome://bay` cannot bind NativeHost. Check the console and verify native actions remain inaccessible. |
| Tabs | Move a live tab to a new window without reloading. Test embedded fullscreen, picture-in-picture and DevTools. |
| Cost | Measure cold start and UI renderer private memory beside the Mac app, recording the same workload and measurement method. |

Check statuses are `not-run`, `pass`, `fail`, or `not-applicable`. Every
`not-applicable` needs evidence, such as the Windows 10 Mica fallback. A missing
control or native operation is `not-run` or `fail`; it is never a passing test.
The initial spike may lack controls needed for some rows. Record that limitation
and complete those rows once the implementation can exercise them.

Set `decision` to `go` only after the required runs pass, with acceptable
measured startup and memory. Use `no-go` for a blocking failure. A blur-only
failure may justify `go-with-solid-overlays` if the record explains that choice.
Keep `not-run` while required evidence is missing. This record does not certify
installer, updater or full application feature parity.
