// Arc Max's Tidy Downloads, without the cloud: a readable name from the file and the page it came from.
//
// The engine side gives a download its URL, the page that started it (tabUrl) and its referrer. This module turns
// those, and the name the server sent, into a shorter name a person would choose: IMG_20261024_8812.pdf on a page
// called "Q3 2026 Report" becomes "Q3 2026 Report.pdf". It never renames anything itself; the app does, and offers
// the way back (apps/browser/src/lib/tidyDownloads.ts).
//
// It is deterministic on purpose. A local cleaner runs in a millisecond, on every Mac, and the on-device model in
// packages/desktop/ios/TidyNamesModule.swift refines the answer where Apple Intelligence has one. Neither sends the
// name or the page anywhere.

export type TidyNameInput = {
  filename: string;
  pageTitle?: string | null;
  pageUrl?: string | null;
  mimeType?: string | null;
};

export type TidyName = {
  /** The name to save, extension included. */
  filename: string;
  /** The name without its extension: what the UI offers and the model answers. */
  stem: string;
  extension: string;
  /** Whether the words came from the file's name or the page's title. */
  basis: "file" | "page";
};

// MARK: Names

const COMPOUND_EXTENSION = /\.(tar\.(?:gz|bz2|xz|zst)|tbz2|txz)$/i;
const SIMPLE_EXTENSION = /\.([a-z0-9]{1,10})$/i;

/** `IMG_8812.JPG` → `{ stem: "IMG_8812", extension: "JPG" }`; an archive keeps its whole `.tar.gz`. */
export function splitFilename(filename: string): { stem: string; extension: string } {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const compound = COMPOUND_EXTENSION.exec(base);
  if (compound && compound.index > 0) return { stem: base.slice(0, compound.index), extension: compound[0].slice(1) };
  const simple = SIMPLE_EXTENSION.exec(base);
  if (simple && simple.index > 0) return { stem: base.slice(0, simple.index), extension: simple[1]! };
  return { stem: base, extension: "" };
}

function decoded(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function normalised(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// MARK: Words

// Arc's own examples keep the subject's character: "Huracan S 02", "Close Up Astronaut Floating".
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "vs", "with"]);

// Words a filename picks up from a camera, a screen, a save panel or a version control tool.
const NOISE_WORDS = new Set([
  "img",
  "image",
  "images",
  "photo",
  "photos",
  "pic",
  "pics",
  "picture",
  "screenshot",
  "screen",
  "shot",
  "capture",
  "untitled",
  "download",
  "downloads",
  "document",
  "doc",
  "file",
  "files",
  "original",
  "final",
  "copy",
  "new",
  "edit",
  "edited",
  "export",
  "output",
  "tmp",
  "temp",
  "version",
  "ver",
]);

// A name made only of these says nothing, with or without a page beside it.
const GENERIC_NAMES = new Set([
  "download",
  "downloads",
  "file",
  "files",
  "document",
  "documents",
  "image",
  "images",
  "photo",
  "photos",
  "picture",
  "pictures",
  "untitled",
  "screenshot",
  "original",
  "export",
  "output",
  "attachment",
  "data",
]);

const UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
const HEX = /(?<![0-9a-f])[0-9a-f]{12,}(?![0-9a-f])/gi;
const DATE = /(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])/g;
const EPOCH = /(?<!\d)\d{10,13}(?!\d)/g;
const LONG_NUMBER = /(?<!\d)\d{5,}(?!\d)/g;
const CAMERA = /(?:^|[^a-z0-9])(?:img|dscf?|pxl|gopr|dji)[\s_-]?\d+(?=$|[^a-z0-9])/gi;
const SCREENSHOT = /(?:^|[^a-z0-9])(?:screenshot|screen shot|cleanshot|snip|screen recording)(?:$|[^a-z0-9])(?:\s*(?:at\s+)?\d[\d\s.:_-]*)?/gi;
// Not one whose dots were kept (VERSION_DOT): "v22.11.0" stays, "v3" goes.
const VERSION = /(?:^|[^a-z0-9])(?:v|ver|version)[\s._-]?\d+(?=$|[^a-z0-9․])/gi;
const DUPLICATE = /\s*\(\d+\)\s*$/;
// "Cra-0.1.30": a dotted version keeps its dots through the word breaks below.
const DOTTED_VERSION = /(?<![\d.])\d+(?:\.\d+){1,3}(?![\d.])/g;
const VERSION_DOT = "․";
const NOISY_WORD =
  /(?:^|[\s._-])(?:final|copy|untitled|original|download|export|output|tmp|temp|image|images|photo|photos|pic|pics|picture|file|files|document|scan)(?=$|[\s._-])/i;
