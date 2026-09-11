import { useEffect, useRef, useState } from "react";

interface UseInViewOptions {
  /** IntersectionObserver threshold (default 0 — see the note below). */
  threshold?: number;
  /** IntersectionObserver rootMargin (default `0px 0px -80px 0px`). */
  rootMargin?: string;
  /** Stop observing after the first intersection (default true). */
  triggerOnce?: boolean;
}

/** Returns `true` once the observed element scrolls into the viewport. */
export function useInView<T extends Element = HTMLDivElement>(
  options?: UseInViewOptions,
): { ref: React.RefObject<T>; inView: boolean } {
  const {
    threshold = 0,
    rootMargin = "0px 0px -80px 0px",
    triggerOnce = true,
  } = options ?? {};
  const ref = useRef<T>(null);
  // Without the API there is no way to tell what is on screen — start revealed rather than leave the content
  // permanently hidden.
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (triggerOnce) observer.disconnect();
          } else if (!triggerOnce) {
            setInView(false);
          }
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold, rootMargin, triggerOnce]);

  return { ref, inView };
}
