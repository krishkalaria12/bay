import type { ImageSourcePropType } from "react-native";

import type { DRIFT_SITES, LINKS } from "./flow";

// The welcome's sites' own icons, shipped with Bay: a fresh install has been nowhere yet, so `SiteIcon` has no saved icon
// for them and would draw letters. Each is the site's own touch icon or favicon at 128 px.
export const WELCOME_ICONS = {
  "news.ycombinator.com": require("../../assets/images/welcome-sites/news.ycombinator.com.png"),
  "wikipedia.org": require("../../assets/images/welcome-sites/wikipedia.org.png"),
  "airbnb.com": require("../../assets/images/welcome-sites/airbnb.com.png"),
  "github.com": require("../../assets/images/welcome-sites/github.com.png"),
  "are.na": require("../../assets/images/welcome-sites/are.na.png"),
  "nytimes.com": require("../../assets/images/welcome-sites/nytimes.com.png"),
  "theverge.com": require("../../assets/images/welcome-sites/theverge.com.png"),
  "youtube.com": require("../../assets/images/welcome-sites/youtube.com.png"),
  "notion.so": require("../../assets/images/welcome-sites/notion.so.png"),
  "figma.com": require("../../assets/images/welcome-sites/figma.com.png"),
  "flytap.com": require("../../assets/images/welcome-sites/flytap.com.png"),
  "timeout.com": require("../../assets/images/welcome-sites/timeout.com.png"),
} satisfies Record<(typeof DRIFT_SITES)[number] | (typeof LINKS)[number]["host"], ImageSourcePropType>;
