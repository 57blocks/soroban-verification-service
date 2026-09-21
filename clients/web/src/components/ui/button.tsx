import { forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * One button shape: a 6px-radius rectangle that lifts on hover. The pill with a circular icon badge it
 * replaced belonged to the palette that left with it.
 */
const buttonVariants = cva(
  "group relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-none",
  {
    variants: {
      variant: {
        primary:
          "border border-ink bg-ink text-white hover:-translate-y-0.5 hover:bg-ink-hover hover:shadow-lg",
        accent:
          "border border-yellow bg-yellow text-ink hover:-translate-y-0.5 hover:border-yellow-bright hover:bg-yellow-bright hover:shadow-lg",
        outline:
          "border border-line bg-surface text-ink hover:-translate-y-0.5 hover:bg-surface-alt hover:shadow-md",
        ghostDark:
          "border border-dark-line bg-transparent text-dark-bright hover:border-dark-dim hover:bg-dark-hover",
        ghost: "border-0 bg-transparent text-ink-warm hover:bg-surface-alt hover:text-ink",
        iconOutline:
          "border border-line-strong bg-surface text-ink hover:border-ink hover:bg-surface-alt",
      },
      size: {
        lg: "min-h-[50px] px-6 py-3.5 text-base",
        md: "min-h-11 px-5 py-2.5 text-[0.9rem]",
        sm: "min-h-9 px-4 py-2 text-[0.85rem]",
        icon: "size-9 text-[0.8rem]",
        iconSm: "size-[26px] text-[0.9rem] font-normal",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        // The console wraps its two stages in one <form>; without this a plain <Button> would default to
        // type="submit" and fire the form on every click.
        {...(asChild ? {} : { type: type ?? "button" })}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
