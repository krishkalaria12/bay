import { bouncySpring } from "../../lib/springs";

// Constants for live folders' meetings on screen: the calendar preview, the meeting alert and the countdown badge.

export const JOINABLE_BEFORE_MS = 10 * 60_000;
export const COUNTDOWN_WITHIN_MIN = 10;

export const MEETING_ALERT_WIDTH = 300;
// Animated's old spring: speed 14, bounciness 6.
export const MEETING_ALERT_SPRING = bouncySpring(14, 6);
// Animated's old springs: in at speed 16, bounciness 10; out without a bounce.
export const MEETING_BADGE_IN = bouncySpring(16, 10);
export const MEETING_BADGE_OUT = bouncySpring(16, 0);
