import test from "node:test";
import assert from "node:assert/strict";
import { loadContext } from "../src/catalog.js";

test("领域资料可以载入", async () => {
  const context = await loadContext();
  assert.ok(context.project);
  assert.ok(context.facts.length >= 3);
  assert.ok(context.actors.length >= 3);
});
