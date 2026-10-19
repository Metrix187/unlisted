import type { ComponentChildren } from "preact";

export function Note({ children }: { children: ComponentChildren }) {
  return (
    <p class="u-note" role="note">
      {children}
    </p>
  );
}
