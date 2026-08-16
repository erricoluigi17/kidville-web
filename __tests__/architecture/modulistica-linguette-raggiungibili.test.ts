import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · ogni linguetta di «Modulistica» si apre anche da un COLLEGAMENTO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────
 *
 * Il nome di una linguetta viveva in QUATTRO punti dello stesso file: il tipo
 * `ModulisticaTab`, la barra `Tabs`, la catena che sceglie il pannello e — l'ultima, quella
 * che si dimentica — il calcolo di `initialTab`, cioè l'elenco dei valori di `?tab=` che la
 * pagina riconosce. Le prime tre senza la quarta danno una linguetta che funziona benissimo
 * col mouse e un collegamento profondo che atterra sulla linguetta SBAGLIATA, in silenzio:
 * niente errore, niente log, solo il pannello di un'altra cosa.
 *
 * È successo tre volte, e il file lo raccontava nei suoi commenti: `candidature` (notifica di
 * una nuova candidatura), `personale` (notifica di anagrafica del personale, più i
 * collegamenti `?tab=personale&pratica=<uuid>` del cockpit) e `prestampati`, aggiunta il
 * 2026-08-14 con tipo, barra e catena e senza la quarta riga.
 *
 * ─── COSA È CAMBIATO IL 2026-08-16, E PERCHÉ QUESTO LOCK ORA GUARDA ALTROVE ─────
 *
 * Le quattro copie sono diventate DUE. `TAB_ORDINE`, in cima alla pagina, è ora l'unico
 * elenco: il tipo si deriva da lì (`typeof TAB_ORDINE[number]`), la barra si disegna
 * mappandolo, e `?tab=` si confronta con lo stesso array (`eTabDiQuestaPagina`). Le tre
 * copie che questo lock sorvegliava non possono più divergere perché non sono più tre.
 *
 * Quando la forma di un difetto sparisce, un lock ha due strade oneste: morire, o spostarsi
 * su ciò che resta davvero duplicato. Qui resta una cosa sola, ed è vera: la catena dei
 * PANNELLI nomina ancora ogni linguetta a mano. Una parola aggiunta a `TAB_ORDINE` senza il
 * suo pannello dà una pillola che si accende su un vuoto — lo stesso guasto di prima, un
 * gradino più in là.
 *
 * E la vecchia forma non deve tornare: un `tabParam === '…'` scritto a mano rimetterebbe in
 * piedi la quarta copia, cioè il difetto originale. Il terzo test qui sotto lo vieta.
 *
 * ⚠️ NON verifica che una notifica QUEL collegamento lo mandi davvero: verifica che se
 * qualcuno lo manda, la pagina lo capisca. Le due cose si aggiungono in momenti diversi, ed è
 * proprio lo scarto fra i due momenti che ha prodotto il difetto.
 *
 * ⚠️ E questo resta un lock di FORMA: legge il testo del file. Che la barra a schermo abbia
 * davvero sei pillole, che `?tab=<parola>` accenda la sua e che un `?tab=` sconosciuto lo
 * DICA invece di tacerlo, lo misura `__tests__/pages/admin-modulistica-linguette.test.tsx`,
 * che la pagina la monta. Due prove diverse per due domande diverse: qui «il file non può
 * divergere da sé», là «la schermata fa quello che dice».
 */

const PAGINA = join(process.cwd(), 'src/app/(dashboard)/admin/modulistica/page.tsx')
const SORGENTE = readFileSync(PAGINA, 'utf8')

