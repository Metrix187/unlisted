type Props = { value: number; label?: string };

// value is 0..1, clamped because workers love sending 1.0000001
export function Progress({ value, label }: Props) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div>
      <div class="u-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div style={{ width: `${pct}%` }} />
      </div>
      {label && <p class="u-progress-label">{label}</p>}
    </div>
  );
}
