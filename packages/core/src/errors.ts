export class GarminError extends Error {}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "unknown error");
