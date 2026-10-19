import { display } from "../normalize";
import {
  type Dates,
  type Site,
  ddg,
  dedupe,
  grab,
  isoDate,
  jsonLd,
  ldDates,
  ldImages,
  scriptJson,
} from "./common";

// trulia is zillow group: same photos, same cdn underneath (behind trulia.com/pictures/thumbs_N/zillowstatic/).
// its search is robots-disallowed, so like redfin it's pasted-link only

type TNext = {
  props?: {
    homeDetails?: {
      media?: { photos?: { url?: { small?: string; large?: string; extraLarge?: string } }[] };
      dateListed?: string;
      lastSold?: { formattedDate?: string };
    };
  };
};

const RE = /\/pictures\/thumbs_(\d+)\/zillowstatic\/fp\/([a-f0-9]+)-[a-z0-9_]+\.(?:jpg|webp)/;
export const truliaKey = (u: string) => u.match(RE)?.[2] ?? u.split("?")[0];
export const truliaSize = (u: string) => {
  const m = u.match(RE);
  return m ? Number(m[1]) * 160 : 500;
};

export const trulia: Site = {
  id: "trulia",
  name: "Trulia",
  hosts: ["trulia.com"],
  searchUrl: (a) => ddg(`"${display(a)}" site:trulia.com`),
  lookupUrl: (a) => `https://www.trulia.com/json/search/location/?query=${encodeURIComponent(display(a))}`,
  parse(html) {
    const hd = (scriptJson(html, "__NEXT_DATA__") as TNext | undefined)?.props?.homeDetails;
    let urls: string[] = [];
    for (const p of hd?.media?.photos ?? []) {
      for (const v of [p.url?.extraLarge, p.url?.large, p.url?.small]) if (v) urls.push(v);
    }
    const ld = jsonLd(html);
    if (!urls.length)
      urls = [
        ...ldImages(ld),
        ...grab(
          html,
          /https:\/\/www\.trulia\.com\/pictures\/thumbs_\d+\/zillowstatic\/fp\/[a-f0-9]+-[a-z0-9_]+\.(?:jpg|webp)/,
        ),
      ];
    const dates: Dates = { ...ldDates(ld) };
    if (hd?.dateListed) dates.listed = isoDate(hd.dateListed);
    if (hd?.lastSold?.formattedDate) dates.sold = isoDate(hd.lastSold.formattedDate);
    return { photos: dedupe(urls, truliaKey, truliaSize), dates };
  },
};
