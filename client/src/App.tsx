import { useEffect, useState } from 'react';
import type { HealthResponse } from '@chat/shared';

export function App() {
  const [health, setHealth] = useState<HealthResponse | 'error' | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<HealthResponse>)
      .then(setHealth, () => setHealth('error'));
  }, []);

  const label = health === null ? 'checking...' : health === 'error' ? 'unreachable' : `db ${health.db}`;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-900">
      <p className="rounded-lg bg-white px-4 py-2 shadow">API: {label}</p>
    </main>
  );
}
