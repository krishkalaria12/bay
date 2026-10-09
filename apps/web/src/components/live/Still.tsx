import LiveWindow from "./LiveWindow";
import { useBay, type PresetName } from "./state";

/** A working window drawn once, with no script: for pictures such as the social card. */
export function StillWindow({ preset }: { preset: PresetName }) {
  const bay = useBay(preset);
  return (
    <div className="@container">
      <div className="mock mock-frame relative w-full">
        <LiveWindow bay={bay} />
      </div>
    </div>
  );
}
