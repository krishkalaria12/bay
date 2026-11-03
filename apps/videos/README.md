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
