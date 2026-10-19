import { type Address, streetLine } from "../normalize";
import { type Dates, type Site, dedupe, grab, isoDate, scriptJson, slugTitle } from "./common";

// realtor.com: __NEXT_DATA__ has the property, photos live on ap.rdcpix.com with the size baked into the
// filename (-w480_h360). they accept address-only detail urls, and robots allows those, so this is the one
// site where an address lookup can even get as far as their bot wall

type RPhoto = { href?: string };
type RProp = {
  photos?: RPhoto[];
  list_date?: string;
  last_sold_date?: string;
  property_history?: { date?: string; event_name?: string }[];
};

function findProp(next: unknown): RProp | undefined {
  const pp = (next as { props?: { pageProps?: Record<string, unknown> } })?.props?.pageProps;
  if (!pp) return;
  const redux = pp.initialReduxState as { propertyDetails?: RProp } | undefined;
  return redux?.propertyDetails ?? (pp.property as RProp | undefined);
}

const SIZE = /-w(\d+)_h\d+(?:_x2)?/;
export const realtorKey = (u: string) =>
  u
    .split("?")[0]
    .replace(SIZE, "")
    .replace(/\.(jpg|webp|jpeg)$/, "");
export const realtorSize = (u: string) => Number(u.match(SIZE)?.[1] ?? 2000);

export const realtorSlug = (a: Address) =>
  [slugTitle(streetLine(a)), slugTitle(a.city), a.state.toUpperCase(), a.zip].filter(Boolean).join("_");

export const realtor: Site = {
  id: "realtor",
  name: "Realtor.com",
  hosts: ["realtor.com", "rdcpix.com"],
  searchUrl: (a) => `https://www.realtor.com/realestateandhomes-detail/${realtorSlug(a)}`,
  lookupUrl: (a) => `https://www.realtor.com/realestateandhomes-detail/${realtorSlug(a)}`,
  parse(html) {
    const prop = findProp(scriptJson(html, "__NEXT_DATA__"));
    let urls = (prop?.photos ?? []).map((p) => p.href).filter((u): u is string => !!u);
    if (!urls.length)
      urls = grab(
        html,
        /https:\/\/ap\.rdcpix\.com\/[a-z0-9]+l-m\d+[a-z]*(?:-w\d+_h\d+(?:_x2)?)?\.(?:jpg|webp)/,
      );
    const dates: Dates = {};
    if (prop?.list_date) dates.listed = isoDate(prop.list_date);
    if (prop?.last_sold_date) dates.sold = isoDate(prop.last_sold_date);
    const history = (prop?.property_history ?? [])
      .filter((h) => h.date && h.event_name)
      .map((h) => ({ date: isoDate(h.date)!, event: h.event_name! }))
      .filter((h) => h.date);
    if (history.length) dates.history = history;
    // keep the full-size original as url, and ask the cdn for a smaller rendition as thumb
    const photos = dedupe(urls, realtorKey, realtorSize).map((p) =>
      p.thumb === p.url && !SIZE.test(p.url)
        ? { url: p.url, thumb: p.url.replace(/\.(jpg|webp)$/, "-w480_h360.$1") }
        : p,
    );
    return { photos, dates };
  },
};
