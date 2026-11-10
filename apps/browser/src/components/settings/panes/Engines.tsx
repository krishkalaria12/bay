import { View } from "react-native";
import { Group, Row, SectionHeader } from "../controls";
import { SETTINGS } from "../definitions";

// Why some sites run in Safari's engine (store/engines.ts). Bay chooses the engine, so there's nothing to set here;
// Site Controls' "Learn more" comes here.

export function EnginesPane() {
  return (
    <View>
      <SectionHeader title="Where sites open" />
      <Group>
        <Row
          settingId={SETTINGS.protectedMedia.id}
          title={SETTINGS.protectedMedia.title}
          description="Netflix, Disney+, Max, Prime Video, Hulu, Apple TV+, Spotify and others open in Safari's engine, which has the DRM their protected media needs."
        />
        <Row title="Other sites" description="Open in Chromium, unless their protected media won't play there. Then the page moves to Safari's engine." />
      </Group>

      <SectionHeader title="What's different in Safari's engine" />
      <Group>
        <Row
          settingId={SETTINGS.engineSignIns.id}
          title={SETTINGS.engineSignIns.title}
          description="Each engine keeps its own cookies and site data in every space, so you sign in once more there. Tabs, history and settings are shared."
        />
        <Row title="Extensions and ad blocking" description="These run only in Chromium for now." />
        <Row title="DevTools" description="DevTools don't open on these pages." />
        <Row
          title="Passkeys"
          description="These pages can't use passkeys until Apple grants Bay its browser passkey entitlement. Sign in another way on them meanwhile."
        />
      </Group>
    </View>
  );
}
