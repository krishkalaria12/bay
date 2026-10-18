import { WindowContext, View } from "@bay/platform";
import { getNativeHostInfo, invokeNative, subscribeNativeEvent } from "@bay/platform/nativeBridge";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "@bay/platform/motion";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { WebView, type WebViewHandle } from "../../../../packages/nncore/src/WebView";

const button: React.CSSProperties = { padding: "7px 10px", border: "1px solid #ffffff30", borderRadius: 7, background: "#ffffff10", color: "inherit", cursor: "pointer" };
const input: React.CSSProperties = { ...button, background: "#0004", cursor: "text", minWidth: 0 };

/** Phase 2 diagnostic, selected only by --bay-hosting-spike or local ?spike. */
function HostingSpike() {
  const info = getNativeHostInfo();
  const preview = info.constants.BayShell?.preview === true;
  const [urls, setURLs] = useState(["https://example.com", "https://example.org"]);
  const [drafts, setDrafts] = useState(urls);
  const [titles, setTitles] = useState(["Waiting for the first page", "Waiting for the second page"]);
  const [overlay, setOverlay] = useState(true);
  const [blur, setBlur] = useState(true);
  const [motion, setMotion] = useState(false);
  const [frames, setFrames] = useState("Not measured");
  const [actionError, setActionError] = useState("");
  const [timing, setTiming] = useState("Not measured");
  const [measuring, setMeasuring] = useState(false);
  const [commands, setCommands] = useState<string[]>([]);
  const address = useRef<HTMLInputElement>(null);
  const pages = useRef<(WebViewHandle | null)[]>([]);
  const progress = useSharedValue(0);
  const motionStyle = useAnimatedStyle(() => ({ transform: [{ translateX: progress.value * 90 }] }));
  useEffect(() => {
    if (!motion || !overlay) {
      cancelAnimation(progress);
      progress.set(0);
      return;
    }
    progress.set(withRepeat(withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.quad) }), -1, true));
    let frame = 0;
    let previous = 0;
    const samples: number[] = [];
    const measureFrame = (timestamp: number) => {
      if (previous) samples.push(timestamp - previous);
      previous = timestamp;
      if (samples.length < 240) frame = requestAnimationFrame(measureFrame);
      else {
        samples.sort((a, b) => a - b);
        setFrames(`Frame intervals: p50 ${samples[119]!.toFixed(1)} ms, p95 ${samples[227]!.toFixed(1)} ms. ${samples.filter(value => value > 25).length}/240 over 25 ms.`);
      }
    };
    setFrames("Sampling 240 animation frame intervals...");
    frame = requestAnimationFrame(measureFrame);
    return () => { cancelAnimation(progress); cancelAnimationFrame(frame); };
  }, [motion, overlay, progress]);
  const pageAction = (action: () => Promise<unknown> | undefined) => {
    setActionError("");
    void Promise.resolve().then(action).catch(error => setActionError(error instanceof Error ? error.message : String(error)));
  };
  useEffect(() => {
    const subscription = subscribeNativeEvent("BayShell", "onCommand", payload => {
      const command = (payload as { command: string }).command;
      setCommands(current => [command, ...current].slice(0, 8));
      if (command === "focusCommandBar" || command === "focusAddress") {
        address.current?.focus();
        address.current?.select();
      }
    });
    return () => subscription.remove();
  }, []);
  const measure = async () => {
    if (measuring) return;
    setMeasuring(true);
    try {
      const samples: number[] = [];
      for (let count = 0; count < 105; ++count) {
        const start = performance.now();
        await invokeNative("BayCEF", "engineInfo");
        if (count >= 5) samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      setTiming(`${preview ? "Fixture, not Mojo. " : ""}p50 ${samples[49]!.toFixed(2)} ms, p95 ${samples[94]!.toFixed(2)} ms`);
    } catch (error) {
      setTiming(error instanceof Error ? error.message : String(error));
    } finally { setMeasuring(false); }
  };
  const windowId = String(info.constants.BayShell?.windowId ?? "hosting-spike");
  return <WindowContext.Provider value={windowId}>
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "#161a22", color: "#eef1f7", font: "14px system-ui,sans-serif" }}>
      <header style={{ padding: 14, borderBottom: "1px solid #ffffff20", display: "flex", alignItems: "center", gap: 16 }}>
        <strong>Bay hosting spike</strong>
        <span>{preview ? "Local UI fixture" : `${info.platform} · Chrome WebUI · SurfaceEmbed`}</span>
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>Phase 2, manual acceptance required</span>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <aside style={{ width: 245, padding: 16, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 16, borderRight: "1px solid #ffffff20" }}>
          <p style={{ margin: 0 }}>Use a page with video and a text field. Move and resize this window, then test input through and around the panel.</p>
          <label><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} /> Overlay panel</label>
          <label><input type="checkbox" checked={blur} onChange={event => setBlur(event.target.checked)} /> Backdrop blur</label>
          <label><input type="checkbox" checked={motion} onChange={event => setMotion(event.target.checked)} /> Animate with Reanimated</label>
          <output aria-live="polite">{frames}</output>
          <button style={button} disabled={measuring} onClick={() => void measure()}>Measure 100 bridge calls</button>
          <output aria-live="polite">{timing}</output>
          {actionError ? <output role="alert">{actionError}</output> : null}
          <label>UI input / IME test<input ref={address} aria-label="UI input and IME test" style={{ ...input, width: "100%", boxSizing: "border-box", marginTop: 8 }} placeholder="日本語 · 中文" /></label>
          <div>Native commands<pre style={{ whiteSpace: "pre-wrap", opacity: 0.7 }}>{commands.join("\n") || "Focus a page and press Ctrl+L."}</pre></div>
          <small style={{ marginTop: "auto", opacity: 0.6 }}>Record DPI, IME, Narrator/NVDA, video, fullscreen, PiP, DevTools and tab-transfer results on Windows. A rendered page alone does not pass the gate.</small>
        </aside>
        <main style={{ flex: 1, minWidth: 0, display: "flex", position: "relative", gap: 8, padding: 8 }}>
          {urls.map((url, index) => <section key={index} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid #ffffff30", borderRadius: 8, overflow: "hidden" }}>
            <form style={{ padding: 8, display: "flex", gap: 6 }} onSubmit={event => {
              event.preventDefault();
              const candidate = (drafts[index] ?? "").trim();
              if (!/^https?:\/\//i.test(candidate)) return;
              setURLs(current => current.map((value, pane) => pane === index ? candidate : value));
            }}>
              <input aria-label={`Pane ${index + 1} address`} style={{ ...input, flex: 1 }} value={drafts[index]} onChange={event => setDrafts(current => current.map((value, pane) => pane === index ? event.target.value : value))} />
              <button style={button}>Load</button>
            </form>
            <output style={{ padding: "0 8px 8px", fontSize: 12, opacity: 0.6 }}>{titles[index]}</output>
            <div style={{ display: "flex", gap: 6, padding: "0 8px 8px" }}>
              <button style={button} aria-label={`Focus pane ${index + 1}`} onClick={() => pageAction(() => pages.current[index]?.focus())}>Focus page</button>
              <button style={button} aria-label={`DevTools pane ${index + 1}`} onClick={() => pageAction(() => pages.current[index]?.showDevTools())}>DevTools</button>
              <button style={button} aria-label={`Zoom pane ${index + 1}`} onClick={() => pageAction(() => pages.current[index]?.zoomStep(1))}>Zoom +</button>
            </div>
            <View style={{ flex: 1 }}>
              <WebView ref={value => { pages.current[index] = value; }} style={{ flex: 1 }} url={url} profile="" visible onNavigationChange={state => setTitles(current => current.map((value, pane) => pane === index ? state.title || state.url : value))} />
            </View>
          </section>)}
          {overlay ? <Animated.View style={[{ position: "absolute", left: "21%", top: "28%", width: "54%", zIndex: 10 }, motionStyle]}><section aria-label="Translucent overlay test" style={{ boxSizing: "border-box", padding: 24, borderRadius: 24, border: "1px solid #ffffff60", background: "#183f737d", backdropFilter: blur ? "blur(22px)" : undefined, boxShadow: "0 18px 70px #0006" }}>
            <h2 style={{ marginTop: 0 }}>UI above two page surfaces</h2>
            <p>Both pages should remain visible through this panel. Input outside the panel must reach the correct page. Tab traversal and accessibility should cross between UI and page content.</p>
            <button style={button} onClick={() => setOverlay(false)}>Hide panel</button>
          </section></Animated.View> : null}
        </main>
      </div>
    </div>
  </WindowContext.Provider>;
}

export function startHostingSpike(root: HTMLElement) {
  createRoot(root).render(<HostingSpike />);
}