/** L'UNICO elenco: `const TAB_ORDINE = [...] as const`. */
function elencoUnico(): string[] {
  const blocco = /const TAB_ORDINE = \[([\s\S]*?)\] as const/.exec(SORGENTE)?.[1]
  if (!blocco) return []
  return [...blocco.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Le linguette che la catena dei pannelli nomina: `activeTab === '…'`. */
function linguetteDeiPannelli(): Set<string> {
  return new Set([...SORGENTE.matchAll(/activeTab === '([^']+)'/g)].map((m) => m[1]))
}

describe('lock architettura · le linguette di Modulistica si aprono da un collegamento', () => {
  const elenco = elencoUnico()
  const pannelli = linguetteDeiPannelli()

  it('il lock sta guardando qualcosa: l’elenco unico e la catena dei pannelli esistono', () => {
    // Senza queste misure le prove qui sotto sarebbero verdi su un file vuoto — che è il
    // modo in cui un lock smette di proteggere senza diventare rosso.
    expect(
      elenco.length,
      '`TAB_ORDINE` non è stato riconosciuto in page.tsx: se l’elenco unico è stato ' +
        'rinominato o spezzato, questo lock va riscritto — non cancellato.',
    ).toBeGreaterThanOrEqual(6)
    expect(pannelli.size, 'la catena `activeTab === …` non è stata riconosciuta').toBeGreaterThanOrEqual(5)
  })

  it('ogni linguetta dell’elenco ha un pannello che la disegna', () => {
    // Il ramo finale della catena (`) : ( <ultimo /> )`) è l'`else`: può non avere un
    // `activeTab === '…'` suo, ed è corretto così. Quindi l'ULTIMA dell'elenco è l'unica che
    // si ammette non nominata — oggi lo è comunque, perché la stessa parola compare nel
    // pulsante d'intestazione, ma quel dettaglio non deve diventare il criterio. Se ne
    // mancassero due, una delle due accenderebbe il pannello dell'altra.
    const ultima = elenco[elenco.length - 1]
    const senzaPannello = elenco.filter((id) => id !== ultima && !pannelli.has(id))
    expect(
      senzaPannello,
      'Queste linguette stanno in `TAB_ORDINE` ma nessun ramo della catena le disegna:\n  ' +
        senzaPannello.join('\n  ') +
        '\nLa pillola si accende su un vuoto. Aggiungi il ramo in ' +
        'src/app/(dashboard)/admin/modulistica/page.tsx.',
    ).toEqual([])
  })

  it('la catena non nomina linguette che nell’elenco non esistono più', () => {
    // L'altra metà: una linguetta cancellata lascia dietro di sé un `activeTab === '…'` che
    // nessuno può più raggiungere — codice morto che sembra vivo.
    const orfane = [...pannelli].filter((id) => !elenco.includes(id))
    expect(
      orfane,
      'Questi rami rispondono a linguette che in `TAB_ORDINE` non ci sono più: ' +
        orfane.join(', ') +
        '. Nessuno può accenderli: vanno tolti insieme alla linguetta.',
    ).toEqual([])
  })

  it('la quarta copia non torna: `?tab=` non si confronta a mano', () => {
    // LA REGRESSIONE VERA. Il difetto originale era un elenco di `tabParam === 'x' || …`
    // scritto a mano accanto alla barra: tre volte su tre è stata quella riga a restare
    // indietro. Oggi il confronto passa da `eTabDiQuestaPagina`, che interroga l'elenco
    // unico. Chi lo riscrive a mano rimette in piedi esattamente il guasto che questo file
    // esiste per impedire, e lo fa senza rompere niente — quindi lo si vieta qui.
    const aMano = [...SORGENTE.matchAll(/tabParam === '([^']+)'/g)].map((m) => m[1])
    expect(
      aMano,
      'Il valore di `?tab=` viene confrontato a mano con ' +
        aMano.map((v) => `«${v}»`).join(', ') +
        '. È la quarta copia che ha già prodotto tre volte lo stesso difetto: usa ' +
        '`eTabDiQuestaPagina(tabParam)`, che chiede a `TAB_ORDINE`.',
    ).toEqual([])

    // E la barra si disegna DALL'elenco, non da un array di `id` ricopiati accanto.
    expect(
      /options=\{TAB_ORDINE\.map\(/.test(SORGENTE),
      'La barra `Tabs` non è più derivata da `TAB_ORDINE`: se torna un elenco di `id` ' +
        'scritto a mano, torna anche la possibilità che diverga dall’elenco unico.',
    ).toBe(true)
  })
})
