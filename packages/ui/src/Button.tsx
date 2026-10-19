import type { ComponentChildren, JSX } from "preact";

type Props = Omit<JSX.HTMLAttributes<HTMLButtonElement>, "type"> & {
  variant?: "primary" | "plain" | "link";
  big?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
  children: ComponentChildren;
};

export function Button({ variant = "plain", big, class: cls, type = "button", ...rest }: Props) {
  const classes = ["u-btn", variant !== "plain" && `u-btn--${variant}`, big && "u-btn--big", cls]
    .filter(Boolean)
    .join(" ");
  return <button type={type} class={classes} {...rest} />;
}
