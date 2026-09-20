import { createServer } from "node:http";
import { loadContext } from "./catalog.js";

const server = createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.url === "/context") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(await loadContext()));
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(8000, "127.0.0.1");
