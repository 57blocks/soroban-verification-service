import { forwardRef } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group relative inline-flex select-none items-center justify-center whitespace-nowrap font-sans font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "border border-ink bg-ink text-white hover:bg-ink-raised",
        accent:
          "border border-yellow bg-yellow text-ink hover:border-yellow-bright hover:bg-yellow-bright",
        outline:
          "border border-ink bg-surface text-ink hover:bg-yellow [&_[data-pill-icon]]:hover:bg-ink [&_[data-pill-icon]]:hover:text-yellow",
        ghostDark:
          "border border-yellow bg-transparent text-yellow hover:border-yellow-bright hover:bg-dark-hover hover:text-yellow-bright",
        ghost:
          "border-0 bg-transparent text-ink-warm hover:bg-yellow-soft hover:text-ink",
        iconOutline:
          "border border-line-strong bg-surface text-ink hover:border-ink hover:bg-yellow",
      },
      size: {
        pill: "min-h-11 gap-2.5 rounded-full py-1.5 pl-[22px] pr-1.5 text-[0.9rem]",
        pillSm: "min-h-9 gap-2.5 rounded-full py-1 pl-[18px] pr-1 text-[0.85rem]",
        pillHero:
          "min-h-[38px] gap-3 rounded-full py-1 pl-[18px] pr-1 text-[0.9rem] font-semibold",
        pillHeroFlat:
          "min-h-[38px] gap-3 rounded-full px-[18px] py-1 text-[0.9rem] font-semibold",
        icon: "size-9 rounded-full text-[0.8rem]",
        iconSm: "size-[26px] rounded-md text-[0.9rem] font-normal",
      },
    },
    defaultVariants: { variant: "primary", size: "pill" },
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
        // Default to type="button": inside the console's <form> a plain <Button> would otherwise submit it.
        {...(asChild ? {} : { type: type ?? "button" })}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
