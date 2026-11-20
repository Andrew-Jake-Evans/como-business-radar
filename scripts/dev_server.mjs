// Local twin of the Cloudflare setup: serves the site and runs the same relay code at /api/search.
// Usage: node scripts/dev_server.mjs   →  http://localhost:8001
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Node can't import JSON without an attribute, so load the template and inject it the way Wrangler bundles it.
const src = fs.readFileSync(path.join(root, "worker/src/index.js"), "utf8")
  .replace(/import TEMPLATE from "\.\/energov_search_template\.json";/,
    `const TEMPLATE = ${fs.readFileSync(path.join(root, "worker/src/energov_search_template.json"), "utf8")};`);
const tmp = path.join(root, "scripts/.relay.local.mjs");
fs.writeFileSync(tmp, src);
const relay = (await import(pathToFileURL(tmp).href)).default;

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const port = Number(process.env.PORT || 8001);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const r = await relay.fetch(new Request(url, { method: req.method, headers: { Origin: `http://localhost:${port}` } }), {}, {});
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
    console.log(req.method, url.pathname + url.search, r.status);
    return;
  }
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(buf);
  });
}).listen(port, () => console.log(`Radar running at http://localhost:${port}`));
