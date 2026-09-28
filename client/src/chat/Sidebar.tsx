import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationResponse, UsersResponse } from '@chat/shared';
import { apiFetch } from '../api';
import { activity, describeError, putConversation, titleOf, useConversations } from './cache';
import { NewGroupDialog } from './NewGroup';

interface Props {
  openId: string | null;
  onOpen: (id: string) => void;
}

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

  const sorted = [...(conversations.data ?? [])].sort((a, b) =>
    activity(b).localeCompare(activity(a)),
  );

  return (
    <>
      <div className="border-b border-slate-200 p-3">
        <div className="flex gap-2">
          <label htmlFor="user-search" className="sr-only">
            Search people
          </label>
          <input
            id="user-search"
            type="search"
            placeholder="Search people by name or email"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 focus:border-slate-900 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="shrink-0 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
          >
            New group
          </button>
        </div>
        {startError && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {startError}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          users.isError ? (
            <p className="p-4 text-sm text-red-700">{describeError(users.error)}</p>
          ) : users.isPending || q !== text.trim() ? (
            <p className="p-4 text-sm text-slate-500">Searching...</p>
          ) : users.data.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No one matches that.</p>
          ) : (
            <ul>
              {users.data.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => void start(u.id)}
                    className="flex w-full flex-col px-4 py-3 text-left hover:bg-slate-100"
                  >
                    <span className="truncate font-medium">{u.displayName}</span>
                    <span className="truncate text-sm text-slate-500">{u.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : conversations.isPending ? (
          <p className="p-4 text-sm text-slate-500">Loading conversations...</p>
        ) : conversations.isError ? (
          <div className="flex flex-col items-start gap-2 p-4 text-sm">
            <p className="text-red-700">Could not load conversations.</p>
            <button
              type="button"
              onClick={() => void conversations.refetch()}
              className="rounded-md border border-slate-300 px-3 py-1 font-medium"
            >
              Retry
            </button>
          </div>
        ) : sorted.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No conversations yet. Search for someone to start one.
          </p>
        ) : (
          <ul>
            {sorted.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  aria-current={c.id === openId ? 'true' : undefined}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-100 aria-[current]:bg-slate-200"
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
                        className="absolute right-0 bottom-0 size-2.5 rounded-full bg-green-500 ring-2 ring-white"
                      />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium">{titleOf(c)}</span>
                      <time className="shrink-0 text-xs text-slate-500" dateTime={activity(c)}>
                        {formatTime(activity(c))}
                      </time>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm text-slate-500">
                        {c.latestMessage?.body ?? 'No messages yet'}
                      </span>
                      {c.unreadCount > 0 && (
                        <span className="shrink-0 rounded-full bg-slate-900 px-1.5 text-xs font-semibold text-white">
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                          <span className="sr-only"> unread</span>
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
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

/** The group image, or initials when there is none or it fails to load. */
export function Avatar({ name, url }: { name: string; url: string | null }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return url && !broken ? (
    <img
      src={url}
      alt=""
      onError={() => setBroken(true)}
      className="size-9 shrink-0 rounded-full object-cover"
    />
  ) : (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-300 text-sm font-semibold text-slate-700"
    >
      {initials || '?'}
    </span>
  );
}

export function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString();
}
