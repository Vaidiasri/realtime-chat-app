import { cn } from 'cn';

/** The app mark: two overlapping speech bubbles on an indigo tile. Kept in sync with public/favicon.svg. */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-linear-to-br from-primary to-primary/75 text-primary-foreground shadow-sm ring-1 shadow-primary/30 ring-white/15 ring-inset',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-[56%]" fill="currentColor">
        <g opacity="0.55">
          <rect x="1.5" y="2.5" width="13" height="10" rx="5" />
          <path d="M3.5 10.5 1.5 15l5-3z" />
        </g>
        <rect x="8.5" y="8.5" width="14" height="10.5" rx="5.25" />
        <path d="M17 18l4.5 3.5-.8-5z" />
      </svg>
    </span>
  );
}
