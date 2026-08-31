import path from "node:path";

import { bindLocalPackageCandidate } from "./dsh-profile-installation.js";

const [profileDirectory, packageName, version, archive] = process.argv.slice(2);
if (profileDirectory === undefined || packageName === undefined || version === undefined || archive === undefined) {
  throw new TypeError("usage: bind-local-package-candidate-cli <profile-directory> <package-name> <version> <archive>");
}

await bindLocalPackageCandidate(
  path.resolve(profileDirectory),
  packageName,
  version,
  path.resolve(archive),
);
