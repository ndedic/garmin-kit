import AdmZip from "adm-zip";
import FitParser from "fit-file-parser";
import { GarminError, errorMessage } from "./errors.js";

const base = "https://personal.connectapi.garmin.com";
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const HTTP_HINTS: Record<number, string> = {
  401: "the API key or token was rejected; create a new key under Profile & Account → Settings → Personal API Key",
  403: "access denied; the key may be revoked or lacks access to this resource",
  404: "not found; check the activity ID",
  429: "rate limited; try again shortly",
};

const retryable = (status: number) => status === 429 || status >= 500;

async function request(path: string, init: RequestInit): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    try {
      const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (!last && retryable(response.status)) { await sleep(500 * 2 ** (attempt - 1)); continue; }
      const hint = HTTP_HINTS[response.status];
      throw new GarminError(`Garmin returned HTTP ${response.status} (${response.statusText})${hint ? `: ${hint}` : ""}`);
    } catch (error) {
      if (error instanceof GarminError) throw error;
      if (last) throw new GarminError(`Request failed: ${errorMessage(error)}`);
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
}

export async function getAccessToken(key: string): Promise<string> {
  const token = (await request("/personalapitoken-service/personal-api/personal-api-key/token", {
    method: "POST", headers: { Authorization: `ApiKey ${key}`, Accept: "*/*" },
  })).toString("utf8").trim();
  if (!token) throw new GarminError("Garmin returned an empty access token.");
  return token;
}

export async function getJson(token: string, path: string): Promise<unknown> {
  const body = await request(path, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
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
