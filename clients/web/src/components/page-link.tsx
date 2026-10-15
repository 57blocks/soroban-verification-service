import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { PageLink } from "@/config/navigation";

type PageLinkAnchorProps = {
  link: PageLink;
  className: string;
  children: ReactNode;
  onNavigate?: () => void;
};

/** A console route is a router link, marked `data-status="active"` on its page; anything else is a plain anchor. */
export const PageLinkAnchor = ({ link, className, children, onNavigate }: PageLinkAnchorProps) =>
  "to" in link ? (
    <Link to={link.to} className={className} onClick={onNavigate}>
      {children}
    </Link>
  ) : (
    <a href={link.href} className={className} onClick={onNavigate}>
      {children}
    </a>
  );
