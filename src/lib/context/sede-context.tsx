'use client';

/**
 * Contesto delle SEDI ATTIVE del cockpit Direzione/Segreteria (Fase B multi-scuola).
 *
 * Modello (deciso col committente): la Direzione vede SOLO le sedi che seleziona,
 * e può selezionarne più d'una contemporaneamente (letture combinate). La
 * selezione è una preferenza UI persistita nel cookie `sedi_attive` (lista di
 * UUID separati da virgola, vuoto = tutte le sedi accessibili). Il cookie NON è
 * un segreto: il server lo ri-valida SEMPRE contro `scuoleDiUtente`
 * (`resolveScuoleAttive`/`resolveScuolaScrittura` in @/lib/auth/scope), quindi
 * manometterlo non dà accesso a plessi non propri.
 *
 * Espone:
 *  - `sedi`         → sedi accessibili (id+nome) da /api/admin/sedi;
 *  - `selezionate`  → subset scelto (vuoto = tutte);
 *  - `effettive`    → subset ∩ accessibili, o tutte: quello che il server scopa;
 *  - `sedeCorrente` → UNA sede per le pagine di configurazione (null se ambiguo,
 *                     cioè più sedi accessibili e nessuna singola scelta);
 *  - `reFetchKey`   → dipendenza stabile per i useEffect delle liste multi-sede;
 *  - `loading`      → true finché non ho caricato le sedi accessibili.
 *
 * NB: non usa `useSessionIdentity` (che dipende da `useSearchParams`) per non far
 * sospendere l'intera shell admin — legge `userId` da URL/localStorage come
 * AdminTopBar; se assente il server risolve comunque l'identità dalla sessione.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const COOKIE = 'sedi_attive';

export interface Sede {
  id: string;
  nome: string;
}

export interface SediContextValue {
  sedi: Sede[];
  selezionate: string[];
  effettive: string[];
  sedeCorrente: string | null;
  reFetchKey: string;
  loading: boolean;
  toggle: (id: string) => void;
  soloSede: (id: string) => void;
  tutte: () => void;
}

const SediContext = createContext<SediContextValue | null>(null);

// ─── Cookie helpers (client-side; non httpOnly, ri-validato server-side) ──────
function readCookie(): string[] {
  if (typeof document === 'undefined') return [];
  const entry = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`));
  if (!entry) return [];
  const raw = decodeURIComponent(entry.slice(COOKIE.length + 1) ?? '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function writeCookie(ids: string[]) {
  if (typeof document === 'undefined') return;
  // 1 anno; path=/ così viaggia su /api/*; SameSite=Lax. Vuoto = "tutte".
  document.cookie = `${COOKIE}=${encodeURIComponent(ids.join(','))}; path=/; max-age=31536000; samesite=lax`;
}

function readUserId(): string | null {
  if (typeof window === 'undefined') return null;
  const fromUrl = new URLSearchParams(window.location.search).get('userId');
  if (fromUrl) return fromUrl;
  try {
    return window.localStorage.getItem('kv_user_id');
  } catch {
    return null;
  }
}

export function SedeProvider({ children }: { children: React.ReactNode }) {
  const [userId] = useState<string | null>(readUserId);
  const [sedi, setSedi] = useState<Sede[]>([]);
  const [selezionate, setSelezionate] = useState<string[]>(readCookie);
  const [loading, setLoading] = useState(true);

  // Carica le sedi accessibili. try/finally (react-hooks 7): niente setState nel
  // ramo di errore, un solo commit a fine risoluzione.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      let list: Sede[] = [];
      try {
        const res = await fetch('/api/admin/sedi', {
          headers: userId ? { 'x-user-id': userId } : undefined,
        });
        if (res.ok) {
          const d = await res.json();
          const arr = Array.isArray(d) ? d : d?.data ?? [];
          list = (arr as Sede[]).filter((s) => s && s.id);
        }
      } finally {
        if (!cancelled) {
          setSedi(list);
          // Scarta dal cookie sedi non più accessibili (cookie stantìo).
          const accessibili = new Set(list.map((s) => s.id));
          setSelezionate((prev) => prev.filter((id) => accessibili.has(id)));
          setLoading(false);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const persist = useCallback((ids: string[]) => {
    // Se coincide con "tutte" le accessibili, memorizzo vuoto (= nessun filtro).
    setSelezionate(ids);
    writeCookie(ids);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      setSelezionate((prev) => {
        const has = prev.includes(id);
        const next = has ? prev.filter((x) => x !== id) : [...prev, id];
        // Se ho selezionato tutte le sedi accessibili, normalizzo a [] (= tutte).
        const tutteAcc = sedi.length > 0 && next.length === sedi.length;
        const finale = tutteAcc ? [] : next;
        writeCookie(finale);
        return finale;
      });
    },
    [sedi]
  );

  const soloSede = useCallback((id: string) => persist([id]), [persist]);
  const tutte = useCallback(() => persist([]), [persist]);

  const value = useMemo<SediContextValue>(() => {
    const ids = sedi.map((s) => s.id);
    const set = new Set(ids);
    const validSel = selezionate.filter((id) => set.has(id));
    const effettive = validSel.length > 0 ? validSel : ids;
    const sedeCorrente = effettive.length === 1 ? effettive[0] : null;
    return {
      sedi,
      selezionate: validSel,
      effettive,
      sedeCorrente,
      reFetchKey: effettive.join(','),
      loading,
      toggle,
      soloSede,
      tutte,
    };
  }, [sedi, selezionate, loading, toggle, soloSede, tutte]);

  return <SediContext.Provider value={value}>{children}</SediContext.Provider>;
}

/** Hook per leggere le sedi attive. Deve stare dentro <SedeProvider>. */
export function useSediAttive(): SediContextValue {
  const ctx = useContext(SediContext);
  if (!ctx) throw new Error('useSediAttive deve essere usato dentro <SedeProvider>');
  return ctx;
}

/**
 * Avviso "seleziona una sola sede" per le pagine mono-sede quando sono attive
 * più sedi (selezione ambigua). Specchia lato UI il 400 di `resolveScuolaScrittura`.
 */
export function SedeNotice({ cosa }: { cosa?: string }) {
  return (
    <div className="rounded-2xl border border-kidville-line bg-kidville-white p-8 text-center">
      <p className="font-barlow text-lg font-extrabold uppercase text-kidville-green">Seleziona una sede</p>
      <p className="mt-2 font-maven text-[14px] text-kidville-muted">
        Hai più sedi attive. Scegline <strong>una sola</strong> dal menu in alto
        {cosa ? <> per gestire {cosa}</> : null}.
      </p>
    </div>
  );
}

/**
 * Guard per le pagine di CONFIGURAZIONE mono-sede (pagamenti, mensa, modulistica,
 * primaria, impostazioni): queste operano su UNA sede alla volta. Rende i figli
 * solo quando è attiva una singola sede, passandone l'id via render-prop; se sono
 * selezionate più sedi (ambiguo) mostra `SedeNotice`. Con una sola sede accessibile
 * è sempre "pronto".
 */
export function SedeRequired({
  cosa,
  children,
}: {
  cosa?: string;
  children: (scuolaId: string) => React.ReactNode;
}) {
  const { sedeCorrente, loading } = useSediAttive();
  if (loading) {
    return <div className="p-8 font-maven text-kidville-muted">Caricamento…</div>;
  }
  if (!sedeCorrente) {
    return <SedeNotice cosa={cosa} />;
  }
  return <>{children(sedeCorrente)}</>;
}
