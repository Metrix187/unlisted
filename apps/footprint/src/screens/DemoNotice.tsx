import { Note } from "@unlisted/ui";

export function isDemoAddress(address: string) {
  return address.toLowerCase() === "123 example st, springfield, il 62701";
}

export function DemoNotice({ address }: { address: string }) {
  return isDemoAddress(address) ? (
    <Note>
      Fixture demo: this made-up address uses synthetic listing pages and licensed sample photos, not live
      listing results. Real automated lookups are largely blocked.
    </Note>
  ) : null;
}
