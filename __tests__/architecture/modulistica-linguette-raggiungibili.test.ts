import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · ogni linguetta di «Modulistica» si apre anche da un COLLEGAMENTO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────
 *
 * Il nome di una linguetta vive in QUATTRO punti dello stesso file: il tipo
 * `ModulisticaTab`, la barra `Tabs`, lo `switch` che sceglie il pannello e — l'ultima, quella
 * che si dimentica — il calcolo di `initialTab`, cioè l'elenco dei valori di `?tab=` che la
 * pagina riconosce. Le prime tre senza la quarta danno una linguetta che funziona benissimo
 * col mouse e un collegamento profondo che atterra sulla linguetta SBAGLIATA, in silenzio:
 * niente errore, niente log, solo il pannello di un'altra cosa.
 *
 * È già successo due volte, e il file lo racconta nei suoi commenti: `candidature`
 * (notifica di una nuova candidatura) e `personale` (notifica di anagrafica del personale,
 * più i collegamenti `?tab=personale&pratica=<uuid>` del cockpit). La terza volta è stata
 * `prestampati`, aggiunta il 2026-08-14 con tipo, barra e switch e senza questa riga.
 *
 * Una convenzione scritta in un commento non è un meccanismo: qui la quarta riga diventa
 * obbligatoria per costruzione. Chi aggiunge una linguetta e dimentica il collegamento trova
 * un rosso che gli dice quale parola scrivere e dove.
 *
 * ⚠️ NON verifica che una notifica QUEL collegamento lo mandi davvero: verifica che se
 * qualcuno lo manda, la pagina lo capisca. Le due cose si aggiungono in momenti diversi, ed è
 * proprio lo scarto fra i due momenti che ha prodotto il difetto.
 */

const PAGINA = join(process.cwd(), 'src/app/(dashboard)/admin/modulistica/page.tsx')
const SORGENTE = readFileSync(PAGINA, 'utf8')

/** Gli `id` delle linguette come li dichiara la barra `Tabs`: è ciò che l'utente vede. */
function linguetteDellaBarra(): string[] {
  const barra = /options=\{\[([\s\S]*?)\]\}/.exec(SORGENTE)?.[1]
  if (!barra) return []
  return [...barra.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1])
}

/** Il blocco che traduce `?tab=` in linguetta di partenza. */
function calcoloIniziale(): string {
  return /const initialTab: ModulisticaTab =([\s\S]*?);\n/.exec(SORGENTE)?.[1] ?? ''
}

describe('lock architettura · le linguette di Modulistica si aprono da un collegamento', () => {
  const barra = linguetteDellaBarra()
  const blocco = calcoloIniziale()
  const riconosciute = new Set([...blocco.matchAll(/tabParam === '([^']+)'/g)].map((m) => m[1]))
  const ripiego = /\?\s*tabParam\s*:\s*'([^']+)'/.exec(blocco)?.[1]

  it('il lock sta guardando qualcosa: la barra, il calcolo e il ripiego esistono', () => {
    // Senza queste tre misure la prova qui sotto sarebbe verde su un file vuoto — che è il
    // modo in cui un lock smette di proteggere senza diventare rosso.
    expect(barra.length, 'la barra `Tabs` non è stata riconosciuta in page.tsx').toBeGreaterThanOrEqual(6)
    expect(riconosciute.size, 'il calcolo di `initialTab` non è stato riconosciuto').toBeGreaterThanOrEqual(3)
    expect(ripiego, 'la linguetta di ripiego non è stata riconosciuta').toBeTruthy()
  })

  it('ogni linguetta della barra è raggiungibile con `?tab=<id>`', () => {
    const mute = barra.filter((id) => id !== ripiego && !riconosciute.has(id))
    expect(
      mute,
      'Queste linguette esistono nella barra ma `?tab=<id>` non le apre:\n  ' +
        mute.map((id) => `?tab=${id}`).join('\n  ') +
        `\nUn collegamento del genere cade su «${ripiego}» senza nessun errore da nessuna parte. ` +
        'Aggiungi la parola al calcolo di `initialTab` in ' +
        'src/app/(dashboard)/admin/modulistica/page.tsx.',
    ).toEqual([])
  })

  it('il calcolo non riconosce parole che nella barra non esistono più', () => {
    // L'altra metà: una linguetta cancellata lascia dietro di sé un `tabParam === '…'` che
    // porta a uno stato che nessun pannello disegna — cioè una pagina bianca.
    const orfane = [...riconosciute].filter((id) => !barra.includes(id))
    expect(
      orfane,
      'Queste parole sono riconosciute da «?tab=» ma nella barra non ci sono più: ' +
        orfane.join(', ') +
        '. Portano a uno stato che nessun pannello disegna, cioè a una pagina bianca.',
    ).toEqual([])
  })
})
