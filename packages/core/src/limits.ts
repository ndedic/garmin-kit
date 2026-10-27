export const MAX_RESULT_CHARS = 200_000; // largest result handed to a model or terminal
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // largest HTTP body we buffer
export const MAX_FIT_BYTES = 100 * 1024 * 1024; // largest decompressed FIT file we accept
export const MAX_ZIP_ENTRIES = 64; // Garmin's export holds one .fit; refuse archives with many entries before parsing them

export const OVERSIZE_HINT = "Narrow the request (for example a larger everySeconds for records), or use analyse_run.";

import { GarminError } from "./errors.js";

/** Refuse output larger than the cap (used by the CLI, which is also on the model-facing path). */
export function capOutput(text: string, unlimited = false): string {
  if (!unlimited && text.length > MAX_RESULT_CHARS) {
    throw new GarminError(`Output is ${text.length} characters (limit ${MAX_RESULT_CHARS}). Narrow the request (e.g. records --every-seconds 60).`);
  }
  return text;
}
