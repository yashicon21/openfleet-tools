import http from "node:http";

export function greeting() {
  return { message: "Hello" };
}

export function createServer() {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/greeting") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(greeting()));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => console.log(`api listening on http://localhost:${port}`));
}
