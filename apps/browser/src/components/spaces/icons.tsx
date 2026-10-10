import { Symbol } from "@bay/shell";
import { Text, View } from "react-native";
import { SPACE_COLORS } from "../../lib/theme";
import type { Space } from "../../store/types";
import { SYMBOL_PREFIX } from "../../lib/constants";
import type { IconChoice } from "../IconGrid";

// Arc's space icons: a set of glyphs, filled, to tell spaces apart at a glance in the switcher. [symbol, title, words]
const SPACE_SET: [string, string, string][] = [
  ["house.fill", "Home", "house"],
  ["briefcase.fill", "Work", "job office"],
  ["building.2.fill", "Company", "office business"],
  ["graduationcap.fill", "School", "study university"],
  ["chevron.left.forwardslash.chevron.right", "Code", "dev programming"],
  ["terminal.fill", "Terminal", "code shell dev"],
  ["cpu.fill", "Tech", "chip computer"],
  ["laptopcomputer", "Laptop", "computer mac"],
  ["server.rack", "Servers", "backend infra"],
  ["hammer.fill", "Projects", "build make"],
  ["wrench.and.screwdriver.fill", "Tools", "fix build"],
  ["paintpalette.fill", "Art", "design colour color"],
  ["paintbrush.pointed.fill", "Design", "art brush"],
  ["pencil", "Writing", "write edit"],
  ["book.closed.fill", "Reading", "book"],
  ["books.vertical.fill", "Library", "books study"],
  ["newspaper.fill", "News", "paper articles"],
  ["doc.text.fill", "Docs", "documents notes"],
  ["checklist", "To Do", "tasks list todo"],
  ["calendar", "Calendar", "plan schedule"],
  ["tray.fill", "Inbox", "mail"],
  ["envelope.fill", "Mail", "email inbox"],
  ["bubble.left.and.bubble.right.fill", "Chat", "messages talk"],
  ["person.fill", "Me", "personal profile"],
  ["person.2.fill", "Team", "friends people"],
  ["figure.2.and.child.holdinghands", "Family", "kids home"],
  ["music.note", "Music", "song"],
  ["headphones", "Audio", "music podcast"],
  ["guitars.fill", "Guitar", "music band"],
  ["mic.fill", "Podcast", "audio record"],
  ["film.fill", "Movies", "film cinema"],
  ["tv.fill", "TV", "watch shows streaming"],
  ["camera.fill", "Photos", "camera photography"],
  ["photo.fill", "Pictures", "images gallery"],
  ["gamecontroller.fill", "Games", "gaming play"],
  ["puzzlepiece.fill", "Puzzle", "extensions games"],
  ["cart.fill", "Shopping", "buy store"],
  ["bag.fill", "Bag", "shopping store"],
  ["gift.fill", "Gifts", "present"],
  ["banknote.fill", "Finance", "money bank"],
  ["creditcard.fill", "Payments", "card money"],
  ["chart.line.uptrend.xyaxis", "Stocks", "invest chart growth"],
  ["chart.pie.fill", "Analytics", "data chart"],
  ["airplane", "Travel", "flight trip"],
  ["car.fill", "Car", "drive"],
  ["globe.americas.fill", "World", "earth globe"],
  ["map.fill", "Maps", "places"],
  ["mountain.2.fill", "Outdoors", "hike mountains"],
  ["beach.umbrella.fill", "Holiday", "vacation beach"],
  ["figure.run", "Fitness", "run exercise"],
  ["dumbbell.fill", "Gym", "fitness workout"],
  ["sportscourt.fill", "Sports", "game court"],
  ["soccerball", "Football", "soccer sport"],
  ["bicycle", "Cycling", "bike"],
  ["fork.knife", "Food", "eat recipes"],
  ["cup.and.saucer.fill", "Café", "coffee tea"],
  ["wineglass.fill", "Drinks", "wine bar"],
  ["leaf.fill", "Nature", "plant green"],
  ["tree.fill", "Forest", "tree nature"],
  ["flame.fill", "Fire", "hot"],
  ["drop.fill", "Water", "drop"],
  ["snowflake", "Winter", "snow cold"],
  ["sun.max.fill", "Sun", "day summer"],
  ["moon.stars.fill", "Evenings", "night moon"],
  ["cloud.fill", "Cloud", "weather"],
  ["bolt.fill", "Energy", "lightning fast"],
  ["sparkles", "Magic", "sparkle ai"],
  ["pawprint.fill", "Pets", "animal"],
  ["cat.fill", "Cat", "pet animal"],
  ["dog.fill", "Dog", "pet animal"],
  ["bird.fill", "Bird", "animal"],
  ["fish.fill", "Fish", "animal sea"],
  ["ladybug.fill", "Bugs", "bug insect"],
  ["heart.fill", "Personal", "love heart"],
  ["star.fill", "Favorites", "star"],
  ["flag.fill", "Flag", "goal"],
  ["bookmark.fill", "Saved", "bookmark"],
  ["crown.fill", "Crown", "king best"],
  ["trophy.fill", "Trophy", "win award"],
  ["target", "Goals", "target aim"],
  ["lightbulb.fill", "Ideas", "idea think"],
  ["brain.head.profile", "Mind", "brain think learn"],
  ["atom", "Science", "physics"],
  ["flask.fill", "Lab", "science test chemistry"],
  ["stethoscope", "Health", "doctor medical"],
  ["cross.case.fill", "Medical", "health first aid"],
  ["lock.fill", "Private", "secure lock"],
  ["shield.fill", "Security", "safe"],
  ["key.fill", "Keys", "passwords"],
  ["globe", "Web", "internet browse"],
];

