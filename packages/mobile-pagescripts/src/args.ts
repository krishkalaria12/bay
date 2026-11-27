/** What a page script's arguments can hold: anything JSON carries. */
export type ScriptArgs = { readonly [name: string]: ScriptValue };

type ScriptValue = string | number | boolean | null | readonly ScriptValue[] | { readonly [key: string]: ScriptValue };

/**
 * Runs a page script that reads its arguments from `args`. Each script is one text both apps share
 * (resources/pagescripts.json), so arguments go in as JSON ahead of it rather than into the text.
 */
export function withArgs(script: string, args: ScriptArgs): string {
  return `const args = ${JSON.stringify(args)};\n${script}`;
}
