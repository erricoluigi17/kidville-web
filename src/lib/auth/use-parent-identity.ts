'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { logClient } from '@/lib/logging/client';
import { useSessionIdentity } from './use-session-identity';
import { getCurrentStudentId } from './current-user';

export interface ParentIdentity {
  parentId: string | null;
  studentId: string | null;
  ready: boolean; // false finché l'auto-resolve non è completato
}

/** Esito della rivalidazione di uno studentId "noto" contro i figli reali. */
export interface RivalidazioneFiglio {
  /** L'id alunno da usare dopo la rivalidazione. */
  studentId: string | null;
  /** Scrivere kv_student_id = studentId nel localStorage. */
  aggiornaCache: boolean;
  /** Rimuovere kv_student_id dal localStorage: era stantio/altrui/inesistente. */
  rimuoviCache: boolean;
}

/**
 * Decisione PURA di rivalidazione. Dato l'id "noto" (URL/localStorage) e la
 * lista dei figli REALI del genitore, stabilisce quale alunno usare e come
 * toccare la cache.
 *
 * `figliIds === null` significa "lista non determinabile" (fetch fallita, rete
 * giù, endpoint 4xx/5xx): si degrada al noto SENZA toccare la cache — una cache
 * buona non va cancellata per un blip di rete. È il punto che impedisce che il
 * fix diventi un nuovo modo di perdere l'identità offline.
 */
export function decidiFiglioRivalidato(
  known: string | null,
  figliIds: string[] | null,
): RivalidazioneFiglio {
  // Lista non determinabile: degrada al noto, cache intatta.
  if (figliIds === null) {
    return { studentId: known, aggiornaCache: false, rimuoviCache: false };
  }
  const primo = figliIds[0] ?? null;

  // Il noto è un figlio reale: resta com'è, nessuna scrittura.
  if (known && figliIds.includes(known)) {
    return { studentId: known, aggiornaCache: false, rimuoviCache: false };
  }
  // Il noto NON è tra i figli (cache stantia, URL altrui, alunno TEST ricreato):
  // butta la cache e passa al primo figlio. È il bug del 403 deterministico
  // della mensa: qui si auto-guarisce per TUTTE le pagine genitore.
  if (known) {
    return { studentId: primo, aggiornaCache: primo !== null, rimuoviCache: true };
  }
  // Nessun noto: primo figlio (comportamento storico), aggiorna la cache.
  return { studentId: primo, aggiornaCache: primo !== null, rimuoviCache: false };
}

/**
 * Chiede al backend gli id dei figli del genitore. Ritorna la lista, oppure
 * `null` se NON determinabile (rete giù, endpoint non-ok, corpo inatteso): il
 * chiamante degrada al noto. Non lancia mai.
 */
export async function fetchFigliIds(parentId: string): Promise<string[] | null> {
  let res: Response;
  try {
    res = await fetch(`/api/parent/students?userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
  } catch {
    // Rete non disponibile: la rivalidazione è best-effort. Si degrada al noto
    // (ritorna null, la cache resta valida). Non si logga: l'offline è uno stato
    // normale e non è l'incidente che ci interessa osservare qui.
    return null;
  }
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) return null;
  return (body.data as Array<{ id?: unknown }>)
    .map((x) => x?.id)
    .filter((v): v is string => typeof v === 'string');
}

/**
 * Rivalida uno studentId "noto" contro i figli reali del genitore.
 * Combina fetch + decisione pura. Senza `parentId` non può rivalidare → degrada
 * al noto senza chiamare il backend.
 */
export async function rivalidaFiglio(
  known: string | null,
  parentId: string | null,
): Promise<RivalidazioneFiglio> {
  if (!parentId) {
    return { studentId: known, aggiornaCache: false, rimuoviCache: false };
  }
  const figliIds = await fetchFigliIds(parentId);
  return decidiFiglioRivalidato(known, figliIds);
}

/**
 * Risolve parentId e studentId per le pagine genitore.
 * parentId viene dall'identità di sessione (URL → localStorage → /api/me →
 * null+redirect login, vedi useSessionIdentity).
 *
 * studentId: URL o localStorage danno un id "noto", che NON è più preso per buono
 * a scatola chiusa — viene RIVALIDATO contro i figli reali del genitore
 * (/api/parent/students). Se il noto non è tra i figli (cambio account senza
 * logout, URL stantio, alunno TEST ricreato) la cache viene ripulita e si passa
 * al primo figlio; se la fetch fallisce si degrada al noto (nessun blocco).
 * Nessun fallback demo (M4).
 */
export function useParentIdentity(): ParentIdentity {
  const session = useSessionIdentity();
  const searchParams = useSearchParams();
  // Inizializza solo dall'URL per evitare hydration mismatch (localStorage non
  // è disponibile durante SSR). Il useEffect risolve/rivalida dopo il mount.
  const fromUrl = searchParams.get('id');
  const [studentId, setStudentId] = useState<string | null>(fromUrl);
  const [studentReady, setStudentReady] = useState<boolean>(false);

  useEffect(() => {
    if (!session.ready) return;
    const parentId = session.userId;
    let cancelled = false;

    const resolve = async () => {
      // `known`: URL esplicita o localStorage. NB: getCurrentStudentId, se l'id
      // è in URL, lo persiste in cache — lo rivalidiamo comunque subito dopo.
      const known = getCurrentStudentId(searchParams);

      // Una sola rivalidazione per mount (non per render): la fetch vive qui,
      // dentro l'effect, non nel corpo del componente.
      const esito = await rivalidaFiglio(known, parentId);
      if (cancelled) return;

      if (esito.rimuoviCache) {
        try { localStorage.removeItem('kv_student_id'); } catch { /* ignore */ }
        // Breadcrumb: cache stantia/altrui rilevata e corretta. È esattamente il
        // log che avrebbe reso visibile il 403 ricorrente della mensa. Solo uuid
        // (nessun nome/email): passano la redazione.
        if (known) {
          logClient({
            livello: 'warn',
            evento: 'react',
            messaggio: `parent-identity: studentId noto non tra i figli del genitore → autorecupero (noto=${known} genitore=${parentId ?? 'nessuno'} nuovo=${esito.studentId ?? 'nessuno'})`,
          });
        }
      }
      if (esito.aggiornaCache && esito.studentId) {
        try { localStorage.setItem('kv_student_id', esito.studentId); } catch { /* ignore */ }
      }

      setStudentId(esito.studentId);
      setStudentReady(true);
    };
    void resolve();
    return () => { cancelled = true; };
  }, [session.ready, session.userId, searchParams]);

  return { parentId: session.userId, studentId, ready: session.ready && studentReady };
}
