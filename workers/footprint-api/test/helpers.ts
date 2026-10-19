import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const page = (name: string) => readFileSync(join(ROOT, "fixtures", "pages", `${name}.html`), "utf8");
export const robotsFile = (host: string) =>
  readFileSync(join(ROOT, "fixtures", "robots", `${host}.txt`), "utf8");

// just enough of KVNamespace for the worker, plus a way to peek at everything that got written
export class MemoryKV {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.store.set(k, v);
  }
  async delete(k: string) {
    this.store.delete(k);
  }
  dump() {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
  }
}

export const photo = async (file: string) =>
  new Response(readFileSync(join(ROOT, "fixtures", "photos", file)));
