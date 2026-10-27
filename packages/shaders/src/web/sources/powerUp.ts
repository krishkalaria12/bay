import type { Source } from "../surface";
import { EASE_OUT_EXPO, HEADER, MAX_COLORS } from "./common";

// ios/PowerUpView.swift powerUpSource. Colours are OKLab + alpha; the output is premultiplied.
export const powerUp: Source = {
  uniforms: {
    direction: "i",
    numberOfColors: "i",
    colors: "v4[]",
    time: "f",
    speed: "f",
    delay: "f",
    fadeOutStart: "f",
    fadeOutDuration: "f",
    origin: "f",
  },
  fragment: `${HEADER}
uniform int direction;
uniform int numberOfColors;
uniform vec4 colors[${MAX_COLORS}];
uniform float time;
uniform float speed;
uniform float delay;
uniform float fadeOutStart;
uniform float fadeOutDuration;
uniform float origin;
${EASE_OUT_EXPO}
float easeInOutQuart(float t) {
  return (t < 0.5) ? 8.0 * t * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 4.0) * 0.5;
}

float shiftCenter(float v, float o) {
  float mid = 1.0 - o;
  return (v <= 0.5) ? v * 2.0 * mid : mid + o * 2.0 * (v - 0.5);
}

vec3 oklabToLinearSRGB(vec3 lab) {
  vec3 lms = vec3(dot(lab, vec3(1.0, 0.396337777, 0.215803757)),
                  dot(lab, vec3(1.0, -0.105561346, -0.0638541728)),
                  dot(lab, vec3(1.0, -0.0894841775, -1.29148555)));
  lms = lms * lms * lms; // pow() is undefined for negative bases in GLSL
  return vec3(dot(lms, vec3(4.0767417, -3.3077116, 0.230969936)),
              dot(lms, vec3(-1.26843798, 2.60975742, -0.341319382)),
              dot(lms, vec3(-0.00419608643, -0.703418612, 1.70761466)));
}

float linearToSRGB(float c) {
  float ac = abs(c);
  if (ac <= 0.00313080009) return c * 12.9200001;
  return sign(c) * (pow(ac, 0.416666657) * 1.05499995 - 0.0549999997);
}

vec4 samplePalette(int n1, float v) {
  float f = float(n1) * v;
  int i = clamp(int(floor(f)), 0, n1);
  vec4 a = colors[i];
  vec4 b = colors[min(i + 1, n1)];
  return mix(a, b, smoothstep(0.0, 1.0, f - float(i)));
}

float mask(vec2 p, float width, float start, float end, float skew, int dir) {
  float left, right, top, bottom;
  if (dir == 0 || dir == 2) {
    float k = (p.y - 0.5) * skew;
    left = smoothstep(0.0, width, p.x + k);
    right = 1.0 - smoothstep(1.0 - width, 1.0, p.x - k);
    if (dir == 0) {
      top = smoothstep(0.0, start, p.y);
      bottom = 1.0 - smoothstep(1.0 - end, 1.0, p.y);
    } else {
      top = 1.0 - smoothstep(1.0 - end, 1.0, 1.0 - p.y);
      bottom = smoothstep(0.0, start, 1.0 - p.y);
    }
  } else {
    float k = (p.x - 0.5) * skew;
    top = smoothstep(0.0, width, p.y + k);
    bottom = 1.0 - smoothstep(1.0 - width, 1.0, p.y - k);
    if (dir == 1) {
      left = 1.0 - smoothstep(1.0 - end, 1.0, 1.0 - p.x);
      right = smoothstep(0.0, start, 1.0 - p.x);
    } else {
      left = smoothstep(0.0, start, p.x);
      right = 1.0 - smoothstep(1.0 - end, 1.0, p.x);
    }
  }
  return left * right * top * bottom;
}

vec4 gradient(vec2 p, float progress, int dir) {
  float c = (dir == 0 || dir == 2) ? p.x : p.y;
  float q;
  if (c >= 0.200000003 && c < 0.400000006) q = progress - 0.0250000004;
  else if (c >= 0.400000006 && c < 0.600000024) q = progress - 0.0500000007;
  else q = (c >= 0.600000024 && c < 0.800000012) ? progress - 0.0250000004 : progress;
  q = clamp(q, 0.0, 1.0);

  float head = 1.0 - easeInOutQuart(q) * 0.949999988;

  float crossPos, alongPos;
  if (dir == 0) { crossPos = p.x; alongPos = p.y; }
  else if (dir == 2) { crossPos = p.x; alongPos = 1.0 - p.y; }
  else if (dir == 1) { crossPos = p.y; alongPos = 1.0 - p.x; }
  else { crossPos = p.y; alongPos = p.x; }
  float along = alongPos * 0.400000006;
  float bend = (1.0 - pow(abs(crossPos - 0.5) + 0.5, 5.0)) * -0.0500000007;

  int n1 = numberOfColors - 1;
  bool past = along > head;
  float v = past ? 1.0 : max(bend + along / head, 0.0);
  vec4 col = samplePalette(n1, v);
  col.a *= q * 0.5 + 0.5;

  if (past) {
    vec4 trail = samplePalette(n1, max(bend + along, 0.0));
    trail.a *= q * 0.5;
    float edge = easeOutExpo(1.0 - q) * 0.0500000007;
    col = mix(col, trail, clamp((along - head) / edge, 0.0, 1.0));
  }

  vec3 lin = oklabToLinearSRGB(col.rgb);
  return vec4(linearToSRGB(lin.r), linearToSRGB(lin.g), linearToSRGB(lin.b), col.a * 0.100000001);
}

void main() {
  if (direction < 0 || direction >= 4 || numberOfColors < 1) { fragColor = vec4(0.0); return; }
  float o = mix(origin, 0.5, clamp(time * 1.5, 0.0, 1.0));
  vec2 p;
  if (direction == 0) p = vec2(shiftCenter(uv.x, o), clamp((uv.y - 0.200000003) * 1.25, 0.0, 1.0));
  else if (direction == 2) p = vec2(shiftCenter(uv.x, o), 1.0 - clamp((0.800000012 - uv.y) * 1.25, 0.0, 1.0));
  else if (direction == 1) p = vec2(clamp((0.800000012 - uv.x) * 1.25, 0.0, 1.0), shiftCenter(uv.y, o));
  else p = vec2(1.0 - clamp((uv.x - 0.200000003) * 1.25, 0.0, 1.0), shiftCenter(uv.y, o));

  float t = time * 0.75 * speed + 0.449999988 - delay;
  vec4 col = gradient(p, t, direction);
  float m = mask(p, 0.449999988, 0.200000003, 0.150000006, 0.25, direction);
  col.a = col.a * m * clamp(time * 10.0, 0.0, 1.0);
  if (t > fadeOutStart) col.a *= 1.0 - clamp((t - fadeOutStart) / fadeOutDuration, 0.0, 1.0);
  fragColor = vec4(col.rgb * col.a, col.a);
}
`,
};

