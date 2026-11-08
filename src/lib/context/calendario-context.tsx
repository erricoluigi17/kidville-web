'use client';

/**
 * Il calendario dell'anno scolastico nel browser: legge `GET /api/anno/calendario` UNA volta per shell
 * (e a `ricarica()`) e lo offre ai componenti, che chiedono `useAnnoDi(sede)(giorno)` invece di
 * ricalcolare l'anno con `getMonth()` nel fuso del browser.
 *
 * ─── DUE REGOLE, ENTRAMBE GIÀ PAGATE ────────────────────────────────────────
 *
 *  · NESSUNA ECCEZIONE FUORI DAL PROVIDER. Gli hook qui sotto rispondono anche senza provider (test,
 *    pagine pubbliche), prima che la risposta arrivi, con la fetch rotta o senza sede: in tutti questi
 *    casi vale il PREDEFINITO (`annoDelGiorno(giorno)`). Un hook che lancia fuori dal provider ha già
 *    fatto esplodere cinque file di test in blocco (vedi `useRuoloCockpit`, `admin-identity.tsx`).
 *  · NESSUNA `new Date()` NEL RENDER (idratazione): il provider non calcola «oggi», chi chiama passa il
 *    giorno.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { annoDelGiorno, type AnnoDelGiorno, type Calendario, type RigaCalendario } from '@/lib/anno-scolastico';
import { logClient } from '@/lib/logging/client';

interface CalendarioValue {
  perSede: Record<string, Calendario>;
  /** `true` finché la prima risposta non è arrivata (o è fallita). */
  loading: boolean;
  /** L'ultima lettura è fallita: il predefinito continua a rispondere. */
  errore: boolean;
  ricarica(): void;
}

const VUOTO: CalendarioValue = { perSede: {}, loading: false, errore: false, ricarica: () => {} };
const CalendarioContext = createContext<CalendarioValue | null>(null);

type Risposta = { perSede: Record<string, Calendario> };

/** Solo la forma: ogni riga è già stata validata dal server (`caricaCalendario`). */
function leggiRisposta(corpo: unknown): Risposta | null {
  const data = (corpo as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const perSede: Record<string, Calendario> = {};
  for (const d of data) {
    const sede = (d as { scuola_id?: unknown })?.scuola_id;
    const righe = (d as { righe?: unknown })?.righe;
    if (typeof sede === 'string' && Array.isArray(righe)) perSede[sede] = righe as RigaCalendario[];
  }
  return { perSede };
}

// Funzione di modulo (non un setState sincrono nell'effect): vedi la regola react-hooks/set-state-in-effect.
async function scarica(userId: string | null | undefined): Promise<Risposta | { stato: number } | null> {
  const res = await fetch('/api/anno/calendario', {
    credentials: 'same-origin',
    headers: userId ? { 'x-user-id': userId } : undefined,
  });
  if (!res.ok) return { stato: res.status };
  return leggiRisposta(await res.json());
}

export function CalendarioProvider({ children, userId }: { children: React.ReactNode; userId?: string | null }) {
  const [perSede, setPerSede] = useState<Record<string, Calendario>>({});
  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState(false);
  const [giro, setGiro] = useState(0);
  const segnalato = useRef(false);
  // `userId` non è una dipendenza: la fetch parte al montaggio e a `ricarica()`, non a ogni cambio.
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    let annullato = false;
    const guasto = (messaggio: string, stato?: number) => {
      if (!segnalato.current) {
        segnalato.current = true;
        logClient({ livello: 'warn', evento: 'fetch', messaggio, ...(stato ? { stato } : {}) });
      }
      setErrore(true);
      setLoading(false);
    };
    scarica(userIdRef.current)
      .then((esito) => {
        if (annullato) return;
        if (esito && 'perSede' in esito) {
          setPerSede(esito.perSede);
          setErrore(false);
          setLoading(false);
        } else if (esito && 'stato' in esito) {
          guasto('calendario-anno-non-caricato', esito.stato);
        } else {
          guasto('calendario-anno-risposta-illeggibile');
        }
      })
      .catch(() => {
        if (!annullato) guasto('calendario-anno-non-caricato');
      });
    return () => {
      annullato = true;
    };
  }, [giro]);

  const ricarica = useCallback(() => {
    setLoading(true);
    setGiro((g) => g + 1);
  }, []);

  const value = useMemo(() => ({ perSede, loading, errore, ricarica }), [perSede, loading, errore, ricarica]);
  return <CalendarioContext.Provider value={value}>{children}</CalendarioContext.Provider>;
}

/** Il calendario di tutte le sedi dell'utente. Fuori dal provider: vuoto, senza eccezioni. */
export function useCalendario(): CalendarioValue {
  return useContext(CalendarioContext) ?? VUOTO;
}

/**
 * `(giorno) => anno` per una sede. Stabile fra i render finché il calendario DI QUELLA sede non cambia,
 * così si può mettere nelle dipendenze di un effetto. Senza provider, senza sede, prima della risposta o
 * con la fetch rotta risponde col predefinito. Un `giorno` non valido lancia, come `annoDelGiorno`.
 */
export function useAnnoDi(scuolaId?: string | null): (giorno: string) => AnnoDelGiorno {
  const { perSede } = useCalendario();
  const cal = (scuolaId ? perSede[scuolaId] : undefined) ?? null;
  return useCallback((giorno: string) => annoDelGiorno(giorno, cal), [cal]);
}
