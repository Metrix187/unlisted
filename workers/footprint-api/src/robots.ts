// robots.txt, per rfc 9309. we fetch it, we obey it, the end.

type Rule = { allow: boolean; pattern: string; re: RegExp };
type Group = { agents: string[]; rules: Rule[] };

export type Robots = { groups: Group[]; status: "ok" | "missing" | "unreachable" };

function toRegex(pattern: string) {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string): Robots {
  const groups: Group[] = [];
  let cur: Group | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !cur) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur || (key !== "allow" && key !== "disallow")) continue;
      // an empty disallow means "everything's fine", so it's not a rule at all
      if (key === "disallow" && val === "") continue;
      cur.rules.push({ allow: key === "allow", pattern: val, re: toRegex(val) });
    }
  }
  return { groups, status: "ok" };
}

// product token match: "unlisted" group if there is one, else the "*" group. groups for the same agent
// get merged, which is what the rfc says to do
function rulesFor(robots: Robots, product: string): Rule[] {
  const p = product.toLowerCase();
  const mine = robots.groups.filter((g) => g.agents.some((a) => a !== "*" && p.includes(a)));
  const chosen = mine.length ? mine : robots.groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

export function isAllowed(robots: Robots, url: string, product = "unlisted"): boolean {
  if (robots.status !== "ok") return robots.status === "missing";
  const u = new URL(url);
  const path = u.pathname + u.search;
  if (path === "/robots.txt") return true;
  let best: Rule | undefined;
  for (const r of rulesFor(robots, product)) {
    if (!r.re.test(path)) continue;
    // longest pattern wins, allow wins ties
    if (
      !best ||
      r.pattern.length > best.pattern.length ||
      (r.pattern.length === best.pattern.length && r.allow)
    )
      best = r;
  }
  return best ? best.allow : true;
}

// 4xx = no robots file, crawl away. 5xx / network trouble = assume everything is off limits
export function robotsFromResponse(status: number, text: string): Robots {
  if (status >= 200 && status < 300) return parseRobots(text);
  if (status >= 400 && status < 500) return { groups: [], status: "missing" };
  return { groups: [], status: "unreachable" };
}
