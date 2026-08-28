import { isAbsolute, relative, resolve } from "node:path";

function comparable(path, platform) {
  return platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

export function outputIsInsideRepository(root, output, platform = process.platform) {
  const absoluteRoot = comparable(resolve(root), platform);
  const absoluteOutput = comparable(resolve(output), platform);
  if (!isAbsolute(resolve(output))) return false;
  const rel = relative(absoluteRoot, absoluteOutput);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}
