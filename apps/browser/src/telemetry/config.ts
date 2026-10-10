// Telemetry's constants: where it sends, its files and how much it keeps, batches and samples.

// MARK: Sending

// Our own collector, behind bay.krishkalaria.in: events and logs are both OTLP log records.
export const LOGS_URL = "https://bay.krishkalaria.in/otel/v1/logs";

// nginx rejects bodies over 512 KB.
export const MAX_BODY_BYTES = 500_000;

// DEV telemetry sends only with BAY_TELEMETRY=1.
export const DEV_SEND_ENV = "BAY_TELEMETRY";

export const EVENTS_SCOPE = "bay.analytics";
export const LOGS_SCOPE = "bay.app";

// MARK: Client (client.ts)

export const TELEMETRY_STATE_DOC = "telemetry.json";
export const TELEMETRY_QUEUE_DOC = "telemetry-queue.json";
export const TELEMETRY_REQUEST_LOG_DOC = "telemetry-requests.log";

export const MAX_EVENTS = 1000;
export const MAX_LOGS = 200;
export const BATCH_SIZE = 100;
export const FLUSH_DELAY_MS = 30_000;
export const URGENT_FLUSH_DELAY_MS = 3_000;
export const MAX_BACKOFF_MS = 30 * 60_000;

// MARK: Errors and logs (errors.ts, logs.ts)

export const MAX_ERRORS_PER_SESSION = 25;
export const MAX_DISTINCT_LOGS = 40;

// MARK: Command bar speed, sampled (track.ts)

export const SAMPLE_EVERY = 5;
export const MAX_SAMPLES = 500;

// MARK: Usage (usage.ts)

export const FIRST_MEMORY_SAMPLE_MS = 10 * 60_000;
export const EXTENSION_SETTLE_MS = 20_000;
