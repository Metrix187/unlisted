// tiny metadata sniffer. we don't need to *read* exif, just prove it's gone

export type MetaReport = {
  format: "jpeg" | "png" | "other";
  exif: boolean;
  xmp: boolean;
  gps: boolean;
  iptc: boolean;
};

function ascii(bytes: Uint8Array, start: number, len: number) {
  let s = "";
  for (let i = 0; i < len && start + i < bytes.length; i++) s += String.fromCharCode(bytes[start + i]);
  return s;
}

function scanGps(bytes: Uint8Array, start: number, end: number) {
  // gps ifd pointer tag 0x8825, in either byte order. crude but it's a test helper, not a parser
  for (let i = start; i < end - 1; i++) {
    if ((bytes[i] === 0x88 && bytes[i + 1] === 0x25) || (bytes[i] === 0x25 && bytes[i + 1] === 0x88))
      return true;
  }
  return false;
}

export function inspectMetadata(input: ArrayBuffer | Uint8Array): MetaReport {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r: MetaReport = { format: "other", exif: false, xmp: false, gps: false, iptc: false };
  if (b[0] === 0xff && b[1] === 0xd8) {
    r.format = "jpeg";
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      if (marker === 0xd9 || marker === 0xda) break; // eoi / start of scan, metadata is all before this
      const len = (b[i + 2] << 8) | b[i + 3];
      const body = i + 4;
      if (marker === 0xe1) {
        const head = ascii(b, body, 29);
        if (head.startsWith("Exif")) {
          r.exif = true;
          if (scanGps(b, body, body + len - 2)) r.gps = true;
        }
        if (head.startsWith("http://ns.adobe.com/xap/1.0/")) r.xmp = true;
      }
      if (marker === 0xed) r.iptc = true;
      i = body + len - 2;
    }
  } else if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    r.format = "png";
    let i = 8;
    while (i + 8 <= b.length) {
      const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
      const type = ascii(b, i + 4, 4);
      if (type === "eXIf") r.exif = true;
      if (type === "iTXt" && ascii(b, i + 8, 17) === "XML:com.adobe.xmp") r.xmp = true;
      if (type === "IEND") break;
      i += 12 + len;
    }
  }
  return r;
}
