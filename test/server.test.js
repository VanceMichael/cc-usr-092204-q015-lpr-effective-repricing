import test from "node:test";
import assert from "node:assert/strict";
import { bootstrap } from "../src/bootstrap.js";
import { buildServer } from "../src/server.js";
import { FIXED_NOW } from "./helpers.js";

async function startTestServer(t) {
  const { service } = await bootstrap({ clock: () => FIXED_NOW });
  const server = buildServer(service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (path) => (await fetch(`${base}${path}`)).json(),
    post: async (path, body) =>
      (
        await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json(),
  };
}

test("服务入口：健康检查、领域资料与只读查询", async (t) => {
  const client = await startTestServer(t);
  assert.equal((await client.get("/health")).status, "ok");
  assert.equal((await client.get("/context")).project, "LPR生效重定价");

  const contracts = await client.get("/contracts");
  assert.ok(contracts.some((item) => item.contractId === "LN-2025-0001"));

  const plan = await client.get("/contracts/LN-2025-0001/plan");
  assert.equal(plan.version, 1);
  assert.equal(plan.status, "OFFICIAL");
  assert.equal(plan.periods[0].rateBp, 340);

  const history = await client.get("/lpr/5Y_PLUS/history");
  assert.equal(history.length, 3);
  assert.equal(history[0].effectiveTo, "2025-05-19");
});

test("服务入口：命令幂等投递与金额追踪", async (t) => {
  const client = await startTestServer(t);
  const command = {
    messageId: "M-HTTP-1",
    type: "PostDueInterest",
    occurredAt: FIXED_NOW,
    payload: { contractId: "LN-2025-0001", periodIndex: 0, postingDate: "2025-02-17" },
  };
  const first = await client.post("/commands", command);
  assert.equal(first.replayed, false);
  assert.equal(first.result.interestCents, 283333);

  // 同一消息重复投递：返回首次结果，不重复入账
  const second = await client.post("/commands", command);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);

  const explanation = await client.get("/postings/POST-LN-2025-0001-0-DUE/explanation");
  assert.equal(explanation.publication.id, "LPR-5YP-20241220");
  assert.equal(explanation.reconciliation.netInterestCents, 283333);

  const view = await client.get("/contracts/LN-2025-0001/periods/0/rate-formation");
  assert.match(view.narrative, /3\.40%/);

  const missing = await client.get("/postings/POST-NOPE/explanation");
  assert.equal(missing.error, "POSTING_NOT_FOUND");
});
