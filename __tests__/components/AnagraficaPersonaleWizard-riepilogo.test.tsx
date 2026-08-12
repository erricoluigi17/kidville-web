import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import { PERSONALE_FIELDS, CONSENSI_PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import {
  ALFA, OGGI, PERCORSO_SCANSIONE, compilaFinoAlRiepilogo, indietro, reteFinta,
  valoreNelRiepilogo,
} from '../fixtures/anagrafica-personale'

/**
 * `/anagrafica-personale` — IL RIEPILOGO RIEPILOGA, E NON È UN DETTAGLIO.
 *
 * ─── IL DIFETTO, MISURATO SUL MODULO FRATELLO ───────────────────────────────
 *
 * Fino all'11/08/2026 l'ultimo passo di `/lavora-con-noi` diceva «Controlla e
 * invia» e mostrava DUE fatti su tredici campi compilabili. Nome, cognome, EMAIL,
 * telefono e tutto il resto non comparivano: chi arrivava lì non aveva niente da
 * controllare. La causa non era la dimenticanza — era che l'elenco delle righe
 * era scritto A MANO, cioè una seconda lista da tenere allineata al template, ed
 * era rimasta indietro di undici campi.
 *
 * Qui pesa di più: i campi sono trentadue e comprendono il codice fiscale, il
 * numero del documento e la sua scadenza. Perciò il riepilogo si COSTRUISCE dalle
 * stesse liste che disegnano i passi, e l'invariante che questo file difende è
 * uno solo e non ammette eccezioni: **ogni campo RESO ha la sua riga**.
 * Un campo aggiunto domani compare da solo; se qualcuno tornasse a scrivere
 * l'elenco a mano, questo collaudo diventa rosso il giorno stesso.
 *
 * ⚠️ «RESO», e non «dichiarato dal template»: `birth_place`, `birth_province` e
 * `birth_nation` non hanno un controllo proprio in nessun passo — li DERIVA la
 * tendina a cascata, che a schermo occupa il posto del codice catastale — e
 * quindi non hanno una riga propria qui. Il loro contenuto non si perde: sta in
 * chiaro nella riga del luogo di nascita.
 *
 * ─── E LE QUATTRO COSE CHE IL RIEPILOGO NON DEVE FARE ───────────────────────
 *
 *  · **omettere i facoltativi vuoti.** «Persona da avvisare in caso di urgenza:
 *    Non indicato» dice che in caso di urgenza non c'è nessuno da chiamare, e chi
 *    voleva indicarlo fa in tempo a tornare indietro. Una riga assente non dice
 *    niente e si legge come un campo che non era stato chiesto;
 *  · **mostrare il valore TECNICO.** `document_type` vale `CI`, e chi rilegge
 *    deve trovarci «Carta d'identità»: controllare una cosa che non si è mai vista
 *    scritta così non è controllare. Vale ANCHE per il codice catastale: fino al
 *    12/08/2026 la riga «Comune di nascita» diceva `E054` e quella subito sotto,
 *    «Comune di nascita (per esteso)», diceva `GIUGLIANO IN CAMPANIA` — due righe
 *    adiacenti che si distinguono per un «(per esteso)» in coda, la prima con
 *    dentro quattro caratteri che chi compila non ha mai digitato né visto,
 *    perché al loro posto c'è una tendina;
 *  · **restituire le date in ISO.** Il modulo le chiede in `gg/mm/aaaa` — sulla
 *    scadenza con la maschera di `DateField`, apposta perché un giorno e un mese
 *    scambiati danno una data valida e sbagliata — e le rileggeva in `aaaa-mm-gg`
 *    (`1985-06-12`, `2029-05-20`). Ritradurre a mente proprio la riga su cui
 *    l'errore non si vede è il contrario di ricontrollare;
 *  · **stampare il percorso della scansione.** È la chiave con cui si firma un
 *    oggetto del bucket privato del personale, e non dice niente a chi lo legge:
 *    del documento interessa che ci sia.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'

/** Le righe del riepilogo: una `<p>` di etichetta e una di valore per ognuna. */
const righe = () => Array.from(document.querySelectorAll('.divide-y > div'))

/**
 * I tre campi che la tendina a cascata DERIVA, e che nessun passo rende: al loro
 * posto, a schermo, c'è un controllo solo (provincia → comune). Non hanno una
 * riga nel riepilogo per la stessa ragione per cui non hanno una casella nel
 * modulo — e il loro contenuto sta, in chiaro, nella riga del luogo di nascita.
 */
const DERIVATI = ['birth_place', 'birth_province', 'birth_nation']
const CAMPI_RESI = PERSONALE_FIELDS.filter((f) => !DERIVATI.includes(f.id))

const modifica = (titolo: string) =>
  screen.getByRole('button', { name: `${itPublic.persRiepilogoModifica} ${titolo}` })

const tornaAlRiepilogo = () =>
  fireEvent.click(screen.getByRole('button', { name: itPublic.persTornaAlRiepilogo }))

async function montaEArrivaAlRiepilogo(opzioni: Parameters<typeof compilaFinoAlRiepilogo>[0] = {}) {
  const rete = reteFinta()
  vi.stubGlobal('fetch', rete.fetch)
  render(<AnagraficaPersonaleWizard oggi={OGGI} />)
  await compilaFinoAlRiepilogo({ sede: ALFA.id, ...opzioni })
  return rete
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AnagraficaPersonaleWizard — ogni campo RESO ha la sua riga', () => {
  it('le righe sono la sede + tutti i campi resi + tutte le prese visione, nessuna esclusa', async () => {
    await montaEArrivaAlRiepilogo()

    // L'invariante, e vale per costruzione: la sede, i campi che il modulo rende
    // davvero (i 32 del template meno i 3 derivati dalla tendina) e le 3 prese
    // visione. Se qualcuno rendesse il riepilogo con un elenco scritto a mano,
    // questo numero smetterebbe di tornare al primo campo aggiunto al template —
    // che è esattamente come il modulo fratello era arrivato a mostrarne due su
    // tredici.
    expect(righe()).toHaveLength(1 + CAMPI_RESI.length + CONSENSI_PERSONALE_FIELDS.length)

    // E ogni etichetta è davvero a schermo, non solo contata.
    for (const f of CAMPI_RESI) {
      expect(screen.getByText(String(f.label)), `manca la riga di «${f.id}»`).toBeInTheDocument()
    }
    for (const c of CONSENSI_PERSONALE_FIELDS) {
      expect(screen.getByText(String(c.label)), `manca la riga di «${c.id}»`).toBeInTheDocument()
    }
  })

  it('⚠️ i tre campi DERIVATI non hanno una riga propria: sarebbero un doppione', async () => {
    await montaEArrivaAlRiepilogo()
    for (const id of DERIVATI) {
      const f = PERSONALE_FIELDS.find((c) => c.id === id)
      expect(f, `il template non dichiara più «${id}»`).toBeDefined()
      // «Comune di nascita (per esteso)» stava attaccata a «Comune di nascita» e
      // si distingueva da essa nel punto in cui l'occhio ha già smesso di
      // leggere: due righe adiacenti per un dato solo.
      expect(
        screen.queryByText(String(f?.label)),
        `«${id}» non deve avere una riga sua`,
      ).not.toBeInTheDocument()
    }
  })

  it('i gruppi sono cinque, nell’ordine dei passi, con la SEDE in cima', async () => {
    await montaEArrivaAlRiepilogo()
    const titoli = screen.getAllByRole('heading', { level: 3 }).map((n) => n.textContent)
    expect(titoli).toEqual([
      itPublic.persSede,
      itPublic.persDati,
      itPublic.persResidenza,
      itPublic.persDocumento,
      itPublic.persConsensiTitolo,
    ])
  })
})

