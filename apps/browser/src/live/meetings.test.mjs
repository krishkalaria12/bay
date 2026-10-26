import assert from "node:assert/strict";
import { test } from "node:test";
import { joinableMeeting } from "./meetings.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 26, 10, 0);
const event = (id, startMin, endMin, extra = {}) => ({
  id,
  occurrence: id,
  calendarId: "c",
  color: "#000",
  title: id,
  start: NOW + startMin * MIN,
  end: NOW + endMin * MIN,
  allDay: false,
  location: "",
  notes: "",
  url: "https://meet.google.com/abc-defg-hij",
  cancelled: false,
  declined: false,
  organizer: null,
  attendees: [],
  ...extra,
});
const LEAD = 10 * MIN;

test("⌃⌘J joins the meeting that's on, or about to start", () => {
  assert.equal(joinableMeeting([event("soon", 2, 30)], NOW, LEAD)?.id, "soon");
  assert.equal(joinableMeeting([event("on", -5, 25)], NOW, LEAD)?.id, "on");
  // Too far off, over, or with nothing to join: none.
  assert.equal(joinableMeeting([event("later", 45, 60)], NOW, LEAD), null);
  assert.equal(joinableMeeting([event("over", -60, -1)], NOW, LEAD), null);
  assert.equal(joinableMeeting([event("room", -5, 25, { url: "", location: "Room 4" })], NOW, LEAD), null);
});

test("declined, cancelled and all-day events aren't joined", () => {
  assert.equal(joinableMeeting([event("declined", -1, 30, { declined: true })], NOW, LEAD), null);
  assert.equal(joinableMeeting([event("cancelled", -1, 30, { cancelled: true })], NOW, LEAD), null);
  assert.equal(joinableMeeting([event("day", -600, 600, { allDay: true })], NOW, LEAD), null);
});

test("of several, the one that started last wins, else the soonest", () => {
  const events = [event("early", -30, 30), event("late", -5, 30), event("next", 5, 30)];
  assert.equal(joinableMeeting(events, NOW, LEAD)?.id, "late");
  assert.equal(joinableMeeting([event("b", 8, 30), event("a", 3, 30)], NOW, LEAD)?.id, "a");
});
