// The native macOS host continues to read app.json's existing registry name.
module.exports = {
  name: "Bay",
  slug: "bay-desktop",
  platforms: ["web"],
  web: { bundler: "metro", output: "single", name: "Bay" },
};
