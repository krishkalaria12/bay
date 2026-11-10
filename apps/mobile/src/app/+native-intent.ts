/**
 * Every link Bay receives from the system (the default browser, a link opened in another app) is a web address, and
 * Bay's only route is the browser itself. Everything goes to the root screen; BrowserScreen listens on Linking and
 * opens the page in a tab. Without this, Expo Router would read a web address as a route name.
 */
export const redirectSystemPath = (): string => "/";
