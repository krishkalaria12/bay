/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  presets: [require("nativewind/preset"), require("@bay/tailwind-config")],
  darkMode: "media",
};
