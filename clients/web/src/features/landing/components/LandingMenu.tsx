import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { PageLinkAnchor } from "@/components/page-link";
import { Button } from "@/components/ui/button";
import { PillIcon } from "@/components/ui/pill-icon";
import { pageLinks } from "@/config/navigation";
import { heroCopy } from "../content";
import { sectionLinks } from "../navigation";

const MenuHeading = ({ children }: { children: ReactNode }) => (
  <div className="px-3 pb-1.5 pt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-yellow-deep">
    {children}
  </div>
);

export const LandingMenu = () => {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div ref={root} className="xl:hidden">
      <Button
        ref={toggle}
        type="button"
        variant="iconOutline"
        size="icon"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X className="size-4" /> : <Menu className="size-4" />}
      </Button>

      {open && (
        <div
          id={panelId}
          className="absolute inset-x-4 top-full mt-2 animate-in fade-in-0 slide-in-from-top-2 rounded-xl border border-line-strong bg-surface p-2 shadow-dropdown duration-150 md:left-auto md:right-20 md:w-[380px]"
        >
          <div className="lg:hidden">
            <MenuHeading>Explore</MenuHeading>
            {pageLinks().map((link) => (
              <PageLinkAnchor
                key={link.label}
                link={link}
                onNavigate={close}
                className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-alt focus-visible:outline-none focus-visible:shadow-focus"
              >
                <span className="block text-[0.95rem] font-semibold text-ink">{link.label}</span>
                <span className="mt-0.5 block text-[0.8rem] leading-snug text-ink-mute">{link.description}</span>
              </PageLinkAnchor>
            ))}
            <div className="mx-3 my-2 h-px bg-line" />
          </div>

          <MenuHeading>On this page</MenuHeading>
          <div className="grid grid-cols-2">
            {sectionLinks.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                onClick={close}
                className="rounded-lg px-3 py-2 text-[0.9rem] text-ink-body transition-colors hover:bg-surface-alt hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
              >
                {label}
              </a>
            ))}
          </div>

          <div className="mt-2 border-t border-line px-1 pb-1 pt-3 sm:hidden">
            <Button
              asChild
              variant="primary"
              size="pillHero"
              className="w-full justify-between border-0 hover:bg-ink-hover"
            >
              <Link to="/verify" onClick={close}>
                {heroCopy.cta}
                <PillIcon size="md" animated>
                  →
                </PillIcon>
              </Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
