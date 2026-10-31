// robots.txt (RFC 9309): obey the groups that name our product token, else the "*" groups; within them the
// longest matching rule wins, and Allow wins a tie. An unreachable file (5xx, 429, network error) means stay out.

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export type RobotsPolicy =
  | { kind: "rules"; rules: RobotsRules }
  | { kind: "allow-all"; reason: string }
  | { kind: "disallow-all"; reason: string };

interface Group {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export function parseRobots(text: string, productToken: string): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let collectingAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !collectingAgents) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (field === "allow" || field === "disallow") {
      collectingAgents = false;
      if (current && value) current[field].push(value);
    } else {
      collectingAgents = false;
    }
  }
  const token = productToken.toLowerCase();
  const named = groups.filter((g) => g.agents.includes(token));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  return { allow: chosen.flatMap((g) => g.allow), disallow: chosen.flatMap((g) => g.disallow) };
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/** Whether a path (with its query string) may be fetched under these rules. */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (pathAndQuery === "/robots.txt") return true;
  if (policy.kind === "allow-all") return true;
  if (policy.kind === "disallow-all") return false;
  let best = { length: -1, allow: true };
  for (const [patterns, allow] of [
    [policy.rules.allow, true],
    [policy.rules.disallow, false],
  ] as const) {
    for (const p of patterns) {
      if (!patternMatches(p, pathAndQuery)) continue;
      if (p.length > best.length || (p.length === best.length && allow)) best = { length: p.length, allow };
    }
  }
  return best.allow;
}

/** RFC 9309 section 2.3.1: how the robots.txt response status decides access. */
export function policyFromResponse(status: number | null, body: string, productToken: string): RobotsPolicy {
  if (status === null) return { kind: "disallow-all", reason: "robots.txt could not be fetched" };
  if (status >= 200 && status < 300) return { kind: "rules", rules: parseRobots(body, productToken) };
  if (status === 429 || status >= 500) return { kind: "disallow-all", reason: `robots.txt returned ${status}` };
  return { kind: "allow-all", reason: `robots.txt returned ${status}` };
}
