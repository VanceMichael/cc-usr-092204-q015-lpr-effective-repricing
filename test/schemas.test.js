import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = new URL("../", import.meta.url);
const read = async (p) => JSON.parse(await readFile(new URL(p, ROOT), "utf8"));

const CASES = [
  ["contracts/context.schema.json", "fixtures/context.json"],
  ["contracts/lpr-quote.schema.json", "fixtures/lpr-quotes.json", "quotes"],
  ["contracts/loan-contract.schema.json", "fixtures/loan-contracts.json", "contracts"],
  ["contracts/change-event.schema.json", "fixtures/change-events.json", "events"],
  ["contracts/repayment-schedule.schema.json", "fixtures/repayment-schedules.json", "schedules"],
  ["contracts/interest-entry.schema.json", "fixtures/interest-entries.json", "entries"],
  ["contracts/inbound-delivery.schema.json", "fixtures/inbound-deliveries.json", "deliveries"],
];

for (const [schemaPath, fixturePath, listKey] of CASES) {
  test(`Schema 校验 ${fixturePath}`, async () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(await read(schemaPath));
    const data = await read(fixturePath);
    const rows = listKey ? data[listKey] : data;
    assert.ok(Array.isArray(rows) ? rows.length > 0 : rows, "样例数据不应为空");
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      assert.equal(validate(row), true, JSON.stringify(validate.errors, null, 2));
    }
  });
}
