import type { Source } from "../surface";
import { HASH12, HEADER } from "./common";

// ios/WindowBackdropView.swift backdropFragment, premultiplied for the canvas.
export const backdrop: Source = {
  uniforms: { labA: "v4", labB: "v4", viewSize: "v2", direction: "v2", grainOpacity: "f", grainScale: "f" },
  fragment: `${HEADER}
uniform vec4 labA;       // OKLab + alpha at the gradient start
uniform vec4 labB;       // OKLab + alpha at the gradient end
uniform vec2 viewSize;   // CSS pixels
uniform vec2 direction;  // unit vector, uv space
uniform float grainOpacity;
uniform float grainScale; // CSS pixels per grain cell
${HASH12}
vec3 oklabToSRGB(vec3 lab) {
  vec3 lms = vec3(dot(lab, vec3(1.0, 0.3963377774, 0.2158037573)),
                  dot(lab, vec3(1.0, -0.1055613458, -0.0638541728)),
                  dot(lab, vec3(1.0, -0.0894841775, -1.2914855480)));
  lms = lms * lms * lms;
  vec3 lin = vec3(dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
                  dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
                  dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
  vec3 a = abs(lin);
  vec3 encoded = sign(lin) * (1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055);
  return mix(encoded, lin * 12.92, lessThanEqual(a, vec3(0.0031308)));
}

void main() {
  float t = clamp(dot(uv - 0.5, direction) + 0.5, 0.0, 1.0);
  vec4 lab = mix(labA, labB, t);
  vec3 base = oklabToSRGB(lab.xyz);
  // Multiply-blend a grey grain tile: base * (1 - a * (1 - g)). Cells are CSS pixels from the top-left.
  vec2 cell = floor(uv * viewSize / max(grainScale, 0.25));
  float g = hash12(cell);
  vec3 rgb = clamp(base * (1.0 - grainOpacity * (1.0 - g)), 0.0, 1.0);
  fragColor = vec4(rgb * lab.w, lab.w);
}
`,
};
