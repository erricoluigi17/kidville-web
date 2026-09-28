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
  /** `null` = la sede non ha mai scelto: valgono le routine predefinite (`@/lib/diary/routine`). */
  routine_attive?: unknown;
  /** Le routine aggiunte dalla segreteria, già filtrate alle ATTIVE (2026-09-28). */
  routine_personalizzate?: unknown;
  diario_primaria_visibile?: boolean;
}

/**
 * La chiave è `utente|sede`. La sede entra dal 2026-09-28: con le routine che funzionano, il
 * cockpit di segreteria che compila il diario di un'ALTRA sede deve vedere le routine di quella,
 * non della propria (prima la GET usava sempre la sede primaria dell'utente).
 */
function chiave(userId: string, scuolaId?: string | null): string {
  return `${userId}|${scuolaId ?? ''}`;
}

async function caricaDiarioConfig(k: string): Promise<DiarioConfigRisposta | null> {
  const [userId, scuolaId] = k.split('|');
  const qs = new URLSearchParams();
  if (userId) qs.set('userId', userId);
  if (scuolaId) qs.set('scuola_id', scuolaId);
  try {
    // `qs.toString()` e non `qs.size`: `size` manca nei WebView iOS più vecchi, dove l'app gira.
    const query = qs.toString();
    const res = await fetch(`/api/diary/config${query ? `?${query}` : ''}`);
    if (!res.ok) return null;
    return (await res.json()) as DiarioConfigRisposta;
  } catch {
    // Rete assente o corpo illeggibile: "non lo so". Non si conserva (la voce
    // viene rimossa dalla cache), così il mount successivo ritenta.
    return null;
  }
}

const cache = creaCachePromesse(caricaDiarioConfig);

/**
 * Config del diario per il docente indicato, della sede indicata (assente = la sua sede).
 * `null` = non determinabile.
 */
export function fetchDiarioConfig(userId: string | null, scuolaId?: string | null): Promise<DiarioConfigRisposta | null> {
  return cache.leggi(chiave(userId ?? '', scuolaId));
}

/** Svuota la cache (cambio identità, e fra un test e l'altro). Senza argomenti: tutta. */
export function invalidaDiarioConfigCache(userId?: string, scuolaId?: string | null): void {
  cache.invalida(userId === undefined ? undefined : chiave(userId, scuolaId));
}
