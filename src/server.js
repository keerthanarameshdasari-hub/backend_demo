// Placeholder backend entry point until the real API is added.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}).listen(port, () => {
  console.log(`backend_demo listening on ${port}`);
});
