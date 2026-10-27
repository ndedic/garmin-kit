import assert from "node:assert/strict";
import { test } from "node:test";
import { summariseRecovery } from "./analyse.js";

// Shapes taken from real Personal API responses (values made up).
const run = { runDate: "2026-10-25", runStartLocal: "2026-10-25 09:01:10", runStartMs: 1792915270000 };
const fixture = {
  ...run,
  sleep: [{ calendarDate: "2026-10-25", sleepTimeSeconds: 24044, deepSleepSeconds: 7860, remSleepSeconds: 1080, awakeSleepSeconds: 1020, sleepScores: { overall: { value: 65, qualifierKey: "FAIR" } } }],
  hrv: { hrvSummaries: [{ calendarDate: "2026-10-25", lastNightAvg: 41, baseline: { balancedLow: 38, balancedUpper: 50 }, status: "NONE" }] },
  bodyBattery: [{ date: "2026-10-25", bodyBatteryValuesArray: [[1792881540000, 30], [1792908000000, 87], [1792919999000, 12]] }],
  daily: { data: [
    { calendarDate: "2026-10-22", heartRate: { restingValue: 80 } }, { calendarDate: "2026-10-23", heartRate: { restingValue: 76 } },
    { calendarDate: "2026-10-24" }, { calendarDate: "2026-10-21", heartRate: { restingValue: 72 } },
    { calendarDate: "2026-10-25", heartRate: { restingValue: 60 }, bodyBattery: { activityEvents: [
      { eventType: "SLEEP", bodyBatteryImpact: 57 },
      { eventType: "ACTIVITY", eventStartTimeLocal: "2026-10-25T09:01:10.0", bodyBatteryImpact: -17 },
    ] } },
  ] },
};

test("summarises sleep, HRV, resting HR and Body Battery going into the run", () => {
  assert.deepEqual(summariseRecovery(fixture), {
    sleep_hours: 6.7, sleep_score: 65, sleep_score_label: "fair", deep_min: 131, rem_min: 18, awake_min: 17,
    hrv_last_night_ms: 41, hrv_baseline_ms: [38, 50], hrv_vs_baseline: "within",
    resting_hr_bpm: 60, resting_hr_vs_prev_week_bpm: -16,
    body_battery_at_run_start: 87, body_battery_run_impact: -17,
  });
});

test("flags HRV outside the baseline and reports status only when Garmin has one", () => {
  const low = summariseRecovery({ ...fixture, hrv: { hrvSummaries: [{ calendarDate: "2026-10-25", lastNightAvg: 30, baseline: { balancedLow: 38, balancedUpper: 50 }, status: "UNBALANCED" }] } })!;
  assert.equal(low.hrv_vs_baseline, "below");
  assert.equal(low.hrv_status, "unbalanced");
});

test("missing or malformed data degrades to partial output, never throws", () => {
  assert.equal(summariseRecovery({ ...run }), null);
  assert.deepEqual(summariseRecovery({ ...run, sleep: "garbage", hrv: 5, bodyBattery: [null], daily: { data: [null, 3] } }), null);
  const partial = summariseRecovery({ ...run, sleep: fixture.sleep })!;
  assert.deepEqual(Object.keys(partial).sort(), ["awake_min", "deep_min", "rem_min", "sleep_hours", "sleep_score", "sleep_score_label"]);
});
