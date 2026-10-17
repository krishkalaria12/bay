import type { ViewProps } from "@bay/platform";

export type Rect = { x: number; y: number; width: number; height: number };

export type AreaLightPalette = "blue" | "red" | "pink" | "orange" | "yellow" | "green" | "purple";

export type AreaLightProps = ViewProps & {
  source: Rect | null;
  cornerRadius?: number;
  palette?: AreaLightPalette | string[];
  lift?: number;
  intensity?: number;
  falloff?: number;
  tilt?: [number, number];
  noiseSeed?: number;
  introDelay?: number;
  introDuration?: number;
  replayKey?: number;
};

export type WindowBackdropProps = ViewProps & {
  colors: [string, string];
  vibrancy?: boolean;
  tintColor?: string;
  tintAlpha?: number;
  tintLightness?: number;
  angle?: number;
  grainOpacity?: number;
  grainScale?: number;
};

export type EdgeLightProps = ViewProps & {
  rectFrame: Rect;
  cornerRadius?: number;
  lightStart: { x: number; y: number };
  lightEnd: { x: number; y: number };
  lightColor?: string;
  logoFrame?: Rect | null;
  animationDuration?: number;
  animationDelay?: number;
};

export type PowerUpProps = ViewProps & {
  palette?: AreaLightPalette | string[];
  speed?: number;
  origin?: number;
  cornerRadius?: number;
  halo?: Rect | null;
};
