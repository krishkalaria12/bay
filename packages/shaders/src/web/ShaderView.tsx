// What the web components share: the rollout switch, live media queries, and the canvas an animated effect owns.

import { capabilities } from "@bay/platform";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribe } from "./clock";
import { createSurface, glLimit, targetSize, type Surface } from "./surface";

declare const process: { env: { EXPO_PUBLIC_BAY_WEB_SHADERS?: string } };

/** BAY_WEB_SHADERS=1 at build time, and a GPU that gives WebGL2. Otherwise every effect takes its CSS path. */
export const webShaders = process.env.EXPO_PUBLIC_BAY_WEB_SHADERS === "1" && capabilities.shaders;

export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = typeof matchMedia === "function" ? matchMedia(query) : null;
      list?.addEventListener("change", onChange);
      return () => list?.removeEventListener("change", onChange);
    },
    () => (typeof matchMedia === "function" ? matchMedia(query).matches : false),
  );
}

/** High contrast or forced colours: grain goes, decorative light goes. */
export function useContrast(): { more: boolean; forced: boolean } {
  return { more: useMedia("(prefers-contrast: more)"), forced: useMedia("(forced-colors: active)") };
}

/** Whether the document's window has focus, the web's key window. */
export function useFocused(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      addEventListener("focus", onChange);
      addEventListener("blur", onChange);
      return () => {
        removeEventListener("focus", onChange);
        removeEventListener("blur", onChange);
      };
    },
    () => document.hasFocus(),
  );
}

// At most two animated contexts per document; a third animation takes its CSS fallback.
let slots = 2;

/** Draws a frame. `dt` is 0 for a redraw of the same moment; return true while there is more to animate. */
export type Draw = (surface: Surface, size: { width: number; height: number; cssWidth: number; cssHeight: number }, dt: number) => boolean;

/**
 * A canvas with its own WebGL2 context, drawn through the shared clock while `draw` asks for more frames and the
 * canvas is on screen. Change `kick` to draw again (new inputs, a replay). `failed` means: show the fallback.
 */
export function useAnimatedCanvas(enabled: boolean, draw: Draw, kick: unknown) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const drawRef = useRef(draw);
  useLayoutEffect(() => {
    drawRef.current = draw;
  });
  const start = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = ref.current;
    if (!enabled || !canvas) return;
    if (slots <= 0) {
      setFailed(true);
      return;
    }
    slots--;
    let stop: (() => void) | null = null;
    let onScreen = true;
    let size: Parameters<Draw>[1] | null = null;
    let first = true;
    const halt = () => {
      stop?.();
      stop = null;
    };
    const surface = createSurface(
      canvas,
      () => {
        halt();
        setFailed(true);
      },
      () => {
        setFailed(false);
        first = true;
        run();
      },
    );
    if (!surface) {
      slots++;
      setFailed(true);
      return;
    }
    const frame = (dt: number) => {
      if (!size || surface.lost) return halt();
      surface.gl.viewport(0, 0, size.width, size.height);
      const more = drawRef.current(surface, size, first ? 0 : dt);
      first = false;
      if (!more || !onScreen) halt();
    };
    const run = () => {
      if (!stop && size && onScreen && !surface.lost) stop = subscribe(frame);
    };
    start.current = () => {
      first = true;
      run();
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const next = targetSize(rect.width, rect.height, devicePixelRatio, glLimit(surface.gl));
      if (!next) {
        size = null;
        return halt();
      }
      if (canvas.width !== next.width || canvas.height !== next.height) {
        canvas.width = next.width;
        canvas.height = next.height;
      }
      size = { ...next, cssWidth: rect.width, cssHeight: rect.height };
      first = true;
      run();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    const intersection = new IntersectionObserver(([entry]) => {
      onScreen = !!entry?.isIntersecting;
      if (onScreen) run();
      else halt();
    });
    intersection.observe(canvas);
    // Moving to a monitor with another scale changes the ratio without a resize.
    let dpr: MediaQueryList | null = null;
    const watchDpr = () => {
      dpr?.removeEventListener("change", onDpr);
      dpr = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
      dpr.addEventListener("change", onDpr);
    };
    const onDpr = () => {
      watchDpr();
      resize();
    };
    watchDpr();
    resize();
    return () => {
      halt();
      resizeObserver.disconnect();
      intersection.disconnect();
      dpr?.removeEventListener("change", onDpr);
      start.current = () => {};
      surface.release();
      slots++;
    };
  }, [enabled]);

  useEffect(() => start.current(), [kick]);

  return { ref, failed };
}

export const fill = { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" } as const;
