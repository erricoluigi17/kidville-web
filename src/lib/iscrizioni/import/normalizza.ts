/**
 * Gli attrezzi per confrontare due nomi scritti da due mani diverse.
 *
 * ─── PERCHÉ ESISTE QUESTO FILE ──────────────────────────────────────────────
 * Lo stesso bambino arriva da due parti che non si sono mai parlate: il genitore
 * lo scrive nel form pubblico, la segreteria lo scrive nell'elenco di classe in
 * Excel. Misurato il 2026-08-16 sul file vero di Giugliano (338 righe) contro le
 * 221 domande già arrivate: 14 nomi hanno spazi doppi o in coda, uno è tutto in
 * minuscolo, uno ha un'annotazione fra parentesi — `ESPOSITO ANDREA (CIRO)` — e
 * uno ha nome e cognome invertiti rispetto al foglio.
 *
 * ─── LA RIGA CHE SEPARA UNA GRAFIA DA UN ERRORE ─────────────────────────────
 * Queste funzioni tolgono le differenze di SCRITTURA: maiuscole, accenti,
 * apostrofi, spazi, parentesi. Non toccano gli ERRORI. `DIECO` per `DIEGO` non è
 * una grafia diversa: è un refuso, e va corretto da una persona.
 *
 * `similitudine` non serve a decidere: serve solo a comporre i tre nomi più
 * somiglianti da mettere nella nota per la segreteria. Chi la usa per abbinare
 * mette un bambino in una classe sbagliata, e nessuno se ne accorge finché non
 * lo cerca la maestra.
 */

/**
 * Il nome ridotto alla sua forma confrontabile: MAIUSCOLO, senza accenti, senza
 * apostrofi, senza annotazioni fra parentesi, con gli spazi stretti a uno solo.
 *
 * L'apostrofo diventa uno SPAZIO e non il nulla: `D'Angelo` e `D Angelo` devono
 * cadere insieme, e la forma tutta attaccata la recupera comunque `senzaSpazi`.
 */
export function normalizzaNome(valore: string | null | undefined): string {
  if (valore === null || valore === undefined) return ''
  return String(valore)
    .normalize('NFD')
    // via i segni diacritici staccati dalla NFD: CÉLINE → CELINE
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    // le annotazioni fra parentesi sono note della segreteria, non parti del nome
    .replace(/\([^)]*\)/g, ' ')
    // apostrofi dritti, curvi e accenti gravi usati come apostrofo
    .replace(/['’`´]/g, ' ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Il nome normalizzato e saldato: serve a far cadere insieme `DESIO GIUNTO` e
 * `De Sio Giunto`, `GIULIA RITA` e `GiuliaRita` — cioè lo stesso nome con gli
 * spazi messi in un altro punto.
 */
export function senzaSpazi(valore: string | null | undefined): string {
  return normalizzaNome(valore).replace(/ /g, '')
}

/**
 * Le parole del nome, come insieme: due nomi con le stesse parole in ordine
 * diverso sono la stessa persona scritta al contrario (`Njambe Charmant` nel
 * form, `CHARMANT NJAMBE` nel foglio).
 */
export function tokenNome(valore: string | null | undefined): Set<string> {
  const n = normalizzaNome(valore)
  return new Set(n ? n.split(' ') : [])
}

/** Due insiemi di parole con gli stessi elementi. */
export function stessiToken(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size || a.size === 0) return false
  for (const t of a) if (!b.has(t)) return false
  return true
}

/**
 * Quanto due nomi si somigliano, da 0 a 1 (coefficiente di Dice sui bigrammi).
 *
 * Sta qui e non in una libreria per una ragione pratica: è una decina di righe,
 * e una dipendenza in più su un percorso che tocca dati di minori è una
 * dipendenza in più da fidarsi. Nessun uso decisionale: solo i «forse cercavi».
 */
export function similitudine(a: string, b: string): number {
  const x = normalizzaNome(a)
  const y = normalizzaNome(b)
  if (x === y) return 1
  // sotto i due caratteri i bigrammi non esistono: si confronta e basta
  if (x.length < 2 || y.length < 2) return 0

  const bigrammi = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) ?? 0) + 1)
    }
    return m
  }
  const ma = bigrammi(x)
  const mb = bigrammi(y)
  let comuni = 0
  for (const [g, n] of ma) comuni += Math.min(n, mb.get(g) ?? 0)
  return (2 * comuni) / (x.length - 1 + (y.length - 1))
}
