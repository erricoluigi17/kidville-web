// ─── Ponte «alunni riconosciuti per CF → genitore pagante comune» (Riconc. v2) ─
// Un bonifico di famiglia salda più figli: cliccando «Apri Incasso unico» dal
// MovimentoDialog di un movimento multi-CF, si precompila il wizard col PAGANTE.
// Il pagante è il genitore legato a TUTTI gli alunni riconosciuti (`student_parents`).
//
// Questa è la parte PURA (testabile senza DB): sceglie il pagante da una lista di
// legami `{ parent_id, student_id }`. L'I/O (query student_parents + intestatario
// di default) vive nella route `api/pagamenti/pagante-comune`.

export interface LegameGenitoreAlunno {
  parent_id?: string | null
  student_id?: string | null
}

/**
 * Sceglie il genitore pagante comune a TUTTI gli `alunni` richiesti.
 *  · genitore comune = legato a ognuno degli alunni richiesti (unico o più);
 *  · fra più candidati comuni vince l'intestatario di default, se indicato;
 *  · a parità (nessun default) → scelta deterministica (ordinamento crescente);
 *  · nessun genitore comune a tutti → `null` (la UI aprirà «scegli pagante»).
 */
export function scegliPaganteComune(
  links: LegameGenitoreAlunno[],
  alunni: string[],
  intestatariDefault?: ReadonlySet<string>,
): string | null {
  const richiesti = new Set(alunni.filter(Boolean))
  if (richiesti.size === 0) return null

  // parent_id → set degli alunni RICHIESTI a cui è legato.
  const perGenitore = new Map<string, Set<string>>()
  for (const l of links) {
    if (!l.parent_id || !l.student_id) continue
    if (!richiesti.has(l.student_id)) continue
    let s = perGenitore.get(l.parent_id)
    if (!s) { s = new Set(); perGenitore.set(l.parent_id, s) }
    s.add(l.student_id)
  }

  // Genitori che coprono TUTTI i richiesti.
  const comuni: string[] = []
  for (const [pid, s] of perGenitore) if (s.size === richiesti.size) comuni.push(pid)
  if (comuni.length === 0) return null

  comuni.sort() // determinismo a parità
  if (intestatariDefault) {
    const def = comuni.find((p) => intestatariDefault.has(p))
    if (def) return def
  }
  return comuni[0]
}
