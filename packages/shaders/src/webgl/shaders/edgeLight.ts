import type { Source } from "../surface";
import { EASE_OUT_EXPO, HEADER, SMOOTHSTEP_ANY } from "./common";

// ios/EdgeLightView.swift edgeLightSource. Premultiplied output.
export const edgeLight: Source = {
  uniforms: {
    resolution: "v2",
    time: "f",
    animationDuration: "f",
    animationDelay: "f",
    rectFrame: "v4",
    cornerRadius: "f",
    lightStart: "v2",
    lightEnd: "v2",
    lightColor: "v4",
    diaLogoFrame: "v4",
  },
  fragment: `${HEADER}
uniform vec2 resolution;
uniform float time;
uniform float animationDuration;
uniform float animationDelay;
uniform vec4 rectFrame;
uniform float cornerRadius;
uniform vec2 lightStart;
uniform vec2 lightEnd;
uniform vec4 lightColor;
uniform vec4 diaLogoFrame;
${SMOOTHSTEP_ANY}
${EASE_OUT_EXPO}
float squircleBoxSDF(vec2 q, float r) {
  bool inX = q.x <= 0.0;
  bool inY = q.y <= 0.0;
  if (inX && inY) return max(q.x, q.y) - r;
  if (inX) return q.y - r;
  if (inY) return q.x - r;
  vec2 k = pow(q / r, vec2(4.5));
  return (pow(k.x + k.y, 0.222222224) - 1.0) * r;
}

vec2 squircleBoxNormal(vec2 q, float r, vec2 s) {
  bool inX = q.x <= 0.0;
  bool inY = q.y <= 0.0;
  if (inX && inY) return (q.x > q.y) ? vec2(s.x, 0.0) : vec2(0.0, s.y);
  if (inX) return vec2(0.0, s.y);
  if (inY) return vec2(s.x, 0.0);
  vec2 g = pow(max(q, vec2(9.99999975e-05)) / r, vec2(3.5)) * s / r;
  return normalize(g);
}

float smoothSubtract(float a, float b, float k, out float h) {
  h = clamp(0.5 - 0.5 * (b + a) / k, 0.0, 1.0);
  return mix(a, -b, h) + k * h * (1.0 - h);
}

void main() {
  vec2 rectCenter = rectFrame.xy + rectFrame.zw * 0.5;
  vec2 halfSize = rectFrame.zw * 0.5;
  float scale = min(halfSize.x, halfSize.y);
  // A degenerate rect would divide by zero below.
  if (!(scale > 0.0)) { fragColor = vec4(0.0); return; }

  vec2 pixel = resolution * uv;
  vec2 p = (pixel - rectCenter) / scale;
  vec2 hs = halfSize / scale;
  float r = cornerRadius * 2.0 / scale;

  vec2 q = abs(p) - hs + r;
  float d = squircleBoxSDF(q, r);

  float progress = 1.0;
  if (animationDuration > 0.0) progress = max(time - animationDelay, 0.0) / animationDuration;
  float ease = easeOutExpo(clamp(progress, 0.0, 1.0));

  vec2 n = squircleBoxNormal(q, r, sign(p));
  vec2 lightPos = mix(lightStart, lightEnd, vec2(ease));

  vec2 toLight = (lightPos - rectCenter) / (hs * scale) - p / hs;
  float lightDist = length(toLight);
  vec2 edgeN = normalize(n * hs);
  vec2 lightDir = (lightDist > 0.00100000005) ? toLight / lightDist : vec2(0.0);
  float facing = max(0.0, dot(edgeN, lightDir));

  float atten = pow(1.0 - smoothstepAny(0.0, 2.0, lightDist), 1.5);
  float lit = mix(atten * 0.5, atten, sqrt(facing));
  float glowLit = mix(0.0500000007, 1.0, lit);

  float absD = abs(d);
  float core = smoothstepAny(1.0 / scale, 0.0, absD) * lit;
  float glow = smoothstepAny(10.0 / scale, 0.0, absD) * glowLit;
  float edge = clamp(core + pow(glow, 2.0) * 0.200000003, 0.0, 1.0) * ease;

  float edgeAlpha = lightColor.a * clamp(edge, 0.0, 1.0);
  vec4 edgeColor = vec4(lightColor.rgb * edgeAlpha, edgeAlpha);

  vec4 logoColor = vec4(0.0);
  float logoSize = min(diaLogoFrame.z, diaLogoFrame.w);
  // No logo (a zero frame) draws no rim.
  if (logoSize > 0.0) {
    vec2 logoCenter = diaLogoFrame.xy + diaLogoFrame.zw * 0.5;
    float logoRadius = logoSize * 0.5;
    float logoBlend = logoSize * 0.0500000007;

    vec2 lp = pixel - logoCenter;
    float lenA = length(lp);
    float dA = lenA - logoRadius;
    vec2 bp = lp - vec2(0.0, logoSize * 1.25);
    float lenB = length(bp);
    float dB = lenB - logoSize;
    float h;
    float logoSDF = smoothSubtract(dA, dB, logoBlend, h);

    vec2 lv = (lightPos - logoCenter) * vec2(1.0, -1.0) / logoRadius;
    float lvLen = length(lv);
    vec2 lvDir = (lvLen > 0.00100000005) ? lv / lvLen : vec2(0.0);
    float logoFade = 1.0 - smoothstepAny(0.0, 6.0, lvLen);
    float logoAtten = logoFade * sqrt(logoFade);

    vec2 nA = (lenA > 9.99999975e-05) ? lp / lenA : vec2(0.0, 1.0);
    vec2 nB = (lenB > 9.99999975e-05) ? bp / lenB : vec2(0.0, -1.0);
    vec2 logoN = normalize(mix(nA, -nB, vec2(h)) * vec2(1.0, -1.0));

    float logoFacing = mix(1.0, max(0.0, dot(logoN, -lvDir)), smoothstepAny(0.0, 1.5, lvLen));
    float logoLit = logoFacing * logoAtten;

    float insideLogo = (logoSDF <= 0.0) ? 1.0 : 0.0;
    float rim = smoothstepAny(1.0, 0.0, abs(logoSDF)) * logoLit;
    float inner = smoothstepAny(10.0, 0.0, max(-logoSDF, 0.0)) * logoLit * insideLogo;
    float logo = clamp(rim + pow(inner, 2.0) * 0.200000003, 0.0, 1.0) + insideLogo * logoAtten * 0.0500000007;

    float logoAlpha = clamp(logo * ease, 0.0, 1.0) * lightColor.a;
    logoColor = vec4(lightColor.rgb * logoAlpha, logoAlpha);
  }

  fragColor = edgeColor + logoColor * (1.0 - edgeAlpha);
}
`,
};
