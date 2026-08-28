import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
for (const [source, target] of [
  [join(root, "public"), join(root, "dist", "public")],
  [join(root, "fixtures", "golden"), join(root, "dist", "fixtures", "golden")],
]) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
}

const sourceManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const runtimeManifest = {
  name: sourceManifest.name,
  version: sourceManifest.version,
  private: true,
  type: "module",
  engines: sourceManifest.engines,
  dependencies: sourceManifest.dependencies,
};
await writeFile(join(root, "dist", "package.json"), `${JSON.stringify(runtimeManifest, null, 2)}\n`, "utf8");
