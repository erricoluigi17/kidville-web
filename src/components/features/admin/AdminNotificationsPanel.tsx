'use client';

/**
 * Centro notifiche della TopBar admin (M7.3). Campanella con badge
 * condizionale (non_lette > 0, stesso markup del pallino DR) + dropdown con
 * le ultime 20 notifiche da GET /api/notifiche, poll 60s. Il click su una
 * notifica la segna letta (PATCH { id }) e naviga sul link; "Segna tutte
 * lette" fa il PATCH senza id. Stile on-token mirror del dropdown
 * SedeSelector (card bianca SHADOW_FLOAT, righe hover cream).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, BellOff } from 'lucide-react';
import { SHADOW_FLOAT } from '@/components/ui/Card';

interface Notifica {
  id: string;
  tipo: string | null;
  titolo: string | null;
  corpo: string | null;
  link: string | null;
  letta_il: string | null;
  creato_il: string;
}

function quando(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
}

export function AdminNotificationsPanel({
  userId,
  attivoSu,
}: {
  userId: string | null;
  /**
   * Media query che gatea fetch+poll. La campanella è montata due volte
   * (topbar desktop + topbar mobile), entrambe sempre nel DOM: senza guardia
   * entrambe le istanze farebbero fetch e poll, raddoppiando le chiamate a
   * /api/notifiche. Ogni topbar passa la propria breakpoint e resta attiva
   * SOLO quando è quella effettivamente visibile. Se assente (usi legacy) il
   * pannello resta sempre attivo.
   */
  attivoSu?: string;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notifica[]>([]);
  const [nonLette, setNonLette] = useState(0);
  const [ready, setReady] = useState(false);

  // `attivo` segue la media query passata (fetch/poll solo quando la topbar è
  // effettivamente visibile); senza prop resta sempre true (retro-compatibile).
  // `useSyncExternalStore` è il modo idiomatico del repo per lo stato esterno
  // (matchMedia): niente `setState` sincrono negli effect (react-hooks 7).
  const subscribeMq = useCallback(
    (onChange: () => void) => {
      if (attivoSu === undefined) return () => {};
      const mql = window.matchMedia(attivoSu);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [attivoSu],
  );
  const getMq = useCallback(
    () => (attivoSu === undefined ? true : window.matchMedia(attivoSu).matches),
    [attivoSu],
  );
  const attivo = useSyncExternalStore(subscribeMq, getMq, () => attivoSu === undefined);

  const qs = userId ? `?userId=${userId}` : '';

  // Pattern PagamentiSummary (react-hooks 7): niente setState sincrono
  // pre-await, nessun catch top-level (fetch già .catch(() => null)), try/finally.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/notifiche${userId ? `?userId=${userId}` : ''}`).catch(() => null);
      const j = res?.ok ? await res.json().catch(() => null) : null;
      if (j?.success) {
        setItems((j.data ?? []).slice(0, 20));
        setNonLette(j.non_lette ?? 0);
      }
    } finally {
      setReady(true);
    }
  }, [userId]);

  useEffect(() => { if (attivo) void load(); }, [attivo, load]);

  // Poll 60s (niente canali realtime, vedi mini-design M7) — solo se attivo.
  useEffect(() => {
    if (!attivo) return;
    const t = setInterval(() => { void load(); }, 60_000);
    return () => clearInterval(t);
  }, [attivo, load]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const withUser = (href: string) =>
    userId ? `${href}${href.includes('?') ? '&' : '?'}userId=${userId}` : href;

  const apri = async (n: Notifica) => {
    setOpen(false);
    if (!n.letta_il) {
      await fetch(`/api/notifiche${qs}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n.id }),
      }).catch(() => null);
      void load();
    }
    if (n.link) router.push(withUser(n.link));
  };

  const segnaTutte = async () => {
    await fetch(`/api/notifiche${qs}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => null);
    void load();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={nonLette > 0 ? `Notifiche (${nonLette} non lette)` : 'Notifiche'}
        className="relative flex h-11 w-11 items-center justify-center rounded-[11px] bg-kidville-white/[0.12] text-kidville-white"
      >
        <Bell size={19} />
        {nonLette > 0 && (
          <span className="absolute right-2 top-2 h-2 w-2 rounded-pill bg-kidville-yellow ring-2 ring-kidville-green" />
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-[60] w-[min(340px,calc(100vw-24px))] rounded-[14px] bg-kidville-white p-1.5"
          style={{ boxShadow: SHADOW_FLOAT }}
        >
          <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5 pt-2">
            <span className="font-barlow text-[13px] font-extrabold uppercase tracking-[0.02em] text-kidville-green">
              Notifiche
            </span>
            {nonLette > 0 && (
              <button
                type="button"
                onClick={() => { void segnaTutte(); }}
                className="font-maven text-[11.5px] font-semibold text-kidville-green hover:underline"
              >
                Segna tutte lette
              </button>
            )}
          </div>

          {!ready ? (
            <div className="px-3 py-4 font-maven text-[12.5px] text-kidville-muted">Caricamento…</div>
          ) : items.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-4 font-maven text-[12.5px] text-kidville-muted">
              <BellOff size={15} /> Nessuna notifica
            </div>
          ) : (
            <div className="max-h-[380px] overflow-y-auto">
              {items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => { void apri(n); }}
                  className={`flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left ${n.letta_il ? 'hover:bg-kidville-cream' : 'bg-kidville-green-soft/60 hover:bg-kidville-green-soft'}`}
                >
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-pill ${n.letta_il ? 'bg-kidville-line' : 'bg-kidville-yellow ring-2 ring-kidville-green'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-maven text-[13px] font-semibold text-kidville-ink">
                      {n.titolo || 'Notifica'}
                    </span>
                    {n.corpo && (
                      <span className="block truncate font-maven text-[11.5px] text-kidville-muted">{n.corpo}</span>
                    )}
                    <span className="block font-maven text-[10.5px] text-kidville-muted">{quando(n.creato_il)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
