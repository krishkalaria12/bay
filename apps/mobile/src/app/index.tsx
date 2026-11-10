import { installCrashReports } from "@/crashReports";

import { BrowserScreen } from "@/browser/BrowserScreen";

// A crash in a release build says nothing, so Bay keeps what happened (B8). The watch goes on before the first
// screen, so nothing that goes wrong on the way there is lost.
installCrashReports();

export { BrowserScreen as default };
