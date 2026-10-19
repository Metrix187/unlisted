# limitations

the blunt version. if you're deciding whether to trust this with something that matters, read all of it.

## the big one

**we can't tell you whether Raven, GeoSpy, or anyone else already has your home in an index.** answering
that means scraping every listing site into one giant photo database and matching against it, which is
exactly the thing we're trying to protect people from. we didn't build it. nothing here can tell you "you're
safe".

## scrub

- **it blurs the room, not you.** everything in the sharp part of the photo goes out as-is: your face, your
  clothes, what you're holding, a slice of window or wall that overlaps your outline, the color of the light
  on your skin. if the identifying thing is right behind your head, scrub can't help.
- **finding people is imperfect.** close-ups work well. small, far-away, or backlit people sometimes get
  partly blurred along with the room, and occasionally a plant or a pillar gets treated as a person and kept
  sharp. pets are found by a box detector plus a general-purpose segmenter, so their outlines are rougher.
  look at the before/after before you share.
- **no person or pet in the photo = the whole thing gets blurred.** we say so, and suggest "blur only the
  hot spots" instead, which keeps the room and blurs what looks identifying. that's a much weaker defense.
- **the heat map is a heuristic, not a model of any real attacker.** it knows about windows (bright, boxy,
  crisp-edged regions), repeating patterns (tile, wallpaper, rugs), and the furniture/fixtures a standard
  object detector knows. it doesn't know about mirrors, paintings (no detector class for them), views of a
  specific building, floor plans, or anything else a determined person would use. windows with blinds or
  curtains often don't register as windows. the 0–100 score is labeled "rough" because it is.
- **"strip metadata only" doesn't help against photo matching.** the app says this and the numbers agree.
  it's there because metadata (gps in particular) is its own leak, not because it hides the room.
- **the matching noise, on its own, does nothing we can measure.** it drives DINOv2-small's similarity
  between your photo and the noised copy to about zero, when both are squashed to 224×224 the way the
  attack sees them. but a real retrieval pipeline resizes and center-crops differently, and in the eval that
  alone washes the noise out: 99.7% top-1 for DINOv2-small with noise vs 100% without, and the other two
  models don't notice it either. where it *does* help is on top of a background scrub (blurred pixels are
  fragile), taking another 8 to 18 points off. it also needs WebGPU and an 88 MB download, it's untested
  against what social apps do to images on upload, and adversarial noise in general decays as models get
  retrained. the toggle stays labeled experimental, and it should be.
- **output is a jpeg capped at 2560 px** on the long side. huge originals get shrunk.
- **the share-sheet entry** only exists once the app is installed. if a browser somehow posted a shared
  photo before the service worker was running, that POST would hit our static host (cloudflare pages,
  which would refuse it). we haven't seen a way to make that happen, but it's the one path where a photo
  could leave the device by accident.

## footprint

- **it mostly can't look for you.** we identify as a bot, we obey robots.txt, and we don't use proxies or
  pretend to be a browser. right now that means: zillow, redfin and trulia all disallow their address
  search in robots.txt, and every site we tried (those three, realtor.com, homes.com, apartments.com)
  answers our lookups with a bot wall. so for a real address you get one honest line per site ("Zillow
  blocked us — open it yourself") and a link. the photo grid you see with the demo address is what it looks
  like when a site lets us in, which, today, none do.
- **pasted listing links get further** (robots usually allows detail pages), but still hit the bot walls.
- **the cache key is sha256 of the normalized address, and that's not anonymity.** addresses are easy to
  guess, so someone who already knows an address could check whether it's in the cache. what the hash buys
  is that we never keep a list of addresses. the cache holds public listing photo urls for 24 hours.
- **cloudflare sees the request.** the address arrives at a cloudflare worker over tls, cloudflare
  terminates tls, and the worker holds the address in memory for the length of the request. worker logs are
  off and we never log it ourselves (there's a test), but cloudflare's own edge logging is outside our
  control.
- **listing sites can see you looking at photos of your home.** zillow photos come through our worker, so
  zillow sees us, not you. redfin's and realtor's photo servers tell crawlers to stay out, so those load
  straight into your browser (no referrer, no cookies) and that site's cdn sees your ip asking for those
  photos. we say this on the page.
- **inside/outside sorting is crude.** "sky touching the top edge, plus greenery" = outside. a bright
  ceiling can read as sky; a cloudy-day exterior with no sky in frame reads as inside. photos we can't read
  pixels from (cdns without cors) don't get a badge at all.
- **the takedown steps can go stale.** the sites change their owner tools and support flows. the guides are
  plain markdown in `docs/REMOVAL/` so they're easy to fix, but nothing checks them automatically.
- **the address parser is us-only** and handles the usual shapes. unusual ones (rural routes, "123½",
  some puerto rico formats) may not parse, and the error says so.
- **photo search (the "have a photo instead?" path)** opens google lens, bing, tineye and yandex for you
  to paste into. once you paste, that search engine has your photo. we don't, but they do.

## the eval

the numbers in [eval/results/leaderboard.md](../eval/results/leaderboard.md) are real, and also narrow:

- **queries are re-shot copies of the indexed photo**, not a genuinely different photo of the room taken
  months later with the furniture moved. that's easier for the attacker than real life, so hit rates here
  are likely higher than what a real attacker gets photo-for-photo.
- **the index is 3,000 photos.** a real one is millions. more distractors make retrieval harder, so in that
  direction we're also kind to the attacker. we haven't measured how the defenses scale with index size.
- **the attackers are off-the-shelf** DINOv2 and CLIP with no fine-tuning. a purpose-built system (trained
  on interiors, using multiple photos per listing, re-ranking with local features) is stronger than
  anything here, and we can't say by how much.
- **"Open Images indoor" isn't "rental listings".** it's flickr photos tagged as rooms: real homes, but also
  hotel rooms, offices and restaurants, and a lot more people in them than listing photos have.
- **when scrub can't find a person it blurs the whole photo**, and those queries (55 of 300) basically never
  match. that flatters the headline scrub number. the leaderboard splits it out: with a person kept, the
  rate is 66.5% (DINOv2-base) and 47.3% (CLIP), not 55.7% and 38.7%.
- **matching noise was measured with the noise targeting DINOv2-small at 224×224 on the whole frame.**
  in its own terms it works (mean self-similarity −0.05). against a matcher that resizes and center-crops
  like normal ones do, it doesn't: −0.3 points for DINOv2-small, −0.3 for DINOv2-base, −1.7 for CLIP.
  training it against the attacker's preprocessing (expectation over resizes/crops) is the obvious next
  thing to try. until that shows numbers, treat the toggle as decoration.
- **one seed, one run.** no error bars. with 300 queries, differences of a few points are noise.
- **the eval itself caught a bug**: on the wasm backend the noise was a silent no-op until we switched to a
  random start. it's fixed and both backends are verified, but it's a good reminder that "the toggle was on"
  and "it did something" are different claims.
