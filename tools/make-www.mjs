// Copies only the files the app needs into ./www  (for Capacitor, or any plain static upload).
// Usage: npm run build:www
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "www");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of ["index.html", "css", "js", "vendor"]) cpSync(path.join(root, f), path.join(out, f), { recursive: true });
console.log("Copied app files to", out);
