import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK — l'asserzione che prova l'ARRIVO a un passo non può essere soddisfatta
 * da un testo che il passo PRECEDENTE mostra già.
 *
 * ─── IL DIFETTO CHE QUESTO LOCK RENDE IMPOSSIBILE ──────────────────────────
 * `e2e/public-iscrizione.spec.ts` provava di essere arrivato al riepilogo così:
 *
 *     await expect(page.getByText('Riepilogo')).toBeVisible();
 *
 * `getByText(stringa)` senza `{ exact: true }` cerca per **sottostringa e senza
 * distinzione di maiuscole** (identica semantica di `getByPlaceholder`, e per lo
 * stesso motivo esiste il lock gemello `e2e-selettori-placeholder.test.ts`). Il
 * passo prima — i consensi — porta come sottotitolo
 * `wizardConsensiSottotitolo` = «Un passaggio, poi il riepilogo»: quella riga
 * era quindi VERDE anche quando il wizard non era avanzato di un passo.
 *
 * Il conto lo ha pagato la diagnosi, non il collaudo: il test falliva una riga
 * più in basso, su «Stai iscrivendo 1 bambino», e accusava la stringa
 * sbagliata. Per due settimane (dal 24/08/2026) ha nascosto un difetto di
 * PRODOTTO, specifico di WebKit, che colpiva i genitori veri sul modulo che
 * riceve circa sei domande al giorno.
 *
 * ─── LA REGOLA ─────────────────────────────────────────────────────────────
 * Un'asserzione di avanzamento si ancora a un elemento che esiste SOLO nel
 * passo d'arrivo. Qui è il pulsante d'invio: lo stesso locatore che due righe
 * più su, con `toHaveCount(0)`, prova che senza la spunta obbligatoria non si
 * avanza. Se il locatore è buono per dire «non ci siamo», è buono per dire «ci
 * siamo».
 */

const RADICE = process.cwd()
const SPEC = join(RADICE, 'e2e', 'public-iscrizione.spec.ts')

const spec = () => readFileSync(SPEC, 'utf8')

/** I valori del catalogo pubblico italiano che fanno da TITOLO o SOTTOTITOLO di un passo. */
function intestazioniDeiPassi(): { chiave: string; testo: string }[] {
  const catalogo = JSON.parse(
    readFileSync(join(RADICE, 'messages', 'it', 'public.json'), 'utf8'),
  ) as Record<string, unknown>
  return Object.entries(catalogo)
    .filter(([k, v]) => typeof v === 'string' && /(Titolo|Sottotitolo|Sub)$/.test(k))
    .map(([chiave, testo]) => ({ chiave, testo: testo as string }))
}

/** Le stringhe letterali passate a `getByText('…')` nello spec. */
function testiCercatiDalloSpec(): { riga: number; testo: string }[] {
  const LETTERALE = /getByText\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g
  const out: { riga: number; testo: string }[] = []
  spec()
    .split('\n')
    .forEach((linea, i) => {
      for (const m of linea.matchAll(LETTERALE)) {
        out.push({ riga: i + 1, testo: (m[1] ?? m[2] ?? '').replace(/\\(['"\\])/g, '$1') })
      }
    })
  return out
}

describe('lock: l’àncora del riepilogo dello spec pubblico è esclusiva del riepilogo', () => {
  it('CONTROLLO POSITIVO: «Riepilogo» NON è esclusivo — il passo prima lo dice già', () => {
    // È la misura che motiva il lock, rieseguita invece che raccontata: se un
    // giorno il sottotitolo dei consensi non nominasse più il riepilogo, questo
    // test diventerebbe rosso e chi lo legge scoprirebbe che il divieto qui
    // sotto ha perso la sua ragione (e non che il prodotto si è rotto).
    const sosia = intestazioniDeiPassi().filter(({ testo }) =>
      testo.toLowerCase().includes('riepilogo'),
    )
    expect(
      sosia.map((s) => s.chiave),
      'nessuna intestazione di passo nomina più il riepilogo: rileggere il lock qui sotto',
    ).toContain('wizardConsensiSottotitolo')
    // Cinque, alla misura del 2026-09-01: i tre «Un passaggio, poi il
    // riepilogo» dei tre wizard pubblici e i due «Manca un dato prima del
    // riepilogo».
    expect(sosia.length).toBeGreaterThanOrEqual(2)
  })

  /*
   * ⚠️ Il divieto è sulla PAROLA, non su «i testi che qualche intestazione
   * contiene»: la prima stesura di questo lock vietava la seconda cosa e
   * pescava anche la riga 59, `getByText('Iscrizione Nuovo Alunno')` — che è il
   * titolo della PAGINA, cercato per verificare di essere sulla pagina giusta,
   * cioè un uso legittimo. Distinguere «sono arrivato al passo» da «sono sulla
   * pagina» leggendo il sorgente non si può; vietare la parola che ha un sosia
   * misurato, sì.
   */
  it('lo spec non prova l’avanzamento con la parola che ha il sosia', () => {
    const ambigui = testiCercatiDalloSpec()
      .filter(({ testo }) => testo.toLowerCase().includes('riepilogo'))
      .map(({ riga, testo }) => `e2e/public-iscrizione.spec.ts:${riga} → «${testo}»`)

    expect(
      ambigui,
      'Un `getByText()` sulla parola «riepilogo»: il sottotitolo del passo dei consensi ' +
        '(«Un passaggio, poi il riepilogo») lo soddisfa già, quindi l’asserzione sarà verde ' +
        'anche se il wizard non è avanzato — e il test fallirà più in basso accusando la ' +
        'stringa sbagliata. Àncorati a un elemento che esiste SOLO nel riepilogo: il ' +
        'pulsante d’invio.',
    ).toEqual([])
  })

  it('…e l’asserzione positiva c’è davvero (il lock non è verde perché la riga è sparita)', () => {
    // Senza questo, cancellare la riga renderebbe verde il test qui sopra: lo
    // spec avanzerebbe al riepilogo senza verificare di esserci arrivato.
    expect(
      /expect\(\s*page\.getByRole\('button', \{ name: 'Invia richiesta' \}\)\s*\)\.toBeVisible\(\)/.test(
        spec(),
      ),
      'manca l’asserzione che prova l’arrivo al riepilogo col pulsante d’invio',
    ).toBe(true)
  })

  it('il nome del pulsante d’invio non compare in nessuna intestazione di passo', () => {
    // La proprietà che rende esclusiva l'àncora NUOVA, misurata sulla stessa
    // regola che quella vecchia violava. «Invia richiesta» vive in tre stringhe
    // del catalogo — il pulsante, la nota del riepilogo e il messaggio di invio
    // fallito — e nessuna delle tre è un'intestazione di passo: tutte e tre si
    // leggono dal riepilogo in poi.
    const dentro = intestazioniDeiPassi().filter(({ testo }) =>
      testo.toLowerCase().includes('invia richiesta'),
    )
    expect(dentro.map((d) => d.chiave)).toEqual([])
  })
})
