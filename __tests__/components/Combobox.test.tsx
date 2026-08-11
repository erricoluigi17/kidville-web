import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import {
  Combobox,
  normalizzaTesto,
  rangoDiMatch,
  type OpzioneCombobox,
  type TestiCombobox,
} from '@/components/ui/Combobox'

expect.extend(toHaveNoViolations)

// =============================================================================
// `Combobox` — la scelta con filtro che questo repo non aveva.
//
// PERCHÉ ESISTE, e perché il collaudo è metà del lavoro. Il caso d'uso vero è
// l'elenco dei comuni della provincia di Torino: **484 voci** in un pannello
// scorribile. Un `<select>` nativo con 484 `<option>` si naviga solo a colpi di
// iniziale, e il campo che oggi lo sostituisce quasi ovunque — un `<input>` di
// testo libero — lascia entrare qualunque stringa.
//
// Le tre cose che un componente così sbaglia sempre, e che qui si MISURANO:
//
//  1. IL FILTRO CANCELLA LA SCELTA. Si digita per cercare, la ricerca non trova
//     niente, e il valore che era stato scelto sparisce senza che nessuno lo
//     abbia chiesto. Qui `onChange` non viene MAI chiamato mentre si filtra
//     (§5): la scelta cambia solo con Invio, con Tab o con un clic.
//
//  2. LA TASTIERA È UN RIPENSAMENTO. `↑ ↓ Home End Invio Esc Tab` non sono
//     scorciatoie per esperti: senza di loro il componente semplicemente non si
//     usa senza mouse. §4 le percorre tutte, `aria-activedescendant` compreso —
//     che è l'UNICO modo in cui uno screen reader sa quale voce è evidenziata,
//     visto che il fuoco del browser resta sull'input.
//
//  3. IL CONTEGGIO NON SI ANNUNCIA. Chi vede, vede il pannello accorciarsi da
//     312 voci a 4. Chi non vede, senza una regione live non riceve NIENTE: il
//     campo tace mentre il contenuto cambia sotto. §6 misura che il numero
//     finisca in `aria-live="polite"`.
//
// La normalizzazione (§2) non è un vezzo: «Forlì» si digita «forli», e
// «Sant'Agnello» si digita con l'apostrofo dritto, con quello tipografico o con
// uno spazio, a seconda della tastiera del telefono. Tre modi di scrivere la
// stessa cosa che devono trovare la stessa voce.
//
// ⚠️ Nessun nome di persona nei dati di prova (repository PUBBLICO): sono nomi
// di comuni, cioè toponimi, e la sede fittizia di collaudo è marcata come tale.
//
// ─── COSA QUESTO BANCO NON PUÒ VEDERE, detto prima di leggere i verdetti ─────
// jsdom non sposta il fuoco quando si clicca, non impagina e non scorre. Le due
// cose che ne dipendevano sono state riportate DENTRO il banco invece che date
// per buone: il clic su una voce si fa con la sequenza vera del browser (§4,
// `clicVero`) e lo scorrimento si misura con una sonda su `scrollIntoView`
// (§11). Resta fuori il resto: contrasto reale, impaginazione, gesti touch.
// Finché il componente non è montato in una schermata, «verde» qui significa
// «verde in jsdom», e va detto così.
//
// E va detto anche questo, perché è la differenza fra una prova e un verde
// preso in prestito: NESSUN modulo importa ancora `Combobox` (`grep -rn
// "components/ui/Combobox" src __tests__ e2e` trova solo questo file), quindi il
// componente non entra nel grafo di build di Next e `npm run build` non dice
// NIENTE su di lui. Le prove di questa corsia sono tre e sono solo queste:
// `npx tsc --noEmit`, `npx eslint` sui due file, e questa suite.
// =============================================================================

/**
 * I testi di servizio sono PROPS: il componente non contiene testo (vedi
 * `TestiCombobox`). Qui è il banco a fare la parte della pagina che lo monta —
 * in italiano per la maggior parte delle prove, in inglese in §12, che è il modo
 * in cui si misura che di italiano cablato dentro non ne sia rimasto.
 */
const TESTI_IT: TestiCombobox = {
  vuoto: 'Nessun risultato',
  // Identico byte per byte a `shared.caricamentoInCorso` di `messages/it`.
  caricamento: 'Caricamento in corso…',
  // Il plurale lo fa il catalogo ICU nella pagina vera; qui il banco lo imita.
  conteggio: (n) => (n === 1 ? '1 risultato disponibile' : `${n} risultati disponibili`),
  commutaElenco: 'Mostra o nascondi l’elenco',
}

const TESTI_EN: TestiCombobox = {
  vuoto: 'No results',
  caricamento: 'Loading…',
  conteggio: (n) => (n === 1 ? '1 result available' : `${n} results available`),
  commutaElenco: 'Show or hide the list',
}

const COMUNI: readonly OpzioneCombobox[] = [
  { valore: 'moncalieri', etichetta: 'Moncalieri', gruppo: 'Area metropolitana' },
  { valore: 'nichelino', etichetta: 'Nichelino', gruppo: 'Area metropolitana', nota: 'Sede convenzionata' },
  { valore: 'rivoli', etichetta: 'Rivoli', gruppo: 'Area metropolitana' },
  { valore: 'bardonecchia', etichetta: 'Bardonecchia', gruppo: 'Valli' },
  { valore: 'santambrogio', etichetta: "Sant'Ambrogio di Torino", gruppo: 'Valli' },
  { valore: 'usseglio', etichetta: 'Usseglio', gruppo: 'Valli', disabilitata: true },
]

/** L'ordine PIATTO in cui le voci vengono rese senza filtro (gruppi in ordine). */
const ORDINE_PIENO = [
  'moncalieri',
  'nichelino',
  'rivoli',
  'bardonecchia',
  'santambrogio',
  'usseglio',
]

const CON_ACCENTI: readonly OpzioneCombobox[] = [
  { valore: 'citta-di-castello', etichetta: 'Città di Castello' },
  { valore: 'forli', etichetta: 'Forlì' },
  { valore: 'santagnello', etichetta: "Sant'Agnello" },
  { valore: 'cefalu', etichetta: 'Cefalù' },
]

/**
 * Il banco di prova: `Combobox` è CONTROLLATO, quindi senza qualcuno che tenga
 * il valore non si può misurare né che la scelta arrivi né che il filtro la
 * lasci in pace. La spia registra ogni chiamata a `onChange`.
 */
