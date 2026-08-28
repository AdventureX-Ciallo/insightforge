import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export async function atomicWriteUtf8(path: string, contents: string) {
  const target = resolve(path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(target)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function atomicWriteJson(path: string, value: unknown) {
  await atomicWriteUtf8(path, `${JSON.stringify(value, null, 2)}\n`);
}
