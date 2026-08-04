'use client';

import { creaCachePromesse } from '@/lib/rete/cache-promesse';

/**
 * GET /api/educator-sections — le sezioni assegnate al docente.
 *
 * Stessa storia di `diary/config`: il valore non cambia dentro un ingresso in
 * pagina, ma ogni componente che ne ha bisogno apriva la propria richiesta, e
 * con StrictMode (`next dev`, che è come gira l'E2E in CI) ognuna diventava due.
 *
 * ⚠️ La chiave è l'uuid del docente e non può diventare fissa: le sezioni sono
 * l'elenco dei bambini di cui quel docente è responsabile. Mostrarne una altrui
 * non è un problema di prestazioni, è un problema di isolamento fra sedi.
 */
export interface SezioneDocente {
  name: string;
  school_type: string | null;
}

export interface EducatorSectionsRisposta {
  sections?: SezioneDocente[];
  /** Forma vecchia della risposta: solo i nomi. */
  sectionNames?: string[];
}

async function caricaSezioni(userId: string): Promise<EducatorSectionsRisposta | null> {
  try {
    const res = await fetch(`/api/educator-sections?userId=${userId}`);
    if (!res.ok) return null;
    return (await res.json()) as EducatorSectionsRisposta;
  } catch {
    return null;
  }
}

const cache = creaCachePromesse(caricaSezioni);

/** Sezioni del docente indicato. `null` = non determinabile. */
export function fetchEducatorSections(userId: string | null): Promise<EducatorSectionsRisposta | null> {
  return cache.leggi(userId ?? '');
}

/** Svuota la cache (cambio identità, e fra un test e l'altro). */
export function invalidaEducatorSectionsCache(userId?: string): void {
  cache.invalida(userId);
}

/**
 * Normalizza la risposta in un elenco di sezioni, qualunque forma abbia.
 * Vive qui, con la richiesta, perché era già duplicata parola per parola in
 * più pagine — e una regola valida per due strade deve stare in un posto solo.
 */
export function sezioniDallaRisposta(risposta: EducatorSectionsRisposta | null): SezioneDocente[] {
  if (!risposta) return [];
  if (Array.isArray(risposta.sections)) return risposta.sections;
  if (Array.isArray(risposta.sectionNames)) {
    return risposta.sectionNames.map((name) => ({ name, school_type: null }));
  }
  return [];
}