describe('AnagraficaPersonaleWizard — che cosa si legge, e come', () => {
  it('i valori a tendina si rileggono con l’ETICHETTA, mai col codice interno', async () => {
    await montaEArrivaAlRiepilogo()
    expect(valoreNelRiepilogo('Tipo di documento')).toBe('Carta d’identità')
    expect(valoreNelRiepilogo('Titolo di studio')).toBe('Laurea triennale')
    expect(valoreNelRiepilogo('Sesso')).toBe('Femmina')
  })

  it('⚠️ il luogo di nascita è UNA riga, e porta il nome — mai il codice catastale', async () => {
    await montaEArrivaAlRiepilogo()

    // La cascata ha scelto NAPOLI in provincia di NA: è quello che chi compila ha
    // visto e toccato, ed è quello che deve ritrovarsi da ricontrollare.
    expect(valoreNelRiepilogo('Comune di nascita')).toBe('NAPOLI (NA)')

    // E il codice catastale non compare da nessuna parte: è il valore TECNICO —
    // quattro caratteri mai digitati, che una schermata di verifica non fa
    // verificare a nessuno. Stessa regola di `CI` → «Carta d'identità».
    expect(document.body.textContent ?? '').not.toContain('H501')
  })

  it('⚠️ le date si rileggono in gg/mm/aaaa, come sono state chieste', async () => {
    await montaEArrivaAlRiepilogo({ scadenza: '20/05/2029' })

    // In react-hook-form valgono `1985-03-07` e `2029-05-20`. Il riepilogo è
    // l'ultima schermata prima di un invio irreversibile: se restituisce in
    // aaaa-mm-gg ciò che ha chiesto in gg/mm/aaaa, obbliga a ritradurre a mente
    // proprio la riga su cui un giorno e un mese scambiati non danno un errore
    // ma una data valida e sbagliata.
    expect(valoreNelRiepilogo('Data di nascita')).toBe('07/03/1985')
    expect(valoreNelRiepilogo('Scadenza del documento')).toBe('20/05/2029')

    const testo = document.body.textContent ?? ''
    expect(testo).not.toContain('1985-03-07')
    expect(testo).not.toContain('2029-05-20')
  })

  it('le fasce d’età sono un elenco, una voce per riga', async () => {
    await montaEArrivaAlRiepilogo()
    expect(valoreNelRiepilogo('Fasce d’età su cui lavori')).toContain('Infanzia (3-6)')
  })

  it('i facoltativi vuoti si MOSTRANO come «Non indicato», in grigio', async () => {
    await montaEArrivaAlRiepilogo()
    // Il contatto d'emergenza è facoltativo per intero (sono i dati di un terzo
    // che non ha ricevuto nessuna informativa): il fatto che manchi va detto.
    expect(valoreNelRiepilogo('Persona da avvisare in caso di urgenza')).toBe(
      itPublic.persRiepilogoNonIndicato,
    )
    const riga = screen.getByText('Persona da avvisare in caso di urgenza').parentElement as HTMLElement
    expect(riga.querySelectorAll('p')[1].className).toContain('text-kidville-sub')
  })

  it('le prese visione hanno «Sì»/«No», mai «Non indicato»', async () => {
    await montaEArrivaAlRiepilogo()
    for (const c of CONSENSI_PERSONALE_FIELDS) {
      expect(valoreNelRiepilogo(String(c.label))).toBe(itPublic.persRiepilogoSi)
    }
  })

  it('⚠️ della scansione si dice che c’è, MAI dove sta', async () => {
    await montaEArrivaAlRiepilogo()
    // Il percorso è la chiave con cui si firma un oggetto del bucket del
    // personale: a schermo non dice niente, e a schermo si fotografa.
    expect(valoreNelRiepilogo('Scansione o foto del documento')).toBe('Allegato caricato')
    const riepilogo = document.body.textContent ?? ''
    expect(riepilogo).not.toContain(PERCORSO_SCANSIONE)
  })

  it('la riga che invita a rileggere codice fiscale e scadenza sta SOPRA il bottone', async () => {
    await montaEArrivaAlRiepilogo()
    const riga = screen.getByText(itPublic.persRiepilogoControlla)
    const bottone = screen.getByRole('button', { name: itPublic.persInvia })
    expect(riga.compareDocumentPosition(bottone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('AnagraficaPersonaleWizard — «Modifica» è un viaggio di andata E RITORNO', () => {
  it('si va al passo, si corregge, e si torna al riepilogo con UN tocco', async () => {
    await montaEArrivaAlRiepilogo()

    fireEvent.click(modifica(itPublic.persResidenza))
    await waitFor(() => expect(screen.getByLabelText(/^Email/)).toBeInTheDocument())

    // Il comando primario ha cambiato nome: dice dove porta.
    expect(screen.queryByRole('button', { name: itPublic.persAvanti })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'corretta@example.test' } })
    tornaAlRiepilogo()

    await waitFor(() => expect(screen.getByText(itPublic.persRiepilogoSede)).toBeInTheDocument())
    expect(valoreNelRiepilogo('Email')).toBe('corretta@example.test')
  })

  it('⚠️ il ritorno NON scavalca la validazione dei passi che salta, e lo DICE', async () => {
    // Il segno del ritorno resta acceso anche camminando: il salto può partire da
    // un passo e scavalcarne altri. Se uno di quelli fosse incompleto, il
    // riepilogo mostrerebbe un modulo che il server rifiuterà — cioè esattamente
    // la cosa che il riepilogo esiste per evitare.
    await montaEArrivaAlRiepilogo()

    fireEvent.click(modifica(itPublic.persResidenza))
    await waitFor(() => expect(screen.getByLabelText(/^Email/)).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: '' } })

    // Si cammina all'indietro senza spegnere il segno del ritorno…
    indietro()
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())

    // …e da qui «Torna al riepilogo» scavalcherebbe la residenza, che è rotta.
    tornaAlRiepilogo()

    await waitFor(() =>
      expect(screen.getByText(itPublic.persRitornoInterrottoTitolo)).toBeInTheDocument(),
    )
    // Si atterra sul primo passo incompleto, col campo che porta il suo messaggio…
    expect(screen.getByLabelText(/^Email/)).toHaveAttribute('aria-invalid', 'true')
    // …e il comando torna «Avanti»: la promessa non si rifà mentre il modulo è rotto.
    expect(screen.getByRole('button', { name: itPublic.persAvanti })).toBeInTheDocument()
    expect(screen.queryByText(itPublic.persRiepilogoSede)).not.toBeInTheDocument()
  })
})
