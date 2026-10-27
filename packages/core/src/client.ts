import AdmZip from "adm-zip";
import FitParser from "fit-file-parser";
import { GarminError, errorMessage } from "./errors.js";

export const base = "https://personal.connectapi.garmin.com";
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const HTTP_HINTS: Record<number, string> = {
  401: "the API key or token was rejected; create a new key under Profile & Account → Settings → Personal API Key",
  403: "access denied; the key may be revoked or lacks access to this resource",
  404: "not found; check the activity ID",
  429: "rate limited; try again shortly",
};

const retryable = (status: number) => status === 429 || status >= 500;

export async function request(path: string, init: RequestInit): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    try {
      const response = await fetch(`${base}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }) // never follow a redirect: the key/token go only to the fixed Garmin origin;
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (!last && retryable(response.status)) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      const hint = HTTP_HINTS[response.status];
      throw new GarminError(`Garmin returned HTTP ${response.status} (${response.statusText})${hint ? `: ${hint}` : ""}`, response.status);
    } catch (error) {
      if (error instanceof GarminError) throw error;
      if (last) throw new GarminError(`Request failed: ${errorMessage(error)}`);
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

export async function getJson(token: string, path: string): Promise<unknown> {
  const body = await request(path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!body.length) return null; // some endpoints return an empty body when there is no data
  try { return JSON.parse(body.toString("utf8")); }
  catch { throw new GarminError("Garmin returned invalid JSON."); }
}

export const getActivityZip = (token: string, id: string): Promise<Buffer> =>
  request(`/download-service/files/activity/${id}?view=download`, { headers: { Authorization: `Bearer ${token}`, Accept: "*/*" } });

export const runsPath = (limit: number, date?: string): string => {
  const query = new URLSearchParams({ start: "0", limit: String(limit), activityType: "running" });
  if (date) { query.set("startDate", date); query.set("endDate", date); }
  return `/activitylist-service/activities/search/activities?${query}`;
};

const query = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;

// Wellness endpoints (paths as used by Garmin's own personal-api client).
export const sleepPath = (date: string) => `/sleep-service/sleep/dailySleep${query({ date })}`;
export const sleepSummariesPath = (startDate: string, endDate: string) => `/sleep-service/sleep/dailySleepSummariesByDate${query({ startDate, endDate })}`;
export const hrvPath = (date: string) => `/hrv-service/hrv/${date}`;
export const hrvSummariesPath = (startDate: string, endDate: string) => `/hrv-service/hrv/daily/${startDate}/${endDate}`;
export const bodyBatteryPath = (startDate: string, endDate: string) => `/wellness-service/wellness/bodyBattery/reports/daily${query({ startDate, endDate })}`;
export const heartRatePath = (date: string) => `/wellness-service/wellness/dailyHeartRate${query({ date })}`;
export const dailySummariesPath = (startDate: string, endDate: string) => `/usersummary-service/v2/dailysummaries${query({ startDate, endDate })}`;

export const activityPath = (id: string): string => `/activity-service/activity/${id}`;

export function extractFit(archive: Buffer): Buffer {
  const entries = new AdmZip(archive).getEntries().filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".fit"));
  if (entries.length !== 1) throw new GarminError(`Expected one FIT file in Garmin's ZIP; found ${entries.length}.`);
  return entries[0].getData();
}

export async function parseFit(fit: Buffer, includeUnmappedMessages = false) {
  try {
    return await new FitParser({ mode: "list", force: false, includeUnmappedMessages }).parseAsync(new Uint8Array(fit).buffer);
  } catch (error) {
    throw new GarminError(`Could not parse Garmin FIT export: ${errorMessage(error)}`);
  }
}
