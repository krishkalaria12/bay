import { Composition } from "remotion";
import { Bay154, bay154Frames } from "./bay-1.5.4/index.tsx";
import { Bay16, bay16Frames } from "./bay-1.6/index.tsx";

// 60 fps, as the recordings were made, at 1440p (the edit is laid out at 1080p and scaled up whole).
const FPS = 60;

export function Root() {
  return (
    <>
      <Composition id="bay-1-5-4" component={Bay154} durationInFrames={bay154Frames(FPS)} fps={FPS} width={2560} height={1440} />
      <Composition id="bay-1-6" component={Bay16} durationInFrames={bay16Frames(FPS)} fps={FPS} width={2560} height={1440} />
    </>
  );
}
