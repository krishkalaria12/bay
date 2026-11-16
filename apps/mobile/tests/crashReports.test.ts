import assert from "node:assert/strict";
import test from "node:test";

import { clearCrashReports, crashReportText, crashReports, recordCrash } from "../src/crashReports.ts";

test("what went wrong is kept, newest first", () => {
  clearCrashReports();
  recordCrash(new Error("first"));
  recordCrash(new Error("second"));

  const reports = crashReports();

  assert.equal(reports.length, 2);
  assert.equal(reports[0]?.message, "second");
  assert.equal(reports[1]?.message, "first");
});

test("only the last ten errors are kept", () => {
  clearCrashReports();

  for (let index = 0; index < 14; index += 1) recordCrash(new Error(`error ${index}`));

  const reports = crashReports();

  assert.equal(reports.length, 10);
  assert.equal(reports[0]?.message, "error 13");
  assert.equal(reports[9]?.message, "error 4");
});

test("something that is not an error is still worth keeping", () => {
  clearCrashReports();
  recordCrash("something odd");

  assert.equal(crashReports()[0]?.message, "something odd");
});

test("the report says what went wrong, and says so when nothing did", () => {
  clearCrashReports();
  assert.match(crashReportText(), /not crashed/);

  recordCrash(new Error("the page fell over"));
  assert.match(crashReportText(), /the page fell over/);
});
