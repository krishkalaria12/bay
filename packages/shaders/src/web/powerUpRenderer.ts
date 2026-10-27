// PowerUp in one context: the band into a quarter-size target, blurred 24 CSS pixels in two passes onto the canvas
// (the native view's layer blur), then the halo unblurred on top in its own viewport.

import { blur, halo, powerUp } from "./sources/powerUp";
import type { Surface, UniformValues } from "./surface";

type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number };
const targets = new WeakMap<Surface, [Target, Target]>();
const BLUR = 24;
const DOWNSAMPLE = 4;

function target(gl: WebGL2RenderingContext, width: number, height: number): Target | null {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const)
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return ok ? { texture, framebuffer, width, height } : null;
}

/** Both blur targets at this size, made again after a resize or a restored context. */
function blurTargets(s: Surface, width: number, height: number): [Target, Target] | null {
  const { gl } = s;
  const w = Math.max(1, Math.ceil(width / DOWNSAMPLE)),
    h = Math.max(1, Math.ceil(height / DOWNSAMPLE));
  const cached = targets.get(s);
  if (cached && cached[0].width === w && cached[0].height === h && gl.isTexture(cached[0].texture)) return cached;
  for (const t of cached ?? []) {
    gl.deleteTexture(t.texture);
    gl.deleteFramebuffer(t.framebuffer);
  }
  targets.delete(s);
  const a = target(gl, w, h),
    b = target(gl, w, h);
  if (!a || !b) return null;
  targets.set(s, [a, b]);
  return [a, b];
}

export type HaloRegion = { x: number; y: number; width: number; height: number; values: UniformValues };

/** Draws one PowerUp frame; false when a program or target failed. */
export function drawPowerUp(
  s: Surface,
  size: { width: number; height: number; cssWidth: number },
  band: UniformValues | null,
  haloRegion: HaloRegion | null,
): boolean {
  const { gl } = s;
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, size.width, size.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (band) {
    const t = blurTargets(s, size.width, size.height);
    if (!t) return false;
    const [a, b] = t;
    const sigma = (BLUR * a.width) / Math.max(size.cssWidth, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.framebuffer);
    gl.viewport(0, 0, a.width, a.height);
    if (!s.draw(powerUp, band)) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.framebuffer);
    gl.bindTexture(gl.TEXTURE_2D, a.texture);
    if (!s.draw(blur, { image: 0, texel: [1 / a.width, 0], sigma })) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, size.width, size.height);
    gl.bindTexture(gl.TEXTURE_2D, b.texture);
    if (!s.draw(blur, { image: 0, texel: [0, 1 / b.height], sigma })) return false;
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  if (haloRegion) {
    const k = size.width / Math.max(size.cssWidth, 1);
    const { x, y, width, height } = haloRegion;
    gl.viewport(Math.round(x * k), Math.round(size.height - (y + height) * k), Math.round(width * k), Math.round(height * k));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const ok = s.draw(halo, haloRegion.values);
    gl.disable(gl.BLEND);
    if (!ok) return false;
  }
  return true;
}