// ios/PowerUpView.swift haloSource. Colours are sRGB + alpha; drawn into the halo's own viewport.
export const halo: Source = {
  uniforms: {
    resolution: "v2",
    direction: "i",
    colors: "v4[]",
    isDark: "i",
    time: "f",
    speed: "f",
    delay: "f",
    fadeOutStart: "f",
    fadeOutDuration: "f",
    inset: "f",
    cornerRadius: "f",
  },
  fragment: `${HEADER}
uniform vec2 resolution;
uniform int direction;
uniform vec4 colors[2];
uniform int isDark;
uniform float time;
uniform float speed;
uniform float delay;
uniform float fadeOutStart;
uniform float fadeOutDuration;
uniform float inset;
uniform float cornerRadius;

// Simplex noise with Dave Hoskins' hash33 (4th-power kernel, scaled by 31.316).
vec3 haloHash33(vec3 p) {
  vec3 p3 = fract(p * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yxz + 19.19);
  return -1.0 + 2.0 * fract((p3.xxy + p3.yzz) * p3.zyx);
}

float haloNoise(vec3 p) {
  const float F3 = 0.333333343, G3 = 0.166666672;
  vec3 s = floor(p + (p.x + p.y + p.z) * F3);
  vec3 x = p - s + (s.x + s.y + s.z) * G3;
  vec3 e = step(vec3(0.0), x - x.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 x1 = x - i1 + G3;
  vec3 x2 = x - i2 + 2.0 * G3;
  vec3 x3 = x - 0.5;
  vec4 w = max(0.6 - vec4(dot(x, x), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  w = w * w * w * w;
  vec4 d = vec4(dot(x, haloHash33(s)), dot(x1, haloHash33(s + i1)), dot(x2, haloHash33(s + i2)), dot(x3, haloHash33(s + 1.0)));
  return dot(vec4(31.316), d * w);
}

void main() {
  bool dark = isDark != 0;
  float aspect = resolution.x / resolution.y;
  vec2 p = (uv - 0.5) * 2.0;
  p.x *= aspect;
  float inset2 = inset * 2.0;
  float hx = 1.0 - inset2 / resolution.x;
  float hy = 1.0 - inset2 / resolution.y;
  vec2 halfSize = aspect > 1.0 ? vec2(hx * aspect, hy) : vec2(hx, hy / aspect);
  float r = cornerRadius / min(resolution.x - inset2, resolution.y - inset2);
  float dist = abs(length(max(abs(p) - halfSize + r, 0.0)) - r);

  float t = speed * 0.8 * time - delay;
  float sweep = (t == 1.0) ? 1.25 : (1.0 - pow(2.0, -10.0 * t)) * 1.25;
  vec2 n = p / halfSize;
  float angle = atan(n.y, n.x);
  if (angle < 0.0) angle += 6.28318548;
  float offset = direction == 1 ? 1.57079637 : direction == 2 ? 3.14159274 : direction == 3 ? 4.71238899 : 0.0;
  // Both operands are positive here, so GLSL mod() matches Metal fmod().
  float around = mod(1.25 - mod(offset + angle, 6.28318548) * 0.159154937, 1.0);
  if (around > 0.5) around = 1.0 - around;
  around *= 2.0;
  float arc = smoothstep(0.0, 1.0, clamp((abs(around - sweep) - 0.22) * -4.54545450, 0.0, 1.0));

  float line = smoothstep(0.0, 1.0, clamp((dist - 0.025) * -40.0, 0.0, 1.0)) * arc * (dark ? 0.4 : 1.0);

  float nz = haloNoise(vec3(p * 0.5, time)) + 0.5;
  float glowWidth = mix(0.1, 0.2, nz);
  float shrink = (1.0 - t) * 0.95;
  float g1 = shrink == 0.0 ? 0.0 : clamp((dist - shrink) / -shrink, 0.0, 1.0);
  float g2 = clamp((dist - glowWidth) / -glowWidth, 0.0, 1.0);
  float g = g1 * g2;
  float glow = g * g * (dark ? 0.1 : 0.12) * arc * (3.0 - 2.0 * g1) * (3.0 - 2.0 * g2);

  float alpha = mix(colors[0].a, colors[1].a, nz) * clamp(glow + line, 0.0, 1.0);
  if (t > fadeOutStart) alpha *= 1.0 - clamp((t - fadeOutStart) / fadeOutDuration, 0.0, 1.0);
  vec3 rgb = clamp(mix(colors[0].rgb, colors[1].rgb, nz) + line, 0.0, 1.0);
  fragColor = vec4(rgb * alpha, alpha);
}
`,
};

// The band's 24-point Gaussian blur (the native view's CAFilter), one axis per pass over a premultiplied texture.
export const blur: Source = {
  uniforms: { image: "i", texel: "v2", sigma: "f" },
  fragment: `${HEADER}
uniform sampler2D image;
uniform vec2 texel; // one texel along the pass's axis
uniform float sigma; // texels
void main() {
  // 25 linear-filtered taps spanning +-3 sigma.
  float spacing = sigma / 4.0;
  vec2 at = vec2(uv.x, 1.0 - uv.y); // textures start at the bottom-left
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) * spacing;
    float w = exp(-0.5 * x * x / max(sigma * sigma, 1e-4));
    sum += texture(image, at + texel * x) * w;
    total += w;
  }
  fragColor = sum / total;
}
`,
};