// The same expression with /g, for replacing every occurrence.
const NOISY_WORD_ALL =
  /(?:^|[\s._-])(?:final|copy|untitled|original|download|export|output|tmp|temp|image|images|photo|photos|pic|pics|picture|file|files|document|scan)(?=$|[\s._-])/gi;
const TRAILING_BYLINE = /\s+(?:by|from)\s+[^|—–]{1,48}$/i;

// .test() must not use a /g expression: it remembers lastIndex between downloads.
const UUID_TEST = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/i;
const HEX_TEST = /(?<![0-9a-f])[0-9a-f]{12,}(?![0-9a-f])/i;
const DATE_TEST = /(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])/;
const EPOCH_TEST = /(?<!\d)\d{10,13}(?!\d)/;
const LONG_NUMBER_TEST = /(?<!\d)\d{5,}(?!\d)/;
const SCREENSHOT_NAME = /(?:^|[^a-z0-9])(?:screenshot|screen shot|cleanshot|snip|screen recording)(?:$|[^a-z0-9])/i;

function hasCameraName(stem: string): boolean {
  return /(?:^|[^a-z0-9])(?:img|dscf?|pxl|gopr|dji)[\s._-]?\d+(?=$|[^a-z0-9])/i.test(stem);
}

/** Whether a file's name is machine-made: a camera's, a screen's, a hash, a version, a save-panel default. */
export function looksGenerated(stem: string): boolean {
  const name = stem.trim();
  if (!name) return true;
  if (UUID_TEST.test(name)) return true;
  if (HEX_TEST.test(name)) return true;
  if (DATE_TEST.test(name)) return true;
  if (EPOCH_TEST.test(name)) return true;
  if (LONG_NUMBER_TEST.test(name)) return true;
  if (hasCameraName(name)) return true;
  if (/[_~]/.test(name)) return true;
  if (NOISY_WORD.test(name)) return true;
  if (/(?:^|[\s._-])(?:v|ver|version)[\s._-]?\d+(?=$|[\s._-])/i.test(name)) return true;
  if (/(?:^|[\s._-])(?:screenshot|screen shot|cleanshot|snip)(?:$|[\s._-])/i.test(name)) return true;
  // A single run of words with short counters ("gw_hura_s_02" is caught by its underscores).
  if (!/\s/.test(name) && /(?:^|[\s._-])\d{1,3}(?:$|[\s._-])/.test(name) && /[a-z]/i.test(name)) return true;
  // A web address's slug: "hello-world-master".
  if (!/\s/.test(name) && /[a-z]{2,}-[a-z0-9]/i.test(name)) return true;
  return false;
}

