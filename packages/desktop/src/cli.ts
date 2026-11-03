import { requireOptionalNativeModule, type EventSubscription } from "@bay/platform/native";

export type CliInstallResult = {
  ok: boolean;
  appVersion: string;
  binPath?: string;
  version?: string;
  rcFile?: string;
  error?: string;
  installedVersion?: string | null;
  lines: string[];
};

type CliNative = {
  installedVersion(): string | null;
  install(): Promise<CliInstallResult>;
  addListener(name: "onInstallLine", listener: (event: { line: string }) => void): EventSubscription;
};

const Cli = requireOptionalNativeModule<CliNative>("BayCli");

export const installedCliVersion = (): string | null => Cli?.installedVersion() ?? null;

export const installCli = (): Promise<CliInstallResult> =>
  Cli ? Cli.install() : Promise.resolve({ ok: false, appVersion: "", error: "This build of Bay can't install the bay command.", lines: [] });

export const onCliInstallLine = (listener: (line: string) => void): EventSubscription =>
  Cli?.addListener("onInstallLine", (event) => listener(event.line)) ?? { remove() {} };
