// The Library's sections, shared by its page and its sidebar.
export const SECTIONS = [
  { id: "media", title: "Media", icon: "photo.on.rectangle" },
  { id: "downloads", title: "Downloads", icon: "arrow.down.circle" },
  { id: "easels", title: "Easels", icon: "rectangle.on.rectangle" },
  { id: "spaces", title: "Spaces", icon: "square.stack" },
  { id: "boosts", title: "Boosts", icon: "paintbrush.pointed" },
  { id: "archive", title: "Archived Tabs", icon: "archivebox" },
] as const;

export type Section = (typeof SECTIONS)[number]["id"];

export function sectionOf(value?: string): Section {
  if (value === "archived-tabs" || value === "archived") return "archive";

  return SECTIONS.find((section) => section.id === value)?.id ?? "media";
}
