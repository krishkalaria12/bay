// WebGL2 plumbing for every web effect: contexts, per-context programs, typed uniforms and capped target sizes.
// Programs, textures and uniform locations belong to one context and are never shared between contexts.

import { VERTEX } from "./sources/common";

export type UniformType = "f" | "i" | "v2" | "v4" | "v4[]";
export type UniformSpec = Record<string, UniformType>;
export type UniformValues = Record<string, number | readonly number[]>;
export type Source = { fragment: string; uniforms: UniformSpec };

type Program = { program: WebGLProgram; locations: Map<string, WebGLUniformLocation | null>; linked: boolean };

const MAX_DPR = 2;
const MAX_PIXELS = 8_000_000;

export type Surface = {
  gl: WebGL2RenderingContext;
  /** Context lost and not yet restored: draw nothing, show the CSS base. */
  readonly lost: boolean;
  /**
   * Starts compiling `sources` and reports: true when all are linked, false while the driver still compiles them
   * (KHR_parallel_shader_compile, so the main thread never waits on it), null when one failed.
   */
  ready(...sources: Source[]): boolean | null;
  /** The linked program, in use; null while compiling or failed. */
  use(source: Source): Program | null;
  uniforms(source: Source, program: Program, values: UniformValues): void;
  /** Draws `source` over the current viewport. False when it is not linked (see `ready`). */
  draw(source: Source, values: UniformValues): boolean;
  release(): void;
};

/**
 * A WebGL2 context on `canvas`, or null when the GPU refuses one. `onLost` and `onRestored` follow the context-loss
 * rules: the loss is prevented so the context can come back, and every program is rebuilt after it does.
 */
export function createSurface(canvas: HTMLCanvasElement | OffscreenCanvas, onLost: () => void, onRestored: () => void): Surface | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      // A request, not a guarantee.
      powerPreference: "low-power",
    }) as WebGL2RenderingContext | null;
  } catch {}
  if (!gl) return null;
  const ctx = gl;
  const parallel = ctx.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
  let programs = new Map<Source, Program | null>();
  // Compiles on first sight; then the link result once the driver has it, without blocking for it.
  const program = (source: Source): Program | null | false => {
    if (!programs.has(source)) programs.set(source, compile(ctx, source));
    const p = programs.get(source) ?? null;
    if (!p || p.linked) return p;
    if (parallel && !ctx.getProgramParameter(p.program, parallel.COMPLETION_STATUS_KHR)) return false;
    if (!ctx.getProgramParameter(p.program, ctx.LINK_STATUS)) {
      if (!ctx.isContextLost()) console.warn("[BayShaders]", ctx.getProgramInfoLog(p.program));
      ctx.deleteProgram(p.program);
      programs.set(source, null);
      return null;
    }
    p.linked = true;
    return p;
  };
  let lost = false;
  const lose = (event: Event) => {
    event.preventDefault();
    lost = true;
    onLost();
  };
  const restore = () => {
    lost = false;
    programs = new Map();
    onRestored();
  };
  canvas.addEventListener("webglcontextlost", lose as EventListener);
  canvas.addEventListener("webglcontextrestored", restore);

  const surface: Surface = {
    gl: ctx,
    get lost() {
      return lost || ctx.isContextLost();
    },
    ready(...sources) {
      let all: boolean | null = true;
      for (const source of sources) {
        const p = program(source);
        if (p === null) return null;
        if (p === false) all = false;
      }
      return all;
    },
    use(source) {
      const p = program(source);
      if (!p) return null;
      ctx.useProgram(p.program);
      return p;
    },
    uniforms(source, program, values) {
      for (const [name, type] of Object.entries(source.uniforms)) {
        const value = values[name];
        if (value === undefined) continue;
        let at = program.locations.get(name);
        if (at === undefined) program.locations.set(name, (at = ctx.getUniformLocation(program.program, name)));
        if (!at) continue;
        const v = typeof value === "number" ? [value] : value;
        if (type === "f") ctx.uniform1f(at, v[0] ?? 0);
        else if (type === "i") ctx.uniform1i(at, v[0] ?? 0);
        else if (type === "v2") ctx.uniform2f(at, v[0] ?? 0, v[1] ?? 0);
        else if (type === "v4") ctx.uniform4f(at, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0);
        else if (v.length) ctx.uniform4fv(at, v as number[]);
      }
    },
    draw(source, values) {
      if (surface.lost) return false;
      const program = surface.use(source);
      if (!program) return false;
      surface.uniforms(source, program, values);
      ctx.drawArrays(ctx.TRIANGLES, 0, 3);
      return true;
    },
    release() {
      canvas.removeEventListener("webglcontextlost", lose as EventListener);
      canvas.removeEventListener("webglcontextrestored", restore);
      if (!ctx.isContextLost()) for (const p of programs.values()) if (p) ctx.deleteProgram(p.program);
      programs.clear();
      ctx.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
  return surface;
}

function compile(gl: WebGL2RenderingContext, source: Source): Program | null {
  // No status queries here: they would wait for the driver. A failed compile shows as a failed link in `ready`.
  const shader = (type: number, text: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, text);
    gl.compileShader(s);
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, VERTEX);
  const fs = shader(gl.FRAGMENT_SHADER, source.fragment);
  const program = vs && fs ? gl.createProgram() : null;
  if (program && vs && fs) {
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
  }
  // Flagged for deletion; they live on while attached.
  if (vs) gl.deleteShader(vs);
  if (fs) gl.deleteShader(fs);
  return program ? { program, locations: new Map(), linked: false } : null;
}

/** Device pixels for a CSS size: DPR capped at 2, at most 8 megapixels with the aspect kept, within `limit`. */
export function targetSize(cssWidth: number, cssHeight: number, dpr: number, limit = 16384): { width: number; height: number } | null {
  if (!(cssWidth > 0 && cssHeight > 0 && Number.isFinite(cssWidth) && Number.isFinite(cssHeight))) return null;
  let scale = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, MAX_DPR);
  const pixels = cssWidth * cssHeight * scale * scale;
  if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
  scale = Math.min(scale, limit / cssWidth, limit / cssHeight);
  return { width: Math.max(1, Math.round(cssWidth * scale)), height: Math.max(1, Math.round(cssHeight * scale)) };
}

export function glLimit(gl: WebGL2RenderingContext): number {
  const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
  return Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, dims?.[0] ?? 4096, dims?.[1] ?? 4096) || 4096;
}