function Banco({
  opzioni = COMUNI,
  iniziale = '',
  testi = TESTI_IT,
  spia,
  ...resto
}: {
  opzioni?: readonly OpzioneCombobox[]
  iniziale?: string
  testi?: TestiCombobox
  spia?: (valore: string, opzione: OpzioneCombobox | null) => void
  placeholder?: string
  disabled?: boolean
  caricamento?: boolean
  invalido?: boolean
  describedById?: string
  className?: string
}) {
  const [valore, setValore] = useState(iniziale)
  return (
    <Combobox
      id="comune"
      label="Comune di nascita"
      testi={testi}
      value={valore}
      options={opzioni}
      onChange={(v, o) => {
        setValore(v)
        spia?.(v, o)
      }}
      {...resto}
    />
  )
}

/**
 * L'ALTRO banco, e serve proprio perché il primo non basta: `Banco` tiene il
 * valore in `useState` e lo cambia solo da `onChange`, quindi non rirende MAI né
 * con altre `options` né con un `value` deciso da fuori. Qui il valore lo tiene
 * il test, e si cambia con `rerender` — è l'unico modo di guardare il caso d'uso
 * dichiarato in cima (le opzioni che arrivano in fondo a una fetch).
 */
function daFuori(p: {
  value: string
  opzioni?: readonly OpzioneCombobox[]
  spia?: (valore: string, opzione: OpzioneCombobox | null) => void
}) {
  return (
    <Combobox
      id="comune"
      label="Comune di nascita"
      testi={TESTI_IT}
      value={p.value}
      options={p.opzioni ?? COMUNI}
      onChange={p.spia ?? (() => {})}
    />
  )
}

const campo = () => screen.getByRole('combobox')
const valoriResi = () =>
  screen.getAllByRole('option').map((o) => o.getAttribute('data-valore'))
const digita = (testo: string) => fireEvent.change(campo(), { target: { value: testo } })
const tasto = (key: string) => fireEvent.keyDown(campo(), { key })
const classi = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

