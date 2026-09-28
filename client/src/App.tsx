import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthResponse } from '@chat/shared';
import { logout, refreshSession } from './api';
import { AuthPage } from './AuthPage';
import { connectSocket } from './socket';

// ponytail: no router yet; feature 6 picks one when conversations need URLs.
export function App() {
  // undefined while the boot refresh runs, null when signed out.
  const [session, setSession] = useState<AuthResponse | null | undefined>(undefined);
  // Stable, so the socket effect does not reconnect on every App render.
  const signedOut = useCallback(() => setSession(null), []);

  useEffect(() => {
    void refreshSession().then(setSession);
  }, []);

  if (session === undefined) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600">
        Loading...
      </main>
    );
  }
  if (!session) return <AuthPage onAuthed={setSession} />;
  return <SignedIn session={session} onSignedOut={signedOut} />;
}

function SignedIn({ session, onSignedOut }: { session: AuthResponse; onSignedOut: () => void }) {
  const [connected, setConnected] = useState(false);
  const stopRef = useRef<() => void>(undefined);

  useEffect(() => {
    const stop = connectSocket(session.accessToken, {
      status: setConnected,
      signedOut: onSignedOut,
    });
    stopRef.current = stop;
    return stop;
  }, [session.accessToken, onSignedOut]);

  const signOut = async () => {
    stopRef.current?.();
    await logout();
    onSignedOut();
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-slate-900">
      <div className="flex flex-col items-center gap-3 rounded-xl bg-white p-6 shadow">
        <p>
          Signed in as <strong>{session.user.displayName}</strong> ({session.user.email})
        </p>
        <p role="status" className={connected ? 'text-green-700' : 'text-amber-700'}>
          Socket {connected ? 'connected' : 'disconnected'}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-md border border-slate-300 px-3 py-2 font-medium"
        >
          Log out
        </button>
      </div>
    </main>
  );
}
