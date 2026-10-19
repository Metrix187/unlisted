import type { ComponentChildren } from "preact";

type Props = {
  label: ComponentChildren;
  hint?: ComponentChildren;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (next: boolean) => void;
  testId?: string;
};

export function Toggle({ label, hint, checked, disabled, title, onChange, testId }: Props) {
  return (
    <label class="u-toggle" title={title}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="u-toggle-label">{label}</span>
      {hint && <span class="u-toggle-hint">{hint}</span>}
    </label>
  );
}
