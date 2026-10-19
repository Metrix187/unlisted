// a small, us-only, libpostal-flavored address normalizer. goal isn't perfect parsing, it's that
// "123 North Main Street, Apt. 4B, Springfield, Illinois 62701-1234" and "123 n main st #4b springfield il
// 62701" land on the same canonical string, so they hash to the same cache key

export type Address = {
  number: string;
  predir?: string;
  street: string; // name only, e.g. "main"
  suffix?: string; // usps abbreviation, e.g. "st"
  postdir?: string;
  unit?: string;
  city: string;
  state: string; // two-letter, lowercase
  zip?: string; // five digits
};

const STATES: Record<string, string> = {
  alabama: "al",
  alaska: "ak",
  arizona: "az",
  arkansas: "ar",
  california: "ca",
  colorado: "co",
  connecticut: "ct",
  delaware: "de",
  "district of columbia": "dc",
  florida: "fl",
  georgia: "ga",
  hawaii: "hi",
  idaho: "id",
  illinois: "il",
  indiana: "in",
  iowa: "ia",
  kansas: "ks",
  kentucky: "ky",
  louisiana: "la",
  maine: "me",
  maryland: "md",
  massachusetts: "ma",
  michigan: "mi",
  minnesota: "mn",
  mississippi: "ms",
  missouri: "mo",
  montana: "mt",
  nebraska: "ne",
  nevada: "nv",
  "new hampshire": "nh",
  "new jersey": "nj",
  "new mexico": "nm",
  "new york": "ny",
  "north carolina": "nc",
  "north dakota": "nd",
  ohio: "oh",
  oklahoma: "ok",
  oregon: "or",
  pennsylvania: "pa",
  "rhode island": "ri",
  "south carolina": "sc",
  "south dakota": "sd",
  tennessee: "tn",
  texas: "tx",
  utah: "ut",
  vermont: "vt",
  virginia: "va",
  washington: "wa",
  "west virginia": "wv",
  wisconsin: "wi",
  wyoming: "wy",
  "puerto rico": "pr",
  guam: "gu",
  "virgin islands": "vi",
};
const STATE_CODES = new Set(Object.values(STATES));

// usps pub 28, the common ones. key = anything people type, value = the abbreviation
const SUFFIXES: Record<string, string> = {
  alley: "aly",
  aly: "aly",
  avenue: "ave",
  av: "ave",
  ave: "ave",
  avn: "ave",
  boulevard: "blvd",
  blvd: "blvd",
  boul: "blvd",
  circle: "cir",
  cir: "cir",
  circ: "cir",
  court: "ct",
  ct: "ct",
  crt: "ct",
  cove: "cv",
  cv: "cv",
  crossing: "xing",
  xing: "xing",
  creek: "crk",
  crk: "crk",
  crescent: "cres",
  cres: "cres",
  drive: "dr",
  dr: "dr",
  drv: "dr",
  estates: "ests",
  ests: "ests",
  expressway: "expy",
  expy: "expy",
  freeway: "fwy",
  fwy: "fwy",
  grove: "grv",
  grv: "grv",
  heights: "hts",
  hts: "hts",
  highway: "hwy",
  hwy: "hwy",
  hill: "hl",
  hl: "hl",
  junction: "jct",
  jct: "jct",
  lane: "ln",
  ln: "ln",
  loop: "loop",
  manor: "mnr",
  mnr: "mnr",
  meadow: "mdw",
  meadows: "mdws",
  parkway: "pkwy",
  pkwy: "pkwy",
  pky: "pkwy",
  park: "park",
  path: "path",
  pike: "pike",
  place: "pl",
  pl: "pl",
  plaza: "plz",
  plz: "plz",
  point: "pt",
  pt: "pt",
  ridge: "rdg",
  rdg: "rdg",
  road: "rd",
  rd: "rd",
  row: "row",
  run: "run",
  square: "sq",
  sq: "sq",
  street: "st",
  st: "st",
  str: "st",
  terrace: "ter",
  ter: "ter",
  terr: "ter",
  trail: "trl",
  trl: "trl",
  turnpike: "tpke",
  tpke: "tpke",
  valley: "vly",
  vly: "vly",
  view: "vw",
  vw: "vw",
  village: "vlg",
  vlg: "vlg",
  walk: "walk",
  way: "way",
  wy: "way",
};

