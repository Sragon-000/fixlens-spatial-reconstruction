import { mkdir, copyFile } from "node:fs/promises";

await mkdir(new URL("../dist/server/", import.meta.url), { recursive: true });
await copyFile(new URL("../server/index.js", import.meta.url), new URL("../dist/server/index.js", import.meta.url));
console.log("Prepared the Cloudflare Worker entry point.");
