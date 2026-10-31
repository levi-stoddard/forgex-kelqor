import fs from "node:fs";
import path from "node:path";
import type { RawResponse, Transport } from "./fetcher";

// Local test pages for automated tests and the acceptance run: one folder per host (for example
// tests/fixtures/sites/www.boise-fab.test/index.html), served by the fetcher without opening any network
// connection. The backend uses it only in test mode, which refuses the real database (src/lib/controls).

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf" };

function response(status: number, body: string | Buffer, contentType = "text/html; charset=utf-8", headers: Record<string, string> = {}): RawResponse {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return { status, headers: { "content-type": contentType, ...headers }, body: buf, truncated: false };
}

/** Every request it served, for tests that check what was (and wasn't) read. */
export interface FixtureTransport extends Transport {
  requests: string[];
}

export function fixtureTransport(root: string): FixtureTransport {
  const base = path.resolve(root);
  const requests: string[] = [];
  const serve = async (url: URL, opts: { maxBytes: number }): Promise<RawResponse> => {
    requests.push(url.toString());
    const hostDir = path.resolve(base, url.hostname.toLowerCase());
    if (!hostDir.startsWith(base + path.sep)) return response(404, "Not found");
    // A host folder can redirect: a redirects.json maps a path to a Location.
    const redirects = path.join(hostDir, "redirects.json");
    if (fs.existsSync(redirects)) {
      const map = JSON.parse(fs.readFileSync(redirects, "utf8")) as Record<string, string>;
      const to = map[url.pathname];
      if (to) return response(301, "", "text/html", { location: to });
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, path.join(rel, "index.html")];
    for (const candidate of candidates) {
      const file = path.resolve(hostDir, candidate);
      if (!file.startsWith(hostDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const body = fs.readFileSync(file);
      return { ...response(200, body.subarray(0, opts.maxBytes), TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"), truncated: body.length > opts.maxBytes };
    }
    return response(404, "Not found");
  };
  return Object.assign(serve, { requests });
}
