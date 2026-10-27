export class GarminError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "unknown error");
