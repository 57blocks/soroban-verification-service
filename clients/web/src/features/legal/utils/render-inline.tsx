import { Fragment, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";

// Either inline mark: `**bold**` or `[label](href)`.
const INLINE_MARK = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
const BOLD = /^\*\*([^*]+)\*\*$/;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

const linkClass =
  "text-ink underline decoration-yellow decoration-2 underline-offset-[3px] hover:decoration-ink";

const renderLink = (label: string, href: string, key: number): ReactNode =>
  href.startsWith("/") ? (
    <Link key={key} to={href} className={linkClass}>
      {label}
    </Link>
  ) : (
    <a key={key} href={href} target="_blank" rel="noreferrer" className={linkClass}>
      {label}
    </a>
  );

export const renderInline = (text: string): ReactNode[] =>
  text.split(INLINE_MARK).filter(Boolean).map((part, index) => {
    const bold = BOLD.exec(part);
    if (bold) return <strong key={index}>{bold[1]}</strong>;
    const link = LINK.exec(part);
    if (link) return renderLink(link[1], link[2], index);
    return <Fragment key={index}>{part}</Fragment>;
  });
