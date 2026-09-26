import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateSchema } from "../src/validate.js";
import { bootstrap } from "../src/bootstrap.js";
import { FIXED_NOW } from "./helpers.js";

async function loadJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("领域资料符合上下文契约", async () => {
  const schema = await loadJson("../contracts/context.schema.json");
  const context = await loadJson("../fixtures/context.json");
  assert.deepEqual(validateSchema(schema, context), []);
  // 契约拒绝未约定字段
  const errors = validateSchema(schema, { ...context, unexpected: true });
  assert.ok(errors.some((message) => message.includes("unexpected")));
});

test("报价样例符合报价与勘误契约", async () => {
  const schema = await loadJson("../contracts/lpr-publication.schema.json");
  const fixture = await loadJson("../fixtures/lpr-publications.json");
  for (const publication of fixture.publications) {
    assert.deepEqual(validateSchema(schema, publication), []);
  }
  // 勘误消息同样受契约约束
  const errata = {
    id: "LPR-5YP-20250520-C1",
    variety: "5Y_PLUS",
    rateBp: 345,
    publishDate: "2025-05-21",
    effectiveFrom: "2025-05-20",
    source: "全国银行间同业拆借中心",
    approvedBy: "运营方主管",
    corrects: "LPR-5YP-20250520",
    reason: "报价行数据录入错误",
  };
  assert.deepEqual(validateSchema(schema, errata), []);
  assert.ok(validateSchema(schema, { ...errata, rateBp: 0 }).length > 0);
});

test("命令信封契约约束消息标识与命令类型", async () => {
  const schema = await loadJson("../contracts/command.schema.json");
  const valid = {
    messageId: "M-2026-0001",
    type: "PostDueInterest",
    occurredAt: "2026-01-05T09:00:00.000Z",
    payload: { contractId: "LN-2025-0001", periodIndex: 0, postingDate: "2025-02-17" },
  };
  assert.deepEqual(validateSchema(schema, valid), []);
  assert.ok(validateSchema(schema, { ...valid, messageId: "含空格" }).length > 0);
  assert.ok(validateSchema(schema, { ...valid, type: "DeleteEverything" }).length > 0);
  assert.ok(validateSchema(schema, { messageId: "M-1", type: "PostDueInterest", occurredAt: "x" }).length > 0);
});

test("利率形成解释输出符合解释契约", async () => {
  const schema = await loadJson("../contracts/rate-formation.schema.json");
  const { service } = await bootstrap({ clock: () => FIXED_NOW });
  const view = service.rateFormationView("LN-2025-0001", 0);
  assert.deepEqual(validateSchema(schema, view), []);
});
