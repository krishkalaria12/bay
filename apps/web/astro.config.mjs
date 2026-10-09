// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // Keep in step with site.url in src/site.ts.
  site: "https://bay.krishkalaria.in",
  // Pages are folders (/switch-from-arc/index.html), so their one address ends in a slash.
  trailingSlash: "always",
  integrations: [
    react(),
    sitemap({
      filter: (page) => !/\/(og|404)\/?$/.test(page),
      // Every page is rebuilt together, so the build's date is each page's last change.
      lastmod: new Date(),
    }),
  ],
  vite: { plugins: [tailwindcss()] },
});