export const SPACE_SYMBOLS: (IconChoice & { title: string })[] = SPACE_SET.map(([name, title, words]) => ({
  name,
  title,
  words: `${title.toLowerCase()} ${words}`,
}));

export const profileSymbol = (icon: string | null) => (icon?.startsWith(SYMBOL_PREFIX) ? icon.slice(SYMBOL_PREFIX.length) : null);

/** The icon's name for a label: its symbol's title, the emoji itself, or "Initial". */
export function spaceIconTitle(icon: string | null): string {
  const symbol = profileSymbol(icon);
  if (symbol) return SPACE_SYMBOLS.find((s) => s.name === symbol)?.title ?? "Symbol";
  return icon ?? "Initial";
}

/** A new space's icon, as Arc gives one: the first of the set no other space uses. */
export function unusedSpaceIcon(profiles: Record<string, Pick<Space, "icon">>): string {
  const used = new Set(Object.values(profiles).map((p) => p.icon));
  const free = SPACE_SYMBOLS.find((s) => !used.has(SYMBOL_PREFIX + s.name)) ?? SPACE_SYMBOLS[0]!;
  return SYMBOL_PREFIX + free.name;
}

export function SpaceBadge({ profile, size = 26 }: { profile: Pick<Space, "name" | "color" | "icon"> & Partial<Pick<Space, "theme">>; size?: number }) {
  const swatch = profile.theme?.colors[0] ?? SPACE_COLORS[profile.color]?.swatch ?? SPACE_COLORS.plum.swatch;
  const symbol = profileSymbol(profile.icon);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: swatch,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: size >= 22 ? 0.5 : 0,
        borderColor: "rgba(0,0,0,0.12)",
      }}
    >
      {symbol ? (
        <Symbol name={symbol} size={size * 0.5} weight="semibold" color="#FFFFFF" style={{ width: size, height: size }} />
      ) : (
        <Text style={{ fontSize: profile.icon ? size * 0.55 : size * 0.46, fontWeight: "600", color: "#FFFFFF" }}>
          {profile.icon ?? (profile.name.trim()[0] ?? "?").toUpperCase()}
        </Text>
      )}
    </View>
  );
}
