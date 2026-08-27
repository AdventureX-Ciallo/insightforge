import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const target = join(root, "dist", "public");
await mkdir(target, { recursive: true });
await cp(join(root, "public"), target, { recursive: true });
