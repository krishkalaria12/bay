import { capabilities } from "@bay/platform";
import { layout } from "../../lib/theme";

// The window's own buttons: macOS's traffic lights at its top left, or the caption buttons Bay draws at its top right
// on Windows (CaptionButtons.tsx). Layouts clear whichever the platform has, and nothing where it has neither.

/** The traffic lights' room at the window's top left. */
export const LIGHTS_WIDTH = capabilities.trafficLights ? layout.trafficLightsWidth : 0;

// Windows 11's caption buttons are 46 epx wide.
export const CAPTION_BUTTON_WIDTH = 46;
/** The caption buttons' room at the window's top right. */
export const CAPTION_BUTTONS_WIDTH = capabilities.captionButtons ? 3 * CAPTION_BUTTON_WIDTH : 0;
