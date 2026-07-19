export function toJsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJsonText<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
