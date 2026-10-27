// Shapes of the Garmin payloads we compute on. Objects are loose (extra fields are kept) and every field
// we use is optional/nullable, so Garmin adding fields never breaks us while wrong types fail loudly.
import { z } from "zod";
import { GarminError } from "./errors.js";

const n = z.number().nullish();

export const RunSummarySchema = z.looseObject({
  activityId: z.union([z.number(), z.string()]),
  startTimeLocal: z.string().nullish(),
  beginTimestamp: n,
  distance: n,
  duration: n,
  averageHR: n,
  elevationGain: n,
  activityTrainingLoad: n,
  aerobicTrainingEffect: n,
});
export const RunListSchema = z.array(RunSummarySchema);

export const LapSchema = z.looseObject({
  total_distance: n, total_timer_time: n, avg_heart_rate: n, max_heart_rate: n, avg_cadence: n, avg_power: n, total_ascent: n,
});
export const LapListSchema = z.array(LapSchema);

export const RecordSchema = z.looseObject({
  timestamp: z.union([z.date(), z.string()]).nullish(), distance: n, heart_rate: n,
});
export const RecordListSchema = z.array(RecordSchema);

/** Validate a Garmin response; a mismatch becomes a clear error instead of NaN or a crash further on. */
export function parseResponse<T extends z.ZodType>(schema: T, data: unknown, what: string): z.output<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new GarminError(`Unexpected Garmin response for ${what}: ${issue.path.join(".") || "value"} ${issue.message}`);
}
