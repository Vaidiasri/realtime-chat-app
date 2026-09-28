import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createGroupBody,
  type ConversationResponse,
  type UserSummary,
  type UsersResponse,
} from '@chat/shared';
import { apiFetch } from '../api';
import { describeError, putConversation } from './cache';

/** Debounced user search. Picking a result hands it to the parent; `exclude` hides people. */
export function PeoplePicker({
  id,
  exclude,
  onPick,
}: {
  id: string;
  exclude: ReadonlySet<string>;
  onPick: (u: UserSummary) => void;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
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
  const shown = users.data?.filter((u) => !exclude.has(u.id)) ?? [];

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        Add people
      </label>
      <input
        id={id}
        type="search"
        placeholder="Search by name or email"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-slate-900 focus:outline-none"
      />
      {searching &&
        (users.isError ? (
          <p className="mt-1 text-sm text-red-700">{describeError(users.error)}</p>
        ) : users.isPending || q !== text.trim() ? (
          <p className="mt-1 text-sm text-slate-500">Searching...</p>
        ) : shown.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">No one else matches that.</p>
        ) : (
          <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200">
            {shown.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => onPick(u)}
                  className="flex w-full flex-col px-3 py-2 text-left hover:bg-slate-100"
                >
                  <span className="truncate text-sm font-medium">{u.displayName}</span>
                  <span className="truncate text-xs text-slate-500">{u.email}</span>
                </button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function NewGroupDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [picked, setPicked] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // A modal <dialog> traps focus and closes on Escape by itself.
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = createGroupBody.safeParse({
      name,
      avatarUrl: avatar.trim() || undefined,
      memberIds: picked.map((p) => p.id),
    });
    if (!body.success) {
      setError(
        name.trim() ? 'The avatar must be an https:// image URL.' : 'Give the group a name.',
      );
      return;
    }
    setError('');
    setBusy(true);
    try {
      const { data } = await apiFetch<ConversationResponse>('/api/conversations/groups', {
        method: 'POST',
        body: body.data,
      });
      putConversation(qc, data.conversation);
      onCreated(data.conversation.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="new-group-title"
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <form onSubmit={(e) => void submit(e)} className="flex max-h-[85dvh] flex-col">
        <h2 id="new-group-title" className="border-b border-slate-200 px-4 py-3 font-semibold">
          New group
        </h2>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <div>
            <label htmlFor="group-name" className="text-sm font-medium">
              Name
            </label>
            <input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-slate-900 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="group-avatar" className="text-sm font-medium">
              Avatar URL (optional)
            </label>
            <input
              id="group-avatar"
              type="url"
              placeholder="https://..."
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
              maxLength={2048}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:border-slate-900 focus:outline-none"
            />
          </div>
          <PeoplePicker
            id="group-people"
            exclude={new Set(picked.map((p) => p.id))}
            onPick={(u) => setPicked((p) => (p.length >= 99 ? p : [...p, u]))}
          />
          {picked.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="People in the new group">
              {picked.map((u) => (
                <li
                  key={u.id}
                  className="flex items-center gap-1 rounded-full bg-slate-200 py-1 pr-1 pl-3 text-sm"
                >
                  {u.displayName}
                  <button
                    type="button"
                    onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))}
                    aria-label={`Remove ${u.displayName}`}
                    className="rounded-full px-2 hover:bg-slate-300"
                  >
                    x
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-slate-200 px-4 py-3">
          {error && (
            <p role="alert" className="mb-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="rounded-md border border-slate-300 px-4 py-2 font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
