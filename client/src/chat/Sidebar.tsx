import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationResponse, ConversationSummary, UsersResponse } from '@chat/shared';
import { Search, SquarePen } from 'lucide-react';
import { Avatar as AvatarRoot, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiFetch } from '../api';
import { activity, describeError, putConversation, titleOf, useConversations } from './cache';
import { NewGroupDialog } from './NewGroup';

interface Props {
  openId: string | null;
  onOpen: (id: string) => void;
}

const rowClass =
  'flex w-full items-center gap-3 rounded-lg px-2.5 text-left transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none';

export function Sidebar({ openId, onOpen }: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [startError, setStartError] = useState('');
  const [creating, setCreating] = useState(false);
  const conversations = useConversations();

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const searching = text.trim().length >= 2;
  const users = useQuery({
    queryKey: ['users', q],
    queryFn: () =>
      apiFetch<UsersResponse>(`/api/users?q=${encodeURIComponent(q)}`).then((r) => r.data.users),
    enabled: searching && q.length >= 2,
  });

  const start = async (userId: string) => {
    setStartError('');
    try {
      const { data } = await apiFetch<ConversationResponse>('/api/conversations/direct', {
        method: 'POST',
        body: { userId },
      });
      putConversation(qc, data.conversation);
      setText('');
      setQ('');
      onOpen(data.conversation.id);
    } catch (e) {
      setStartError(describeError(e));
    }
  };

  const sorted = byActivity(conversations.data);

  return (
    <>
      <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
        <div className="flex items-center justify-between gap-2 pl-1">
          <h2 className="text-sm font-semibold tracking-tight">Messages</h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="New group"
                onClick={() => setCreating(true)}
              >
                <SquarePen />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New group</TooltipContent>
          </Tooltip>
        </div>
        <div className="relative">
          <label htmlFor="user-search" className="sr-only">
            Search people
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="user-search"
            type="search"
            placeholder="Search people"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="h-9 border-transparent bg-muted pl-8 dark:bg-muted"
          />
        </div>
        {startError && (
          <p role="alert" className="px-1 text-sm text-destructive">
            {startError}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {searching ? (
          users.isError ? (
            <p className="p-4 text-sm text-destructive">{describeError(users.error)}</p>
          ) : users.isPending || q !== text.trim() ? (
            <RowSkeletons count={3} />
          ) : users.data.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No one matches that.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {users.data.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => void start(u.id)}
                    className={`${rowClass} py-2`}
                  >
                    <Avatar name={u.displayName} url={null} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{u.displayName}</span>
                      <span className="truncate text-xs text-muted-foreground">{u.email}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : conversations.isPending ? (
          <RowSkeletons count={6} />
        ) : conversations.isError ? (
          <div className="flex flex-col items-start gap-3 p-4 text-sm">
            <p className="text-destructive">Could not load conversations.</p>
            <Button variant="outline" size="sm" onClick={() => void conversations.refetch()}>
              Retry
            </Button>
          </div>
        ) : sorted.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No conversations yet. Search for someone to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sorted.map((c) => {
              const unread = c.unreadCount > 0;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(c.id)}
                    aria-current={c.id === openId ? 'true' : undefined}
                    className={`${rowClass} py-2.5 aria-[current]:bg-accent`}
                  >
                    <span className="relative shrink-0">
                      <Avatar
                        key={c.type === 'group' ? c.avatarUrl : null}
                        name={titleOf(c)}
                        url={c.type === 'group' ? c.avatarUrl : null}
                      />
                      {c.type === 'direct' && c.peer.online && (
                        <span
                          role="img"
                          aria-label="online"
                          className="absolute right-0 bottom-0 size-2.5 rounded-full bg-success ring-2 ring-background"
                        />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">{titleOf(c)}</span>
                        <time
                          className={`shrink-0 text-[11px] tabular-nums ${unread ? 'font-medium text-primary' : 'text-muted-foreground'}`}
                          dateTime={activity(c)}
                        >
                          {formatTime(activity(c))}
                        </time>
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span
                          className={`truncate text-[13px] ${unread ? 'text-foreground' : 'text-muted-foreground'}`}
                        >
                          {c.latestMessage
                            ? c.latestMessage.deletedAt
                              ? 'Message deleted'
                              : c.latestMessage.body || 'Attachment'
                            : 'No messages yet'}
                        </span>
                        {unread && (
                          <Badge className="h-5 min-w-5 px-1.5 tabular-nums">
                            {c.unreadCount > 99 ? '99+' : c.unreadCount}
                            <span className="sr-only"> unread</span>
                          </Badge>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {creating && (
        <NewGroupDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onOpen(id);
          }}
        />
      )}
    </>
  );
}

const byActivity = (list: readonly ConversationSummary[] | undefined) =>
  [...(list ?? [])].sort((a, b) => activity(b).localeCompare(activity(a)));

/** The collapsed sidebar: recent conversations as avatars, newest first. */
export function RailList({ openId, onOpen }: Props) {
  const conversations = useConversations();
  return (
    <ul className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-1">
      {byActivity(conversations.data).map((c) => (
        <li key={c.id}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                aria-current={c.id === openId ? 'true' : undefined}
                aria-label={
                  c.unreadCount > 0 ? `${titleOf(c)}, ${c.unreadCount} unread` : titleOf(c)
                }
                className="relative flex rounded-full p-0.5 ring-2 ring-transparent transition-shadow hover:ring-border focus-visible:ring-ring/50 focus-visible:outline-none aria-[current]:ring-primary"
              >
                <Avatar
                  key={c.type === 'group' ? c.avatarUrl : null}
                  name={titleOf(c)}
                  url={c.type === 'group' ? c.avatarUrl : null}
                />
                {c.type === 'direct' && c.peer.online && (
                  <span
                    aria-hidden="true"
                    className="absolute right-0.5 bottom-0.5 size-2.5 rounded-full bg-success ring-2 ring-background"
                  />
                )}
                {c.unreadCount > 0 && (
                  <Badge
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 h-4.5 min-w-4.5 px-1 text-[10px] tabular-nums"
                  >
                    {c.unreadCount > 99 ? '99+' : c.unreadCount}
                  </Badge>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{titleOf(c)}</TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

const RowSkeletons = ({ count }: { count: number }) => (
  <ul aria-label="Loading" className="flex flex-col gap-0.5">
    {Array.from({ length: count }, (_, i) => (
      <li key={i} className="flex items-center gap-3 px-2.5 py-2.5">
        <Skeleton className="size-10 rounded-full" />
        <span className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-4/5" />
        </span>
      </li>
    ))}
  </ul>
);

/** The group image, or initials when there is none or it fails to load. */
export function Avatar({
  name,
  url,
  size = 'lg',
}: {
  name: string;
  url: string | null;
  size?: 'sm' | 'default' | 'lg';
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <AvatarRoot size={size} aria-hidden="true">
      {url && <AvatarImage src={url} alt="" />}
      <AvatarFallback className="bg-secondary font-medium text-secondary-foreground">
        {initials || '?'}
      </AvatarFallback>
    </AvatarRoot>
  );
}

export function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString();
}
