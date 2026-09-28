import { useSyncExternalStore, useState, type FormEvent, type ReactNode } from 'react';
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
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '../api';
import { describeError, putGroup, useGroup } from './cache';
import { PeoplePicker } from './NewGroup';
import { Avatar } from './Sidebar';

const roleLabel: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

// At xl the panel fits beside the chat; below it slides over as a sheet.
const wide = window.matchMedia('(min-width: 1280px)');
const useWide = () =>
  useSyncExternalStore(
    (cb) => {
      wide.addEventListener('change', cb);
      return () => wide.removeEventListener('change', cb);
    },
    () => wide.matches,
  );

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
  const body = <PanelBody groupId={groupId} me={me} />;
  if (useWide()) {
    return (
      <aside
        aria-labelledby="group-panel-title"
        className="flex w-80 shrink-0 flex-col border-l bg-muted/30 dark:bg-card/40"
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b px-5">
          <h2 id="group-panel-title" className="text-sm font-semibold">
            Group info
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X />
          </Button>
        </div>
        {body}
      </aside>
    );
  }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>Group info</SheetTitle>
          <SheetDescription className="sr-only">Members and group settings</SheetDescription>
        </SheetHeader>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({ groupId, me }: { groupId: string; me: UserSummary }) {
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

  let content: ReactNode;
  if (group.isPending) {
    content = (
      <div aria-label="Loading members" className="flex flex-col gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  } else if (group.isError || !g || !myRole) {
    content = (
      <div className="flex flex-col items-start gap-3 text-sm">
        <p className="text-destructive">Could not load this group.</p>
        <Button variant="outline" size="sm" onClick={() => void group.refetch()}>
          Retry
        </Button>
      </div>
    );
  } else {
    content = (
      <div className="flex flex-col gap-5">
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
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
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-muted-foreground">{g.members.length} members</h3>
          <ul className="-mx-2 flex flex-col">
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
        <Separator />
        <section className="flex flex-col items-start gap-2">
          {confirm ? (
            <div className="flex w-full flex-col gap-3 rounded-lg bg-destructive/10 p-3 text-sm">
              <p>
                {confirm === 'leave'
                  ? `Leave ${g.name}? You will stop getting its messages.`
                  : `Delete ${g.name} for everyone? This cannot be undone.`}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void (
                      confirm === 'leave'
                        ? run(`${base}/members/${me.id}`, 'DELETE')
                        : run(base, 'DELETE')
                    ).then(() => setConfirm(null))
                  }
                >
                  {confirm === 'leave' ? 'Leave' : 'Delete'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              {myRole === 'owner' ? (
                <p className="text-xs text-muted-foreground">
                  To leave, make someone else the owner first.
                </p>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirm('leave')}
                  className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  Leave group
                </Button>
              )}
              {can('delete', myRole) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirm('delete')}
                  className="-ml-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  Delete group
                </Button>
              )}
            </>
          )}
        </section>
      </div>
    );
  }

  return <div className="min-h-0 flex-1 overflow-y-auto p-5">{content}</div>;
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
    <form onSubmit={save} className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <Avatar key={group.avatarUrl} name={group.name} url={group.avatarUrl} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Label htmlFor="panel-name">Name</Label>
          <Input
            id="panel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            className="h-9"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="panel-avatar">Avatar URL</Label>
        <Input
          id="panel-avatar"
          type="url"
          placeholder="https://..."
          value={avatar}
          onChange={(e) => setAvatar(e.target.value)}
          maxLength={2048}
          className="h-9"
        />
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-destructive">
          {invalid}
        </p>
      )}
      {dirty && (
        <Button type="submit" size="sm" disabled={busy} className="self-start">
          Save
        </Button>
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
  const buttons: { label: string; danger?: boolean; onClick: () => void }[] = [];
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
    buttons.push({ label: 'Remove', danger: true, onClick: () => act(path, 'DELETE') });
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-accent/60">
      <span className="flex items-center gap-3">
        <Avatar name={m.displayName} url={null} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {m.displayName}
          {self && <span className="font-normal text-muted-foreground"> (you)</span>}
        </span>
        <Badge variant={m.role === 'member' ? 'outline' : 'secondary'} className="shrink-0">
          {roleLabel[m.role]}
        </Badge>
      </span>
      {buttons.length > 0 && (
        <span className="flex flex-wrap gap-1.5 pl-9">
          {buttons.map((b) => (
            <Button
              key={b.label}
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={b.onClick}
              aria-label={`${b.label}: ${m.displayName}`}
              className={b.danger ? 'text-destructive hover:text-destructive' : undefined}
            >
              {b.label}
            </Button>
          ))}
        </span>
      )}
    </li>
  );
}
