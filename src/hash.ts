import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

export function hashValue(value: unknown): string {
  const serialized = JSON.stringify(stable(value)) ?? "undefined";
  return createHash("sha256").update(serialized).digest("hex");
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
