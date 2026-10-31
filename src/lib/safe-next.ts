const SAME_SITE = "http://forgex.invalid";

/**
 * Only same-site paths, so ?next= can't send a signed-in user off-site. Control characters and
 * backslashes are rejected outright (browsers strip tabs, turning "/\t/evil.com" into "//evil.com"),
 * and the result must resolve to this site's origin.
 */
export function safeNext(path: string, fallback = "/dashboard"): string {
  if (!path || !path.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(path)) return fallback;
  try {
    const url = new URL(path, SAME_SITE);
    return url.origin === SAME_SITE ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}
