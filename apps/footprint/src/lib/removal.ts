import { marked } from "marked";
import type { SiteResult } from "../api";

// the guides are plain markdown in docs/REMOVAL, pulled in at build time. edit those, not this
const raw = import.meta.glob("../../../../docs/REMOVAL/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const GUIDES: Record<string, string> = Object.fromEntries(
  Object.entries(raw).map(([path, text]) => [path.split("/").pop()!.replace(/\.md$/, ""), text]),
);

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderGuide(site: SiteResult, address: string): { html: string; emails: string[] } {
  const src = GUIDES[site.site] ?? `# ${site.name}\n\nNo guide yet.`;
  const link = `[${site.blocked || site.listingUrl === site.searchUrl ? "search for your home" : "the listing"}](${site.listingUrl})`;
  const filled = src
    .replace(/\{\{listingLink\}\}/g, link)
    .replace(/\{\{listingUrl\}\}/g, site.listingUrl)
    .replace(/\{\{address\}\}/g, address);

  // pull the ```email blocks out so the ui can give them a copy button instead of rendering them
  const emails: string[] = [];
  const body = filled.replace(/```email\n([\s\S]*?)```/g, (_, text: string) => {
    emails.push(text.trim());
    return "";
  });
  const html = marked.parse(body.replace(/^# .*\n/, ""), { async: false }) as string;
  // links open in a new tab, no referrer (so the site can't tell you came from here)
  return {
    html: html.replace(
      /<a href="([^"]+)"/g,
      (_, href) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"`,
    ),
    emails,
  };
}

export async function addressKey(address: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address.toLowerCase()));
  return [...new Uint8Array(buf)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// "mark as requested" lives in this browser only, keyed on a hash so the address itself isn't sitting in
// localStorage either
export function getRequested(key: string, site: string): boolean {
  try {
    return localStorage.getItem(`footprint:req:${key}:${site}`) === "1";
  } catch {
    return false;
  }
}

export function setRequested(key: string, site: string, on: boolean) {
  try {
    if (on) localStorage.setItem(`footprint:req:${key}:${site}`, "1");
    else localStorage.removeItem(`footprint:req:${key}:${site}`);
  } catch {
    // private mode. the checkbox just won't stick, no big deal
  }
}
