"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  ["/", "Home"],
  ["/spots", "Spots"],
  ["/notes", "Notes"],
  ["/settings", "Settings"],
] as const;

export function Nav() {
  const path = usePathname();
  if (path === "/login" || path.startsWith("/visit")) return null;
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-[1000] border-t border-line bg-surface/95 backdrop-blur">
      <ul className="mx-auto flex max-w-lg">
        {LINKS.map(([href, label]) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 items-center justify-center text-sm font-medium ${active ? "text-accent" : "text-muted"}`}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
