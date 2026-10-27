export class GarminError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

// Remote text can contain terminal escape sequences or other control characters; keep only \n and \t.
// eslint-disable-next-line no-control-regex
export const sanitize = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

export const errorMessage = (error: unknown): string => sanitize(error instanceof Error ? error.message : "unknown error");
