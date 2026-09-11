import { type ReactNode, type ElementType } from "react";
import { useInView } from "@/lib/use-in-view";

interface FadeUpProps {
  children: ReactNode;
  /** Delay in ms before the transition starts (default 0). */
  delay?: number;
  /** Additional className forwarded to the wrapper element. */
  className?: string;
  /** IntersectionObserver threshold — see `useInView` before raising this above 0. */
  threshold?: number;
  /** IntersectionObserver rootMargin override. */
  rootMargin?: string;
  /** The element to render (default "div"). Use "span" inside an `<h1>` or `<p>`. */
  as?: ElementType;
  /**
   * Transforms do not apply to inline boxes, so a `span` must be given a block-ish display; it defaults to
   * `inline-block`.
   */
  display?: "block" | "inline-block";
}

/** Fades and lifts its children into place once they scroll into the viewport. */
export const FadeUp = ({
  children,
  delay = 0,
  className,
  threshold,
  rootMargin,
  as: Tag = "div",
  display = Tag === "span" ? "inline-block" : undefined,
}: FadeUpProps) => {
  const { ref, inView } = useInView<HTMLElement>({ threshold, rootMargin });

  return (
    <Tag
      ref={ref}
      data-visible={inView ? "true" : "false"}
      className={["fade-up", className ?? ""].filter(Boolean).join(" ")}
      style={{
        ...(display ? { display } : {}),
        ...(delay ? { transitionDelay: `${delay}ms` } : {}),
      }}
    >
      {children}
    </Tag>
  );
};

export default FadeUp;
