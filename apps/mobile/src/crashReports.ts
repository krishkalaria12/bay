export interface CrashReport {
  /** When it happened. */
  at: number;
  /** What went wrong. */
  message: string;
  /** Where it went wrong. */
  stack: string;
}

/** How many are kept; the newest comes first. */
const LIMIT = 10;

let reports: CrashReport[] = [];

/**
 * Keeps what went wrong (B8). A release build says nothing when it breaks, so Bay remembers the last few errors and
 * offers them from Settings, where they can be sent to whoever looks after the app.
 */
export function recordCrash(cause: unknown): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));

  reports = [{ at: Date.now(), message: error.message, stack: error.stack ?? "" }, ...reports].slice(0, LIMIT);
}

/** The errors Bay kept, newest first. */
export function crashReports(): readonly CrashReport[] {
  return reports;
}

/** Forgets the errors Bay kept. */
export function clearCrashReports(): void {
  reports = [];
}

/** The errors as text, ready to be sent. */
export function crashReportText(): string {
  if (!reports.length) return "Bay has not crashed since it was last opened.";

  return reports.map((report) => `--- ${new Date(report.at).toISOString()}\n${report.message}\n${report.stack}`).join("\n\n");
}

/**
 * Watches for the errors nothing else caught. React Native's own handler still runs, so the app behaves as it did;
 * this only keeps a copy.
 */
export function installCrashReports(): void {
  if (!ErrorUtils) return;

  const previous = ErrorUtils.getGlobalHandler();

  ErrorUtils.setGlobalHandler((cause, isFatal) => {
    recordCrash(cause);
    previous?.(cause, isFatal);
  });
}
