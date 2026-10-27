// Compact, Claude-friendly run summary. Units live in field names; no names, GPS or profile data.

type Num = number | null | undefined;
export interface Lap { total_distance?: Num; total_timer_time?: Num; avg_heart_rate?: Num; max_heart_rate?: Num; avg_cadence?: Num; avg_power?: Num; total_ascent?: Num }
export interface RecordSample { timestamp?: Date | string; distance?: Num; heart_rate?: Num }
export interface RunSummary { activityId: number | string; startTimeLocal?: string | null; beginTimestamp?: number | null; distance?: Num; duration?: Num; averageHR?: Num; elevationGain?: Num; activityTrainingLoad?: Num; aerobicTrainingEffect?: Num }

const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const num = (n: Num): n is number => typeof n === "number" && Number.isFinite(n);

export function formatPace(secondsPerKm: number): string {
  const total = Math.round(secondsPerKm);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const paceOf = (distanceM: number, seconds: number) => (distanceM > 0 ? formatPace((seconds / distanceM) * 1000) : null);
const mean = (values: number[]) => (values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null);

function splits(laps: Lap[]) {
  return laps.filter((l) => num(l.total_distance) && num(l.total_timer_time)).map((l, i) => ({
    split: i + 1,
    distance_m: Math.round(l.total_distance as number),
    pace_min_per_km: paceOf(l.total_distance as number, l.total_timer_time as number),
    avg_hr: num(l.avg_heart_rate) ? l.avg_heart_rate : null,
    cadence_spm: num(l.avg_cadence) ? l.avg_cadence * 2 : null, // FIT stores cadence per leg
    power_w: num(l.avg_power) ? l.avg_power : null,
  }));
}

// First half vs second half by distance, from per-second records.
function halves(records: RecordSample[]) {
  const pts = records
    .filter((r) => r.timestamp && num(r.distance))
    .map((r) => ({ t: new Date(r.timestamp as Date | string).getTime() / 1000, d: r.distance as number, hr: num(r.heart_rate) ? r.heart_rate : null }));
  if (pts.length < 10) return null;
  const total = pts[pts.length - 1].d;
  const mid = pts.findIndex((p) => p.d >= total / 2);
  if (mid <= 0) return null;
  const half = (slice: typeof pts) => ({
    pace_s: ((slice[slice.length - 1].t - slice[0].t) / (slice[slice.length - 1].d - slice[0].d)) * 1000,
    hr: mean(slice.flatMap((p) => (p.hr === null ? [] : [p.hr]))),
  });
  const first = half(pts.slice(0, mid + 1)), second = half(pts.slice(mid));
  return {
    first_half: { pace_min_per_km: formatPace(first.pace_s), avg_hr: first.hr },
    second_half: { pace_min_per_km: formatPace(second.pace_s), avg_hr: second.hr },
    pacing: second.pace_s < first.pace_s - 2 ? "negative split" : second.pace_s > first.pace_s + 2 ? "positive split" : "even",
    hr_drift_bpm: first.hr !== null && second.hr !== null ? round(second.hr - first.hr) : null,
  };
}


// --- Recovery context: how rested the body was going into the run (best effort, any part may be missing). ---

export interface RecoveryInputs {
  runDate: string; // YYYY-MM-DD, local
  runStartLocal?: string | null; // "YYYY-MM-DD HH:MM:SS"
  runStartMs?: number | null; // epoch ms
  sleep?: unknown; // sleep summaries for the run date
  hrv?: unknown; // HRV summaries for the run date
  bodyBattery?: unknown; // body battery report for the run date
  daily?: unknown; // daily summaries covering the 7 days before the run plus the run date
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const val = (v: unknown): number | undefined => (num(v as Num) ? (v as number) : undefined);
const pick = (items: unknown[], key: string, date: string): Obj | undefined => obj(items.find((i) => obj(i)?.[key] === date)) ?? obj(items[items.length - 1]);

export function summariseRecovery(input: RecoveryInputs) {
  const out: Record<string, unknown> = {};

  const sleep = pick(arr(input.sleep), "calendarDate", input.runDate);
  if (sleep && val(sleep.sleepTimeSeconds) !== undefined) {
    const overall = obj(obj(sleep.sleepScores)?.overall);
    out.sleep_hours = round((sleep.sleepTimeSeconds as number) / 3600, 1);
    if (val(overall?.value) !== undefined) { out.sleep_score = overall!.value; out.sleep_score_label = String(overall!.qualifierKey ?? "").toLowerCase() || undefined; }
    for (const [key, field] of [["deep_min", "deepSleepSeconds"], ["rem_min", "remSleepSeconds"], ["awake_min", "awakeSleepSeconds"]] as const) {
      if (val(sleep[field]) !== undefined) out[key] = Math.round((sleep[field] as number) / 60);
    }
  }

  const hrv = pick(arr(obj(input.hrv)?.hrvSummaries), "calendarDate", input.runDate);
  if (hrv && val(hrv.lastNightAvg) !== undefined) {
    const low = val(obj(hrv.baseline)?.balancedLow), high = val(obj(hrv.baseline)?.balancedUpper), last = hrv.lastNightAvg as number;
    out.hrv_last_night_ms = last;
    if (low !== undefined && high !== undefined) {
      out.hrv_baseline_ms = [low, high];
      out.hrv_vs_baseline = last < low ? "below" : last > high ? "above" : "within";
    }
    if (typeof hrv.status === "string" && hrv.status !== "NONE") out.hrv_status = hrv.status.toLowerCase();
  }

  const days = arr(obj(input.daily)?.data).map(obj).filter((d): d is Obj => !!d);
  const resting = (d: Obj) => val(obj(d.heartRate)?.restingValue);
  const today = days.find((d) => d.calendarDate === input.runDate);
  const previousResting = days.filter((d) => d.calendarDate !== input.runDate).flatMap((d) => (resting(d) !== undefined ? [resting(d) as number] : []));
  if (today && resting(today) !== undefined) {
    out.resting_hr_bpm = resting(today);
    if (previousResting.length >= 3) out.resting_hr_vs_prev_week_bpm = round((resting(today) as number) - previousResting.reduce((a, b) => a + b, 0) / previousResting.length);
  }

  const battery = pick(arr(input.bodyBattery), "date", input.runDate);
  const startMs = input.runStartMs;
  if (battery && num(startMs)) {
    const before = arr(battery.bodyBatteryValuesArray).flatMap((p) => (Array.isArray(p) && num(p[0]) && num(p[1]) && p[0] <= startMs ? [[p[0], p[1]] as [number, number]] : []));
    if (before.length) out.body_battery_at_run_start = before[before.length - 1][1];
  }
  const startKey = input.runStartLocal?.replace(" ", "T").slice(0, 19);
  const event = arr(obj(today?.bodyBattery)?.activityEvents).map(obj).find((e) => e?.eventType === "ACTIVITY" && String(e.eventStartTimeLocal).slice(0, 19) === startKey);
  if (event && val(event.bodyBatteryImpact) !== undefined) out.body_battery_run_impact = event.bodyBatteryImpact;

  return Object.keys(out).length ? out : null;
}

export function analyse(laps: Lap[], records: RecordSample[], run: RunSummary | undefined, previous: RunSummary[], recovery: ReturnType<typeof summariseRecovery> = null) {
  const timed = laps.filter((l) => num(l.total_distance) && num(l.total_timer_time));
  const distance = timed.reduce((a, l) => a + (l.total_distance as number), 0);
  const seconds = timed.reduce((a, l) => a + (l.total_timer_time as number), 0);
  const hrLaps = timed.filter((l) => num(l.avg_heart_rate));
  const hrWeight = hrLaps.reduce((a, l) => a + (l.total_timer_time as number), 0);
  const avgHr = hrWeight ? round(hrLaps.reduce((a, l) => a + (l.avg_heart_rate as number) * (l.total_timer_time as number), 0) / hrWeight) : null;
  const maxHr = laps.reduce((max, l) => (num(l.max_heart_rate) && l.max_heart_rate > max ? l.max_heart_rate : max), 0) || null; // reduce, not Math.max(...spread): lap count comes from the provider
  const cadenceLaps = timed.filter((l) => num(l.avg_cadence));
  const cadence = cadenceLaps.length ? round((cadenceLaps.reduce((a, l) => a + (l.avg_cadence as number) * (l.total_timer_time as number), 0) / cadenceLaps.reduce((a, l) => a + (l.total_timer_time as number), 0)) * 2) : null;

  const prev = previous.filter((p) => num(p.distance) && num(p.duration)).map((p) => ({
    date: p.startTimeLocal?.slice(0, 10) ?? null,
    distance_km: round((p.distance as number) / 1000, 2),
    pace_min_per_km: paceOf(p.distance as number, p.duration as number),
    avg_hr: num(p.averageHR) ? p.averageHR : null,
  }));
  const prevPaces = previous.filter((p) => num(p.distance) && num(p.duration)).map((p) => ((p.duration as number) / (p.distance as number)) * 1000);
  const prevHr = previous.flatMap((p) => (num(p.averageHR) ? [p.averageHR] : []));

  return {
    activity_id: String(run?.activityId ?? ""),
    date_local: run?.startTimeLocal ?? null,
    distance_km: round(distance / 1000, 2),
    duration_min: round(seconds / 60, 1),
    avg_pace_min_per_km: paceOf(distance, seconds),
    avg_hr: avgHr,
    max_hr: maxHr,
    avg_cadence_spm: cadence,
    elevation_gain_m: num(run?.elevationGain) ? Math.round(run.elevationGain) : null,
    training_load: num(run?.activityTrainingLoad) ? Math.round(run.activityTrainingLoad) : null,
    aerobic_training_effect: num(run?.aerobicTrainingEffect) ? run.aerobicTrainingEffect : null,
    splits: splits(laps),
    ...(halves(records) ?? {}),
    recovery,
    previous_runs: prev,
    vs_previous: prev.length ? {
      pace_delta_s_per_km: seconds && distance ? Math.round((seconds / distance) * 1000 - prevPaces.reduce((a, b) => a + b, 0) / prevPaces.length) : null,
      avg_hr_delta_bpm: avgHr !== null && prevHr.length ? round(avgHr - prevHr.reduce((a, b) => a + b, 0) / prevHr.length) : null,
      note: "negative pace delta = faster than the previous runs' average",
    } : null,
  };
}
