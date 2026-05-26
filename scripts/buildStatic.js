import { cp, mkdir, rm } from "node:fs/promises";

const OUTPUT_DIR = "dist";

await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

await cp("index.html", `${OUTPUT_DIR}/index.html`);
await cp("src", `${OUTPUT_DIR}/src`, { recursive: true });

console.log(`Built static assets in ${OUTPUT_DIR}/`);
