import { type ReactNode, type ElementType } from "react";
import { useInView } from "@/lib/use-in-view";

interface FadeUpProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  threshold?: number;
  rootMargin?: string;
  as?: ElementType;
  /** Transforms do not apply to inline boxes, so a `span` defaults to `inline-block`. */
  display?: "block" | "inline-block";
}

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
