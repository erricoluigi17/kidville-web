/**
 * LA FORMULA DEL TRIGGER, IN UN POSTO SOLO.
 *
 * Il nome di una classe scritto a mano dalla segreteria deve ritrovare la
 * sezione in archivio, e a deciderlo è un trigger nel database:
 *
 *   lower(replace(s.name, ' ', '')) = lower(replace(NEW.classe_sezione, ' ', ''))
 *   — `sync_alunno_section_id()`, supabase/migrations/20260704120000_baseline.sql
 *
 * Cioè: via TUTTI gli spazi (non un `trim`, che lascerebbe quelli interni) e
 * minuscolo. Niente altro: il punto di `4 ANNI M.ROSARIA` resta, e la barra di
 * `NIDO 2026/2027` resta.
 *
 * ─── PERCHÉ VIVE QUI E NON IN DUE COPIE ─────────────────────────────────────
 * Chi in TypeScript vuole sapere in anticipo se una classe troverà la sua
 * sezione deve fare **esattamente** questo conto. Una copia che normalizzasse un
 * carattere in più accetterebbe nomi che il trigger poi NON risolve — e il
 * difetto tornerebbe identico e muto: `section_id` NULL, il bambino iscritto ma
 * invisibile all'appello. Una che ne normalizzasse uno in meno boccerebbe
 * assegnazioni valide.
 *
 * ⚠️ NON si usa `normalizzaNome` di `iscrizioni/import/normalizza.ts`: quella
 * toglie anche punti, apostrofi e parentesi, quindi farebbe combaciare
 * `4 ANNI M.ROSARIA` con `4 ANNI MROSARIA` — che il trigger non risolve. Due
 * normalizzazioni diverse per due lavori diversi, e vanno tenute distinte.
 *
 * Il lock `__tests__/architecture/formula-sezione-un-posto-solo.test.ts` impedisce
 * che ne rinasca una copia dentro `src/`.
 */
export function normalizzaNomeSezione(nome: unknown): string {
  return String(nome ?? '').replace(/ /g, '').toLowerCase()
}

/**
 * Codici PostgREST/Postgres che significano «qui lo schema non c'è» (il DB E2E
 * della CI non è migrato): non sono guasti, sono un ambiente diverso.
 *  42P01 tabella assente · 42703 colonna assente (SELECT) · PGRST204 colonna
 *  assente (INSERT/UPDATE) · PGRST205 tabella non in cache.
 */
export const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])
