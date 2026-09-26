import { createServer } from "node:http";
import {
  loadContext,
  loadDataset,
  officialSchedule,
  officialScheduleAsAt,
  explainPeriod,
  traceEntry,
  effectiveQuoteAt,
  getContract,
  duplicateIdempotencyKeys,
} from "./catalog.js";

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

// 只读查询服务。所有端点只读取已发布资料，不产生任何业务效果。
export async function requestHandler(request, response) {
  const { pathname, searchParams } = new URL(request.url, "http://localhost");

  if (pathname === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (pathname === "/context") {
    json(response, 200, await loadContext());
    return;
  }

  const ds = await loadDataset();

  // 报价时点查询：/quotes?tenor=1Y&date=2024-12-23&asOf=2024-12-23T10:00:00+08:00
  if (pathname === "/quotes") {
    const tenor = searchParams.get("tenor");
    const date = searchParams.get("date");
    if (!tenor || !date) {
      json(response, 400, { error: "需要 tenor 与 date 参数" });
      return;
    }
    const quote = effectiveQuoteAt(ds.quotes, tenor, date, searchParams.get("asOf"));
    json(response, quote ? 200 : 404, { date, asOf: searchParams.get("asOf"), quote });
    return;
  }

  // 合同正式计划：
  //   /contracts/{id}/schedule                当前正式版本
  //   ?date=YYYY-MM-DD                        该日历日的利率适用（管辖）版本
  //   ?asAt=YYYY-MM-DDTHH:mm:ss+08:00         该系统时刻实际持有的权威版本
  let m = pathname.match(/^\/contracts\/([^/]+)\/schedule$/);
  if (m) {
    const asAt = searchParams.get("asAt");
    const date = searchParams.get("date");
    const schedule = asAt
      ? officialScheduleAsAt(ds, m[1], asAt)
      : officialSchedule(ds, m[1], date);
    json(response, schedule ? 200 : 404, {
      contract_id: m[1],
      timeline: asAt ? "system_authority" : date ? "rate_application" : "current",
      schedule,
    });
    return;
  }

  // 客户视角的每期利率形成：/contracts/{id}/periods/{n}/explain?scheduleId=...
  m = pathname.match(/^\/contracts\/([^/]+)\/periods\/(\d+)\/explain$/);
  if (m) {
    try {
      const explanation = explainPeriod(ds, m[1], Number(m[2]), searchParams.get("scheduleId"));
      json(response, 200, explanation);
    } catch (err) {
      json(response, 404, { error: err.message });
    }
    return;
  }

  // 审计视角的金额追溯：/entries/{entryId}/trace
  m = pathname.match(/^\/entries\/([^/]+)\/trace$/);
  if (m) {
    try {
      json(response, 200, traceEntry(ds, m[1]));
    } catch (err) {
      json(response, 404, { error: err.message });
    }
    return;
  }

  // 合同清单（便于发现可用ID）
  if (pathname === "/contracts") {
    json(response, 200, {
      contracts: ds.contracts.map((c) => ({
        contract_id: c.contract_id,
        product: c.product,
        principal_cents: c.principal_cents,
        current_official_schedule_id: officialSchedule(ds, c.contract_id)?.schedule_id ?? null,
      })),
    });
    return;
  }

  json(response, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  requestHandler(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: err.message });
  });
});

// 仅在直接运行时监听端口；被测试引用时只导出 requestHandler。
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8000);
  server.listen(port, "127.0.0.1", () => {
    console.log(`LPR 只读目录服务已启动：http://127.0.0.1:${port}`);
  });
}

export { server, duplicateIdempotencyKeys, getContract };
