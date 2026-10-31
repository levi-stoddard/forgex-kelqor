import path from "node:path";

// Pure checks behind the main process's security boundary, kept free of Electron so the tests can run them.

/** The packaged interface is served from this origin; nothing else may load in the window. */
export const APP_ORIGIN = "app://kelqor";

/** The window's content security policy: local files only, no network access, no inline code. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True for a plain http address on this computer, the only kind of backend the desktop app talks to in Milestone 1. */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname.toLowerCase()) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The file inside the packaged interface folder that an app:// request names, or null if it points anywhere else. */
export function resolveAppAsset(rootDir: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (`${url.protocol}//${url.host}` !== APP_ORIGIN) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const root = path.resolve(rootDir);
  const file = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  return file.startsWith(root + path.sep) ? file : null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Pages of the existing web app the desktop app may open in the browser: established workflows only. */
export function isWebAppPath(value: string): boolean {
  return /^\/(dashboard|ops\/builders|orders\/[0-9a-f-]{36}|ops\/new(\?[A-Za-z0-9%=&.+_-]{0,400})?)$/.test(value);
}

/** True for an http(s) address, the only kind the app will hand to the browser (after the owner confirms). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && value.length <= 2000;
  } catch {
    return false;
  }
}
