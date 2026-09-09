import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

rmSync(fileURLToPath(new URL("../dist/tests", import.meta.url)), { force: true, recursive: true });
