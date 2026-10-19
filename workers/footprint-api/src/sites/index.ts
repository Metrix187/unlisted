import { apartments } from "./apartments";
import { type Site, isHost } from "./common";
import { homes } from "./homes";
import { realtor } from "./realtor";
import { redfin } from "./redfin";
import { streetview } from "./streetview";
import { trulia } from "./trulia";
import { zillow } from "./zillow";

export * from "./common";

// order here is the order cards show up in. adding a site = new file + add it to this list
export const SITES: Site[] = [zillow, redfin, realtor, trulia, homes, apartments, streetview];

export function siteForUrl(url: string): Site | undefined {
  return SITES.find((s) => !s.linkOnly && isHost(url, s.hosts));
}

// photo cdns the image proxy will fetch from. the others' robots.txt says no, so the browser loads those
// directly instead (see /img in index.ts)
export const PROXY_HOSTS = ["photos.zillowstatic.com", "fixtures.unlisted.test"];