// =============================================================================
describe('§1 · apertura e chiusura', () => {
  it('nasce chiuso: nessun elenco nell\'albero di accessibilità', () => {
    render(<Banco />)
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('un clic apre il pannello con TUTTE le voci, nell\'ordine dei gruppi', () => {
    render(<Banco />)
    fireEvent.click(campo())
    expect(campo()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(valoriResi()).toEqual(ORDINE_PIENO)
  })

  it('l\'input dichiara il pannello che controlla e il tipo di completamento', () => {
    render(<Banco />)
    fireEvent.click(campo())
    const elenco = screen.getByRole('listbox')
    expect(campo()).toHaveAttribute('aria-controls', elenco.id)
    expect(campo()).toHaveAttribute('aria-autocomplete', 'list')
  })

  it('i gruppi sono `role="group"` con il proprio nome, non solo un\'intestazione dipinta', () => {
    render(<Banco />)
    fireEvent.click(campo())
    const gruppi = screen.getAllByRole('group')
    expect(gruppi.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Area metropolitana',
      'Valli',
    ])
  })

  it('la voce scelta è l\'unica con `aria-selected="true"`', () => {
    render(<Banco iniziale="rivoli" />)
    expect(campo()).toHaveValue('Rivoli')
    fireEvent.click(campo())
    const scelte = screen
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(scelte).toHaveLength(1)
    expect(scelte[0]).toHaveAttribute('data-valore', 'rivoli')
  })

  it('riaprendo dopo una scelta si rivedono TUTTE le voci, non solo quella scelta', () => {
    // Il difetto classico: il testo dell'input è l'etichetta scelta, il filtro la
    // usa come query, e il pannello mostra una voce sola. Il filtro riparte solo
    // quando l'utente DIGITA.
    render(<Banco iniziale="rivoli" />)
    fireEvent.click(campo())
    expect(valoriResi()).toEqual(ORDINE_PIENO)
  })
})

// =============================================================================
describe('§2 · il filtro — accenti, apostrofi, maiuscole', () => {
  it('la normalizzazione è quella dichiarata (accenti via NFD, apostrofi, minuscole)', () => {
    expect(normalizzaTesto('Città di Castello')).toBe('citta di castello')
    expect(normalizzaTesto('FORLÌ')).toBe('forli')
    expect(normalizzaTesto("Sant'Agnello")).toBe('sant agnello')
    expect(normalizzaTesto('Sant’Agnello')).toBe('sant agnello')
    expect(normalizzaTesto('  Rivoli   Alta ')).toBe('rivoli alta')
  })

  it.each([
    ['citta', 'citta-di-castello'],
    ['CITTÀ', 'citta-di-castello'],
    ['forli', 'forli'],
    ['FORLÌ', 'forli'],
    ['cefalu', 'cefalu'],
  ])('digitando «%s» resta «%s»', (query, atteso) => {
    render(<Banco opzioni={CON_ACCENTI} />)
    fireEvent.click(campo())
    digita(query)
    expect(valoriResi()).toEqual([atteso])
  })

  it.each([
    ["sant'agnello"], // apostrofo dritto (tastiera fisica)
    ['sant’agnello'], // apostrofo tipografico (correzione automatica iOS)
    ['sant agnello'], // spazio (chi non lo digita affatto)
    ["SANT'AGNELLO"], // e tutto maiuscolo
  ])('l\'apostrofo si scrive in quattro modi e trova sempre la stessa voce («%s»)', (query) => {
    render(<Banco opzioni={CON_ACCENTI} />)
    fireEvent.click(campo())
    digita(query)
    expect(valoriResi()).toEqual(['santagnello'])
  })

  it('il testo digitato resta quello digitato (nessun completamento a sorpresa)', () => {
    render(<Banco />)
    fireEvent.click(campo())
    digita('riv')
    expect(campo()).toHaveValue('riv')
  })
})

// =============================================================================
describe('§3 · l\'ordine — inizio parola prima, sottostringa poi', () => {
  // «Cantoira» contiene «to» in mezzo a una parola; «Settimo Torinese» ce l'ha a
  // inizio della SECONDA parola; «Torino» comincia con «to». Nell'elenco di
  // partenza stanno nell'ordine peggiore possibile: il primo è il meno pertinente.
  const TRE: readonly OpzioneCombobox[] = [
    { valore: 'cantoira', etichetta: 'Cantoira' },
    { valore: 'settimo', etichetta: 'Settimo Torinese' },
    { valore: 'torino', etichetta: 'Torino' },
  ]

  it('il rango è 0 a inizio stringa, 1 a inizio parola, 2 dentro una parola', () => {
    expect(rangoDiMatch('torino', 'to')).toBe(0)
    expect(rangoDiMatch('settimo torinese', 'to')).toBe(1)
    expect(rangoDiMatch('cantoira', 'to')).toBe(2)
    expect(rangoDiMatch('cantoira', 'zz')).toBeNull()
    expect(rangoDiMatch('sant ambrogio di torino', 'ambr')).toBe(1)
  })

  it('l\'elenco filtrato riordina: prefisso, poi inizio parola, poi sottostringa', () => {
    render(<Banco opzioni={TRE} />)
    fireEvent.click(campo())
    digita('to')
    expect(valoriResi()).toEqual(['torino', 'settimo', 'cantoira'])
  })

  it('a parità di rango l\'ordine di partenza è rispettato', () => {
    render(<Banco opzioni={TRE} />)
    fireEvent.click(campo())
    digita('i')
    // «Cantoira», «Settimo Torinese» e «Torino» hanno tutte una «i» dentro una
    // parola: nessuna vince sulle altre, quindi resta l'ordine dell'elenco.
    expect(valoriResi()).toEqual(['cantoira', 'settimo', 'torino'])
  })

  it('senza query l\'ordine non viene toccato', () => {
    render(<Banco opzioni={TRE} />)
    fireEvent.click(campo())
    expect(valoriResi()).toEqual(['cantoira', 'settimo', 'torino'])
  })
})

// =============================================================================
describe('§4 · la tastiera — ↑ ↓ Home End Invio Esc Tab', () => {
  const evidenziata = () =>
    screen.getAllByRole('option').find((o) => o.hasAttribute('data-evidenziata')) ?? null

  it('↓ da chiuso apre e porta sulla PRIMA voce', () => {
    render(<Banco />)
    tasto('ArrowDown')
    expect(campo()).toHaveAttribute('aria-expanded', 'true')
    expect(evidenziata()).toHaveAttribute('data-valore', 'moncalieri')
  })

  it('↑ da chiuso apre e porta sull\'ULTIMA voce ABILITATA', () => {
    render(<Banco />)
    tasto('ArrowUp')
    // «Usseglio» è l'ultima dell'elenco ma è disabilitata: si salta.
    expect(evidenziata()).toHaveAttribute('data-valore', 'santambrogio')
  })

  it('↓ e ↑ scorrono le voci e SALTANO quelle disabilitate', () => {
    render(<Banco />)
    tasto('ArrowDown')
    tasto('ArrowDown')
    expect(evidenziata()).toHaveAttribute('data-valore', 'nichelino')
    tasto('ArrowUp')
    expect(evidenziata()).toHaveAttribute('data-valore', 'moncalieri')
    for (let i = 0; i < 10; i++) tasto('ArrowDown')
    // In fondo si ferma sull'ultima ABILITATA e non gira in tondo.
    expect(evidenziata()).toHaveAttribute('data-valore', 'santambrogio')
  })

  it('Home ed End vanno alla prima e all\'ultima voce abilitata', () => {
    render(<Banco />)
    tasto('ArrowDown')
    tasto('End')
    expect(evidenziata()).toHaveAttribute('data-valore', 'santambrogio')
    tasto('Home')
    expect(evidenziata()).toHaveAttribute('data-valore', 'moncalieri')
  })

  it('`aria-activedescendant` segue l\'evidenziato, e sparisce quando non c\'è', () => {
    render(<Banco />)
    expect(campo()).not.toHaveAttribute('aria-activedescendant')
    tasto('ArrowDown')
    expect(campo()).toHaveAttribute('aria-activedescendant', evidenziata()!.id)
    tasto('ArrowDown')
    expect(campo()).toHaveAttribute('aria-activedescendant', evidenziata()!.id)
    // Digitando si riparte da zero: nessuna voce è evidenziata finché non si
    // preme una freccia (Invio non deve scegliere una voce «a caso»).
    digita('bar')
    expect(campo()).not.toHaveAttribute('aria-activedescendant')
  })

  it('Invio sceglie l\'evidenziato, chiude e riporta l\'etichetta nel campo', () => {
    const spia = vi.fn()
    render(<Banco spia={spia} />)
    tasto('ArrowDown')
    tasto('ArrowDown')
    tasto('Enter')
    expect(spia).toHaveBeenCalledTimes(1)
    expect(spia).toHaveBeenCalledWith('nichelino', expect.objectContaining({ valore: 'nichelino' }))
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(campo()).toHaveValue('Nichelino')
  })

  /**
   * IL CLIC VERO, in tre eventi e nell'ordine in cui il browser li manda:
   * `mousedown` → il fuoco si sposta (ma SOLO se il mousedown non è stato
   * annullato) → `click`.
   *
   * `fireEvent.click` da solo non sposta mai il fuoco: con quello, togliere il
   * `preventDefault` dal mousedown di una voce lascia la suite verde mentre in
   * un browser la selezione col mouse smette di funzionare del tutto (il blur
   * chiude il pannello e la voce si smonta prima che il click arrivi). Qui la
   * riga «il fuoco se ne va» è resa esplicita, e la difesa diventa misurabile.
   *
   * `fireEvent` ritorna il valore di `dispatchEvent`: `false` quando il gestore
   * ha chiamato `preventDefault`. È esattamente il segnale che serve.
   */
  const clicVero = (voce: HTMLElement) => {
    const nonAnnullato = fireEvent.mouseDown(voce)
    if (nonAnnullato) fireEvent.blur(campo())
    fireEvent.click(voce)
  }

  it('il mousedown su una voce è ANNULLATO: il fuoco non lascia mai l\'input', () => {
    render(<Banco />)
    fireEvent.click(campo())
    expect(fireEvent.mouseDown(screen.getAllByRole('option')[2])).toBe(false)
  })

  it('…e lo è su TUTTO il pannello: elenco, intestazioni, padding', () => {
    // La difesa messa solo sulle voci lasciava scoperto tutto il resto, e il
    // «resto» non è un dettaglio geometrico: è il padding del pannello, sono le
    // intestazioni di gruppo, ed è la BARRA DI SCORRIMENTO — che nel DOM è il
    // `role="listbox"` stesso (`max-h-72 overflow-y-auto`), cioè l'unico modo di
    // percorrere 484 comuni col mouse. In un browser un mousedown su un div non
    // focalizzabile toglie il fuoco all'input, `onBlur` chiama `chiudi(true)`, il
    // pannello si chiude e il testo digitato viene ripristinato.
    //
    // MISURATO prima della correzione, con una sonda: `fireEvent.mouseDown`
    // tornava `true` (non annullato) su elenco, pannello e intestazione, e `false`
    // solo sulla voce. Queste tre righe sono quelle che passavano da `true` e che
    // nessun test guardava.
    render(<Banco />)
    fireEvent.click(campo())
    const elenco = screen.getByRole('listbox')
    expect(fireEvent.mouseDown(elenco)).toBe(false)
    expect(fireEvent.mouseDown(elenco.parentElement!)).toBe(false)
    expect(fireEvent.mouseDown(screen.getByText('Area metropolitana'))).toBe(false)
  })

  it('trascinare la barra di scorrimento non chiude il pannello né perde il filtro', () => {
    // Lo stesso fatto, detto in comportamento invece che in `preventDefault`: il
    // gesto vero è mousedown sull'elenco e — SE non è stato annullato — il fuoco
    // che se ne va. Senza la difesa, qui si vedeva il pannello chiudersi e «bardo»
    // tornare «Rivoli» mentre l'utente stava solo scorrendo.
    render(<Banco iniziale="rivoli" />)
    fireEvent.click(campo())
    digita('bardo')
    const elenco = screen.getByRole('listbox')
    if (fireEvent.mouseDown(elenco)) fireEvent.blur(campo())
    expect(campo()).toHaveAttribute('aria-expanded', 'true')
    expect(campo()).toHaveValue('bardo')
    expect(valoriResi()).toEqual(['bardonecchia'])
  })

  it('un clic VERO su una voce sceglie, esattamente come Invio', () => {
    const spia = vi.fn()
    render(<Banco spia={spia} />)
    fireEvent.click(campo())
    clicVero(screen.getAllByRole('option')[2])
    expect(spia).toHaveBeenCalledWith('rivoli', expect.objectContaining({ valore: 'rivoli' }))
    expect(campo()).toHaveValue('Rivoli')
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
  })

  it('il clic VERO sceglie anche dopo aver filtrato (la voce non si smonta sotto il dito)', () => {
    const spia = vi.fn()
    render(<Banco spia={spia} />)
    fireEvent.click(campo())
    digita('bardo')
    expect(valoriResi()).toEqual(['bardonecchia'])
    clicVero(screen.getAllByRole('option')[0])
    expect(spia).toHaveBeenCalledWith('bardonecchia', expect.objectContaining({ valore: 'bardonecchia' }))
    expect(campo()).toHaveValue('Bardonecchia')
  })

  it('una voce DISABILITATA non si sceglie, né col clic né con Invio', () => {
    const spia = vi.fn()
    render(<Banco spia={spia} />)
    fireEvent.click(campo())
    const usseglio = screen.getAllByRole('option')[5]
    expect(usseglio).toHaveAttribute('aria-disabled', 'true')
    clicVero(usseglio)
    expect(spia).not.toHaveBeenCalled()
    expect(campo()).toHaveAttribute('aria-expanded', 'true')
  })

  it('Esc chiude e RIPRISTINA il valore precedente, senza toccarlo', () => {
    const spia = vi.fn()
    render(<Banco iniziale="rivoli" spia={spia} />)
    fireEvent.click(campo())
    digita('bardo')
    expect(valoriResi()).toEqual(['bardonecchia'])
    tasto('Escape')
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(campo()).toHaveValue('Rivoli')
    expect(spia).not.toHaveBeenCalled()
  })

  it('Esc su un campo senza scelta lo riporta vuoto', () => {
    render(<Banco />)
    fireEvent.click(campo())
    digita('bardo')
    tasto('Escape')
    expect(campo()).toHaveValue('')
  })

  it('Esc a pannello aperto NON risale al contenitore, a pannello chiuso sì', () => {
    // Il patto scritto nel componente: dentro una modale un solo Escape non
    // chiude anche il dialogo — si annulla la ricerca. Ma quando non c'è nessuna
    // ricerca da annullare l'Escape deve passare, altrimenti il campo si mangia
    // l'unico modo di uscire dalla modale con la tastiera.
    const suiTasti = vi.fn()
    render(
      <div onKeyDown={suiTasti}>
        <Banco />
      </div>,
    )
    fireEvent.click(campo())
    tasto('Escape')
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(suiTasti).not.toHaveBeenCalled()
    tasto('Escape')
    expect(suiTasti).toHaveBeenCalledTimes(1)
  })

  it('il chevron è un pulsante VERO: commuta, e non ruba il fuoco all\'input', () => {
    // Un’icona che sembra un interruttore e apre soltanto è un comando dipinto.
    render(<Banco />)
    const pulsante = screen.getByRole('button', { name: 'Mostra o nascondi l’elenco' })
    expect(pulsante).toHaveAttribute('tabindex', '-1')
    // Il mousedown è annullato: il fuoco resta dov’è, come per le voci.
    expect(fireEvent.mouseDown(pulsante)).toBe(false)
    fireEvent.click(pulsante)
    expect(campo()).toHaveAttribute('aria-expanded', 'true')
    expect(campo()).toHaveFocus()
    fireEvent.mouseDown(pulsante)
    fireEvent.click(pulsante)
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(campo()).toHaveFocus()
  })

  it('Tab chiude CONFERMANDO l\'evidenziato', () => {
    const spia = vi.fn()
    render(<Banco spia={spia} />)
    fireEvent.click(campo())
    digita('bardo')
    tasto('ArrowDown')
    tasto('Tab')
    expect(spia).toHaveBeenCalledWith('bardonecchia', expect.objectContaining({ valore: 'bardonecchia' }))
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(campo()).toHaveValue('Bardonecchia')
  })

  it('Tab senza evidenziato chiude e ripristina, senza scegliere niente', () => {
    const spia = vi.fn()
    render(<Banco iniziale="rivoli" spia={spia} />)
    fireEvent.click(campo())
    digita('bardo')
    tasto('Tab')
    expect(spia).not.toHaveBeenCalled()
    expect(campo()).toHaveValue('Rivoli')
  })

  it('uscendo dal campo (blur) il pannello si chiude e il testo torna coerente', () => {
    render(<Banco iniziale="rivoli" />)
    fireEvent.click(campo())
    digita('zzz')
    fireEvent.blur(campo())
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(campo()).toHaveValue('Rivoli')
  })
})

// =============================================================================
describe('§5 · il filtro non cancella MAI la scelta', () => {
  it('digitare non chiama `onChange`, nemmeno quando non trova niente', () => {
    const spia = vi.fn()
    render(<Banco iniziale="rivoli" spia={spia} />)
    fireEvent.click(campo())
    digita('b')
    digita('ba')
    digita('bar')
    digita('zzzzz')
    digita('')
    expect(spia).not.toHaveBeenCalled()
  })

  it('la voce scelta resta `aria-selected` anche mentre il filtro la esclude', () => {
    render(<Banco iniziale="rivoli" />)
    fireEvent.click(campo())
    digita('bardo')
    expect(valoriResi()).toEqual(['bardonecchia'])
    // La scelta non è cambiata: si rivede appena il filtro si allarga.
    digita('riv')
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('svuotare il campo non REVOCA la scelta: `onChange` non parte, il testo si riallinea', () => {
    // È il rovescio dell'invariante, e va scritto perché è anche il suo prezzo:
    // da qui non si torna a «nessuna scelta» cancellando il testo. Chi legge il
    // componente deve trovarlo misurato, non scoprirlo su un campo facoltativo.
    const spia = vi.fn()
    render(<Banco iniziale="rivoli" spia={spia} />)
    fireEvent.click(campo())
    digita('')
    fireEvent.blur(campo())
    expect(spia).not.toHaveBeenCalled()
    expect(campo()).toHaveValue('Rivoli')
  })

  it('per un campo FACOLTATIVO la revoca è una voce con `valore: \'\'`', () => {
    // La via che il componente offre, ed è scritta nelle props di `value`: la
    // pagina mette in elenco una voce vuota. Si sceglie come tutte le altre — con
    // la tastiera, col clic — e `onChange` riceve la stringa vuota.
    const CON_NESSUNO: readonly OpzioneCombobox[] = [
      { valore: '', etichetta: 'Nessun comune' },
      ...COMUNI,
    ]
    const spia = vi.fn()
    render(<Banco opzioni={CON_NESSUNO} iniziale="rivoli" spia={spia} />)
    expect(campo()).toHaveValue('Rivoli')
    fireEvent.click(campo())
    tasto('Home')
    tasto('Enter')
    expect(spia).toHaveBeenCalledTimes(1)
    expect(spia).toHaveBeenCalledWith('', expect.objectContaining({ valore: '' }))
    // Il campo mostra l'etichetta che la PAGINA ha dato al vuoto: «nessuna
    // scelta» va detto, non lasciato indovinare da un campo bianco.
    expect(campo()).toHaveValue('Nessun comune')
  })
})

// =============================================================================
describe('§6 · la regione live — il conteggio si ANNUNCIA', () => {
  const regione = () => screen.getByRole('status')

  it('la regione esiste da subito ed è `polite` (una live-region creata dopo non annuncia)', () => {
    render(<Banco />)
    expect(regione()).toHaveAttribute('aria-live', 'polite')
    expect(regione().textContent).toBe('')
  })

  it('all\'apertura annuncia quante voci ci sono, e il numero cambia col filtro', () => {
    render(<Banco />)
    fireEvent.click(campo())
    expect(regione()).toHaveTextContent('6 risultati disponibili')
    digita('riv')
    expect(regione()).toHaveTextContent('1 risultato disponibile')
    digita('zzz')
    expect(regione()).toHaveTextContent('Nessun risultato')
  })

  it('il singolare è singolare (non «1 risultati»)', () => {
    render(<Banco />)
    fireEvent.click(campo())
    digita('riv')
    expect(regione().textContent).toBe('1 risultato disponibile')
  })

  it('chiudendo la regione torna muta (nessun annuncio a pannello chiuso)', () => {
    render(<Banco />)
    fireEvent.click(campo())
    tasto('Escape')
    expect(regione().textContent).toBe('')
  })
})

// =============================================================================
describe('§7 · elenco vuoto, campo spento, caricamento', () => {
  /** Il messaggio scritto NEL PANNELLO (l'altra copia sta nella regione live). */
  const messaggioNelPannello = (testo: string) =>
    screen.getAllByText(testo).filter((el) => el.getAttribute('role') !== 'status')

  it('senza risultati mostra il messaggio predefinito, e l\'elenco resta vuoto', () => {
    render(<Banco />)
    fireEvent.click(campo())
    digita('zzz')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    // Due volte, e sono due cose diverse: il pannello lo MOSTRA, la regione live
    // lo DICE. Chi legge lo schermo non deve dedurre il vuoto dal silenzio.
    expect(messaggioNelPannello('Nessun risultato')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Nessun risultato')
  })

  it('il testo del vuoto è quello che passa la pagina, anche nell\'annuncio', () => {
    render(<Banco testi={{ ...TESTI_IT, vuoto: 'Nessun comune trovato' }} />)
    fireEvent.click(campo())
    digita('zzz')
    expect(messaggioNelPannello('Nessun comune trovato')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Nessun comune trovato')
    expect(screen.queryAllByText('Nessun risultato')).toHaveLength(0)
  })

  it('un elenco di opzioni VUOTO mostra il messaggio già all\'apertura', () => {
    render(<Banco opzioni={[]} />)
    fireEvent.click(campo())
    expect(messaggioNelPannello('Nessun risultato')).toHaveLength(1)
  })

  it('`disabled`: il campo è spento e il pannello non si apre in nessun modo', () => {
    render(<Banco disabled />)
    expect(campo()).toBeDisabled()
    fireEvent.click(campo())
    tasto('ArrowDown')
    expect(campo()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('`caricamento`: lo stato è dichiarato con `aria-busy` e detto a voce', () => {
    render(<Banco caricamento opzioni={[]} />)
    expect(campo()).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status').textContent).toMatch(/Caricamento/)
    fireEvent.click(campo())
    // Due volte: nel pannello (per chi vede) e nella regione live (per chi ascolta).
    expect(screen.getAllByText(/Caricamento/).length).toBeGreaterThanOrEqual(2)
    // Mentre carica NON si dice «nessun risultato»: sarebbe una bugia.
    expect(screen.queryByText('Nessun risultato')).toBeNull()
  })
})

// =============================================================================
const TESTO_ERRORE = 'Scegli un comune dall’elenco.'

describe('§8 · errore visibile, non solo colore', () => {
  it('`invalido` porta `aria-invalid` e punta al messaggio con `aria-describedby`', () => {
    render(
      <div>
        <Banco invalido describedById="comune-errore" />
        <p id="comune-errore">{TESTO_ERRORE}</p>
      </div>,
    )
    expect(campo()).toHaveAttribute('aria-invalid', 'true')
    expect(campo()).toHaveAttribute('aria-describedby', 'comune-errore')
    // Il messaggio è TESTO, ed è nel documento: non un bordo rosso e basta.
    expect(screen.getByText(TESTO_ERRORE)).toBeInTheDocument()
  })

  it('lo stato d\'errore porta anche un segno NON cromatico accanto al campo', () => {
    const { container } = render(<Banco invalido />)
    expect(container.querySelector('[data-kv-combobox-invalido]')).toBeTruthy()
  })

  it('senza errore niente `aria-invalid` e nessun segno', () => {
    const { container } = render(<Banco describedById="aiuto" />)
    expect(campo()).not.toHaveAttribute('aria-invalid')
    expect(campo()).toHaveAttribute('aria-describedby', 'aiuto')
    expect(container.querySelector('[data-kv-combobox-invalido]')).toBeNull()
  })
})

// =============================================================================
/** I token `--color-kidville-*` dichiarati nei blocchi `@theme` di globals.css. */
function tokenDichiarati(): Set<string> {
  const css = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8')
  const out = new Set<string>()
  for (const m of css.matchAll(/--color-kidville-([a-z0-9-]+)\s*:/g)) out.add(m[1])
  return out
}

/** Le palette Tailwind di serie: qui dentro non ne deve comparire nemmeno una. */
const PALETTE_DI_SERIE =
  /^(bg|text|border|ring|placeholder|fill|stroke|from|via|to|outline|decoration|divide|shadow)-(inherit|current|transparent|black|white|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-\d{2,3})?(\/\d+)?$/

describe('§9 · colori e fuoco — token di casa, anello di sistema', () => {
  /** Le classi di TUTTO l'albero reso, spogliate delle varianti (`focus:`, `disabled:`). */
  const tutteLeClassi = (radice: Element) =>
    Array.from(radice.querySelectorAll('*'))
      .flatMap((el) => classi(el))
      .map((c) => c.slice(c.lastIndexOf(':') + 1))

  it('nessun colore LETTERALE nel markup reso', () => {
    const { container } = render(<Banco iniziale="rivoli" />)
    fireEvent.click(campo())
    const html = container.innerHTML
    expect(html).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/)
    expect(html).not.toMatch(/rgba?\(/)
    expect(html).not.toMatch(/hsla?\(/)
  })

  it('nessuna palette Tailwind di serie: le tinte vengono TUTTE dai token di casa', () => {
    const { container } = render(<Banco iniziale="rivoli" invalido />)
    fireEvent.click(campo())
    const fuoriCasa = tutteLeClassi(container).filter((c) => PALETTE_DI_SERIE.test(c))
    // `border-transparent` è ammesso: è l'assenza di tinta che tiene ferma la
    // geometria della voce non evidenziata, non un colore.
    expect(fuoriCasa.filter((c) => !c.endsWith('-transparent'))).toEqual([])
  })

  it('ogni utility `*-kidville-*` corrisponde a un token dichiarato in globals.css', () => {
    // Tailwind v4 genera le utility dai token `@theme`: un nome inesistente non
    // produce NESSUN colore, in silenzio e col gate verde (lock
    // `utility-kidville-esistenti`). Qui si verifica sul markup davvero reso.
    const dichiarati = tokenDichiarati()
    expect(dichiarati.size, 'la sonda legge davvero i token').toBeGreaterThan(20)
    const { container } = render(<Banco iniziale="rivoli" invalido />)
    fireEvent.click(campo())
    const usati = tutteLeClassi(container)
      .map((c) => c.match(/^(?:bg|text|border|ring|placeholder|fill|stroke)-kidville-([a-z0-9-]+?)(?:\/\d+)?$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1])
    expect(usati.length, 'il componente usa davvero i token di casa').toBeGreaterThan(3)
    expect(usati.filter((n) => !dichiarati.has(n))).toEqual([])
  })

  it('il campo NON spegne l\'anello di fuoco globale con `outline-none`', () => {
    // `:focus-visible` di globals.css disegna 2px verdi (e 3px gialli in Alto
    // Contrasto). Un `outline-none` qui lo cancellerebbe, e resterebbe solo il
    // cambio di colore del bordo — cioè un segnale SOLO cromatico. Per la stessa
    // ragione non si usa `focus:ring-kidville-*`: quella utility nasce da
    // `@theme inline`, ha l'hex INLINATO e in Alto Contrasto resterebbe verde
    // mentre tutto il resto della pagina passa al giallo (lezione `.kv-fuoco-esito`).
    render(<Banco />)
    expect(classi(campo())).not.toContain('outline-none')
    expect(classi(campo()).some((c) => c.startsWith('focus:ring-'))).toBe(false)
  })

  it('l\'evidenziazione di una voce non è solo un colore (cambia anche il bordo)', () => {
    render(<Banco />)
    tasto('ArrowDown')
    const prima = screen.getAllByRole('option')[0]
    expect(prima).toHaveAttribute('data-evidenziata')
    expect(classi(prima).some((c) => c.startsWith('border-l-'))).toBe(true)
  })
})

// =============================================================================
describe('§10 · il `value` che cambia da FUORI (le opzioni arrivano dopo)', () => {
  // È il caso d'uso dichiarato in cima a questo file e in cima al componente —
  // 484 comuni in fondo a una fetch — ed era l'unico pezzo con copertura zero:
  // il blocco «adjust state during render» si poteva cancellare per intero e la
  // suite restava verde, perché `Banco` non rirende mai dall'esterno.

  it('opzioni che arrivano DOPO: il campo si riempie con l\'etichetta del valore', () => {
    const { rerender } = render(daFuori({ value: 'rivoli', opzioni: [] }))
    // Il valore c'è già, ma l'elenco no: non esiste ancora nessuna etichetta.
    expect(campo()).toHaveValue('')
    rerender(daFuori({ value: 'rivoli' }))
    expect(campo()).toHaveValue('Rivoli')
  })

  it('`value` cambiato da fuori a pannello CHIUSO: il testo si riallinea', () => {
    const { rerender } = render(daFuori({ value: 'rivoli' }))
    expect(campo()).toHaveValue('Rivoli')
    rerender(daFuori({ value: 'moncalieri' }))
    expect(campo()).toHaveValue('Moncalieri')
  })

  it('modulo azzerato da codice: il campo torna vuoto, non resta l\'etichetta vecchia', () => {
    const { rerender } = render(daFuori({ value: 'rivoli' }))
    rerender(daFuori({ value: '' }))
    expect(campo()).toHaveValue('')
  })

  it('`value` cambiato da fuori MENTRE si digita: il testo NON viene sovrascritto', () => {
    // L'invariante scritta nel commento del componente: a pannello aperto non si
    // tocca niente. Sovrascrivere il campo sotto le dita è il difetto, non la cura.
    const { rerender } = render(daFuori({ value: 'rivoli' }))
    fireEvent.click(campo())
    digita('bardo')
    rerender(daFuori({ value: 'moncalieri' }))
    expect(campo()).toHaveValue('bardo')
    expect(campo()).toHaveAttribute('aria-expanded', 'true')
    expect(valoriResi()).toEqual(['bardonecchia'])
    // …e appena il pannello si chiude il riallineamento avviene, sul valore NUOVO.
    fireEvent.blur(campo())
    expect(campo()).toHaveValue('Moncalieri')
  })

  it('cambia l\'ETICHETTA a parità di valore (elenco ricaricato, nome corretto)', () => {
    const prima: OpzioneCombobox[] = [{ valore: 'rivoli', etichetta: 'Rivoli' }]
    const poi: OpzioneCombobox[] = [{ valore: 'rivoli', etichetta: 'Rivoli (TO)' }]
    const { rerender } = render(daFuori({ value: 'rivoli', opzioni: prima }))
    expect(campo()).toHaveValue('Rivoli')
    rerender(daFuori({ value: 'rivoli', opzioni: poi }))
    expect(campo()).toHaveValue('Rivoli (TO)')
  })

  it('la scelta fatta dall\'utente sopravvive a un rirendere dall\'esterno', () => {
    const spia = vi.fn()
    const { rerender } = render(daFuori({ value: '', spia }))
    tasto('ArrowDown')
    tasto('Enter')
    expect(spia).toHaveBeenCalledWith('moncalieri', expect.objectContaining({ valore: 'moncalieri' }))
    // Il genitore recepisce e rirende: il campo non deve tornare vuoto.
    rerender(daFuori({ value: 'moncalieri', spia }))
    expect(campo()).toHaveValue('Moncalieri')
  })
})

// =============================================================================
describe('§11 · 484 voci — il pannello scorre e porta in vista', () => {
  /** 484 come i comuni della provincia di Torino: toponimi finti, nessun nome di persona. */
  const MOLTE: readonly OpzioneCombobox[] = Array.from({ length: 484 }, (_, i) => ({
    valore: `comune-${i}`,
    etichetta: `Comune ${i}`,
  }))

  it('il pannello ha un tetto d\'altezza e SCORRE (nessuna virtualizzazione)', () => {
    render(<Banco opzioni={MOLTE} />)
    fireEvent.click(campo())
    const elenco = screen.getByRole('listbox')
    expect(classi(elenco)).toContain('overflow-y-auto')
    expect(classi(elenco).some((c) => c.startsWith('max-h-'))).toBe(true)
  })

  it('nessuna voce sparisce dal DOM, e `aria-activedescendant` punta a un nodo VERO', () => {
    // È la ragione per cui qui non si virtualizza: togliere dal DOM le voci fuori
    // schermo significa togliere l'elemento a cui `aria-activedescendant` punta.
    render(<Banco opzioni={MOLTE} />)
    tasto('ArrowUp') // dall'alto verso l'ULTIMA voce
    expect(screen.getAllByRole('option')).toHaveLength(484)
    const puntato = campo().getAttribute('aria-activedescendant')
    expect(puntato).toBeTruthy()
    expect(document.getElementById(puntato!)).toHaveAttribute('data-valore', 'comune-483')
  })

  it('l\'elenco ha un NOME accessibile: è l\'etichetta del campo', () => {
    // Un `role="listbox"` senza nome è un elenco anonimo per chi lo ascolta, e
    // jest-axe non lo segnala: va misurato per nome, non dedotto dal verde di axe.
    render(<Banco opzioni={MOLTE} />)
    fireEvent.click(campo())
    expect(screen.getByRole('listbox', { name: 'Comune di nascita' })).toBeInTheDocument()
  })

  it('la voce evidenziata viene PORTATA in vista, non solo colorata', () => {
    // jsdom non implementa `scrollIntoView`: senza sonda, il componente prende il
    // ramo «non è una funzione» e il gesto non si vede. Con la sonda si misura.
    const originale = HTMLElement.prototype.scrollIntoView
    const sonda = vi.fn()
    HTMLElement.prototype.scrollIntoView = sonda
    try {
      render(<Banco opzioni={MOLTE} />)
      tasto('ArrowDown')
      expect(sonda).toHaveBeenCalledWith({ block: 'nearest' })
      expect(sonda.mock.instances[0]).toHaveAttribute('data-indice', '0')
      tasto('End')
      expect(sonda.mock.instances[sonda.mock.instances.length - 1]).toHaveAttribute(
        'data-indice',
        '483',
      )
    } finally {
      HTMLElement.prototype.scrollIntoView = originale
    }
  })
})

// =============================================================================
describe('§12 · la lingua la decide la pagina, non il componente', () => {
  /** Tutto ciò che il componente diceva in italiano prima che i testi diventassero props. */
  const ITALIANO = /Nessun risultato|Caricamento|risultat\w* disponibil\w*|elenco/i

  it('in inglese non resta una parola di italiano: conteggio, vuoto, caricamento', () => {
    const { container, rerender } = render(<Banco testi={TESTI_EN} />)
    fireEvent.click(campo())
    expect(screen.getByRole('status')).toHaveTextContent('6 results available')
    digita('rivo')
    expect(screen.getByRole('status').textContent).toBe('1 result available')
    digita('zzz')
    expect(screen.getByRole('status').textContent).toBe('No results')
    expect(screen.getByRole('button', { name: 'Show or hide the list' })).toBeInTheDocument()
    rerender(<Banco testi={TESTI_EN} caricamento opzioni={[]} />)
    expect(container.textContent ?? '').not.toMatch(ITALIANO)
  })

  it('NIENTE testo cablato: tutto ciò che si legge viene dalle props (lock di CLASSE)', () => {
    // La prova qui sopra elenca le stringhe italiane che c'erano PRIMA: è una
    // difesa contro la regressione NOTA, non contro la classe di difetto. Un testo
    // nuovo cablato domani — in italiano, in inglese o in qualunque lingua — le
    // passerebbe indenne.
    //
    // Questa non elenca niente. Prende tutto il testo reso, ne sottrae ogni
    // stringa che il banco ha PASSATO come prop, e pretende che non resti nulla.
    // Qualunque letterale dentro il JSX lascia un residuo, e il residuo è il
    // messaggio d'errore.
    const dalleProps = (n: number) =>
      [
        'Comune di nascita', // label
        'Cerca il comune…', // placeholder
        TESTI_EN.vuoto,
        TESTI_EN.caricamento,
        TESTI_EN.conteggio(n),
        TESTI_EN.commutaElenco,
        ...COMUNI.flatMap((o) => [o.etichetta, o.nota ?? '', o.gruppo ?? '']),
      ].filter(Boolean)

    /** Il testo reso meno tutto ciò che arriva da fuori — le più lunghe per prime. */
    const residuo = (testo: string, n: number) =>
      dalleProps(n)
        .sort((a, b) => b.length - a.length)
        .reduce((acc, s) => acc.split(s).join(''), testo)
        .replace(/\s+/g, '')

    const { container, rerender } = render(
      <Banco testi={TESTI_EN} placeholder="Cerca il comune…" />,
    )
    // La sonda misura sé stessa: se `residuo` non togliesse niente, un residuo
    // vuoto non significherebbe nulla.
    expect(residuo('Comune di nascita XYZ', 6)).toBe('XYZ')

    fireEvent.click(campo())
    expect(residuo(container.textContent ?? '', 6), 'aperto').toBe('')
    digita('zzz')
    expect(residuo(container.textContent ?? '', 0), 'senza risultati').toBe('')
    rerender(<Banco testi={TESTI_EN} placeholder="Cerca il comune…" caricamento opzioni={[]} />)
    expect(residuo(container.textContent ?? '', 0), 'in caricamento').toBe('')
  })

  it('il conteggio passa dalla funzione della pagina, plurale compreso', () => {
    // Nel prodotto quella funzione è `t('…', { count: n })`: il plurale lo fa
    // l'ICU del catalogo (lock `messaggi-plurali-e-glossario`), non un ternario.
    const conteggio = vi.fn((n: number) => `${n}`)
    render(<Banco testi={{ ...TESTI_EN, conteggio }} />)
    fireEvent.click(campo())
    expect(conteggio).toHaveBeenCalledWith(6)
    digita('rivo')
    expect(conteggio).toHaveBeenLastCalledWith(1)
  })
})

// =============================================================================
describe('§13 · jest-axe — nessuna violazione', () => {
  // Le regole document-level non si applicano a un componente isolato, e il
  // contrasto non è calcolabile in jsdom (lo misura `contrasto-cascata`).
  const opzioniAxe = {
    rules: {
      region: { enabled: false },
      'landmark-one-main': { enabled: false },
      'page-has-heading-one': { enabled: false },
    },
  }

  it('chiuso, senza violazioni', async () => {
    const { container } = render(<Banco iniziale="rivoli" />)
    expect(await axe(container, opzioniAxe)).toHaveNoViolations()
  })

  it('aperto con gruppi, voci disabilitate e una voce evidenziata, senza violazioni', async () => {
    const { container } = render(<Banco iniziale="rivoli" />)
    tasto('ArrowDown')
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0)
    expect(await axe(container, opzioniAxe)).toHaveNoViolations()
  })

  it('in errore, con il messaggio collegato, senza violazioni', async () => {
    const { container } = render(
      <div>
        <Banco invalido describedById="comune-errore" />
        <p id="comune-errore">Scegli un comune dall&apos;elenco.</p>
      </div>,
    )
    expect(await axe(container, opzioniAxe)).toHaveNoViolations()
  })

  it('vuoto e in caricamento, senza violazioni', async () => {
    const { container } = render(<Banco caricamento opzioni={[]} />)
    fireEvent.click(campo())
    expect(await axe(container, opzioniAxe)).toHaveNoViolations()
  })
})

// =============================================================================
describe('§14 · le tre props che nessuno guardava: `nota`, `placeholder`, `className`', () => {
  it('la `nota` è resa E fa parte del NOME ACCESSIBILE della voce — è una DECISIONE', () => {
    // La nota finisce dentro il nome dell'opzione: uno screen reader legge
    // «Nichelino Sede convenzionata». È voluto, e va scritto qui perché finora
    // era solo un effetto collaterale che nessuno aveva deciso. La nota dice
    // PERCHÉ quella voce è diversa dalle altre; nasconderla con `aria-hidden`
    // lascerebbe chi non vede a scegliere fra voci apparentemente identiche.
    // Se un giorno la nota diventasse decorativa, è questa riga che deve cadere.
    render(<Banco />)
    fireEvent.click(campo())
    expect(screen.getByText('Sede convenzionata')).toBeInTheDocument()
    const nichelino = screen.getAllByRole('option')[1]
    expect(nichelino).toHaveAttribute('data-valore', 'nichelino')
    expect(nichelino).toHaveAccessibleName('Nichelino Sede convenzionata')
    // Le voci senza nota restano il solo toponimo: la nota non è un ornamento
    // aggiunto a tutte.
    expect(screen.getAllByRole('option')[0]).toHaveAccessibleName('Moncalieri')
  })

  it('`placeholder` arriva all\'input, e non è un valore', () => {
    // Il segnaposto non deve mai finire nel `value`: un campo che «sembra
    // compilato» è il modo più semplice di far inviare un modulo vuoto.
    render(<Banco placeholder="Cerca il comune…" />)
    expect(campo()).toHaveAttribute('placeholder', 'Cerca il comune…')
    expect(campo()).toHaveValue('')
  })

  it('`className` si SOMMA alle classi del contenitore, non le sostituisce', () => {
    // `relative` non è decorativo: il pannello è in `absolute` e senza il
    // contenitore posizionato finirebbe altrove nella pagina. Una `className`
    // della pagina che lo scalzasse sarebbe un difetto invisibile in jsdom.
    const { container } = render(<Banco className="mt-6 col-span-2" />)
    const radice = container.firstElementChild!
    expect(classi(radice)).toEqual(expect.arrayContaining(['relative', 'mt-6', 'col-span-2']))
  })
})
