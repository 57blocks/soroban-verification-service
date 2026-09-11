import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Two families of pill in the design, sharing one component: */
const badgeVariants = cva("inline-flex items-center whitespace-nowrap", {
  variants: {
    variant: {
      success: "bg-success-badge text-success-strong",
      warning: "bg-warning-badge text-warning-fg",
      danger: "bg-danger-badge text-danger-strong",
      neutral: "bg-neutral-badge text-neutral-fg",
      chip: "border border-line bg-surface-chip font-mono uppercase tracking-[0.06em] text-ink-body",
    },
    size: {
      status: "rounded-full px-2 py-1 text-[11px] font-semibold uppercase leading-none",
      tag: "rounded-full px-2.5 py-1 text-[0.72rem]",
      tagSm:
        "min-h-[22px] rounded-full px-2 py-0.5 text-[0.64rem] font-semibold tracking-[0.08em] text-ink-mute",
    },
  },
  defaultVariants: { variant: "neutral", size: "status" },
});

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof badgeVariants>;

export const Badge = ({ className, variant, size, ...props }: BadgeProps) => (
  <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
);
