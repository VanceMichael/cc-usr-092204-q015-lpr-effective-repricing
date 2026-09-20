import { readFile } from "node:fs/promises";

export async function loadContext(path = new URL("../fixtures/context.json", import.meta.url)) {
  return JSON.parse(await readFile(path, "utf8"));
}
