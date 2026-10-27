// Compact, Claude-friendly run summary. Units live in field names; no names, GPS or profile data.

type Num = number | null | undefined;
export interface Lap { total_distance?: Num; total_timer_time?: Num; avg_heart_rate?: Num; max_heart_rate?: Num; avg_cadence?: Num; avg_power?: Num; total_ascent?: Num }
export interface RecordSample { timestamp?: Date | string; distance?: Num; heart_rate?: Num }
export interface RunSummary { activityId: number | string; startTimeLocal?: string; distance?: Num; duration?: Num; averageHR?: Num; elevationGain?: Num; activityTrainingLoad?: Num; aerobicTrainingEffect?: Num }

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

export function analyse(laps: Lap[], records: RecordSample[], run: RunSummary | undefined, previous: RunSummary[]) {
  const timed = laps.filter((l) => num(l.total_distance) && num(l.total_timer_time));
  const distance = timed.reduce((a, l) => a + (l.total_distance as number), 0);
  const seconds = timed.reduce((a, l) => a + (l.total_timer_time as number), 0);
  const hrLaps = timed.filter((l) => num(l.avg_heart_rate));
  const hrWeight = hrLaps.reduce((a, l) => a + (l.total_timer_time as number), 0);
  const avgHr = hrWeight ? round(hrLaps.reduce((a, l) => a + (l.avg_heart_rate as number) * (l.total_timer_time as number), 0) / hrWeight) : null;
  const maxHr = Math.max(0, ...laps.map((l) => (num(l.max_heart_rate) ? l.max_heart_rate : 0))) || null;
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
    previous_runs: prev,
    vs_previous: prev.length ? {
      pace_delta_s_per_km: seconds && distance ? Math.round((seconds / distance) * 1000 - prevPaces.reduce((a, b) => a + b, 0) / prevPaces.length) : null,
      avg_hr_delta_bpm: avgHr !== null && prevHr.length ? round(avgHr - prevHr.reduce((a, b) => a + b, 0) / prevHr.length) : null,
      note: "negative pace delta = faster than the previous runs' average",
    } : null,
  };
}
