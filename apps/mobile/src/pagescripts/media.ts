// The mini player: each page reports its audio and video to the app ({ type: "media", playing, title, video })
// whenever one plays, pauses or ends, so a tab playing in the background can be shown and controlled. Media events
// don't bubble, so they're caught on the way down at the document. State lives under Symbol.for("bay.media").
import * as v from "valibot";

import { withArgs } from "./args.ts";

export interface MediaMessage {
  type: "media";
  playing: boolean;
  /** The page's title, else the media's own, else its file name (a media file opened on its own has no title). */
  title: string;
  /** Video (shown) rather than audio only. */
  video: boolean;
}

/** Starts reporting the page's media; running it again on the same document does nothing. */
export const WATCH_MEDIA_SCRIPT = `
const state = (window[Symbol.for("bay.media")] ??= {});
if (state.watching) return true;
state.watching = true;
const fileName = (media) => {
  try {
    return decodeURIComponent(new URL(media.currentSrc || location.href).pathname.split("/").pop() || "");
  } catch {
    return "";
  }
};
// Silent media is part of the page, not something being listened to: a muted preview (search results, a feed), a
// looping background, a GIF served as video. It never brings the player; unmuting it does.
const audible = (media) => !media.muted && media.volume > 0;
const report = (event) => {
  const media = event.target;
  if (!(media instanceof HTMLMediaElement)) return;
  const sounding = !media.paused && !media.ended && audible(media);
  if (sounding && ["play", "playing", "volumechange"].includes(event.type)) state.current = media;
  else if (media !== state.current) return;
  // Media muted while it plays counts as paused.
  const playing = sounding;
  post({
    type: "media",
    playing,
    title: (document.title || media.title || fileName(media) || location.hostname).slice(0, 200),
    video: media instanceof HTMLVideoElement && media.videoWidth > 0,
  });
};
for (const type of ["play", "playing", "pause", "ended", "emptied", "volumechange"]) document.addEventListener(type, report, true);
// Media that started before the watch did (a file that plays by itself as it opens) never sends its play event again.
const playing = [...document.querySelectorAll("video, audio")].find((media) => !media.paused && !media.ended && audible(media));
if (playing) report({ type: "playing", target: playing });
return true;
`;

/** Plays or pauses the media the page played last; resolves whether it's playing now, or null when there is none. */
export const TOGGLE_MEDIA_SCRIPT = `
const state = window[Symbol.for("bay.media")];
const media = state && state.current;
if (!media || !media.isConnected) return null;
if (media.paused || media.ended) {
  await media.play();
  return true;
}
media.pause();
return false;
`;

/** Pauses the page's media. */
export const PAUSE_MEDIA_SCRIPT = `
const state = window[Symbol.for("bay.media")];
if (state && state.current) state.current.pause();
return true;
`;

/** Seeks the page's media by `args.seconds` (negative rewinds), clamped to the media's own bounds. */
export const SEEK_MEDIA_SCRIPT = `
const state = window[Symbol.for("bay.media")];
const media = state && state.current;
if (!media || !media.isConnected) return null;
media.currentTime = Math.max(0, media.currentTime + args.seconds);
return true;
`;

export function seekMediaScript(seconds: number): string {
  return withArgs(SEEK_MEDIA_SCRIPT, { seconds });
}

/** Asks the page's own video element for picture in picture; false where it can't (audio, or the engine won't). */
export const PIP_MEDIA_SCRIPT = `
const state = window[Symbol.for("bay.media")];
const media = state && state.current;
if (!media || !media.isConnected || !("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) return false;
if (typeof media.requestPictureInPicture !== "function") return false;
try {
  await media.requestPictureInPicture();
  return true;
} catch {
  return false;
}
`;

const mediaMessageSchema = v.object({
  type: v.literal("media"),
  playing: v.boolean(),
  title: v.string(),
  video: v.boolean(),
});

/** Parses a page message as a media report; null for anything else. Messages come from the page, so check them. */
export function parseMediaMessage(message: string): MediaMessage | null {
  let value: unknown;

  try {
    value = JSON.parse(message);
  } catch {
    // Not JSON: not a media report.
    return null;
  }

  const parsed = v.safeParse(mediaMessageSchema, value);

  if (!parsed.success) return null;

  return { type: "media", playing: parsed.output.playing, title: parsed.output.title.slice(0, 200), video: parsed.output.video };
}
