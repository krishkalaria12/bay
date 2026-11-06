// The mini player: each page reports its audio and video to the app ({ type: "media", playing, title, video })
// whenever one plays, pauses or ends, so a tab playing in the background can be shown and controlled. Media events
// don't bubble, so they're caught on the way down at the document. State lives under Symbol.for("bay.media").
import * as v from "valibot";

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
const report = (event) => {
  const media = event.target;
  if (!(media instanceof HTMLMediaElement)) return;
  if (event.type === "play" || event.type === "playing") state.current = media;
  else if (media !== state.current) return;
  const playing = !media.paused && !media.ended;
  post({
    type: "media",
    playing,
    title: (document.title || media.title || fileName(media) || location.hostname).slice(0, 200),
    video: media instanceof HTMLVideoElement && media.videoWidth > 0,
  });
};
for (const type of ["play", "playing", "pause", "ended", "emptied"]) document.addEventListener(type, report, true);
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
