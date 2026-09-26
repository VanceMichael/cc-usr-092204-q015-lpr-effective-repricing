import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadContext } from "./catalog.js";
import { bootstrap } from "./bootstrap.js";
import { DomainError } from "./errors.js";

async function readBody(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  return data ? JSON.parse(data) : {};
}

export function buildServer(service) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (code, body) => {
      response.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/health") return send(200, { status: "ok" });
      if (url.pathname === "/context") return send(200, await loadContext());

      if (request.method === "GET" && url.pathname === "/contracts") return send(200, service.listContracts());

      const planMatch = /^\/contracts\/([^/]+)\/plan$/.exec(url.pathname);
      if (request.method === "GET" && planMatch) return send(200, service.officialPlanView(planMatch[1]));

      const formationMatch = /^\/contracts\/([^/]+)\/periods\/(\d+)\/rate-formation$/.exec(url.pathname);
      if (request.method === "GET" && formationMatch) {
        return send(200, service.rateFormationView(formationMatch[1], Number(formationMatch[2])));
      }

      const historyMatch = /^\/lpr\/([^/]+)\/history$/.exec(url.pathname);
      if (request.method === "GET" && historyMatch) return send(200, service.publicationHistory(historyMatch[1]));

      const explainMatch = /^\/postings\/([^/]+)\/explanation$/.exec(url.pathname);
      if (request.method === "GET" && explainMatch) return send(200, service.explainPosting(explainMatch[1]));

      // 变更命令统一入口：信封携带 messageId，重复投递返回首次结果
      if (request.method === "POST" && url.pathname === "/commands") {
        return send(200, service.dispatch(await readBody(request)));
      }

      return send(404, { error: "NOT_FOUND", message: `未知路径：${url.pathname}` });
    } catch (error) {
      if (error instanceof DomainError) {
        const code = error.code.endsWith("NOT_FOUND") ? 404 : 409;
        return send(code, { error: error.code, message: error.message });
      }
      return send(500, { error: "INTERNAL", message: error.message });
    }
  });
}

export async function start(port = 8000) {
  const { service } = await bootstrap();
  const server = buildServer(service);
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await start();
  console.log(`LPR生效重定价服务已启动：http://127.0.0.1:${server.address().port}`);
}
