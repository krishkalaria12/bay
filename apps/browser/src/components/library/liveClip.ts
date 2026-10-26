/** Scroll may clamp at the page's bottom. Translate the remaining document offset inside the clipped view. */
export function liveClipTransform(clip: number[], display: { width: number; height: number }, scrollY: number) {
  const [x = 0, y = 0, width = 1, height = 1] = clip;
  const scaleX = display.width / Math.max(1, width);
  const scaleY = display.height / Math.max(1, height);
  return { left: -x * scaleX, top: -(y - scrollY) * scaleY, scaleX, scaleY };
}
