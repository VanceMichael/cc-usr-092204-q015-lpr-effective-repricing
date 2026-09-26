import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.js";
import { loadDataset } from "../src/catalog.js";

let base;
let ds;

test.before(async () => {
  ds = await loadDataset();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const get = (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: await r.json() }));

test("GET /health", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
});

test("GET /context 仍可载入领域资料", async () => {
  const r = await get("/context");
  assert.equal(r.status, 200);
  assert.ok(r.body.facts.length >= 10);
});

test("GET /contracts 返回合同与当前正式计划ID", async () => {
  const r = await get("/contracts");
  assert.equal(r.status, 200);
  assert.equal(r.body.contracts.length, 2);
  const a = r.body.contracts.find((c) => c.contract_id === "LN-A-2023-0001");
  assert.equal(a.current_official_schedule_id, "SC-A-V6");
});

test("GET /quotes 默认当前视角可见勘误；asOf 可复现勘误前视角", async () => {
  const after = await get("/quotes?tenor=1Y&date=2024-12-20");
  assert.equal(after.status, 200);
  assert.equal(after.body.quote.quote_id, "Q-1Y-2024-12-ERR");
  assert.equal(after.body.quote.rate_bps, 315);

  const before = await get("/quotes?tenor=1Y&date=2024-12-20&asOf=2024-12-20T11:00:00%2B08:00");
  assert.equal(before.body.quote.quote_id, "Q-1Y-2024-12");
  assert.equal(before.body.quote.rate_bps, 310);

  const bad = await get("/quotes?tenor=1Y");
  assert.equal(bad.status, 400);
});

test("GET /contracts/:id/schedule 支持时点回放，落败草稿永不返回", async () => {
  const now = await get("/contracts/LN-A-2023-0001/schedule");
  assert.equal(now.body.schedule.schedule_id, "SC-A-V6");
  const at2025 = await get("/contracts/LN-A-2023-0001/schedule?date=2025-09-25");
  assert.equal(at2025.body.schedule.schedule_id, "SC-A-V4");
  // 系统权威时间轴：周末顺延期，新版本创建前旧版本仍在系统中
  const beforeCreate = await get(
    "/contracts/LN-B-2024-0002/schedule?asAt=2025-09-22T09:59:59%2B08:00",
  );
  assert.equal(beforeCreate.body.timeline, "system_authority");
  assert.equal(beforeCreate.body.schedule.schedule_id, "SC-B-V6");
  const afterCreate = await get(
    "/contracts/LN-B-2024-0002/schedule?asAt=2025-09-22T10:00:00%2B08:00",
  );
  assert.equal(afterCreate.body.schedule.schedule_id, "SC-B-V7");
  const missing = await get("/contracts/NO-SUCH/schedule");
  assert.equal(missing.status, 404);
});

test("GET /contracts/:id/periods/:n/explain 给出利率形成", async () => {
  const r = await get("/contracts/LN-A-2023-0001/periods/37/explain");
  assert.equal(r.status, 200);
  assert.equal(r.body.rate.effective_rate_bps, 370);
  assert.equal(r.body.quote.source.publisher, "全国银行间同业拆借中心");
  assert.match(r.body.narrative, /3.70%/);
  const old = await get("/contracts/LN-B-2024-0002/periods/7/explain?scheduleId=SC-B-V3");
  assert.match(old.body.narrative, /2.80%/);
});

test("GET /entries/:id/trace 从金额追到报价与批准变更", async () => {
  const correction = ds.entries.find((e) => e.kind === "correction");
  const r = await get(`/entries/${correction.entry_id}/trace`);
  assert.equal(r.status, 200);
  assert.equal(r.body.broken, false);
  assert.equal(r.body.quote.quote_id, "Q-1Y-2024-12-ERR");
  assert.equal(r.body.approved_change.approval_ref, "APV-ERRC-20250122-002");
  assert.ok(r.body.related_entries.some((x) => x.relation === "correction_of"));
  const nf = await get("/entries/NOPE/trace");
  assert.equal(nf.status, 404);
});

test("未知路径 404", async () => {
  const r = await get("/nope");
  assert.equal(r.status, 404);
});
