import { MessageCircle } from 'lucide-react';

/** The app mark: a speech bubble on an indigo tile. */
export function Logo() {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm"
    >
      <MessageCircle className="size-4" strokeWidth={2.25} />
    </span>
  );
}
