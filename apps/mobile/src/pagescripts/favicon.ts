// The page's own icon: the declared one closest to 96 px (apple-touch-icon counts as 180, small ones last), never SVG (React Native's
// Image can't draw it), else /favicon.ico on the page's origin, with the page's user agent. The app downloads it once and shows the local copy.
export const FAVICON_SCRIPT = `
const links = [...document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i], link[rel~="apple-touch-icon-precomposed" i]')];
const size = (link) => parseInt((link.getAttribute("sizes") || "").split(/x/i)[0], 10) || (/apple-touch/i.test(link.rel) ? 180 : 32);
const usable = links.filter((link) => /^https?:/.test(link.href) && !/svg/i.test(link.type) && !/\\.svg([?#]|$)/i.test(link.href));
// Closest to 96 px, but anything under 48 px (blurry on a 60 px tile) only when there's nothing bigger.
const rank = (link) => (size(link) < 48 ? 1000 - size(link) : Math.abs(96 - size(link)));
usable.sort((a, b) => rank(a) - rank(b));
const href = usable[0] ? usable[0].href : /^https?:/.test(location.href) ? new URL("/favicon.ico", location.href).href : null;
// The browser's own user agent goes with the download: some sites refuse requests from unknown clients.
return href && { href, userAgent: navigator.userAgent };
`;
