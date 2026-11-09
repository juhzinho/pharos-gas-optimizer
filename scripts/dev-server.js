// Local stand-in for Vercel: public/ + the API function.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import market from "../api/market.js";

const PORT = Number(process.env.PORT ?? 3160);
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8" };
http
  .createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/market") return market(req, res);
    const file = normalize(pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)));
    if (file.startsWith("..")) return res.writeHead(403).end();
    let body;
    try {
      body = await readFile(join(ROOT, file));
    } catch {
      return res.writeHead(404).end("not found");
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
