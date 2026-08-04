'use client';

import { creaCachePromesse } from '@/lib/rete/cache-promesse';

/**
 * GET /api/diary/config — una risposta sola, tre lettori.
 *
 * L'endpoint restituisce insieme `routine_attive` (quali tipi evento mostrare)
 * e `diario_primaria_visibile` (se il diario 0-6 è esposto alla primaria), e
 * ignora il `?userId=` — l'identità la prende dalla sessione. Tre punti del
 * codice ne avevano bisogno e ognuno se la chiedeva da solo: il chrome di
 * `/teacher/diary`, `useDiaryDay` dentro l'editor, `useTeacherGradi` nella
 * bottom-nav. Con StrictMode di `next dev` sono sei richieste identiche a ogni
 * ingresso in pagina; sul trace della CI erano quattro delle chiamate che hanno
 * fatto scadere l'E2E del diario.
 *
 * La chiave resta l'identità del docente: la configurazione dipende dalla SEDE
 * dell'utente (`auth.user.scuola_id`), quindi due docenti diversi possono
 * riceverne due diverse e non devono mai leggere quella dell'altro.
 */
export interface DiarioConfigRisposta {
  routine_attive?: unknown;
  diario_primaria_visibile?: boolean;
}

async function caricaDiarioConfig(userId: string): Promise<DiarioConfigRisposta | null> {
  try {
    const res = await fetch(`/api/diary/config${userId ? `?userId=${userId}` : ''}`);
    if (!res.ok) return null;
    return (await res.json()) as DiarioConfigRisposta;
  } catch {
    // Rete assente o corpo illeggibile: "non lo so". Non si conserva (la voce
    // viene rimossa dalla cache), così il mount successivo ritenta.
    return null;
  }
}

const cache = creaCachePromesse(caricaDiarioConfig);

/** Config del diario per il docente indicato. `null` = non determinabile. */
export function fetchDiarioConfig(userId: string | null): Promise<DiarioConfigRisposta | null> {
  return cache.leggi(userId ?? '');
}

/** Svuota la cache (cambio identità, e fra un test e l'altro). */
export function invalidaDiarioConfigCache(userId?: string): void {
  cache.invalida(userId);
}
