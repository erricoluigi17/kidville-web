'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

// Identità di sessione lato client (M4) — sostituisce i fallback demo.
// Precedenza: URL `?userId=` → localStorage → GET /api/me (sessione reale,
// cookie Supabase) → null + redirect al login. Nessun fallback demo: se
// nessuna fonte risolve, l'utente non è autenticato.

const USER_KEY = 'kv_user_id';
const ROLE_KEY = 'kv_user_role';

export interface SessionIdentity {
  userId: string | null;
  role: string | null;
  ready: boolean; // false finché la risoluzione non è completata
}

function readStore(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStore(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function useSessionIdentity(): SessionIdentity {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [state, setState] = useState<SessionIdentity>({ userId: null, role: null, ready: false });

  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      let userId: string | null = null;
      let role: string | null = null;
      try {
        // 1) URL — deep link esplicito; persiste per le navigazioni successive.
        const fromUrl = searchParams.get('userId');
        if (fromUrl) {
          writeStore(USER_KEY, fromUrl);
          userId = fromUrl;
          role = readStore(ROLE_KEY);
          return;
        }

        // 2) localStorage — identità persistita in una navigazione precedente.
        const stored = readStore(USER_KEY);
        if (stored) {
          userId = stored;
          role = readStore(ROLE_KEY);
          return;
        }

        // 3) /api/me — identità reale dalla sessione (cookie).
        const res = await fetch('/api/me').catch(() => null);
        if (res?.ok) {
          const data = await res.json().catch(() => null);
          if (data?.id) {
            userId = String(data.id);
            role = (data.role ?? data.ruolo ?? null) as string | null;
            writeStore(USER_KEY, userId);
            if (role) writeStore(ROLE_KEY, role);
          }
        }
      } finally {
        if (!cancelled) {
          setState({ userId, role, ready: true });
          // 4) Nessuna fonte ha risolto: non autenticato → login.
          if (!userId) router.replace(`/auth/login?next=${encodeURIComponent(pathname)}`);
        }
      }
    };
    void resolve();
    return () => { cancelled = true; };
  }, [searchParams, pathname, router]);

  return state;
}
