import { useRef, useState } from "preact/hooks";

// drag anywhere on the photo to wipe between the two. arrow keys work too
export function BeforeAfter({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    <div
      class="ba"
      ref={box}
      tabIndex={0}
      role="slider"
      aria-label="Before and after. Drag or use arrow keys to compare."
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pos)}
      data-testid="before-after"
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && move(e.clientX)}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setPos((p) => Math.max(0, p - 5));
        if (e.key === "ArrowRight") setPos((p) => Math.min(100, p + 5));
      }}
    >
      <img src={after} alt="After scrubbing" draggable={false} />
      <img
        src={before}
        alt="Before scrubbing"
        class="ba-before"
        draggable={false}
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      />
      <div class="ba-handle" style={{ left: `${pos}%` }} />
      <span class="ba-tag ba-tag--l">Before</span>
      <span class="ba-tag ba-tag--r">After</span>
    </div>
  );
}
