/**
 * ═════════════════════════════════════════════════════════════════════════════
 * IL VINCOLO `parents_fiscal_code_key`, RICONOSCIUTO IN UN POSTO SOLO.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `parents.fiscal_code` è UNIQUE (misurato l'11 agosto su `pg_constraint`:
 * `parents_fiscal_code_key UNIQUE (fiscal_code)`). Scrivere su un genitore il
 * codice che appartiene già a un altro fa rispondere Postgres `23505`, e la rotta
 * lo rimanda su come `error.message` grezzo — «duplicate key value violates unique
 * constraint "parents_fiscal_code_key"». A chi sta correggendo un'anagrafica quella
 * riga non dice NIENTE: non nomina il codice fiscale, non dice che esiste già
 * qualcun altro con quel codice, e sembra un guasto invece di un dato da verificare.
 *
 * ⚠️ E NON È UN CASO DI SCUOLA: sempre l'11 agosto, in produzione, su 50 genitori
 * **26 hanno `fiscal_code` NULL e UNO ha la stringa VUOTA**. Con `UNIQUE` la
 * stringa vuota è un valore come gli altri — `NULL` no — quindi il secondo record
 * che ricevesse `''` collide con quell'unico. È la ragione per cui le schede
 * normalizzano il campo vuoto a `null` PRIMA di salvare, e questa funzione esiste
 * per il giorno in cui la collisione arriva lo stesso.
 *
 * ─── PERCHÉ QUI E NON DENTRO UNA SCHEDA ─────────────────────────────────────
 * Fino al 2026-08-11 questa funzione viveva dentro `ParentDetailPanel.tsx`, cioè
 * dentro un componente `'use client'`, e l'altra scheda la importava DA LÌ: una
 * regola di dominio raggiungibile solo passando per un pezzo di interfaccia. La
 * regola vale per più strade (PATCH `/api/admin/parents` e domani qualunque rotta
 * che scriva su quella colonna), quindi vive in `src/lib`, dove non porta con sé
 * React. Qui era citata anche `POST /api/admin/adults`: **non esiste più**,
 * cancellata l'11/08/2026 perché irraggiungibile e rotta (scriveva le colonne
 * generate di `utenti`) — vedi il commento in `src/app/api/admin/adults/route.ts`.
 *
 * Non si guarda solo il codice `23505`: le rotte oggi rimandano il solo `message`,
 * senza `code`. Si riconosce il nome del vincolo, che è il segnale più specifico.
 */
export function eCfGenitoreDuplicato(messaggio: unknown): boolean {
  if (typeof messaggio !== 'string') return false
  const m = messaggio.toLowerCase()
  if (m.includes('parents_fiscal_code_key')) return true
  const duplicato = m.includes('23505') || m.includes('duplicate key')
  return duplicato && m.includes('fiscal_code')
}
