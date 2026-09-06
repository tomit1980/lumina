// Serve the static export (`out/`) under the same `/lumina` basePath GitHub
// Pages uses, so `npm run build && npm start` previews exactly what ships.
// Zero dependencies. Usage: node scripts/serve-static.mjs [port]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../out", import.meta.url));
const BASE = "/lumina";
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 3001);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".txt": "text/plain", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff",
};

function resolve(urlPath) {
  if (urlPath === "/" || urlPath === BASE) return { file: join(ROOT, "index.html"), status: 200 };
  if (!urlPath.startsWith(BASE + "/")) return { file: join(ROOT, "404.html"), status: 404 };
  let rel = normalize(decodeURIComponent(urlPath.slice(BASE.length))).replace(/^[\/]+/, "");
  if (rel.includes("..")) return { file: join(ROOT, "404.html"), status: 404 };
  let file = join(ROOT, rel);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
  if (!existsSync(file)) return { file: join(ROOT, "404.html"), status: 404 };
  return { file, status: 200 };
}

createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  const { file, status } = resolve(pathname);
  res.writeHead(status, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`Serving out/ at http://localhost:${PORT}${BASE}/`));
