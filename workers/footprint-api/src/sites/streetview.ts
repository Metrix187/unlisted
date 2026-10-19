import { display } from "../normalize";
import type { Site } from "./common";

// not a listing site, and we never fetch anything from it. it's here so the removal screen can hand people
// a map link straight to their house and the "request blur" steps
export const streetview: Site = {
  id: "streetview",
  name: "Google Street View",
  hosts: ["google.com"],
  linkOnly: true,
  searchUrl: (a) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(display(a))}`,
  parse: () => ({ photos: [], dates: {} }),
};
