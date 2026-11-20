# Profiling Bay on Windows and Linux

A profile is a Chrome trace of the whole browser, plus Bay's own timings, while you do the slow thing.
`apps/browser/scripts/perf/trace.mjs` turns it into a report, and compares two reports. macOS has its own tools
(`js-bench.mjs`, `native-bench.mjs`).

## Recording

Any of these records the same things. The engine notices any trace that records `blink.user_timing` and tells every
Bay document to add its spans until it stops (`ProfilingWatch`), so all three get Bay's spans too.

- **In Bay:** F10 › Help › Record Performance Issue…. Reproduce the problem, then click Stop. The trace goes to
  Downloads as `Bay Trace <date>.json`. Bay keeps the newest 256 MB, so a long recording keeps its end.
- **From a terminal**, against the running Bay (turn on Settings › "Let the bay command control Bay"):

  ```sh
  node apps/browser/scripts/perf/trace.mjs record              # until you press Enter
  node apps/browser/scripts/perf/trace.mjs record --seconds 15 --out slow-switch.json
  ```

  `--data-dir` finds a Bay with its own data folder (`BAY_DATA_DIR`), and `--port`/`--ws` reach any Chromium started
  with `--remote-debugging-port`, the local web preview included.
- **From launch:** `trace.mjs startup-flags --seconds 30` prints the switches to add to Bay's command line. Chrome
  writes the trace when the time is up.

Gzipped traces (`.json.gz`) read the same, so send a compressed one.

## Reading a profile

```sh
node apps/browser/scripts/perf/trace.mjs report "Bay Trace 2026-11-16 at 10.12.03.json" --json before.json
# change something, record the same steps again
node apps/browser/scripts/perf/trace.mjs report after-trace.json --json after.json
node apps/browser/scripts/perf/trace.mjs compare before.json after.json
```

The report lists:

- **Processes**: the browser, the GPU, Bay's documents (renderers running `chrome://bay` scripts) and web pages.
- **Main threads**: how long each was busy, how many tasks it ran, and how many took 50 ms or more.
- **Bay's spans**: count, total, median, 95th percentile and worst, with the kilobytes they carried. The spans are
  listed below.
- **JavaScript**, per process, from V8's 1 ms samples: time by layer (React, DOM and browser APIs, garbage collection,
  Bay), self time per function and total time with callees. The web build keeps function names
  (`apps/browser/metro.config.js`), so these are readable.
- **React**: commits, component renders, and which components rendered most.
- **Frames**: frames the compositor presented, partly presented or dropped, and how long each took.
- **Input**: per event type, the time from the event to the next frame after its handlers ran. Interactions of
  100 ms or more are listed with the moment they happened.
- **Longest tasks**, **long animation frames**, **garbage collection**, **IPC** received per interface, and each
  process's peak **memory**: footprint, V8, Blink's heap, malloc and PartitionAlloc.

The trace also opens in DevTools' Performance panel, and in [Perfetto](https://ui.perfetto.dev) for the native stacks.
Bay's spans appear there under Timings.

`compare` lists what moved by 10% or more. Counts and totals only compare between recordings of the same steps.

## Bay's spans

The engine's spans run in the browser process (`app_runtime.cc`, `native_host.cc`). The report marks them `[engine]`.

| Span | What it times |
| --- | --- |
| `Bay.command <method>` | A window's command, from its dispatch until its commit is applied in that window (`runtime/client.ts`) |
| `Bay.runtime encodeCommand` / `awaitReply` | Serialising the command, then the round trip until the reply is parsed |
| `Bay.Runtime.Dispatch` [engine] | The browser checking the command and passing it to the coordinator |
| `Bay.runtime decodeCommand` | The coordinator parsing it |
| `Bay.reduce <method>` | The reducer (`runtime/authority.ts`) |
| `Bay.authority project` / `notify` | Projecting the new state, and handing the commit on |
| `Bay.runtime encodeCommit` / `awaitPublish` | The coordinator serialising the commit, then the browser accepting it. `partial` marks a delta: only the top-level fields that changed since the last accepted commit, which an engine that says `partialCommits` takes |
| `Bay.Runtime.Publish` [engine] | Parsing (`ParseCommit`) and checking (`ValidateCommit`) the state (a delta's fields are swapped into the accepted state first), then projecting and writing it for each window (`SendCommit`, `Snapshot`, `WriteJson`). A window that was sent the revision before gets a delta too: history and bookmarks only when they changed, other fields only when their JSON did. `CommitSent` gives each window's bytes |
| `Bay.Runtime.Resolve` [engine] | The coordinator's reply, passed to the window with its commit's revision (the window has the commit itself from `Publish`) |
| `Bay.coordinator <method>` | A command's whole stay in the coordinator, waits included |
| `Bay.runtime decodeCommit` / `deliverCommit` | A window parsing a commit, then handing it on |
| `Bay.client decodeCommit` / `decodeReply` / `applyCommit` | Validating it, then the window's store taking it and its subscribers running |
| `Bay.native <Module.method>` | A native call's round trip, with bytes sent and received (`mojoTransport.ts`) |
| `Bay.NativeHost.Invoke` [engine] | The call's synchronous part in the browser |
| `Bay.event <Module.event>` | A native event parsed and delivered to its listeners |
| `Bay.NativeHost.Emit` [engine] | Serialising an event for one document. `EmitSize` gives its bytes |
| `Bay.EngineEvent` / `Bay.Runtime.PageEvent` [engine] | The engine's change events, and page facts passed to the coordinator |
| `Bay.WindowShortcut` [engine] | A window key the browser ran |
| `Bay.react commit` | A React commit: what rendered, how many, how many mounted. The span is the walk that counts them, so that cost can be taken out |
| `Bay.startup bundle` / `nativeHost` / `font` / `runtimeTransport` / `entry` / `firstCommit` | A document's start, from navigation (`index.web.ts`) |

A span is a User Timing measure (`packages/platform/src/profiling.ts`). While nothing records, it costs a boolean
check. To add one, wrap the work in `timed(name, run)`, or call `span(name, spanStart())` when it ends.

## Limits

- Bay's engine spans and the menu's full category list need an engine built from this change or later. An older
  engine records Chrome's defaults, without `Bay.*` events.
- Several documents can share one renderer process, and so one main thread. Their JavaScript samples are reported
  together.
- `trace.mjs record` uses `ReportEvents`. With `ReturnAsStream`, Chrome 157 never answered `IO.read` for a trace a few
  seconds long with this category list.
