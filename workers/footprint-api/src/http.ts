import { type Robots, isAllowed, robotsFromResponse } from "./robots";

export const UA = "Unlisted/0.1 (+https://github.com/Metrix187/unlisted)";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type Fetched =
  | { ok: true; url: string; status: number; text: string }
  | { ok: false; reason: "robots" | "bot-wall" | "not-found" | "error"; status?: number; url: string };

// tells us we got a captcha / challenge page instead of the listing. these vendors are everywhere
const WALL_MARKERS = [
  /px-captcha/i,
  /perimeterx/i,
  /_pxAppId/,
  /captcha-delivery\.com/i,
  /cf-chl-|challenge-platform/i,
  /<title>\s*just a moment/i,
  /pardon our interruption/i,
  /access to this page has been denied/i,
  /<title>\s*access denied/i,
  /incapsula incident/i,
];

export function looksWalled(status: number, body: string) {
  if (status === 403 || status === 429 || status === 503) return true;
  return WALL_MARKERS.some((re) => re.test(body.slice(0, 20_000)));
}

// one polite fetcher per lookup. robots per host (memoized), a minimum gap between hits on the same host,
// an honest user agent, and nothing about the user in the request. no cookies, no referrer
export class Polite {
  private robots = new Map<string, Promise<Robots>>();
  private static nextSlot = new Map<string, number>();

  constructor(
    private fetchFn: FetchFn,
    private opts: { gapMs?: number; robotsCache?: KVNamespace; timeoutMs?: number } = {},
  ) {}

  private async getRobots(origin: string): Promise<Robots> {
    let p = this.robots.get(origin);
    if (!p) {
      p = (async () => {
        const key = `robots:${origin}`;
        const cached = await this.opts.robotsCache?.get(key);
        if (cached !== null && cached !== undefined) {
          const { status, text } = JSON.parse(cached) as { status: number; text: string };
          return robotsFromResponse(status, text);
        }
        let status = 0;
        let text = "";
        try {
          const res = await this.raw(`${origin}/robots.txt`);
          status = res.status;
          text = status < 300 ? await res.text() : "";
        } catch {
          status = 599;
        }
        // robots isn't user data, it's fine to keep a day of it
        await this.opts.robotsCache?.put(key, JSON.stringify({ status, text }), { expirationTtl: 86_400 });
        return robotsFromResponse(status, text);
      })();
      this.robots.set(origin, p);
    }
    return p;
  }

  private async wait(host: string) {
    const gap = this.opts.gapMs ?? 1500;
    const now = Date.now();
    const slot = Math.max(now, Polite.nextSlot.get(host) ?? 0);
    Polite.nextSlot.set(host, slot + gap);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  private async raw(url: string) {
    const host = new URL(url).host;
    await this.wait(host);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 12_000);
    try {
      return await this.fetchFn(url, {
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        },
        redirect: "follow",
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  async allowed(url: string) {
    return isAllowed(await this.getRobots(new URL(url).origin), url);
  }

  async get(url: string): Promise<Fetched> {
    if (!(await this.allowed(url))) return { ok: false, reason: "robots", url };
    let res: Response;
    try {
      res = await this.raw(url);
    } catch {
      return { ok: false, reason: "error", url };
    }
    const text = await res.text().catch(() => "");
    if (looksWalled(res.status, text)) return { ok: false, reason: "bot-wall", status: res.status, url };
    if (res.status === 404) return { ok: false, reason: "not-found", status: 404, url };
    if (!res.ok) return { ok: false, reason: "error", status: res.status, url };
    return { ok: true, url: res.url || url, status: res.status, text };
  }

  // for the image proxy: robots-checked, rate-limited, returns the raw response
  async image(url: string): Promise<Response | { blocked: "robots" | "error" }> {
    if (!(await this.allowed(url))) return { blocked: "robots" };
    try {
      return await this.raw(url);
    } catch {
      return { blocked: "error" };
    }
  }
}
