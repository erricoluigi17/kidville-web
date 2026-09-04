// @vitest-environment node
/**
 * LOCK · CHI intesta la fattura si decide in UN POSTO SOLO, e chi lo MOSTRA usa
 * quello che EMETTE.
 *
 * ─── PERCHÉ ESISTE, ed è la stessa storia della causale ──────────────────────
 * Il 2026-09-03 la FPR 1948/26 è partita con una descrizione diversa da quella
 * configurata, perché il modale «Emetti» la ricalcolava per conto suo: la
 * segreteria approvava un testo e ne partiva un altro. Da lì il lock gemello
 * `causale-fattura-un-motore-solo.test.ts`.
 *
 * L'intestatario è l'altra metà dello stesso documento, e il danno è più grande:
 * una descrizione sbagliata è una frase, un intestatario sbagliato è una fattura
 * emessa a nome di un'altra persona, col suo codice fiscale, trasmessa
 * all'Agenzia delle Entrate — e si corregge solo con una nota di variazione.
 *
 * ─── COSA SORVEGLIA, E COSA NO ──────────────────────────────────────────────
 *  1. `determinaQuoteFatturazione` — la cascata che dice a chi va intestata una
 *     quota — si chiama da un elenco CHIUSO di moduli. In particolare NON dalla
 *     route di anteprima: quella passa da `componiIntestatarioPagamento`, che è
 *     il posto unico.
 *  2. `riconosciOrdinante` (il riconoscimento del genitore dal nome sul bonifico)
 *     ha UN solo chiamante di produzione. Due lo renderebbero due regole.
 *  3. `applicaIntestatarioScelto` — la regola dei genitori separati — si chiama
 *     solo dall'emissione. Se la chiamasse anche qualcun altro, il rifiuto a 409
 *     varrebbe su una strada e non sull'altra.
 *  4. L'anteprima e l'emissione convergono davvero: l'una su
 *     `componiIntestatarioPagamento`, l'altra su `determinaQuoteFatturazione`.
 *  5. Nessun componente client ricalcola nulla di tutto questo. Il browser può
 *     usare `validaCessionario` — è il punto, la stessa regola in tre posti — ma
 *     non può decidere CHI.
 *
 * NON verifica che l'intestatario sia GIUSTO: quello è
 * `__tests__/api/fattura-anteprima-intestatario.test.ts` e
 * `__tests__/lib/aruba/emissione-intestatario-scelto.test.ts`. E non verifica che
 * il cessionario dell'XML resti una persona fisica senza `Denominazione` né
 * `IdFiscaleIVA`: quello si MISURA sul documento generato, in
 * `__tests__/lib/aruba/emissione-intestatario-xsd.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.join(process.cwd(), 'src')

const INTESTATARI = path.join('src', 'lib', 'pagamenti', 'intestatari.ts')
const ORDINANTE = path.join('src', 'lib', 'pagamenti', 'ordinante-genitore.ts')
const MOTORE = path.join('src', 'lib', 'aruba', 'intestatario-pagamento.ts')
const EMISSIONE = path.join('src', 'lib', 'aruba', 'emissione.ts')
const RICEVUTE = path.join('src', 'lib', 'pagamenti', 'ricevute.ts')
const ANTEPRIMA = path.join('src', 'app', 'api', 'pagamenti', 'fattura', 'anteprima', 'route.ts')

/**
 * Chi può chiedere alla cascata a chi va intestata una quota. `ricevute.ts` c'è
 * perché la ricevuta cartacea deve nominare LA STESSA persona della fattura: è
 * l'opposto di una divergenza, ed è il motivo per cui riusa questa funzione
 * invece di rileggersi `intestatario_fatture` per conto suo.
 */
const AMMESSI_QUOTE = [INTESTATARI, EMISSIONE, RICEVUTE, MOTORE]

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

function chiamano(nome: string): string[] {
  const re = new RegExp(`\\b${nome}\\s*\\(`)
  return FILE.filter((f) => re.test(f.codice)).map((f) => f.relativo)
}

