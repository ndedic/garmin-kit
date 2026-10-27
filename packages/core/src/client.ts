import AdmZip from "adm-zip";
import FitParser from "fit-file-parser";
import { GarminError, errorMessage } from "./errors.js";
import { MAX_FIT_BYTES, MAX_RESPONSE_BYTES, MAX_ZIP_ENTRIES } from "./limits.js";

export const base = "https://personal.connectapi.garmin.com";
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const HTTP_HINTS: Record<number, string> = {
  401: "the API key or token was rejected; create a new key under Profile & Account → Settings → Personal API Key",
  403: "access denied; the key may be revoked or lacks access to this resource",
  404: "not found; check the activity ID",
  429: "rate limited; try again shortly",
};

// Buffer a response, refusing anything larger than MAX_RESPONSE_BYTES (declared or actual).
async function readBody(response: Response): Promise<Buffer> {
  const tooLarge = () => new GarminError(`Garmin response is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB; refusing to buffer it.`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw tooLarge();
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) { await response.body.cancel().catch(() => undefined); throw tooLarge(); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const retryable = (status: number) => status === 429 || status >= 500;

// Credentials only ever go to the fixed origin: a path that could change the host is a bug, so refuse it.
function urlFor(path: string): string {
  const url = new URL(path, base);
  if (!path.startsWith("/") || path.startsWith("//") || url.origin !== new URL(base).origin) throw new GarminError("Internal error: API path must be an absolute path on the Garmin origin.");
  return url.toString();
}

export async function request(path: string, init: RequestInit): Promise<Buffer> {
  const url = urlFor(path);
  for (let attempt = 1; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    try {
      const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }) // never follow a redirect: the key/token go only to the fixed Garmin origin;
      if (response.ok) return await readBody(response);
      await response.body?.cancel().catch(() => undefined); // not consumed otherwise
      if (!last && retryable(response.status)) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      const hint = HTTP_HINTS[response.status];
      throw new GarminError(`Garmin returned HTTP ${response.status}${hint ? `: ${hint}` : ""}`, response.status);
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

// Entry count from the end-of-central-directory record, read without parsing (or allocating for) the entries.
function zipEntryCount(archive: Buffer): number {
  const floor = Math.max(0, archive.length - 22 - 0xffff);
  for (let i = archive.length - 22; i >= floor; i--) if (archive.readUInt32LE(i) === 0x06054b50) return archive.readUInt16LE(i + 10);
  throw new GarminError("Garmin's export is not a valid ZIP archive.");
}

export function extractFit(archive: Buffer): Buffer {
  if (zipEntryCount(archive) > MAX_ZIP_ENTRIES) throw new GarminError(`Garmin's ZIP has more than ${MAX_ZIP_ENTRIES} entries; refusing to parse it.`);
  const entries = new AdmZip(archive).getEntries().filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith(".fit"));
  if (entries.length !== 1) throw new GarminError(`Expected one FIT file in Garmin's ZIP; found ${entries.length}.`);
  if (entries[0].header.size > MAX_FIT_BYTES) throw new GarminError(`FIT file in Garmin's ZIP is larger than ${MAX_FIT_BYTES / 1024 / 1024} MiB; refusing to decompress it.`);
  return entries[0].getData();
}

export async function parseFit(fit: Buffer, includeUnmappedMessages = false) {
  try {
    return await new FitParser({ mode: "list", force: false, includeUnmappedMessages }).parseAsync(new Uint8Array(fit).buffer);
  } catch (error) {
    throw new GarminError(`Could not parse Garmin FIT export: ${errorMessage(error)}`);
  }
}
