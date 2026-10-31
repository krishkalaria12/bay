// GLSL ES 3.00 ports of the Metal sources in ios/. Each keeps the Metal function names so the two read side by side.
// Metal's select(), fmod() and reversed smoothstep() are written out explicitly where GLSL differs.

/** One triangle over the viewport; uv (0,0) is the top-left, as in fullscreenVertex. */
export const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv;
out vec4 fragColor;
`;

// Dave Hoskins hash12 (hash without sine).
export const HASH12 = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

// Hermite smoothstep that is defined for e0 > e1 (GLSL's is not).
export const SMOOTHSTEP_ANY = `
float smoothstepAny(float e0, float e1, float x) {
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;

export const EASE_OUT_EXPO = `
float easeOutExpo(float t) {
  return (t == 1.0) ? 1.0 : 1.0 - pow(2.0, -10.0 * t);
}
`;

/** Palette arrays are fixed-size uniforms; longer palettes are cut to this. */
export const MAX_COLORS = 16;