/** The page's title without its site's name, counters, "Download" or a file extension. */
export function cleanPageTitle(title: string | null | undefined): string {
  let text = (title ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text.replace(/^\(\d+\)\s*/, "");
  text = text.replace(/^(?:Download|Downloading)\s*[-–—:]?\s+/i, "");
  // "Q3 Report | Acme" and "How to feel less stressed — Psyche" keep the subject. A short leading part is
  // more likely to be a site's own name ("Acme — Q3 Report"), so only the first half of a long title wins.
  const parts = text.split(/\s+(?:[|•·]|[—–])\s+|\s+-\s+/);
  if (parts.length > 1 && (parts[0]?.length ?? 0) >= 4) text = parts[0]!;
  // "Huracan S 02 by Someone" on a photo site: the byline isn't part of the subject.
  if (text.length > 10) text = text.replace(TRAILING_BYLINE, "");
  text = text.replace(/\s*[-–—|]\s*(?:Download|Downloads|PDF|PDFs?)\s*$/i, "");
  text = text.replace(/\.(?:pdf|zip|png|jpe?g|gif|webp|avif|svg|mp4|mov|webm|mp3|m4a|wav|docx?|xlsx?|pptx?|txt|md|csv)$/i, "");
  return text.trim();
}

function titleCase(words: string[]): string {
  return words
    .map((word, index) => {
      // Keep a short acronym the server or the page already had: NASA, PDF, USA.
      if (/^[A-Z0-9]{2,5}$/.test(word) && /[A-Z]/.test(word)) return word;
      // And a brand's own capitals: VSCode.
      if (/^[A-Z]{2,}[a-z]/.test(word)) return word;
      const lower = word.toLowerCase();
      if (index > 0 && index < words.length - 1 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

type CleanOptions = { title?: boolean };

/** A filename or title's words, with hashes, dates, camera prefixes, versions and filler removed. */
function cleanWords(input: string, options: CleanOptions = {}): string[] {
  let text = input;
  // A generator's handle before its prompt: "rahulchowdhury._close_up_portrait_of_...". Only a long, one-word,
  // digit-free handle with a prompt behind it; "national_geographic_photo_of_a_cat" keeps its first word.
  const handle = /^([a-z]{8,})[._]/i.exec(text);
  if (handle && !/\d/.test(handle[1]!) && text.split(/[._\s-]+/).filter(Boolean).length >= 7) text = text.replace(/^[a-z]{8,}[._]/i, "");
  text = text.replace(UUID, " ");
  text = text.replace(HEX, " ");
  text = text.replace(DATE, " ");
  text = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  // A screenshot's "at 12.34.56" is a time; anywhere else, dots between numbers are a version.
  if (!SCREENSHOT_NAME.test(text)) text = text.replace(DOTTED_VERSION, (version) => version.replaceAll(".", VERSION_DOT));
  // Now that dates and hashes are out, the separators are just word breaks; the rest of the patterns can use
  // ordinary boundaries without an underscore hiding a word.
  text = text.replace(/[._~-]+/g, " ");
  text = text.replace(EPOCH, " ");
  text = text.replace(LONG_NUMBER, " ");
  text = text.replace(DUPLICATE, " ");
  text = text.replace(VERSION, " ");
  if (!options.title) {
    text = text.replace(CAMERA, " ");
    text = text.replace(SCREENSHOT, " ");
    text = text.replace(NOISY_WORD_ALL, " ");
  }
  text = text.replace(new RegExp(`[^\\p{L}\\p{N}\\p{M}'’ ${VERSION_DOT}]+`, "gu"), " ");
  let words = text.split(/\s+/).filter(Boolean);
  const keepShortNumbers = words.some((word) => !/^\d+$/.test(word));
  words = words
    .map((word) => ({ word, lower: word.toLowerCase() }))
    .filter(({ word, lower }) => {
      // "Hura S 02" keeps its S; a dangling one at either end is a prompt leftover and goes below.
      if (lower.length === 1) return /[a-z]/i.test(word) && keepShortNumbers;
      if (/^\d+$/.test(lower)) {
        if (!keepShortNumbers) return false;
        // Years and model numbers mean something; 5+ digit runs were timestamps and are already gone.
        return lower.length <= 4;
      }
      if (!options.title && NOISE_WORDS.has(lower)) return false;
      // "gw" and "pxl" are camera noise; "Q3" is a name and keeps its letter-digit pair.
      if (!options.title && /^[a-z]{2,}$/.test(lower) && /^[^aeiouy]+$/.test(lower)) return false;
      return true;
    })
    .map(({ word }) => word);

  // Trim the helper words a prompt leaves at the end, but never a year or a name. A leading "The" or "A" is part
  // of the name; only trailing "… in", "… of" or a dangling one-letter prompt fragment is filler.
  const isEdgeFiller = (word: string, edge: "start" | "end") => {
    const lower = word.toLowerCase();
    if (lower.length === 1) return edge === "end";
    if (edge === "end" && SMALL_WORDS.has(lower)) return true;
    if (edge === "end" && (lower === "upload" || lower === "version")) return true;
    return false;
  };
  while (words.length && isEdgeFiller(words[words.length - 1]!, "end")) words.pop();
  // "final final" and "copy copy" reads like a save dialog, not a title.
  words = words.filter((word, index) => index === 0 || word.toLowerCase() !== words[index - 1]!.toLowerCase());
  return words.map((word) => word.replaceAll(VERSION_DOT, "."));
}

function limitStem(stem: string, max = 64): string {
  if (stem.length <= max) return stem;
  const cut = stem.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s\-–—,.;:]+$/, "");
}

// A word in common, or one spelling out the other ("hura" and "Huracan"). Single letters prove nothing.
function sharesWord(a: string[], b: string[]): boolean {
  const others = b.map((word) => word.toLowerCase());
  return a.some((word) => {
    const lower = word.toLowerCase();
    return lower.length > 1 && others.some((other) => other.length > 1 && (other.startsWith(lower) || lower.startsWith(other)));
  });
}

function isGeneric(words: string[]): boolean {
  if (!words.length) return true;
  return words.every((word) => GENERIC_NAMES.has(word.toLowerCase()) || /^\d+$/.test(word));
}

function named(stem: string, originalFilename: string, basis: TidyName["basis"]): TidyName | null {
  const original = splitFilename(decoded(originalFilename));
  if (!original.extension || !stem) return null;
  const filename = `${stem}.${original.extension}`;
  if (normalised(filename) === normalised(decoded(originalFilename))) return null;
  return { filename, stem, extension: original.extension, basis };
}

/**
 * A model's answer as a name with the download's own extension, or null when it can't be one. It already reads like a
 * person's ("DM with Sara", "Fly.io Invoice Nov 3"), so it only loses what a file name can't hold; the word-level
 * cleaning is for the names machines make. The page's title is in its prompt, so an answer is never trusted to be safe.
 */
export function tidyNameFor(answer: string, originalFilename: string, basis: TidyName["basis"] = "page"): TidyName | null {
  // No hidden files: the leading dots go before ".hidden" could be taken for an extension.
  let proposed = (answer.split(/\r?\n/)[0] ?? "")
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/^[\s.]+/, "");
  // The ".30" of "Cra 0.1.30" is part of the name, not an extension to swap out.
  const proposedExtension = SIMPLE_EXTENSION.exec(proposed);
  if (proposedExtension && proposedExtension.index > 0 && !/^\d+$/.test(proposedExtension[1]!)) proposed = proposed.slice(0, proposedExtension.index);
  const stem = limitStem(
    proposed
      .replace(/[/\\:*?"<>|\p{Cc}]+/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+/, "")
      .replace(/[\s.]+$/, ""),
  );
  if (isGeneric(stem.split(" ").filter(Boolean))) return null;
  return named(stem, originalFilename, basis);
}

/**
 * tidyNameFor for an answer that has to keep the file's subject. The model leans hard on the page's title, and a file
 * isn't always what its page is about: Cra-0.1.30.dmg from a page called "Q3 2026 Report" came back as "Acme Q3 2026
 * Report". When the file's own name says something, the answer has to share a word with it (or spell one out, "hura"
 * and "Huracan"). A name that says nothing (IMG_8812, 387494875) leaves the model free.
 */
export function modelTidyName(answer: string, originalFilename: string): TidyName | null {
  const fileWords = cleanWords(splitFilename(decoded(originalFilename)).stem);
  if (!isGeneric(fileWords) && !sharesWord(fileWords, cleanWords(answer, { title: true }))) return null;
  return tidyNameFor(answer, originalFilename, "page");
}

// MARK: Suggestion

/**
 * A readable name for a download, or null when the name is already a person's choice or there is nothing better to
 * offer. The caller decides whether to show it; nothing is renamed here.
 */
export function tidyDownloadName(input: TidyNameInput): TidyName | null {
  const filename = decoded(input.filename.split(/[\\/]/).pop() ?? "");
  const original = splitFilename(filename);
  if (!original.extension) return null;
  // Spaced names are usually already the person's: "Q4 2025 Roadmap.pdf" needs no help. The machine-made signals
  // are what ask for a tidy name.
  if (!looksGenerated(original.stem)) return null;

  const fileWords = cleanWords(original.stem);
  const pageWords = cleanWords(cleanPageTitle(input.pageTitle), { title: true });
  const pageUsable = pageWords.length > 0 && !isGeneric(pageWords);
  // A page that spells out a clipped name ("Hura" → "Huracan") names the subject better than the file does.
  const spellsOut = fileWords.some(
    (fileWord) =>
      fileWord.length >= 3 && pageWords.some((pageWord) => pageWord.length > fileWord.length && pageWord.toLowerCase().startsWith(fileWord.toLowerCase())),
  );
  const preferPage =
    pageUsable &&
    (fileWords.length === 0 ||
      isGeneric(fileWords) ||
      spellsOut ||
      /untitled|screenshot|screen shot|original|download/i.test(original.stem) ||
      // "report_1" has a word but is mostly a counter, and the page spells out which report. A page about something
      // else (Cra-0.1.30.dmg on "Q3 2026 Report") doesn't name the file.
      (fileWords.length <= 3 && pageWords.length > fileWords.length && sharesWord(fileWords, pageWords)));

  const words = preferPage ? pageWords : fileWords;
  if (!words.length || isGeneric(words)) return null;
  return named(limitStem(titleCase(words)), filename, preferPage ? "page" : "file");
}

/**
 * Chromium remembers the name the server sent (suggestedFilename) beside the path it saved. When they differ, the
 * person chose the name — in a save panel, or by renaming it — and Tidy Downloads leaves it alone.
 */
export function isUserNamedDownload(filename: string, suggestedFilename?: string | null): boolean {
  if (!suggestedFilename) return false;
  // Chromium's disambiguation suffix sits before the extension: "invoice (1).pdf".
  const strip = (name: string) => normalised(name.replace(/\s*\(\d+\)(?=\.[^.]*$|$)/, ""));
  return strip(filename) !== strip(suggestedFilename);
}
