// Uniwind turns the Tailwind classes in the app into styles, so the one stylesheet is imported for its side effects
// only. TypeScript needs to be told the import exists: a side-effect import of a file with no type declarations is an
// error on its own (TS2882).
declare module "*.css";
