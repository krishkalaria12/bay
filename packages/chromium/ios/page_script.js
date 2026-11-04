// Install before page scripts. The script's value is this function: the renderer runs it and calls what it returns
// (NNPageObserver::DidCreateScriptContext), so the expression below is used, by the engine.
// oxlint-disable-next-line no-unused-expressions
(function (post) {
  "use strict";
  // An about:blank or srcdoc frame has no URL of its own, and a sandboxed frame has an opaque origin: the page they
  // run for is the one whose base URL they inherit. Match the content blocker's rules on that, as uBO does, or the
  // blank frame is a way around its scriptlets and cosmetic filters.
  const documentURL = () => {
    if (/^(https?|file):/.test(location.protocol) && location.origin !== "null") return location.href;
    const base = document.baseURI || "";
    return /^(https?|file):/.test(base) ? base : "";
  };
  const url = documentURL();
  if (!url) return () => {};
  const isTop = window === window.top;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const primaryModifier = (event) => (isMac ? event.metaKey : event.ctrlKey);
  const secondaryModifier = (event) => (isMac ? event.ctrlKey : event.metaKey);
  const handlers = Object.create(null);
  // Page code runs after this and can replace any global or prototype method:
  // keep the originals, and send plain copies (a page's Object.prototype.toJSON
  // can't reach them). The browser still checks every message.
  const { stringify: toJSON, parse: fromJSON } = JSON;
  const apply = Reflect.apply;
  const { keys, setPrototypeOf } = Object;
  const { isArray } = Array;
  const { isFinite } = Number;
  const startsWith = String.prototype.startsWith;
  const plain = (value, depth) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return isFinite(value) ? value : null;
    if (typeof value !== "object" || depth > 4) return null;
    const out = setPrototypeOf(isArray(value) ? [] : {}, null);
    const names = keys(value);
    for (let i = 0; i < names.length; i++) {
      const v = value[names[i]];
      if (v !== undefined && typeof v !== "function") out[names[i]] = plain(v, depth + 1);
    }
    return out;
  };
  const serialize = (data) => toJSON(plain(data, 0));
  const send = (kind, data) => post(kind, serialize(data));
  const onReady = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn());
  const guard = (fn) =>
    function () {
      try {
        return apply(fn, this, arguments);
      } catch {}
    };
  const later = (fn, ms) => {
    let queued = false;
    return () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        guard(fn)();
      }, ms);
    };
  };

  // MARK: Media — audible state (tab speaker glyph), now playing, transport controls.
  const frame = Math.random().toString(36).slice(2);
  const tracked = new WeakSet();
  let active = null;
  let lastPlaying = null;
  const audible = (m) => !m.paused && !m.ended && !m.muted && m.volume > 0 && m.readyState > 2;
  // Live collections follow DOM additions/removals without rescanning unrelated feed nodes on every media event.
  const videos = document.getElementsByTagNameNS("*", "video");
  const audios = document.getElementsByTagNameNS("*", "audio");
  const anyAudible = (elements) => {
    for (let i = 0; i < elements.length; i++) if (audible(elements[i])) return true;
    return false;
  };
  const reportAudible = () => {
    const playing = anyAudible(videos) || anyAudible(audios) || (active && audible(active)) || webAudible();
    if (playing === lastPlaying) return;
    lastPlaying = playing;
    send("media", { frame, playing });
  };

  const session = navigator.mediaSession;
  const actions = new Map();
  let positionState = null;
  // Now playing is media the user has heard, as in Chrome's media controls: never a muted autoplay (X's feed), and
  // never a sound effect (chess.com's moves) shorter than Chrome's 5 s floor for a media session.
  const heard = new WeakSet();
  const SOUND_EFFECT_S = 5;
  const hear = (m) => {
    if (heard.has(m) || !audible(m)) return false;
    heard.add(m);
    return true;
  };
  const showable = (m) => heard.has(m) && m.duration >= SOUND_EFFECT_S;
  const pickMedia = () => {
    const all = [...document.querySelectorAll("video,audio")];
    if (active && !all.includes(active)) all.push(active);
    const shown = all.filter(showable);
    return shown.find((m) => !m.paused && !m.ended) || (shown.includes(active) ? active : null);
  };
  const absolute = (src) => {
    try {
      return new URL(src, location.href).href;
    } catch {
      return null;
    }
  };
  const artworkOf = (metadata) => {
    const art = metadata && metadata.artwork;
    if (!art || !art.length) return null;
    const size = (a) =>
      Math.max(
        0,
        ...String(a.sizes || "0x0")
          .split(/\s+/)
          .map((s) => parseInt(s, 10) || 0),
      );
    return absolute([...art].sort((a, b) => size(b) - size(a))[0].src);
  };
  // YouTube's player, which knows more than its video element: subtitles, and where a live stream's end is.
  const youTubePlayer = (v) => {
    const player = v.closest(".html5-video-player");
    return player && typeof player.getOption === "function" && typeof player.setOption === "function" ? player : null;
  };
  // YouTube pads a live video's duration an hour past the live edge, so its seekable end never moves: the edge is
  // its player's, in the player's own time.
  const youTubeLive = (m) => {
    const player = youTubePlayer(m);
    try {
      if (!player || !player.getVideoData?.()?.isLive) return null;
      const { seekableEnd: end, current } = player.getProgressState();
      return isFinite(end) && isFinite(current) ? { player, end, behind: end - current } : null;
    } catch {
      return null;
    }
  };

  // A live stream: an endless duration, or a seekable range whose end keeps moving with the clock (a live stream
  // that can be rewound, as Twitch's is). How far behind is measured from that end.
  const liveSeen = new WeakMap();
  const seekableEnd = (m) => (m.seekable && m.seekable.length ? m.seekable.end(m.seekable.length - 1) : NaN);
  const isLive = (m) => {
    if (m.duration === Infinity || liveSeen.get(m) === true || youTubeLive(m)) return true;
    const end = seekableEnd(m);
    if (!isFinite(end)) return false;
    const seen = liveSeen.get(m);
    const elapsed = seen ? (Date.now() - seen.at) / 1000 : 0;
    // A new stream in the element, or a minute without the end keeping up: measure again from here.
    if (!seen || end < seen.end || elapsed > 60) liveSeen.set(m, { end, at: Date.now() });
    else if (elapsed >= 2 && end - seen.end >= elapsed / 2) liveSeen.set(m, true);
    return liveSeen.get(m) === true;
  };
  // The live edge, unless the seekable end is a placeholder: Twitch's reaches 2^30 s, decades ahead, where no stream
  // that can be rewound goes.
  const liveEdge = (m) => {
    const end = seekableEnd(m);
    return end - m.currentTime < 86400 ? end : NaN;
  };
  const liveBehind = (m) => {
    const behind = youTubeLive(m)?.behind ?? liveEdge(m) - m.currentTime;
    return isFinite(behind) ? Math.max(0, Math.round(behind)) : 0;
  };
  const goLive = (m) => {
    const youTube = youTubeLive(m);
    const end = liveEdge(m);
    if (youTube) youTube.player.seekTo(youTube.end, true);
    else if (isFinite(end)) m.currentTime = Math.max(m.seekable.start(m.seekable.length - 1), end - 2);
    else return;
    if (m.paused) m.play().catch(() => {});
  };
  let lastNowPlaying = "";
  const reportNowPlaying = later(() => {
    const el = pickMedia();
    const md = session && session.metadata;
    let state = null;
    if (el) {
      const duration = positionState?.duration ?? el.duration;
      const sessionState = session ? session.playbackState : "none";
      const elementState = el.paused || el.ended ? "paused" : "playing";
      state = {
        frame,
        title: md?.title || document.title || "",
        artist: md?.artist || "",
        album: md?.album || "",
        artwork: artworkOf(md),
        playbackState: sessionState !== "none" ? sessionState : elementState,
        position: positionState?.position ?? el.currentTime,
        duration: Number.isFinite(duration) ? duration : null,
        playbackRate: positionState?.playbackRate ?? el.playbackRate,
        hasVideo: el.tagName === "VIDEO" && el.videoWidth > 0,
        actions: [...actions.keys()],
        live: isLive(el),
      };
      state.liveBehind = state.live ? liveBehind(el) : 0;
    }
    const json = serialize(state && { ...state, position: Math.round(state.position) });
    if (json === lastNowPlaying) return;
    lastNowPlaying = json;
    send("nowPlaying", state && { ...state, timestamp: Date.now() });
  }, 100);
  let blockAutoplay = false;
  const onMediaEvent = (e) => {
    const m = e.target;
    if (!(m instanceof HTMLMediaElement)) return;
    // Playing is when a live stream's end is seen moving.
    if (e.type === "timeupdate") {
      if (liveSeen.get(m) !== true && isLive(m)) reportNowPlaying();
      return;
    }
    // Another stream in the same element (YouTube's next video) is measured again.
    if (e.type === "emptied") liveSeen.delete(m);
    if (blockAutoplay && e.type === "play" && !(navigator.userActivation && navigator.userActivation.hasBeenActive)) {
      m.pause();
      return;
    }
    if (e.type === "play" || e.type === "playing") active = m;
    // Unmuting a playing video is when it's first heard.
    const firstHeard = hear(m);
    if (m === document.pictureInPictureElement) reportPip();
    reportAudible();
    if (e.type !== "volumechange" || firstHeard) reportNowPlaying();
  };
  document.addEventListener(
    "enterpictureinpicture",
    (e) => {
      send("pip", { active: true, kind: "video" });
      watchPip(e.target);
    },
    true,
  );
  document.addEventListener(
    "leavepictureinpicture",
    () => {
      send("pip", { active: false, kind: "video" });
      unwatchPip();
    },
    true,
  );
  const mediaEvents = ["play", "playing", "pause", "ended", "volumechange", "emptied", "seeked", "ratechange", "loadedmetadata", "timeupdate"];
  for (const e of mediaEvents) document.addEventListener(e, onMediaEvent, true);
  // Others that follow media the page never adds to the document (Protected video, below).
  const detachedMediaWatchers = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!tracked.has(this) && !this.isConnected) {
      tracked.add(this);
      for (const e of mediaEvents) this.addEventListener(e, onMediaEvent);
      for (const watch of detachedMediaWatchers) guard(watch)(this);
    }
    return play.apply(this, arguments);
  };
  const QUIET_MS = 3000;
  const audioContexts = new Set();
  const taps = new WeakMap();
  const samples = new Float32Array(256);
  let webAudioUntil = 0;
  let audioPoll = 0;
  function webAudible() {
    return Date.now() < webAudioUntil;
  }
  const pollWebAudio = guard(() => {
    let running = false;
    for (const ctx of audioContexts) {
      if (ctx.state === "closed") audioContexts.delete(ctx);
      if (ctx.state !== "running") continue;
      running = true;
      taps.get(ctx).getFloatTimeDomainData(samples);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
      if (peak > 1e-4) webAudioUntil = Date.now() + QUIET_MS;
    }
    if (!running && !webAudible()) {
      clearInterval(audioPoll);
      audioPoll = 0;
    }
    reportAudible();
  });
  const pollAudio = () => audioPoll || (audioPoll = setInterval(pollWebAudio, 500));
  if (window.AudioNode && window.AudioDestinationNode && window.AudioContext) {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (target, output) {
      const result = connect.apply(this, arguments);
      guard(() => {
        const ctx = target instanceof AudioDestinationNode ? target.context : null;
        if (!(ctx instanceof AudioContext)) return;
        if (!taps.has(ctx)) {
          const tap = ctx.createAnalyser();
          tap.fftSize = samples.length;
          taps.set(ctx, tap);
          audioContexts.add(ctx);
          ctx.addEventListener("statechange", () => (ctx.state === "running" ? pollAudio() : pollWebAudio()));
        }
        connect.call(this, taps.get(ctx), output || 0);
        pollAudio();
      })();
      return result;
    };
  }

  const proto = session && Object.getPrototypeOf(session);
  if (proto) {
    const wrapSetter = (name) => {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (!d || !d.set) return;
      Object.defineProperty(proto, name, {
        ...d,
        set(value) {
          d.set.call(this, value);
          reportNowPlaying();
        },
      });
    };
    wrapSetter("metadata");
    wrapSetter("playbackState");
    const setActionHandler = proto.setActionHandler;
    proto.setActionHandler = function (action, handler) {
      if (action === "enterpictureinpicture") send("pipTrace", { event: "setActionHandler", action, set: !!handler });
      const result = setActionHandler.apply(this, arguments);
      if (handler) actions.set(action, handler);
      else actions.delete(action);
      reportNowPlaying();
      return result;
    };
    const setPositionState = proto.setPositionState;
    proto.setPositionState = function (state) {
      positionState = state || null;
      reportNowPlaying();
      return setPositionState.apply(this, arguments);
    };
  }
  handlers.media = ({ action, seconds }) => {
    const el = pickMedia();
    const call = (name, details) => {
      const h = actions.get(name);
      if (!h) return false;
      h({ action: name, ...details });
      return true;
    };
    const playing = session?.playbackState === "playing" || (el && !el.paused);
    switch (action) {
      case "play":
        if (!call("play")) el?.play();
        break;
      case "pause":
        if (!call("pause")) el?.pause();
        break;
      case "toggle":
        if (playing) {
          if (!call("pause")) el?.pause();
        } else if (!call("play")) el?.play();
        break;
      case "next":
        call("nexttrack");
        break;
      case "previous":
        call("previoustrack");
        break;
      case "seekBy": {
        const handled = seconds >= 0 ? call("seekforward", { seekOffset: seconds }) : call("seekbackward", { seekOffset: -seconds });
        if (!handled && el) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + seconds));
        break;
      }
      case "seekTo":
        if (!call("seekto", { seekTime: seconds }) && el) el.currentTime = seconds;
        break;
      case "stop":
        if (!call("stop")) el?.pause();
        break;
      case "enterpictureinpicture":
        call("enterpictureinpicture");
        break;
      case "seekToLive":
        if (el) goLive(el);
        break;
    }
    reportNowPlaying();
  };

  // MARK: Picture in Picture — what the floating window's speed, subtitles and Live controls show, and the choices
  // made there (NNCorePictureInPicture.mm). Chrome's window shows only the video's frames, so the subtitles it draws
  // come from here: the chosen track's cues, or YouTube's own subtitles from its player.
  let pipVideo = null;
  let pipCues = null;
  let pipTimer = 0;
  let lastPip = "";
  const youTubeTracks = (player) => {
    const listed = player.getOption("captions", "tracklist");
    if (isArray(listed) && listed.length) return listed.map((t) => ({ label: t.displayName || t.languageName || t.languageCode, track: t }));
    const response = typeof player.getPlayerResponse === "function" ? player.getPlayerResponse() : null;
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!isArray(tracks)) return [];
    return tracks.map((t) => ({
      label: t.name?.simpleText || t.name?.runs?.map((r) => r.text).join("") || t.languageCode,
      track: { languageCode: t.languageCode, ...(t.kind ? { kind: t.kind } : {}), ...(t.vssId ? { vss_id: t.vssId } : {}) },
    }));
  };
  const sameYouTubeTrack = (a, b) =>
    !!b?.languageCode && (a.vss_id && b.vss_id ? a.vss_id === b.vss_id : a.languageCode === b.languageCode && (a.kind || "") === (b.kind || ""));
  const textTracks = (v) => [...v.textTracks].filter((t) => t.kind === "subtitles" || t.kind === "captions");
  const subtitlesOf = (v) => {
    const player = youTubePlayer(v);
    if (player) {
      try {
        const list = youTubeTracks(player);
        const current = player.getOption("captions", "track");
        return { player, list, tracks: list.map((t) => t.label), selected: list.findIndex((t) => sameYouTubeTrack(t.track, current)) };
      } catch {}
    }
    const list = textTracks(v);
    return { list, tracks: list.map((t, i) => t.label || t.language || `Track ${i + 1}`), selected: list.findIndex((t) => t.mode === "showing") };
  };
  const cueText = (subtitles) => {
    if (subtitles.selected < 0) return "";
    if (subtitles.player) {
      const lines = subtitles.player.querySelectorAll(".ytp-caption-window-container .caption-visual-line");
      return [...lines]
        .map((line) => line.textContent.trim())
        .filter(Boolean)
        .join("\n");
    }
    const cues = subtitles.list[subtitles.selected].activeCues;
    return [...(cues || [])]
      .map((cue) => (typeof cue.getCueAsHTML === "function" ? cue.getCueAsHTML().textContent : cue.text || "").trim())
      .filter(Boolean)
      .join("\n");
  };
  const reportPip = later(() => {
    const v = document.pictureInPictureElement;
    if (!v || v !== pipVideo) return;
    const subtitles = subtitlesOf(v);
    const live = isLive(v);
    const state = {
      rate: v.playbackRate,
      tracks: subtitles.tracks,
      selected: subtitles.selected,
      cue: cueText(subtitles),
      live,
      endless: v.duration === Infinity,
      behind: live ? liveBehind(v) : 0,
    };
    const json = serialize(state);
    if (json === lastPip) return;
    lastPip = json;
    send("pipState", state);
  }, 50);
  const cuesWatched = new WeakSet();
  const watchTracks = () => {
    for (const t of pipVideo ? pipVideo.textTracks : []) {
      if (cuesWatched.has(t)) continue;
      cuesWatched.add(t);
      t.addEventListener("cuechange", reportPip);
    }
    reportPip();
  };
  function watchPip(v) {
    if (!(v instanceof HTMLVideoElement)) return;
    unwatchPip();
    pipVideo = v;
    lastPip = "";
    for (const type of ["addtrack", "removetrack", "change"]) v.textTracks.addEventListener(type, watchTracks);
    watchTracks();
    // YouTube's subtitles are its own elements, and a live stream falls further behind while paused.
    const player = youTubePlayer(v);
    if (player) {
      pipCues = new MutationObserver(reportPip);
      pipCues.observe(player, { subtree: true, childList: true, characterData: true });
    }
    pipTimer = setInterval(reportPip, 1000);
  }
  function unwatchPip() {
    if (!pipVideo) return;
    for (const type of ["addtrack", "removetrack", "change"]) pipVideo.textTracks.removeEventListener(type, watchTracks);
    pipCues?.disconnect();
    clearInterval(pipTimer);
    pipVideo = pipCues = null;
  }
  handlers.pip = ({ action, value }) => {
    const v = document.pictureInPictureElement;
    if (!v || v !== pipVideo) return;
    if (action === "rate" && typeof value === "number" && value >= 0.25 && value <= 4) {
      const player = youTubePlayer(v);
      if (player && typeof player.setPlaybackRate === "function") player.setPlaybackRate(value);
      else v.playbackRate = value;
    } else if (action === "subtitles" && typeof value === "number") {
      const { player, list } = subtitlesOf(v);
      const chosen = list[value];
      if (!player) {
        for (const t of list) t.mode = t === chosen ? "showing" : "disabled";
      } else if (chosen) {
        player.loadModule?.("captions");
        player.setOption("captions", "track", chosen.track);
      } else {
        player.unloadModule?.("captions");
      }
    } else if (action === "live") goLive(v);
    reportPip();
  };

  // MARK: Password reveal — an eye button in a focused password field the user
  // Reveal only user-typed passwords; never expose saved passwords.
  const typedByUser = new WeakSet();
  let revealedField = null;
  let eyeField = null;
  let eyeHost = null;
  let eyeButton = null;
  const isPassword = (el) => el.type === "password" || el === revealedField;
  const EYE =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2.1"/></svg>';
  const EYE_SLASH =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8A6.6 6.6 0 0 1 8 3.5c4.1 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M4.3 4.9C2.5 6.1 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.2 0 2.3-.4 3.2-.9"/><path d="M6.6 6.6a2.1 2.1 0 0 0 2.8 2.8"/><path d="M2 2l12 12"/></svg>';
  const hasOwnToggle = (el) => {
    for (let n = el.parentElement, depth = 0; n && depth < 3 && n.querySelectorAll("input").length === 1; n = n.parentElement, depth++)
      for (const c of n.querySelectorAll('button, [role="button"], [aria-label], [title], [class*="eye" i], [class*="toggle" i]'))
        if (
          c !== el &&
          /show|hide|reveal|toggle|visib|eye|peek|afficher|mostrar|anzeigen/i.test(
            (c.getAttribute("aria-label") || "") + " " + (c.getAttribute("title") || "") + " " + (c.getAttribute("class") || ""),
          )
        )
          return true;
    return false;
  };
  const placeEye = () => {
    if (!eyeHost || !eyeField) return;
    const r = eyeField.getBoundingClientRect();
    const cs = getComputedStyle(eyeField);
    const size = Math.min(24, Math.max(18, r.height - 8));
    const inset = Math.max(4, Math.min(10, parseFloat(cs.paddingRight) || 4));
    eyeHost.style.left = r.right - (parseFloat(cs.borderRightWidth) || 0) - inset - size + "px";
    eyeHost.style.top = r.top + (r.height - size) / 2 + "px";
    eyeButton.style.width = eyeButton.style.height = size + "px";
    eyeButton.style.color = cs.color;
  };
  const hideEye = () => {
    if (eyeHost) eyeHost.style.display = "none";
    eyeField = null;
  };
  const conceal = () => {
    const el = revealedField;
    if (!el) return;
    revealedField = null;
    if (el.type === "text") el.type = "password";
    if (eyeButton) eyeButton.innerHTML = EYE;
  };
  const ensureEye = () => {
    if (eyeHost && eyeHost.isConnected) return;
    eyeHost = document.createElement("bay-reveal");
    eyeHost.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none;";
    const root = eyeHost.attachShadow({ mode: "closed" });
    root.innerHTML =
      "<style>button{all:initial;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:5px;cursor:default;opacity:.55;transition:opacity .12s,background-color .12s}" +
      "button:hover{opacity:.85;background:color-mix(in srgb,currentColor 9%,transparent)}button:active{background:color-mix(in srgb,currentColor 16%,transparent)}</style>" +
      '<button type="button" tabindex="-1"></button>';
    eyeButton = root.querySelector("button");
    eyeButton.innerHTML = EYE;
    eyeButton.addEventListener("mousedown", (e) => e.preventDefault());
    eyeButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = eyeField;
      if (!el) return;
      const [start, end] = [el.selectionStart, el.selectionEnd];
      if (revealedField === el) conceal();
      else {
        revealedField = el;
        el.type = "text";
        eyeButton.innerHTML = EYE_SLASH;
      }
      eyeButton.title = revealedField ? "Hide password" : "Show password";
      el.focus();
      try {
        el.setSelectionRange(start, end);
      } catch {}
    });
    eyeButton.title = "Show password";
    document.documentElement.appendChild(eyeHost);
  };
  const updateEye = guard(() => {
    const el = document.activeElement;
    const show = el instanceof HTMLInputElement && isPassword(el) && el.value && typedByUser.has(el) && el.getBoundingClientRect().width >= 80;
    if (!show) return hideEye();
    if (eyeField !== el && hasOwnToggle(el)) return hideEye();
    ensureEye();
    eyeField = el;
    eyeHost.style.display = "block";
    placeEye();
  });
  document.addEventListener(
    "input",
    guard((e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || !isPassword(el)) return;
      if (!el.value) typedByUser.delete(el);
      else if (e.isTrusted) typedByUser.add(el);
      updateEye();
    }),
    true,
  );
  document.addEventListener("focusin", updateEye, true);
  document.addEventListener(
    "focusout",
    guard((e) => {
      setTimeout(() => {
        if (document.activeElement === e.target) return;
        if (revealedField === e.target) conceal();
        updateEye();
      }, 0);
    }),
    true,
  );
  document.addEventListener("submit", conceal, true);
  document.addEventListener("keydown", (e) => e.key === "Enter" && conceal(), true);
  document.addEventListener(
    "click",
    (e) => {
      const b = e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]');
      if (b && eyeHost && !eyeHost.contains(b)) conceal();
    },
    true,
  );
  addEventListener("scroll", () => eyeField && requestAnimationFrame(placeEye), { passive: true, capture: true });
  addEventListener("resize", () => eyeField && requestAnimationFrame(placeEye));
  addEventListener("pagehide", conceal);

  // MARK: Notifications — shown by the app (macOS notifications that open the
  // Wait a microtask so Blink installs Notification before page scripts.
  const installNotifications = () => {
    const NativeNotification = window.Notification;
    if (!NativeNotification || NativeNotification.__nn) return !!NativeNotification;
    const live = new Map();
    let seq = 0;
    const show = (title, options) => {
      options = options || {};
      const id = frame + ":" + ++seq;
      const icon = options.icon ? absolute(String(options.icon)) : null;
      if (options.tag)
        for (const [otherId, n] of live)
          if (n.tag === String(options.tag)) {
            live.delete(otherId);
            n._fire("close");
          }
      send("notification", {
        id,
        title: String(title),
        body: options.body == null ? "" : String(options.body),
        icon,
        tag: options.tag == null ? "" : String(options.tag),
        silent: !!options.silent,
        requireInteraction: !!options.requireInteraction,
      });
      return id;
    };
    class PageNotification extends EventTarget {
      constructor(title, options) {
        if (!new.target) throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator.");
        if (arguments.length < 1) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
        super();
        options = options || {};
        const fields = {
          title: String(title),
          body: String(options.body ?? ""),
          tag: String(options.tag ?? ""),
          icon: String(options.icon ?? ""),
          data: options.data ?? null,
          silent: !!options.silent,
          requireInteraction: !!options.requireInteraction,
          dir: options.dir || "auto",
          lang: options.lang || "",
        };
        for (const [k, v] of Object.entries(fields)) Object.defineProperty(this, k, { value: v, enumerable: true });
        this.onclick = this.onshow = this.onclose = this.onerror = null;
        Object.defineProperty(this, "_fire", {
          value: (type) => {
            const event = new Event(type, { cancelable: type === "click" });
            const handler = this["on" + type];
            if (typeof handler === "function") guard(handler).call(this, event);
            this.dispatchEvent(event);
            return event;
          },
        });
        if (NativeNotification.permission !== "granted") {
          setTimeout(() => this._fire("error"), 0);
          return;
        }
        const id = show(title, options);
        live.set(id, this);
        Object.defineProperty(this, "_id", { value: id });
        setTimeout(() => this._fire("show"), 0);
      }
      close() {
        if (!this._id || !live.has(this._id)) return;
        live.delete(this._id);
        send("notificationClose", { id: this._id });
        setTimeout(() => this._fire("close"), 0);
      }
      static get permission() {
        return NativeNotification.permission;
      }
      static requestPermission(callback) {
        return NativeNotification.requestPermission(callback);
      }
      static get maxActions() {
        return NativeNotification.maxActions || 0;
      }
    }
    Object.defineProperty(PageNotification, "name", { value: "Notification" });
    Object.defineProperty(PageNotification, "__nn", { value: true });
    window.Notification = PageNotification;
    const Registration = window.ServiceWorkerRegistration;
    if (Registration && Registration.prototype.showNotification) {
      Registration.prototype.showNotification = function (title, options) {
        if (NativeNotification.permission !== "granted") return Promise.reject(new TypeError("No notification permission has been granted for this origin."));
        show(title, options);
        return Promise.resolve();
      };
    }
    handlers.notification = ({ id, action }) => {
      const n = live.get(id);
      if (!n) return;
      if (action === "click") {
        const event = n._fire("click");
        if (!event.defaultPrevented) window.focus();
      } else {
        live.delete(id);
        n._fire("close");
      }
    };
    return true;
  };
  if (!installNotifications()) queueMicrotask(() => installNotifications() || setTimeout(installNotifications, 0));

  // MARK: Screen sharing — getDisplayMedia() through the app's source picker
  const displayRequests = new Map();
  let displaySeq = 0;
  const installDisplayMedia = () => {
    const devices = navigator.mediaDevices;
    const proto = devices && Object.getPrototypeOf(devices);
    if (!proto || !proto.getDisplayMedia || proto.getDisplayMedia.__nn) return;
    const getUserMedia = proto.getUserMedia;
    const getDisplayMedia = function getDisplayMedia(constraints) {
      const self = this;
      return new Promise((resolve, reject) => {
        const id = ++displaySeq;
        displayRequests.set(id, { self, resolve, reject, constraints: constraints || {} });
        send("displayMedia", { id, audio: !!(constraints && constraints.audio) });
      });
    };
    Object.defineProperty(getDisplayMedia, "__nn", { value: true });
    proto.getDisplayMedia = getDisplayMedia;
    handlers.displayMedia = ({ id, sourceId }) => {
      const request = displayRequests.get(id);
      if (!request) return;
      displayRequests.delete(id);
      if (!sourceId) {
        request.reject(new DOMException("Permission denied", "NotAllowedError"));
        return;
      }
      const video = request.constraints.video;
      const frameRate = (video && video.frameRate && (video.frameRate.max || video.frameRate.ideal || video.frameRate)) || 30;
      const tabAudio = !!request.constraints.audio && apply(startsWith, sourceId, ["web-contents-media-stream://"]);
      // The browser allows only the approved source, whatever reaches getUserMedia.
      apply(getUserMedia, request.self, [
        {
          audio: tabAudio ? { mandatory: { chromeMediaSource: "desktop" } } : false,
          video: {
            mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: +frameRate || 30 },
          },
        },
      ]).then(request.resolve, request.reject);
    };
  };

  // Protected video: Chromium here has no Widevine, so a player that needs a DRM system it can't have stalls. Tell the
  // app once (it offers to open the page in WebKit, apps/browser lib/pageEngines.ts) when a refused Widevine, PlayReady
  // or FairPlay request is followed by playback that tried and didn't start, not on a capability check alone.
  try {
    const NavigatorType = window.Navigator;
    const requestAccess = NavigatorType && NavigatorType.prototype.requestMediaKeySystemAccess;
    if (typeof requestAccess === "function") {
      const protectedSystem = /^com\.(widevine\.alpha|microsoft\.playready|apple\.fps)/;
      const { test } = RegExp.prototype;
      const then = Promise.prototype.then;
      const setTimer = window.setTimeout;
      const GRACE_MS = 5000;
      const KEYS_GRACE_MS = 2000;
      const MEDIA_ERR_DECODE = 3;
      let drmSent = false;
      let refused = "";
      const attempted = new Set();
      const needsProtectedPlayback = (keySystem) => {
        if (drmSent) return;
        drmSent = true;
        send("drm", { keySystem });
      };
      const progressed = (m) => m.readyState >= 2 && m.currentTime > 0;
      const anyProgressed = () => [...attempted, ...document.querySelectorAll("video, audio")].some(progressed);
      const after = (ms, fn) => apply(setTimer, window, [guard(fn), ms]);
      const stalled = (m) => !m.paused && !m.ended && !progressed(m);
      const judgeAttempt = (m) =>
        after(GRACE_MS, () => {
          if (refused && stalled(m)) needsProtectedPlayback(refused);
        });
      const onAttempt = (m) => {
        if (attempted.size >= 16) attempted.delete(attempted.values().next().value);
        attempted.add(m);
        judgeAttempt(m);
      };
      const onNeedsKey = (m) =>
        after(KEYS_GRACE_MS, () => {
          if (!m.mediaKeys && !progressed(m)) needsProtectedPlayback(refused);
        });
      const onDrmMediaEvent = (e) => {
        const m = e.target;
        if (drmSent || !(m instanceof HTMLMediaElement)) return;
        if (e.type === "play") onAttempt(m);
        else if (e.type === "encrypted" || e.type === "waitingforkey") onNeedsKey(m);
        else if (e.type === "error" && refused && m.error && m.error.code === MEDIA_ERR_DECODE) needsProtectedPlayback(refused);
      };
      const drmMediaEvents = ["play", "encrypted", "waitingforkey", "error"];
      for (const type of drmMediaEvents) document.addEventListener(type, guard(onDrmMediaEvent), true);
      detachedMediaWatchers.push((m) => {
        for (const type of drmMediaEvents) m.addEventListener(type, guard(onDrmMediaEvent));
      });
      const onRefused = (keySystem, activated) => {
        if (drmSent) return;
        if (!refused) refused = keySystem;
        for (const m of attempted) if (stalled(m)) judgeAttempt(m);
        if (activated)
          after(GRACE_MS, () => {
            if (!anyProgressed()) needsProtectedPlayback(keySystem);
          });
      };
      const wrapped = {
        requestMediaKeySystemAccess(keySystem, _configurations) {
          const result = apply(requestAccess, this, arguments);
          if (!drmSent && typeof keySystem === "string" && apply(test, protectedSystem, [keySystem])) {
            const activated = !!(navigator.userActivation && navigator.userActivation.isActive);
            apply(then, result, [null, () => onRefused(keySystem, activated)]);
          }
          return result;
        },
      }.requestMediaKeySystemAccess;
      Object.defineProperty(NavigatorType.prototype, "requestMediaKeySystemAccess", {
        ...Object.getOwnPropertyDescriptor(NavigatorType.prototype, "requestMediaKeySystemAccess"),
        value: wrapped,
      });
    }
  } catch {}

  // MARK: Content blocker — the classes and ids the document uses, each sent once (batched) for the generic cosmetic
  // filters that hide them (NNCoreContentBlocker.mm), from the moment the browser says the page gets them.
  let cosmeticOn = false;
  const installCosmetic = () => {
    if (cosmeticOn) return;
    cosmeticOn = true;
    const seenClasses = new Set();
    const seenIds = new Set();
    let classes = [];
    let ids = [];
    let queued = false;
    let sent = 0;
    const full = () => seenClasses.size + seenIds.size >= 20000;
    const flush = () => {
      queued = false;
      // Match NNCoreWebView's limit per message, so every discovered name reaches the host.
      for (let offset = 0; offset < Math.max(classes.length, ids.length); offset += 4000) {
        send("cosmetic", { url, classes: classes.slice(offset, offset + 4000), ids: ids.slice(offset, offset + 4000) });
      }
      sent += classes.length + ids.length;
      classes = [];
      ids = [];
    };
    const note = (el) => {
      if (full()) return;
      const id = el.getAttribute("id");
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        ids.push(id);
      }
      const list = el.classList;
      for (let i = 0; list && i < list.length && !full(); i++) {
        if (seenClasses.has(list[i])) continue;
        seenClasses.add(list[i]);
        classes.push(list[i]);
      }
      if (full()) observer.disconnect();
      if (!queued && (classes.length || ids.length)) {
        queued = true;
        // The first names at once (the page is painting), then every 100 ms.
        setTimeout(guard(flush), sent ? 100 : 0);
      }
    };
    const noteTree = (node) => {
      if (node.nodeType !== 1 || full()) return;
      note(node);
      if (node.firstElementChild && !full()) {
        for (const el of node.querySelectorAll("[id],[class]")) {
          note(el);
          if (full()) break;
        }
      }
    };
    const observer = new MutationObserver(
      guard((records) => {
        for (const record of records) {
          if (full()) break;
          if (record.type === "attributes") note(record.target);
          else {
            for (const node of record.addedNodes) {
              noteTree(node);
              if (full()) break;
            }
          }
        }
      }),
    );
    observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] });
    if (document.documentElement) noteTree(document.documentElement);
  };

  // Site rules that require DOM inspection or actions, in adblock-rust's procedural AST format.
  let proceduralOn = false;
  const installProcedural = (encoded) => {
    if (proceduralOn || !isArray(encoded) || !encoded.length) return;
    const unquote = (text) => {
      const value = text.trim();
      if (value[0] !== '"' && value[0] !== "'") return value;
      let result = "";
      for (let n = 1; n < value.length; n++) {
        if (value[n] === value[0]) return n === value.length - 1 ? result : value;
        if (value[n] === "\\" && (value[n + 1] === value[0] || value[n + 1] === "\\")) n++;
        result += value[n];
      }
      return value;
    };
    const pattern = (text, exact = false, quoted = true) => {
      const value = quoted ? unquote(text) : text.trim();
      const regex = /^\/(.*)\/([imu]*)$/.exec(value);
      if (regex) return new RegExp(regex[1], regex[2]);
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(exact ? `^${escaped}$` : escaped);
    };
    const select = (node, selector, first) => {
      if (first || node.nodeType === 9) return [...node.querySelectorAll(selector)];
      if (/^\s*[+~]/.test(selector)) {
        const parent = node.parentElement;
        if (!parent) return [];
        const index = [...parent.children].indexOf(node) + 1;
        return [...parent.querySelectorAll(`:scope > :nth-child(${index})${selector}`)];
      }
      if (/^\s*>/.test(selector)) return [...node.querySelectorAll(`:scope ${selector}`)];
      if (/^\s/.test(selector)) return [...node.querySelectorAll(selector.trim())];
      return node.matches(selector) ? [node] : [];
    };
    const operator = ({ type, arg }, index) => {
      if (typeof arg !== "string") throw new Error("no procedural argument");
      if (type === "css-selector") return (nodes) => nodes.flatMap((node) => select(node, arg, index === 0));
      if (type === "has-text") {
        const regex = pattern(arg);
        return (nodes) => nodes.filter((node) => regex.test(node.textContent));
      }
      if (type === "min-text-length") {
        const min = Number(arg);
        if (!Number.isInteger(min) || min < 0) throw new Error("invalid text length");
        return (nodes) => nodes.filter((node) => node.textContent.length >= min);
      }
      if (type === "matches-path") {
        const regex = pattern(arg.replace(/\P{ASCII}/gu, (c) => encodeURIComponent(c)));
        return (nodes) => (regex.test(location.pathname + location.search) ? nodes : []);
      }
      if (type === "matches-attr") {
        const attribute = unquote(arg);
        const equal = attribute.indexOf("=");
        const name = pattern(equal < 0 ? attribute : attribute.slice(0, equal), true);
        const value = equal < 0 ? null : pattern(attribute.slice(equal + 1), true);
        return (nodes) => nodes.filter((node) => node.getAttributeNames?.().some((key) => name.test(key) && (!value || value.test(node.getAttribute(key)))));
      }
      if (["matches-css", "matches-css-before", "matches-css-after"].includes(type)) {
        const before = /^(before|after),\s*/.exec(arg);
        const declaration = before ? arg.slice(before[0].length) : arg;
        const colon = declaration.indexOf(":");
        if (colon <= 0) throw new Error("invalid CSS match");
        const property = declaration.slice(0, colon).trim();
        const regex = pattern(declaration.slice(colon + 1), true, false);
        const pseudoFor = { "matches-css": null, "matches-css-before": "::before", "matches-css-after": "::after" };
        const pseudo = before ? `::${before[1]}` : pseudoFor[type];
        return (nodes) => nodes.filter((node) => node.nodeType === 1 && regex.test(getComputedStyle(node, pseudo).getPropertyValue(property)));
      }
      if (type === "upward") {
        if (/^\d+$/.test(arg.trim())) {
          const count = Number(arg);
          if (count < 1 || count > 255) throw new Error("invalid ancestor count");
          return (nodes) =>
            nodes.flatMap((node) => {
              for (let n = 0; node && n < count; n++) node = node.parentElement;
              return node ? [node] : [];
            });
        }
        return (nodes) =>
          nodes.flatMap((node) => {
            const parent = node.parentElement?.closest(arg);
            return parent ? [parent] : [];
          });
      }
      if (type === "xpath") {
        const expression = document.createExpression(arg, null);
        return (nodes) =>
          nodes.flatMap((node) => {
            const result = expression.evaluate(node, 6, null); // UNORDERED_NODE_SNAPSHOT_TYPE
            const matches = [];
            for (let n = 0; n < result.snapshotLength; n++) {
              const item = result.snapshotItem(n);
              if (item?.nodeType === 1) matches.push(item);
            }
            return matches;
          });
      }
      throw new Error("unknown procedural operator");
    };
    const rules = [];
    for (const entry of encoded) {
      try {
        const rule = typeof entry === "string" ? fromJSON(entry) : entry;
        if (!isArray(rule?.selector) || !rule.selector.length) continue;
        const action = rule.action || { type: "style", arg: "display:none!important" };
        if (!["style", "remove", "remove-attr", "remove-class"].includes(action.type)) continue;
        if (action.type !== "remove" && typeof action.arg !== "string") continue;
        const probe = document.createElement("span");
        const styles = [];
        if (action.type === "style") {
          probe.style.cssText = action.arg;
          for (let n = 0; n < probe.style.length; n++) {
            const name = probe.style[n];
            styles.push([name, probe.style.getPropertyValue(name), probe.style.getPropertyPriority(name)]);
          }
        }
        rules.push({ operators: rule.selector.map(operator), action, styles, applied: new Map() });
      } catch {}
    }
    if (!rules.length) return;
    proceduralOn = true;
    let queued = false;
    const options = { childList: true, subtree: true, attributes: true, characterData: true };
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(guard(run), 100);
    });
    const run = () => {
      queued = false;
      // Actions mutate the observed DOM too. Disconnect while applying them to avoid scheduling ourselves forever.
      observer.disconnect();
      try {
        for (const rule of rules) {
          try {
            let nodes = [document];
            for (const next of rule.operators) nodes = next(nodes);
            const targets = new Set(nodes.filter((node) => node.nodeType === 1));
            for (const [node, previous] of rule.applied) {
              if (targets.has(node)) continue;
              for (const [name, value, priority, ownedValue, ownedPriority] of previous) {
                if (node.style.getPropertyValue(name) !== ownedValue || node.style.getPropertyPriority(name) !== ownedPriority) continue;
                if (value) node.style.setProperty(name, value, priority);
                else node.style.removeProperty(name);
              }
              rule.applied.delete(node);
            }
            for (const node of targets) {
              if (rule.action.type === "remove") node.remove();
              else if (rule.action.type === "remove-attr") node.removeAttribute(rule.action.arg);
              else if (rule.action.type === "remove-class") node.classList.remove(rule.action.arg);
              else {
                if (!rule.applied.has(node)) {
                  rule.applied.set(
                    node,
                    rule.styles.map(([name, value, priority]) => [
                      name,
                      node.style.getPropertyValue(name),
                      node.style.getPropertyPriority(name),
                      value,
                      priority,
                    ]),
                  );
                }
                for (const [name, value, priority] of rule.styles) node.style.setProperty(name, value, priority);
              }
            }
          } catch {}
        }
      } finally {
        observer.observe(document, options);
      }
    };
    run();
    // SPA navigations can change :matches-path() without changing the DOM.
    if (window.navigation)
      window.navigation.addEventListener("navigatesuccess", () => {
        if (!queued) {
          queued = true;
          setTimeout(guard(run), 0);
        }
      });
  };

  handlers.config = (config) => {
    blockAutoplay = !!config.blockAutoplay;
    if (config.displayMediaPicker) installDisplayMedia();
    if (config.cosmetic) installCosmetic();
    installProcedural(config.procedural);
  };
  send("hello", { top: isTop, url });

  const receive = (kind, json) => {
    const handler = handlers[kind];
    if (handler) guard(handler)(fromJSON(json));
  };
  if (!isTop) return receive;

  // MARK: Theme color — <meta name="theme-color">, else the colour at the top of
  const parse = (css) => {
    const m = css && css.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    return { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] };
  };
  const hex = (c) =>
    "#" +
    [c.r, c.g, c.b]
      .map((n) => Math.round(n).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  const normalize = (value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    if (!probe.style.color) return null;
    // A cached literal must normalize independently of author rules such as `span { color: ... !important }`.
    if (staticColor(value)) probe.style.setProperty("color", value, "important");
    document.documentElement.appendChild(probe);
    const c = parse(getComputedStyle(probe).color);
    probe.remove();
    return c && c.a > 0 ? hex(c) : null;
  };
  // Only absolute literals are reusable. Variables, currentColor, system colours and
  // expressions such as light-dark() must resolve against the page on every sample.
  const namedColors = new Set(
    (
      "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
      "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
      "deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon " +
      "lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
      "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato transparent turquoise violet wheat white whitesmoke yellow yellowgreen"
    ).split(" "),
  );
  const staticColor = (value) => namedColors.has(value.toLowerCase()) || /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?)\([\d\s.,%+/-]+\))$/i.test(value);
  let normalizedMetaColors = new WeakMap();
  const themeMedia = new Map();
  const metaColor = () => {
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    const mediaQueries = new Set(Array.from(metas, (m) => m.getAttribute("media")).filter(Boolean));
    for (const [media, query] of themeMedia) {
      if (mediaQueries.has(media)) continue;
      query.removeEventListener("change", invalidateTheme);
      themeMedia.delete(media);
    }
    for (const media of mediaQueries) {
      if (themeMedia.has(media)) continue;
      const query = matchMedia(media);
      query.addEventListener("change", invalidateTheme);
      themeMedia.set(media, query);
    }
    for (const m of metas) {
      const media = m.getAttribute("media");
      if (!media || themeMedia.get(media).matches) {
        const value = (m.getAttribute("content") || "").trim();
        const cached = normalizedMetaColors.get(m);
        const c = cached && cached.value === value ? cached.color : normalize(value);
        if ((!cached || cached.value !== value) && staticColor(value)) normalizedMetaColors.set(m, { value, color: c });
        if (c) return c;
      }
    }
    return null;
  };
  const backgroundOf = (el) => el && parse(getComputedStyle(el).backgroundColor);
  const pageBackground = () => {
    for (const el of [document.body, document.documentElement]) {
      const c = backgroundOf(el);
      if (c && c.a > 0) return c;
    }
    const dark = /dark/.test(getComputedStyle(document.documentElement).colorScheme) && matchMedia("(prefers-color-scheme: dark)").matches;
    return dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  };
  const blend = (c, under) =>
    c.a >= 1 ? c : { r: c.r * c.a + under.r * (1 - c.a), g: c.g * c.a + under.g * (1 - c.a), b: c.b * c.a + under.b * (1 - c.a), a: 1 };
  const headerColor = (page) => {
    const scrolled = window.scrollY > 4;
    for (const x of [innerWidth / 2, innerWidth * 0.2, innerWidth * 0.8]) {
      let pinned = false;
      let color = null;
      for (let el = document.elementFromPoint(x, 1); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.position === "sticky") pinned = true;
        if (!color) {
          const c = parse(cs.backgroundColor);
          if (c && c.a >= 0.5) color = c;
        }
        if (color && pinned) break;
      }
      if (color && (pinned || !scrolled)) return blend(color, page);
    }
    return null;
  };
  let lastTheme;
  let lastThemeSample = -Infinity;
  const reportTheme = guard(() => {
    if (!document.documentElement) return;
    lastThemeSample = performance.now();
    let color = metaColor();
    let source = color ? "meta" : null;
    if (!color && document.body) {
      const page = pageBackground();
      const header = headerColor(page);
      color = hex(header || page);
      source = header ? "header" : "background";
    }
    const key = color + source;
    if (key === lastTheme) return;
    lastTheme = key;
    send("theme", { color, source });
  });
  let themeQueued = false;
  const scheduleTheme = () => {
    if (themeQueued) return;
    themeQueued = true;
    requestAnimationFrame(() => {
      themeQueued = false;
      reportTheme();
    });
  };
  const invalidateTheme = () => {
    normalizedMetaColors = new WeakMap();
    scheduleTheme();
  };
  const SCROLL_THEME_INTERVAL = 100;
  let scrollThemeTimer;
  const scheduleScrollTheme = () => {
    if (performance.now() - lastThemeSample >= SCROLL_THEME_INTERVAL) scheduleTheme();
    clearTimeout(scrollThemeTimer);
    // Keep a trailing sample even when the last scroll fell inside the interval.
    scrollThemeTimer = setTimeout(scheduleTheme, SCROLL_THEME_INTERVAL);
  };
  const startTheme = () => {
    reportTheme();
    const observer = new MutationObserver(invalidateTheme);
    observer.observe(document.head || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["content", "media", "name", "href", "rel", "disabled"],
    });
    for (const el of [document.documentElement, document.body])
      if (el) observer.observe(el, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    for (const ms of [300, 1000, 3000]) setTimeout(invalidateTheme, ms);
  };
  onReady(startTheme);
  // The app forgets a document's colour when another one commits (NNCoreWebView tabDidCommitDocument:): a page back from
  // the back/forward cache, or a prerendered page shown, says again what it last said.
  const resendTheme = () => {
    lastTheme = undefined;
    normalizedMetaColors = new WeakMap();
    reportTheme();
  };
  addEventListener("pageshow", (e) => e.persisted && resendTheme());
  document.addEventListener("prerenderingchange", resendTheme);
  addEventListener("load", invalidateTheme);
  addEventListener("scroll", scheduleScrollTheme, { passive: true, capture: true });
  addEventListener("resize", invalidateTheme);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", invalidateTheme);

  // MARK: Pinch zoom (visual viewport scale), for the zoom indicator.
  if (window.visualViewport) {
    let lastScale = 1;
    visualViewport.addEventListener("resize", () => {
      const scale = Math.round(visualViewport.scale * 100) / 100;
      if (scale === lastScale) return;
      lastScale = scale;
      send("pinch", { scale });
    });
  }

  // MARK: Selected text — a mouse selection of page text (not in a text field)
  let selectionShown = false;
  let selecting = false;
  const hideSelection = () => {
    if (!selectionShown) return;
    selectionShown = false;
    send("selection", null);
  };
  const editableSelection = (sel) => {
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return true;
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!el && el.isContentEditable;
  };
  const reportSelection = guard(() => {
    const sel = getSelection();
    const text = sel && !sel.isCollapsed && sel.rangeCount ? sel.toString().trim() : "";
    const pinched = window.visualViewport && visualViewport.scale !== 1;
    if (!text || pinched || editableSelection(sel)) return hideSelection();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return hideSelection();
    selectionShown = true;
    send("selection", { text: text.slice(0, 2000), rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  });
  document.addEventListener(
    "mousedown",
    (e) => {
      selecting = e.button === 0;
      hideSelection();
    },
    true,
  );
  document.addEventListener(
    "mouseup",
    (e) => {
      if (e.button !== 0 || !selecting) return;
      selecting = false;
      setTimeout(reportSelection, 0);
    },
    true,
  );
  document.addEventListener("selectionchange", () => selectionShown && !selecting && getSelection().isCollapsed && hideSelection());
  document.addEventListener("keydown", (e) => primaryModifier(e) || /^(Shift|Meta|Alt|Control)$/.test(e.key) || hideSelection(), true);
  addEventListener("scroll", hideSelection, { passive: true, capture: true });
  addEventListener("resize", hideSelection);
  addEventListener("pagehide", hideSelection);

  // MARK: Capture — the primary modifier plus Shift and a drag starts Capture where it was pressed: the app puts its own
  // selection in the page, which goes on with the drag (apps/browser components/capture/captureScript.ts). Until then
  // the page gets neither the press nor the click it ends in (⌘⇧-click on a link would open it).
  if (isTop) {
    let swallowClick = false;
    const swallow = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    addEventListener(
      "mousedown",
      (e) => {
        swallowClick = false;
        if (!e.isTrusted || e.button !== 0 || !primaryModifier(e) || !e.shiftKey || e.altKey || secondaryModifier(e)) return;
        swallow(e);
        swallowClick = true;
        send("captureGesture", { x: e.clientX, y: e.clientY });
      },
      true,
    );
    for (const type of ["click", "auxclick"])
      addEventListener(
        type,
        (e) => {
          if (!swallowClick) return;
          swallowClick = false;
          swallow(e);
        },
        true,
      );
  }

  // MARK: Link previews — Shift-hover a link for 5 seconds (Arc Max). Send the link after 5 s of hovering while Shift
  // is held; the app shows a summary card with Open, Peek and Copy.
  let linkPreviewTimer = null;
  let linkPreviewTarget = null;
  const clearLinkPreview = () => {
    if (linkPreviewTimer) {
      clearTimeout(linkPreviewTimer);
      linkPreviewTimer = null;
    }
    linkPreviewTarget = null;
  };
  const armLinkPreview = (a) => {
    // Moving across a link's own children (an icon, a span) keeps its timer, and a shown preview isn't sent again.
    if (a === linkPreviewTarget) return;
    clearLinkPreview();
    const url = a && a.href;
    if (!url || !/^https?:/i.test(url)) return;
    linkPreviewTarget = a;
    linkPreviewTimer = setTimeout(() => {
      if (linkPreviewTarget !== a) return;
      linkPreviewTimer = null;
      // Where the link is now: the page may have scrolled in the 5 s.
      const r = a.getBoundingClientRect();
      send("linkPreview", { url, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    }, 5000);
  };
  const linkUnder = (node) => (node && node.closest ? node.closest("a[href]") : null);
  document.addEventListener(
    "mouseover",
    (e) => {
      if (!e.isTrusted || !e.shiftKey) return;
      const a = linkUnder(e.target);
      if (!a) return;
      armLinkPreview(a);
    },
    true,
  );
  document.addEventListener(
    "mouseout",
    (e) => {
      const a = linkUnder(e.target);
      if (a && a === linkPreviewTarget && !a.contains(e.relatedTarget)) clearLinkPreview();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Shift") return;
      const a = linkUnder(document.elementFromPoint?.(lastMouseX, lastMouseY) || null);
      // Fall back to the currently hovered element tracked by mousemove.
      const target = a || hoveredLink;
      if (target && !e.repeat) armLinkPreview(target);
    },
    true,
  );
  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "Shift") clearLinkPreview();
    },
    true,
  );
  let lastMouseX = 0,
    lastMouseY = 0,
    hoveredLink = null;
  document.addEventListener(
    "mousemove",
    (e) => {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      hoveredLink = linkUnder(e.target);
      if (!e.shiftKey) clearLinkPreview();
    },
    true,
  );

  // MARK: Scroll direction, for the toolbar that tucks away while you read (tabs on top). From the page's real scroll
  // (the document, or an element scroller filling most of the window), not wheel deltas, and only while the user is
  // scrolling (wheel, keys, a press or a scrollbar drag in the last second): scroll restoration or a chat scrolling
  // itself doesn't hide the bar. "down" once a gesture has gone DOWN px down, "up" after UP px back, "top" at the top.
  // A page with under MIN_RANGE px to scroll never hides it (the bar's own height could make it unscrollable). Hiding
  // or showing the bar resizes the viewport, which can move the scroll position (the clamp at the bottom, scroll
  // anchoring): for SETTLE ms the anchor absorbs up to the viewport's change, so that move can't flip the bar back and
  // forth while a real scroll still counts. Sent on a change, and "down" again at the start of a gesture (the app
  // shows the bar on its own: tab switch, navigation, a click on the strip).
  const scrollDirection = () => {
    const DOWN = 24,
      UP = 12,
      MIN_RANGE = 120,
      SETTLE = 300,
      GESTURE = 300;
    let anchor = 0,
      last = 0,
      lastAt = -1e9,
      settleUntil = -1e9,
      budget = 0,
      height = 0,
      sent = null,
      gestureSent = false;
    const resized = (viewport, now) => {
      if (now >= settleUntil) budget = 0;
      if (height && viewport !== height) {
        settleUntil = now + SETTLE;
        budget += Math.abs(viewport - height) + 2;
      }
      height = viewport;
    };
    return {
      resized,
      rebase(y) {
        anchor = last = y;
      },
      scrolled(y, range, viewport, now, user) {
        resized(viewport, now);
        if (now - lastAt > GESTURE) {
          gestureSent = false;
          anchor = last;
        }
        lastAt = now;
        const moved = y - last;
        last = y;
        if (budget > 0 && moved) {
          const absorbed = Math.min(budget, Math.abs(moved));
          budget -= absorbed;
          anchor += moved > 0 ? absorbed : -absorbed;
        }
        let state = null;
        if (y <= 2) state = "top";
        else if (!user) anchor = y;
        else if (y - anchor >= DOWN) {
          if (range >= MIN_RANGE) state = "down";
          else anchor = y;
        } else if (anchor - y >= UP) state = "up";
        else if (sent === "down" ? gestureSent && y > anchor : y < anchor) anchor = y;
        if (state) anchor = y;
        if (!state || (state === sent && (state !== "down" || gestureSent))) return null;
        sent = state;
        if (state === "down") gestureSent = true;
        return state;
      },
    };
  };
  const direction = scrollDirection();
  let scroller = null;
  let scrollTarget = null;
  let inputAt = -1e9;
  const noteInput = () => {
    inputAt = performance.now();
    // The document's position before the first scroll, so a single jump (End, Space) counts.
    if (!scroller && document.scrollingElement) direction.rebase((scroller = document.scrollingElement).scrollTop);
  };
  for (const type of ["wheel", "keydown", "mousedown", "touchstart"]) addEventListener(type, noteInput, { passive: true, capture: true });
  addEventListener("mousemove", (e) => e.buttons && noteInput(), { passive: true, capture: true });
  const measureScroll = guard(() => {
    const target = scrollTarget;
    scrollTarget = null;
    const doc = document.scrollingElement || document.documentElement;
    const el = target === document || target === doc ? doc : target;
    if (!el || !doc || (el !== doc && (el.clientHeight < innerHeight * 0.5 || el.clientWidth < innerWidth * 0.5))) return;
    // Another scroller: measured from here on (its first move only tells the top).
    if (el !== scroller) direction.rebase((scroller = el).scrollTop);
    const now = performance.now();
    const state = direction.scrolled(el.scrollTop, el.scrollHeight - el.clientHeight, innerHeight, now, now - inputAt < 1000);
    if (state) send("scroll", { state });
  });
  addEventListener(
    "scroll",
    (e) => {
      if (!scrollTarget) requestAnimationFrame(measureScroll);
      scrollTarget = e.target;
    },
    { passive: true, capture: true },
  );
  addEventListener("resize", () => direction.resized(innerHeight, performance.now()));

  return receive;
});
