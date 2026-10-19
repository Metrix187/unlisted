import { heatColor, scoreColor } from "@unlisted/ui";
import type { FMap } from "@unlisted/vision";
import { useEffect, useRef } from "preact/hooks";

// the heat map is tiny (256px). we paint it at native size and let css stretch + blur it, which is
// exactly the soft glow we want and costs nothing
function HeatCanvas({ heat, cool }: { heat: FMap; cool: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = heat.width;
    c.height = heat.height;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(heat.width, heat.height);
    for (let i = 0; i < heat.data.length; i++) {
      const h = heat.data[i];
      const [r, g, b] = heatColor(h);
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = b;
      // cool stays a faint green wash, hot gets properly red
      const t = Math.max(0, Math.min(1, (h - 0.12) / 0.7));
      img.data[i * 4 + 3] = Math.round(255 * (cool + (0.65 - cool) * t * t * (3 - 2 * t)));
    }
    ctx.putImageData(img, 0, 0);
  }, [heat, cool]);
  return <canvas ref={ref} class="heat" aria-hidden="true" />;
}

// cool = how visible the green wash is where nothing identifying is left. louder on the result screen
type Props = { src: string; heat?: FMap; alt: string; testId?: string; cool?: number };

export function Photo({ src, heat, alt, testId, cool = 0.1 }: Props) {
  return (
    <div class="photo" data-testid={testId}>
      <img src={src} alt={alt} />
      {heat && <HeatCanvas heat={heat} cool={cool} />}
    </div>
  );
}

export function Score({ value, label = "how matchable" }: { value: number; label?: string }) {
  return (
    <span class="score" data-testid="score">
      <span class="score-num" style={{ color: scoreColor(value) }}>
        {value}
      </span>
      <span class="u-muted">
        {" "}
        / 100 {label.toLowerCase()} <span class="u-tag">rough</span>
      </span>
    </span>
  );
}
