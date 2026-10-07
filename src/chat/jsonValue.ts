// 外部データ（チャットJSON）を安全にたどるための小さなヘルパー。

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function getObject(o: unknown, key: string): JsonObject | undefined {
  if (!isObject(o)) return undefined;
  const v = o[key];
  return isObject(v) ? v : undefined;
}

export function getArray(o: unknown, key: string): unknown[] | undefined {
  if (!isObject(o)) return undefined;
  const v = o[key];
  return Array.isArray(v) ? v : undefined;
}

export function getString(o: unknown, key: string): string | undefined {
  if (!isObject(o)) return undefined;
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}
