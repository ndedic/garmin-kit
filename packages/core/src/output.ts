import { sanitize } from "./errors.js";

// JSON.stringify escapes C0 control characters but not DEL or C1 (U+007F-U+009F, which include terminal
// escape introducers such as U+009B) or the line separators. Provider text is untrusted, so escape them too.
// eslint-disable-next-line no-control-regex
const RISKY = /[\u007f-\u009f\u2028\u2029]/g;
const escape = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** Text for a tool result, safe to print to a terminal or hand to a model. Plain strings are sanitised. */
export function serialize(result: unknown, pretty = false): string {
  if (typeof result === "string") return sanitize(result);
  return JSON.stringify(result, null, pretty ? 2 : undefined).replace(RISKY, escape);
}
