import { config } from "dotenv";
import { resolve } from "node:path";

/** Load .env from the given directories, then ./.env. Real environment variables always win. */
export function loadEnv(...dirs: string[]): void {
  config({ path: [...dirs.map((d) => resolve(d, ".env")), resolve(process.cwd(), ".env")], quiet: true });
}

export function requireApiKey(): string {
  const key = process.env.GARMIN_PERSONAL_API_KEY?.trim();
  if (!key) throw new Error("Set GARMIN_PERSONAL_API_KEY in .env or the environment.");
  return key;
}
