import { createHash } from "node:crypto";
import fs from "node:fs/promises";

/** Cache key that changes whenever the source file is replaced or edited. */
export async function sourceCacheKey(filePath: string, variant: string): Promise<string> {
  const st = await fs.stat(filePath);
  return createHash("sha1").update(`${filePath}|${st.size}|${st.mtimeMs}|${variant}`).digest("hex");
}

const globalPending = globalThis as unknown as { __lveInflight?: Map<string, Promise<unknown>> };
const inflight = (globalPending.__lveInflight ??= new Map());

/** Runs `work` once per key at a time; concurrent callers share the same promise. */
export function once<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = work().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
