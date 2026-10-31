// `scripts/build.sh` sets the release version with `bun build --compile --define BAY_CLI_VERSION=...`.
// A run from the source tree keeps the number below.
declare const BAY_CLI_VERSION: string | undefined;

export const VERSION = typeof BAY_CLI_VERSION === "string" && BAY_CLI_VERSION ? BAY_CLI_VERSION : "0.1.0";
