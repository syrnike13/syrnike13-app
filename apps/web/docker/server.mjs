import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import handler from "./dist/server/server.js";

const port = Number.parseInt(process.env.PORT || "5000", 10);
const clientDir = resolve("dist/client");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function assetPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(clientDir, `.${normalize(decoded)}`);

  if (candidate !== clientDir && !candidate.startsWith(`${clientDir}${sep}`)) {
    return null;
  }

  return candidate;
}

async function serveAsset(req, res, pathname) {
  const filePath = assetPath(pathname);
  if (!filePath) return false;

  try {
    const file = await stat(filePath);
    if (!file.isFile()) return false;

    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypes[extname(filePath)] || "application/octet-stream");
    res.setHeader("Content-Length", file.size);

    if (pathname.startsWith("/assets/")) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else if (
      pathname === "/sw.js" ||
      pathname === "/serviceWorker.js" ||
      pathname === "/manifest.json" ||
      pathname === "/manifest.webmanifest"
    ) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    } else {
      res.setHeader("Cache-Control", "public, max-age=300");
    }

    if (req.method === "HEAD") {
      res.end();
      return true;
    }

    createReadStream(filePath).pipe(res);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function requestBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  return Readable.toWeb(req);
}

function createFetchRequest(req) {
  const origin = `http://${req.headers.host || `127.0.0.1:${port}`}`;
  const url = new URL(req.url || "/", origin);

  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: requestBody(req),
    duplex: req.method === "GET" || req.method === "HEAD" ? undefined : "half",
  });
}

function writeFetchResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!res.hasHeader("Cache-Control")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  if (response.body && response.status !== 204 && response.status !== 304) {
    Readable.fromWeb(response.body).pipe(res);
    return;
  }

  res.end();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (await serveAsset(req, res, url.pathname)) return;

    const response = await handler.fetch(createFetchRequest(req));
    writeFetchResponse(res, response);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.end("Internal Server Error");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`syrnike13 web listening on ${port}`);
});
