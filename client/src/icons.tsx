/** The app mark: a speech bubble on an accent tile. */
export function Logo() {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent text-on-accent shadow-sm"
    >
      <ChatIcon className="size-4.5" />
    </span>
  );
}

export function ChatIcon({ className = 'size-6' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
    </svg>
  );
}
