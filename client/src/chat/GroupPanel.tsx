import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  can,
  updateGroupBody,
  type GroupDetail,
  type GroupMember,
  type GroupResponse,
  type Role,
  type UserSummary,
} from '@chat/shared';
import { apiFetch } from '../api';
import { describeError, putGroup, useGroup } from './cache';
import { PeoplePicker } from './NewGroup';
import { Avatar } from './Sidebar';

const roleLabel: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/**
 * Members and role controls. Buttons show only when `can()` allows them, but the server decides:
 * a stale view just gets a `forbidden` shown inline.
 */
export function GroupPanel({
  groupId,
  me,
  onClose,
}: {
  groupId: string;
  me: UserSummary;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const group = useGroup(groupId);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);

  const base = `/api/conversations/${groupId}`;
  // Every mutation: REST call, then the returned detail replaces the cache. 204s return nothing;
  // the socket's group:removed does the cleanup for those.
  const run = async (path: string, method: string, body?: unknown) => {
    setError('');
    setBusy(true);
    try {
      const { data } = await apiFetch<GroupResponse | undefined>(path, { method, body });
      if (data && 'group' in data) putGroup(qc, data.group, me.id);
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const g = group.data;
  const myRole = g?.members.find((m) => m.userId === me.id)?.role;

  return (
    <aside
      aria-labelledby="group-panel-title"
      className="fixed inset-0 z-10 flex flex-col bg-white md:static md:w-80 md:border-l md:border-slate-200"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
        <h2 id="group-panel-title" className="font-semibold">
          Group info
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {group.isPending ? (
          <p className="text-sm text-slate-500">Loading members...</p>
        ) : group.isError || !g || !myRole ? (
          <div className="flex flex-col items-start gap-2 text-sm">
            <p className="text-red-700">Could not load this group.</p>
            <button
              type="button"
              onClick={() => void group.refetch()}
              className="rounded-md border border-slate-300 px-3 py-1 font-medium"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            {can('rename', myRole) ? (
              <EditGroup key={`${g.name}|${g.avatarUrl ?? ''}`} group={g} busy={busy} run={run} />
            ) : (
              <div className="flex items-center gap-3">
                <Avatar key={g.avatarUrl} name={g.name} url={g.avatarUrl} />
                <p className="truncate font-medium">{g.name}</p>
              </div>
            )}
            {can('add', myRole) && (
              <PeoplePicker
                id="panel-add-people"
                exclude={new Set(g.members.map((m) => m.userId))}
                onPick={(u) => void run(`${base}/members`, 'POST', { userIds: [u.id] })}
              />
            )}
            <section>
              <h3 className="mb-1 text-sm font-medium">{g.members.length} members</h3>
              <ul className="divide-y divide-slate-100">
                {g.members.map((m) => (
                  <MemberRow
                    key={m.userId}
                    m={m}
                    me={me}
                    myRole={myRole}
                    busy={busy}
                    act={(path, method, body) => void run(`${base}/${path}`, method, body)}
                  />
                ))}
              </ul>
            </section>
            <section className="flex flex-col gap-2 border-t border-slate-200 pt-3">
              {confirm ? (
                <div className="flex flex-col gap-2 rounded-md bg-red-50 p-3 text-sm">
                  <p>
                    {confirm === 'leave'
                      ? `Leave ${g.name}? You will stop getting its messages.`
                      : `Delete ${g.name} for everyone? This cannot be undone.`}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void (
                          confirm === 'leave'
                            ? run(`${base}/members/${me.id}`, 'DELETE')
                            : run(base, 'DELETE')
                        ).then(() => setConfirm(null))
                      }
                      className="rounded-md bg-red-700 px-3 py-1 font-medium text-white disabled:opacity-50"
                    >
                      {confirm === 'leave' ? 'Leave' : 'Delete'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirm(null)}
                      className="rounded-md border border-slate-300 px-3 py-1 font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {myRole === 'owner' ? (
                    <p className="text-xs text-slate-500">
                      To leave, make someone else the owner first.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirm('leave')}
                      className="self-start text-sm font-medium text-red-700 underline"
                    >
                      Leave group
                    </button>
                  )}
                  {can('delete', myRole) && (
                    <button
                      type="button"
                      onClick={() => setConfirm('delete')}
                      className="self-start text-sm font-medium text-red-700 underline"
                    >
                      Delete group
                    </button>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}

function EditGroup({
  group,
  busy,
  run,
}: {
  group: GroupDetail;
  busy: boolean;
  run: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState(group.name);
  const [avatar, setAvatar] = useState(group.avatarUrl ?? '');
  const [invalid, setInvalid] = useState('');
  const dirty = name.trim() !== group.name || avatar.trim() !== (group.avatarUrl ?? '');

  const save = (e: FormEvent) => {
    e.preventDefault();
    const body = updateGroupBody.safeParse({ name, avatarUrl: avatar.trim() || null });
    if (!body.success) {
      setInvalid(
        name.trim() ? 'The avatar must be an https:// image URL.' : 'Give the group a name.',
      );
      return;
    }
    setInvalid('');
    void run(`/api/conversations/${group.id}`, 'PATCH', body.data);
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Avatar key={group.avatarUrl} name={group.name} url={group.avatarUrl} />
        <div className="min-w-0 flex-1">
          <label htmlFor="panel-name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="panel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 focus:border-slate-900 focus:outline-none"
          />
        </div>
      </div>
      <label htmlFor="panel-avatar" className="text-sm font-medium">
        Avatar URL
      </label>
      <input
        id="panel-avatar"
        type="url"
        placeholder="https://..."
        value={avatar}
        onChange={(e) => setAvatar(e.target.value)}
        maxLength={2048}
        className="rounded-md border border-slate-300 px-3 py-1.5 focus:border-slate-900 focus:outline-none"
      />
      {invalid && (
        <p role="alert" className="text-sm text-red-700">
          {invalid}
        </p>
      )}
      {dirty && (
        <button
          type="submit"
          disabled={busy}
          className="self-start rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
      )}
    </form>
  );
}

function MemberRow({
  m,
  me,
  myRole,
  busy,
  act,
}: {
  m: GroupMember;
  me: UserSummary;
  myRole: Role;
  busy: boolean;
  act: (path: string, method: string, body?: unknown) => void;
}) {
  const self = m.userId === me.id;
  const path = `members/${m.userId}`;
  const buttons: { label: string; onClick: () => void }[] = [];
  if (!self && can('setRole', myRole, m.role)) {
    buttons.push(
      m.role === 'admin'
        ? { label: 'Remove admin', onClick: () => act(path, 'PATCH', { role: 'member' }) }
        : { label: 'Make admin', onClick: () => act(path, 'PATCH', { role: 'admin' }) },
    );
  }
  if (!self && can('transfer', myRole, m.role)) {
    buttons.push({
      label: 'Make owner',
      onClick: () => act('transfer', 'POST', { userId: m.userId }),
    });
  }
  if (!self && can('remove', myRole, m.role)) {
    buttons.push({ label: 'Remove', onClick: () => act(path, 'DELETE') });
  }

  return (
    <li className="flex flex-col gap-1 py-2">
      <span className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">
          {m.displayName}
          {self && ' (you)'}
        </span>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
          {roleLabel[m.role]}
        </span>
      </span>
      {buttons.length > 0 && (
        <span className="flex flex-wrap gap-2">
          {buttons.map((b) => (
            <button
              key={b.label}
              type="button"
              disabled={busy}
              onClick={b.onClick}
              aria-label={`${b.label}: ${m.displayName}`}
              className="rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium disabled:opacity-50"
            >
              {b.label}
            </button>
          ))}
        </span>
      )}
    </li>
  );
}