describe('LOCK · un solo motore per l’intestatario della fattura', () => {
  it('la misura vede davvero i sorgenti (controllo positivo)', () => {
    // Senza questo, un percorso sbagliato renderebbe VERDI tutte le regole qui
    // sotto: «zero file letti» e «zero violazioni» hanno lo stesso colore.
    expect(FILE.length).toBeGreaterThan(500)
    expect(FILE.map((f) => f.relativo)).toContain(EMISSIONE)
    expect(FILE.map((f) => f.relativo)).toContain(MOTORE)
  })

  it('`determinaQuoteFatturazione` si chiama solo dai moduli ammessi', () => {
    const colpevoli = chiamano('determinaQuoteFatturazione').filter((f) => !AMMESSI_QUOTE.includes(f))
    expect(
      colpevoli,
      'Chi vuole sapere a chi è intestata una quota passa da `determinaQuoteFatturazione`, ' +
        'non se la ricalcola: due cascate divergono, e la divergenza si vede solo su una fattura emessa.',
    ).toEqual([])
  })

  it('`riconosciOrdinante` ha UN solo chiamante di produzione', () => {
    const chiamanti = chiamano('riconosciOrdinante').filter((f) => f !== ORDINANTE)
    expect(chiamanti).toEqual([MOTORE])
  })

  it('`applicaIntestatarioScelto` si chiama solo dall’emissione', () => {
    const chiamanti = chiamano('applicaIntestatarioScelto').filter((f) => f !== INTESTATARI)
    expect(
      chiamanti,
      'La regola dei genitori separati (409, non si scavalca) vale solo se esiste in un posto solo.',
    ).toEqual([EMISSIONE])
  })

  it('«chi sono i genitori di questo bambino» ha UNA definizione sola', () => {
    // L'anteprima la usa per PROPORRE, l'emissione per RIFIUTARE (via
    // `adultoEGenitoreDi`). Se i due insiemi divergessero, l'anteprima
    // offrirebbe un adulto che l'emissione poi respinge: l'operatore leggerebbe
    // un rifiuto su una scelta che gli avevamo messo davanti noi.
    const chiamanti = chiamano('identitaGenitoriDiAlunno').filter((f) => f !== INTESTATARI)
    expect(chiamanti).toEqual([MOTORE])
    expect(chiamano('adultoEGenitoreDi').filter((f) => f !== INTESTATARI)).toEqual([EMISSIONE])
  })

  it('l’anteprima e l’emissione convergono davvero', () => {
    expect(chiamano('componiIntestatarioPagamento')).toContain(ANTEPRIMA)
    expect(chiamano('determinaQuoteFatturazione')).toContain(EMISSIONE)
    expect(chiamano('determinaQuoteFatturazione')).toContain(MOTORE)
  })

  it('nessun componente client decide CHI intesta la fattura', () => {
    const client = FILE.filter(
      (f) =>
        /^\s*['"]use client['"]/m.test(f.codice) &&
        /\b(riconosciOrdinante|determinaQuoteFatturazione|applicaIntestatarioScelto|componiIntestatarioPagamento)\s*\(/.test(
          f.codice,
        ),
    ).map((f) => f.relativo)
    expect(client).toEqual([])
  })

  it('la forma dell’intestatario scelto non porta né `Denominazione` né `IdFiscaleIVA`', () => {
    // Fuori scope per decisione del titolare: qui si intesta a una persona
    // fisica. Il divieto vive nello schema (unione discriminata + oggetti
    // stretti); questa riga impedisce che rientri da una scorciatoia nel modulo.
    const forma = FILE.find((f) => f.relativo === path.join('src', 'lib', 'fatturazione', 'intestatario-scelto.ts'))!
    expect(forma.codice).not.toMatch(/denominazione/i)
    expect(forma.codice).not.toMatch(/id_?fiscale_?iva/i)
  })
})
