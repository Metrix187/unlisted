import type { ComponentChildren } from "preact";

type Props = { title: string; step?: string; children: ComponentChildren };

export function Screen({ title, step, children }: Props) {
  return (
    <main class="u-screen">
      <header class="u-header">
        <h1>{title}</h1>
        {step && <span class="u-step">{step}</span>}
      </header>
      {children}
    </main>
  );
}
