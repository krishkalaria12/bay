// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

// Keep in step with site.url in src/site.ts.
const site = "https://bay.krishkalaria.in";

export default defineConfig({
  site,
  // Pages are folders (/switch-from-arc/index.html), so their one address ends in a slash.
  trailingSlash: "always",
  integrations: [
    react(),
    sitemap({
      filter: (page) => !/\/(og|404|share)\/?$/.test(page),
      // Every page is rebuilt together, so the build's date is each page's last change.
      lastmod: new Date(),
      // Lists Bay's screenshot for image search. The Sitemap type leaves `img` out, but the writer takes it.
      serialize(item) {
        if (item.url !== `${site}/`) return item;
        return { ...item, img: [{ url: `${site}/screenshots/bay-browser-for-mac.jpg` }] };
      },
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
