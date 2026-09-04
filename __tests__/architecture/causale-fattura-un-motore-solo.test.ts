// @vitest-environment node
/**
 * LOCK · la causale della fattura si compone in UN POSTO SOLO, e chi la mostra usa
 * quello che la emette.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────────
 * Il 2026-09-03 la fattura FPR 1948/26 è partita verso lo SDI con «Retta 09/2026» —
 * la nuda `pagamenti.descrizione` — mentre la sede di Aversa aveva configurato
 * «Pagamento retta del mese di {mese} {anno}. Per il figlio minore {nome_completo}
 * C. F. {codice_fiscale}». Non era un guasto dell'emissione: era il modale «Emetti»,
 * che precompilava la casella della causale con la descrizione del pagamento e la
 * spediva come *correzione manuale della segreteria* — che per progetto batte
 * qualunque modello. Chi premeva il pulsante annullava la configurazione senza
 * saperlo, e senza poterlo vedere.
 *
 * La correzione è mostrare **prima** cosa uscirà. Ma un'anteprima ricalcolata a
 * parte sarebbe peggio del difetto che chiude: la segreteria approverebbe un testo e
 * ne spedirebbe un altro, su un documento che si corregge solo con una nota di
 * variazione. Ed è una divergenza che non darebbe nessun errore — `renderCausale`
 * omette con grazia i segmenti coi segnaposto vuoti, e la grazia è proprio ciò che
 * la renderebbe invisibile.
 *
 * Questa regola era già stata scritta tre volte in passato (elenco pagamenti,
 * solleciti, e mai davvero nella fatturazione): v. la testata di `modelloCausale` in
 * `src/lib/pagamenti/causale.ts`.
 *
 * ─── COSA SORVEGLIA, E COSA NO ─────────────────────────────────────────────────
 *  1. `causaleFattura` / `causaleFatturaConOrigine` si chiamano da UN solo modulo di
 *     produzione: `src/lib/aruba/causale-pagamento.ts`. Chiunque altro passa di lì.
 *  2. `emissione.ts` e la route di anteprima usano entrambi `componiCausalePagamento`.
 *  3. Nessun file client (`'use client'`) importa il motore delle causali per la
 *     fattura: ricalcolare nel browser è l'altra forma della stessa divergenza.
 *
 * Non verifica che la causale sia GIUSTA — quello è
 * `__tests__/api/fattura-anteprima.test.ts` (compreso il caso ANTI-DIVERGENZA che
 * confronta le due strade sullo stesso pagamento) e
 * `__tests__/lib/pagamenti-causale-fattura.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.join(process.cwd(), 'src')

/**
 * I due moduli ammessi: quello che DEFINISCE le funzioni (dove `causaleFattura`
 * delega a `causaleFatturaConOrigine`) e quello che le CHIAMA per conto di tutti.
 */
const AMMESSI = [
    path.join('src', 'lib', 'pagamenti', 'causale-fattura.ts'),
    path.join('src', 'lib', 'aruba', 'causale-pagamento.ts'),
]

function fileTs(dir: string, out: string[] = []): string[] {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) fileTs(p, out)
    else if (/\.tsx?$/.test(voce.name)) out.push(p)
  }
  return out
}

/** Via i commenti: un lock non deve poter essere aggirato — né innescato — da una frase. */
function soloCodice(testo: string): string {
  return testo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const FILE = fileTs(RADICE).map((assoluto) => ({
  relativo: path.relative(process.cwd(), assoluto),
  codice: soloCodice(fs.readFileSync(assoluto, 'utf-8')),
}))

describe('LOCK · un solo motore per la causale della fattura', () => {
  it('solo `causale-pagamento.ts` invoca `causaleFattura`/`causaleFatturaConOrigine`', () => {
    const colpevoli = FILE.filter(
      (f) => !AMMESSI.includes(f.relativo) && /\bcausaleFattura(ConOrigine)?\s*\(/.test(f.codice)
    ).map((f) => f.relativo)
    expect(colpevoli).toEqual([])
  })

  it('l’emissione e l’anteprima passano entrambe da `componiCausalePagamento`', () => {
    const usano = FILE.filter((f) => /componiCausalePagamento\s*\(/.test(f.codice)).map((f) => f.relativo)
    expect(usano).toContain(path.join('src', 'lib', 'aruba', 'emissione.ts'))
    expect(usano).toContain(path.join('src', 'app', 'api', 'pagamenti', 'fattura', 'anteprima', 'route.ts'))
  })

  it('nessun componente client ricalcola la causale della fattura', () => {
    const client = FILE.filter(
      (f) =>
        /^\s*['"]use client['"]/m.test(f.codice) &&
        /from ['"]@\/lib\/pagamenti\/causale-fattura['"]/.test(f.codice) &&
        /\b(causaleFattura|causaleFatturaConOrigine|risolviModelloCausale|modelloCausale)\s*\(/.test(f.codice)
    ).map((f) => f.relativo)
    expect(client).toEqual([])
  })
})
