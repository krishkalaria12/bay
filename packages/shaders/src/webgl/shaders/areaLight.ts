import type { Source } from "../surface";
import { HASH12, HEADER, MAX_COLORS } from "./common";

// ios/AreaLightView.swift areaLightSource. Colours are sRGB + alpha; the output is premultiplied.
export const areaLight: Source = {
  uniforms: {
    shapeFrame: "v4",
    rotationTrig: "v4",
    viewSize: "v2",
    cornerRadius: "f",
    falloff: "f",
    noiseSeed: "f",
    lift: "f",
    time: "f",
    intensity: "f",
    numberOfColors: "i",
    lightMode: "i",
    colors: "v4[]",
  },
  fragment: `${HEADER}
uniform vec4 shapeFrame;   // emitter rect (x, y, w, h) in CSS pixels, top-left origin
uniform vec4 rotationTrig; // (cos a, sin a, cos b, sin b)
uniform vec2 viewSize;
uniform float cornerRadius;
uniform float falloff;
uniform float noiseSeed;
uniform float lift;
uniform float time;
uniform float intensity;
uniform int numberOfColors;
uniform int lightMode;     // 1 = light appearance, 0 = dark (HDR + filmic tonemap)
uniform vec4 colors[${MAX_COLORS}];
${HASH12}
vec3 samplePalette(float pos) {
  int n = max(numberOfColors, 1);
  float scaled = fract(pos) * float(n);
  int i0 = min(int(floor(scaled)), n - 1);
  int i1 = (i0 + 1) % n;
  return mix(colors[i0], colors[i1], smoothstep(0.0, 1.0, scaled - float(i0))).rgb;
}

// IQ sin-hash gradient.
vec2 hashGradient(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
}

// IQ 2D simplex noise, roughly [-1, 1].
float simplex2D(vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  vec2 o = (a.x > a.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h * vec3(dot(a, hashGradient(i)), dot(b, hashGradient(i + o)), dot(c, hashGradient(i + 1.0)));
  return dot(n, vec3(70.0));
}

float triangularNoise(float u) {
  float r = u * 2.0;
  return (u < 0.5) ? sqrt(r) - 1.0 : 1.0 - sqrt(2.0 - r);
}

float rectCornerTerm(float x, float y, float h) {
  float r = sqrt(h * h + x * x + y * y);
  return (r < 1e-4) ? 0.0 : atan((x * y) / (r * h));
}

float rectangleIrradiance(vec2 p, vec2 hs, float height) {
  float h = max(height, 1e-3);
  float x1 = -(hs.x + p.x), x2 = hs.x - p.x;
  float y1 = -(hs.y + p.y), y2 = hs.y - p.y;
  float sum = rectCornerTerm(x2, y2, h) - (rectCornerTerm(x1, y2, h) + rectCornerTerm(x2, y1, h)) + rectCornerTerm(x1, y1, h);
  return sum * 0.159154943;
}

float roundedRectIrradiance(vec2 p, vec2 hs, float radius, float height) {
  float r = min(radius, min(hs.x, hs.y));
  float full = rectangleIrradiance(p, hs, height);
  if (r < 0.5) return full;
  vec2 inner = hs - r;
  vec2 q = abs(p) - inner;
  float inCorner = step(0.0, q.x) * step(0.0, q.y);
  float cornerDist = length(max(q, 0.0));
  float cornerHalf = r * 0.5;
  vec2 cornerCenter = sign(p) * (inner + cornerHalf);
  float cornerE = rectangleIrradiance(p - cornerCenter, vec2(cornerHalf), height);
  float outsideArc = smoothstep(r - 1.0, r + 1.0, cornerDist);
  return max(full - inCorner * 0.214601837 * cornerE * outsideArc, 0.0);
}

vec3 hableCurve(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 hableTonemap(vec3 x) { return clamp(hableCurve(x) * 1.37906432, 0.0, 1.0); }

void main() {
  float lft = max(lift, 1e-3);
  float cosA = rotationTrig.x, sinA = rotationTrig.y;
  float cosB = rotationTrig.z, sinB = rotationTrig.w;

  vec2 pixel = viewSize * uv;
  vec2 hs = shapeFrame.zw * 0.5;
  if (hs.x <= 0.0 || hs.y <= 0.0) { fragColor = vec4(0.0); return; }
  vec2 d = pixel - (shapeFrame.xy + hs);

  float planeOffset = (d.y * sinA - cosA * sinB * d.x) / max(cosB * cosA, 1e-3);
  if (lft - planeOffset <= 0.0) { fragColor = vec4(0.0); return; }

  float zA = d.y * sinA - cosA * lft;
  vec2 local = vec2(zA * sinB + d.x * cosB, d.y * cosA + sinA * lft);
  float height = max(abs(d.y * sinA * cosB - (d.x * sinB + cosA * cosB * lft)), 1e-3);

  float irradiance = roundedRectIrradiance(local, hs, cornerRadius, height);

  float r = min(cornerRadius, min(hs.x, hs.y));
  vec2 q = abs(local) - hs + r;
  float sdf = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  float outside = max(sdf, 0.0);
  float dist = max(sqrt(outside * outside + height * height), 1e-4);
  float light = irradiance * (height * height) / (dist * dist);
  if (falloff != 2.0 && outside > 0.0) light *= pow(height / dist, falloff - 2.0);

  float edgeFade = clamp(outside / hs.x, 0.0, 1.0);
  vec2 shapeUV = (clamp(local, -hs, hs) + hs) / shapeFrame.z;
  vec2 noiseP = shapeUV * 0.75 - time * 0.05 + noiseSeed * vec2(17.3, 31.7);
  float warp = (1.0 - edgeFade) * 0.125 * simplex2D(noiseP);
  float gradPos = shapeUV.x * 0.9 + shapeUV.y * 0.1 - time * 0.05 + warp;
  vec3 color = samplePalette(gradPos);

  float alpha;
  if (lightMode != 0) {
    alpha = clamp(pow(intensity * light, falloff * 0.3), 0.0, 1.0);
  } else {
    vec3 hdr = pow(light, falloff * 0.3) * color * intensity;
    color = hableTonemap(hdr);
    alpha = clamp(dot(color, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  }

  alpha *= smoothstep(0.0, 50.0, pixel.y) * smoothstep(0.0, 200.0, viewSize.y - pixel.y);

  float dither = triangularNoise(hash12(pixel)) * (3.0 / 255.0);
  float a = clamp(alpha + dither, 0.0, 1.0);
  fragColor = vec4(clamp(color + dither, 0.0, 1.0) * a, a);
}
`,
};
