// Whether this GPU gives WebGL2 at full speed: one 1×1 canvas, released at once. A software renderer counts as no,
// so the shader views keep their CSS. Effects still handle their own allocation and compile failures.

/** The canvas the shaders draw on, and the context they ask for. */
type Canvas = { width: number; height: number; getContext(type: "webgl2", options: WebGLContextAttributes): WebGL2RenderingContext | null };

type Doc = { createElement(tag: "canvas"): Canvas };

let supported: boolean | undefined;

// SAFETY: the checks above established this shape.
export function webgl2Supported(doc: Doc | undefined = globalThis.document as Doc | undefined): boolean {
  if (supported !== undefined) return supported;

  try {
    const canvas = doc?.createElement("canvas");

    if (canvas) canvas.width = canvas.height = 1;

    // SAFETY: the checks above established this shape.
    const gl = canvas?.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) as
      | { getExtension(name: string): { loseContext(): void } | null }
      | null
      | undefined;

    supported = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    supported = false;
  }

  return supported;
}