const DIRS: Record<string, string> = {
  north: "n",
  n: "n",
  south: "s",
  s: "s",
  east: "e",
  e: "e",
  west: "w",
  w: "w",
  northeast: "ne",
  ne: "ne",
  northwest: "nw",
  nw: "nw",
  southeast: "se",
  se: "se",
  southwest: "sw",
  sw: "sw",
};

const UNIT_WORDS = new Set([
  "apt",
  "apartment",
  "unit",
  "suite",
  "ste",
  "#",
  "no",
  "number",
  "rm",
  "room",
  "fl",
  "floor",
  "bldg",
  "building",
  "lot",
  "spc",
  "space",
]);

const ORDINALS: Record<string, string> = {
  first: "1st",
  second: "2nd",
  third: "3rd",
  fourth: "4th",
  fifth: "5th",
  sixth: "6th",
  seventh: "7th",
  eighth: "8th",
  ninth: "9th",
  tenth: "10th",
  eleventh: "11th",
  twelfth: "12th",
};

const CITY_WORDS: Record<string, string> = {
  saint: "st",
  "st.": "st",
  fort: "ft",
  mount: "mt",
  mt: "mt",
  ft: "ft",
};

function clean(s: string) {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/#\s*/g, " # ")
    .replace(/[^a-z0-9#,\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class AddressError extends Error {}

export function parseAddress(input: string): Address {
  let s = clean(input);
  if (!s) throw new AddressError("empty address");

  let zip: string | undefined;
  s = s.replace(/\b(\d{5})(?:-\d{4})?\s*$/, (_, z) => {
    zip = z;
    return "";
  });
  s = s.replace(/[\s,]+$/, "");

  // state: try two-word names first, then one-word names, then codes
  let state: string | undefined;
  const tail = s.split(/[\s,]+/);
  for (const n of [3, 2, 1]) {
    if (tail.length < n) continue;
    const cand = tail.slice(-n).join(" ");
    const code = STATES[cand] ?? (n === 1 && STATE_CODES.has(cand) ? cand : undefined);
    if (code) {
      state = code;
      s = s.slice(0, s.lastIndexOf(tail[tail.length - n])).replace(/[\s,]+$/, "");
      break;
    }
  }
  if (!state) throw new AddressError("couldn't find a state");

  // split street from city: commas if we have them, otherwise right after the street suffix
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  let streetPart: string;
  let city: string;
  let unitPart = "";
  if (parts.length >= 2) {
    city = parts[parts.length - 1];
    streetPart = parts[0];
    unitPart = parts.slice(1, -1).join(" ");
  } else {
    const toks = s.split(" ");
    let cut = -1;
    for (let i = 1; i < toks.length; i++) if (SUFFIXES[toks[i]]) cut = i;
    // a unit can sit between suffix and city
    let end = cut + 1;
    if (cut >= 0 && end < toks.length && DIRS[toks[end]] && toks.length - end > 1) end++;
    if (cut >= 0 && UNIT_WORDS.has(toks[end] ?? "")) end += 2;
    if (cut < 0) throw new AddressError("couldn't tell the street from the city, try adding commas");
    streetPart = toks.slice(0, end).join(" ");
    city = toks.slice(end).join(" ");
  }
  if (!city) throw new AddressError("couldn't find a city");

  let toks = `${streetPart} ${unitPart}`.trim().split(" ");
  // unit: designator + id, anywhere after the number
  let unit: string | undefined;
  for (let i = 1; i < toks.length; i++) {
    if (UNIT_WORDS.has(toks[i]) && toks[i + 1]) {
      unit = toks[i + 1].replace(/^#/, "");
      toks = [...toks.slice(0, i), ...toks.slice(i + 2)];
      break;
    }
  }

  const number = toks.shift();
  if (!number || !/^\d+[a-z]?(?:[-/]\d+[a-z]?)?$/.test(number))
    throw new AddressError("address should start with a house number");
  toks = toks.map((t) => ORDINALS[t] ?? t);

  let predir: string | undefined;
  if (toks.length > 1 && DIRS[toks[0]]) predir = DIRS[toks.shift()!];
  let postdir: string | undefined;
  if (toks.length > 1 && DIRS[toks[toks.length - 1]]) postdir = DIRS[toks.pop()!];
  let suffix: string | undefined;
  if (toks.length > 1 && SUFFIXES[toks[toks.length - 1]]) suffix = SUFFIXES[toks.pop()!];
  const street = toks.join(" ");
  if (!street) throw new AddressError("couldn't find a street name");

  return {
    number,
    predir,
    street,
    suffix,
    postdir,
    unit,
    city: city
      .split(" ")
      .map((w) => CITY_WORDS[w] ?? w)
      .join(" "),
    state,
    zip,
  };
}

export function streetLine(a: Address) {
  return [a.number, a.predir, a.street, a.suffix, a.postdir].filter(Boolean).join(" ");
}

// the cache key input. lowercase, abbreviated, unit included, zip if we have it
export function canonical(a: Address) {
  const unit = a.unit ? ` unit ${a.unit}` : "";
  return `${streetLine(a)}${unit}, ${a.city}, ${a.state}${a.zip ? ` ${a.zip}` : ""}`;
}

const title = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

// "123 N Main St, Springfield, IL 62701" for showing people and for search boxes
export function display(a: Address) {
  const unit = a.unit ? ` #${a.unit.toUpperCase()}` : "";
  return `${title(streetLine(a))}${unit}, ${title(a.city)}, ${a.state.toUpperCase()}${a.zip ? ` ${a.zip}` : ""}`;
}

export function normalize(input: string) {
  const a = parseAddress(input);
  return { address: a, canonical: canonical(a), display: display(a) };
}

export async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// listing urls bake the address into the slug. pull it back out so a pasted zillow link can drive the
// other sites too
export function addressFromListingUrl(raw: string): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  const host = u.hostname.replace(/^www\./, "");
  const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const dashes = (s: string) => s.replace(/-/g, " ");
  if (host === "zillow.com" && seg[0] === "homedetails" && seg[1]) {
    // 123-Main-St-Springfield-IL-62701 -> needs the zip/state at the end, city is ambiguous so we use a
    // comma-free form and let the parser split on the suffix
    const m = seg[1].match(/^(.*)-([A-Za-z]{2})-(\d{5})$/);
    if (m) return `${dashes(m[1])} ${m[2]} ${m[3]}`;
  }
  if (host === "redfin.com" && seg.length >= 4 && seg.includes("home")) {
    // /IL/Springfield/123-Main-St-62701/home/12345
    const [state, city, street] = seg;
    const m = street.match(/^(.*)-(\d{5})$/);
    if (m) return `${dashes(m[1])}, ${dashes(city)}, ${state} ${m[2]}`;
  }
  if (host === "realtor.com" && seg[0] === "realestateandhomes-detail" && seg[1]) {
    // 123-Main-St_Springfield_IL_62701_M12345-67890
    const p = seg[1].split("_");
    if (p.length >= 4) return `${dashes(p[0])}, ${dashes(p[1])}, ${p[2]} ${p[3]}`;
  }
  if (host === "trulia.com" && (seg[0] === "home" || seg[0] === "p")) {
    // /home/123-main-st-springfield-il-62701--2083012345
    const slug = seg[seg.length - 1].split("--")[0];
    const m = slug.match(/^(.*)-([a-z]{2})-(\d{5})$/i);
    if (m) return `${dashes(m[1])} ${m[2]} ${m[3]}`;
  }
  if (host === "homes.com" && seg[0] === "property" && seg[1]) {
    // /property/123-main-st-springfield-il/abc123/
    const m = seg[1].match(/^(.*)-([a-z]{2})(?:-(\d{5}))?$/i);
    if (m) return `${dashes(m[1])} ${m[2]}${m[3] ? ` ${m[3]}` : ""}`;
  }
  return;
}
