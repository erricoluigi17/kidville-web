/**
 * IL CONTEGGIO DI UNA SCHEDA: funzione pura, nessun accesso al database.
 *
 * Dai voti di UNA scheda ricava i candidati con i loro voti (in ordine decrescente) e chi è stato
 * eletto. Regola decisa dal titolare: vince chi ha PIÙ voti; in caso di PARITÀ decide la segreteria.
 * Perciò `eletti` non sceglie mai fra due pari merito: li restituisce tutti.
 *
 *  · `eletti.length === 1` → un eletto;
 *  · `eletti.length  >  1` → parità fra i primi (la schermata dice «decide la segreteria»);
 *  · `eletti.length === 0` → nessun voto (il massimo è 0, e un candidato a zero non è mai eletto).
 *
 * `candidatiAZero` sono i candidati che devono comparire anche senza voti (l’istituto mostra tutti i
 * candidati; la classe solo chi ha preso almeno un voto, quindi lì non si passa).
 *
 * L’ordine dei `conteggi` è: voti decrescenti, poi `utenteId` crescente. Il secondo criterio serve solo
 * a rendere l’uscita DETERMINISTICA (non dipende dall’ordine con cui il database restituisce i voti); il
 * criterio per NOME, che richiede i nomi, lo applica chi li ha (`RisultatoScheda.candidati`).
 */
export function contaVoti(
  voti: ReadonlyArray<{ candidatoId: string }>,
  candidatiAZero: readonly string[] = [],
): { conteggi: { utenteId: string; voti: number }[]; eletti: string[] } {
  const perCandidato = new Map<string, number>()
  for (const id of candidatiAZero) {
    if (!perCandidato.has(id)) perCandidato.set(id, 0)
  }
  for (const v of voti) {
    perCandidato.set(v.candidatoId, (perCandidato.get(v.candidatoId) ?? 0) + 1)
  }

  const conteggi = [...perCandidato].map(([utenteId, n]) => ({ utenteId, voti: n }))
  conteggi.sort((a, b) => b.voti - a.voti || (a.utenteId < b.utenteId ? -1 : a.utenteId > b.utenteId ? 1 : 0))

  const massimo = conteggi.length > 0 ? conteggi[0].voti : 0
  const eletti = massimo > 0 ? conteggi.filter((c) => c.voti === massimo).map((c) => c.utenteId) : []
  return { conteggi, eletti }
}

/**
 * L’affluenza di una scheda come FRAZIONE (`votanti / aventi`, 0 = nessuno ha votato, 1 = hanno votato
 * tutti), oppure 0 quando non si può calcolare.
 *
 * ⚠️ `aventi` vale 0 per una classe in cui nessun genitore ha un account (Review Focus 4): senza questa
 * guardia sarebbe `NaN` o `Infinity` a schermo. Anche gli altri valori non calcolabili (non finiti,
 * `aventi` negativo) danno 0 e non un numero senza senso.
 *
 * NON si taglia a 1: gli aventi diritto si calcolano al momento in cui si guarda, e un bambino che
 * cambia classe porta via l’avente diritto ma il suo voto già dato resta. `votanti > aventi` è possibile,
 * e dirlo è più onesto che nasconderlo.
 */
export function affluenza(votanti: number, aventi: number): number {
  if (!Number.isFinite(votanti) || !Number.isFinite(aventi) || aventi <= 0) return 0
  return votanti / aventi
}
