import { Skia } from "@shopify/react-native-skia";

/**
 * A thick glass lens over Bay itself: inside the circle the start page underneath is magnified, bent harder towards
 * the rim (red and blue a hair apart there, as through real glass), shaded at the edge and lit across the top.
 * Outside the circle nothing is drawn. `open` (0–1) flattens the glass as the lens spreads across the screen, so by the
 * time it covers everything it shows the page exactly as it is.
 */
const source = `
uniform shader page;
uniform float2 centre;
uniform float radius;
uniform float zoom;
uniform float open;
uniform float2 shift;

half4 main(float2 point) {
  float2 offset = point - centre;
  float dist = length(offset);

  if (dist > radius + 1.0) {
    return half4(0.0);
  }

  float n = dist / radius;
  float glass = 1.0 - open;
  float bend = 1.0 + glass * 0.42 * n * n;
  float2 base = centre + shift + offset * (bend / zoom);
  float2 direction = dist > 0.0 ? offset / dist : float2(0.0);
  float fringe = glass * 0.018 * n * n * n * radius;

  half4 colour = half4(page.eval(base + direction * fringe).r, page.eval(base).g, page.eval(base - direction * fringe).b, 1.0);

  // Shade at the rim, where the glass turns away; light across the top, where it catches the sky.
  float rim = smoothstep(0.78, 1.0, n) * glass;
  colour.rgb *= half(1.0 - 0.2 * rim);
  float top = smoothstep(0.55, 0.98, n) * smoothstep(0.1, -0.75, offset.y / radius) * glass;
  colour.rgb += half(0.22 * top);

  float edge = 1.0 - smoothstep(radius - 1.0, radius + 1.0, dist);

  return colour * half(edge);
}
`;

export const lensEffect = Skia.RuntimeEffect.Make(source)!;
