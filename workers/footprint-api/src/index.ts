import { Hono } from "hono";
import { cors } from "hono/cors";
import { FIXTURE_CANONICAL, FIXTURE_HOST, fixtureFetch, fixtureListing, fixturePhotoFile } from "./fixtures";
import { type FetchFn, Polite } from "./http";
import { type Env, InputError, lookup, parseInput } from "./lookup";
import { PROXY_HOSTS } from "./sites";

// privacy notes for whoever touches this next:
//  - the address only ever lives in memory for the length of one request
//  - kv gets sha256(normalized address) as the key and photo urls/counts/dates as the value. that's it
//  - nothing here logs request bodies. errors log the site + status, never the input
//  - if you add a console.log with the address in it, the no-persistence test will yell at you

type Bindings = Env & { ALLOWED_ORIGINS?: string };

export function makeApp(
  opts: { fetch?: FetchFn; gapMs?: number; photo?: (file: string) => Promise<Response | null> } = {},
) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        const allowed = String(c.env?.ALLOWED_ORIGINS ?? "*")
          .split(",")
          .map((s: string) => s.trim());
        return allowed.includes("*") || allowed.includes(origin) ? origin || "*" : "";
      },
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 86_400,
    }),
  );

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/lookup", async (c) => {
    let body: { address?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Send JSON like {"address": "..."}.' }, 400);
    }
    if (typeof body.address !== "string") return c.json({ error: "Missing address." }, 400);
    try {
      const parsed = parseInput(body.address);
      const fixture = parsed.canonical === FIXTURE_CANONICAL || c.env?.FIXTURES === "1";
      const res = await lookup(body.address, c.env ?? {}, {
        fetch: fixture ? fixtureFetch : (opts.fetch ?? ((u, i) => fetch(u, i))),
        gapMs: fixture ? 0 : opts.gapMs,
        fixtureListing: fixture ? fixtureListing : undefined,
      });
      return c.json(res);
    } catch (e) {
      if (e instanceof InputError) return c.json({ error: e.message }, 400);
      console.error("lookup failed:", (e as Error).name);
      return c.json({ error: "Something broke on our end. Try again in a minute." }, 500);
    }
  });

  // thumbnail proxy. only for cdns whose robots.txt lets us in, and only images. the point is so the
  // listing site's cdn sees our worker instead of your ip, and so the page can read pixels (cors) to
  // sort interior from exterior
  app.get("/img", async (c) => {
    const raw = c.req.query("u");
    let u: URL;
    try {
      u = new URL(raw ?? "");
    } catch {
      return c.text("bad url", 400);
    }
    if (u.protocol !== "https:" || !PROXY_HOSTS.includes(u.hostname))
      return c.text("not a host we proxy", 403);

    if (u.hostname === FIXTURE_HOST) {
      const file = fixturePhotoFile(u.toString());
      const res = file
        ? opts.photo
          ? await opts.photo(file)
          : await c.env?.ASSETS?.fetch(new Request(`https://assets.invalid/${file}`))
        : null;
      if (!res?.ok) return c.text("no such fixture", 404);
      return new Response(res.body, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "*",
        },
      });
    }

    const polite = new Polite(opts.fetch ?? ((x, i) => fetch(x, i)), {
      gapMs: 250,
      robotsCache: c.env?.CACHE,
    });
    const res = await polite.image(u.toString());
    if ("blocked" in res) return c.text(res.blocked, res.blocked === "robots" ? 403 : 502);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return c.text("upstream said no", 502);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > 12 * 1024 * 1024) return c.text("too big", 413);
    return new Response(res.body, {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=86400",
        "access-control-allow-origin": "*",
      },
    });
  });

  return app;
}

export default makeApp();
