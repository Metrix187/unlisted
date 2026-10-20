# demo video

a 48 s animated walkthrough of scrub + footprint, in three sizes:

| file | size | for |
|---|---|---|
| `unlisted-demo-landscape-1920x1080.mp4` | 16:9 | youtube, the site, anywhere |
| `unlisted-demo-reel-1080x1920.mp4` | 9:16 | instagram reels / stories, tiktok |
| `unlisted-demo-feed-1080x1350.mp4` | 4:5 | instagram feed |

no audio on purpose: it's built to read with the sound off, which is how most people see it. drop a
track on in whatever editor if you want one.

## how it's made

`index.html` is the whole video. every element is a pure function of `t`, so `render.mjs` can step it one
frame at a time in headless edge and pipe the pngs into ffmpeg. no screen recording, no dropped frames.

```bash
node media/demo/render.mjs                          # all three, 60 fps, into media/demo/out/
node media/demo/render.mjs --format reel --fps 30
node media/demo/render.mjs --stills 3,10,19,31       # just pngs of those seconds, for checking layout
```

open `index.html?format=reel` in a browser and call `seek(12.5)` in the console to scrub around.

the phone screens in `assets/` are screenshots of the live apps (390×844 at 3×), the scrubbed photo is
the real output of the live app, and the noise pattern is the actual matching-noise delta from the eval,
amplified 18×. the numbers are from `eval/results/leaderboard.md`.

## reel safe zones

instagram puts its own ui over the top ~220 px, the bottom ~320 px and a strip on the right of a reel.
the reel layout keeps the text and anything important out of those.

## credits

every photo is from Open Images under CC BY 2.0. who took what is in [CREDITS.md](CREDITS.md), and the
end card names all of them.
