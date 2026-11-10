# Videos

Release videos for Bay, in Remotion: real recordings of the app on the site's paper, with captions, highlighter marks
and an original score. A standalone project (its own lockfile; the root workspace leaves it out).

```bash
pnpm install
npx remotion studio                       # preview
npx remotion render src/index.ts bay-1-5-4 out/bay-1-5-4-music-1440p60.mp4 \
  --codec=h264 --crf=12 --x264-preset=slow --image-format=png --audio-codec=aac --audio-bitrate=320k
```

## Bay 1.5.4

`src/bay-1.5.4`: 60 fps at 2560 × 1440, laid out at 1080p and timed in 30ths of a second (`useBeat`). The scenes are
recordings in `public/clips` (one drawn scene: the update channel, since a dev build has updates off).

- **Score:** `scripts/music/bay-1.5.4.py` synthesizes it (numpy, scipy, ffmpeg) into `public/music/bay-1.5.4.wav`: a lo-fi
  groove at 85.7 BPM, so a bar is the intro's 2.8 s and the film is 16 bars, with a swell into every scene change.
- **Recordings:** made in Bay Dev (`scripts/run-app`) with a staged profile, driven by `scripts/capture`: `ev` runs
  JavaScript in the app through the dev harness (put a `perf-probe` file in Bay Dev's data folder first), `rec` pins the
  window and records it, `drag` makes a real drag with `cliclick`. Return, Escape and arrows only arrive through
  `osascript -e 'tell application "System Events" to key code …'`.

## Bay 1.6

`src/bay-1.6` (composition `bay-1-6`): the same paper, captions and timing as 1.5.4 (it reuses `bay-1.5.4/ui.tsx`), with
the recordings in `public/clips-1.6` and the score from `scripts/music/bay-1.6.py` (1.5.4's voices on a progression in D,
its swells on this edit's cuts).

```bash
npx remotion render src/index.ts bay-1-6 out/bay-1-6-1440p60.mp4 \
  --codec=h264 --crf=12 --x264-preset=slow --image-format=png --audio-codec=aac --audio-bitrate=320k
```

- **Recordings:** `scripts/capture/winrec.swift` (`swiftc -O` it once) records the screen under Bay Dev's window by its
  id with ScreenCaptureKit, at 2x and 60 fps, without the pointer, while the dev harness (`ev`) drives the app: no
  clicks or typing, so nothing lands in another window. Bay Dev still has to be in front: a covered Chromium window
  stops painting. A filter that names the window makes macOS draw a "being shared" badge over its traffic lights, so
  it captures the display cropped to the window instead. The takes only hold frames that changed: convert each to
  constant 60 fps with its last frame held (`ffmpeg -vf "fps=60,tpad=stop_mode=clone:stop_duration=8"`) before the
  edit. The pointer in the edit is drawn (`Click`).
