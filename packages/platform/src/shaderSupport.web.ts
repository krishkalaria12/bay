// Whether this GPU gives WebGL2 at full speed: one 1×1 canvas, released at once. A software renderer counts as no,
// so the shader views keep their CSS. Effects still handle their own allocation and compile failures.

type Doc = { createElement(tag: "canvas"): { width: number; height: number; getContext(type: "webgl2", options: object): unknown } };

let supported: boolean | undefined;

export function webgl2Supported(doc: Doc | undefined = globalThis.document as Doc | undefined): boolean {
  if (supported !== undefined) return supported;
  try {
    const canvas = doc?.createElement("canvas");
    if (canvas) canvas.width = canvas.height = 1;
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
