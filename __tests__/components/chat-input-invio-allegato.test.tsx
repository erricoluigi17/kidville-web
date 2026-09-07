import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

/**
 * `ChatInput` — l'invio, con e senza allegato, e cosa succede quando il server rifiuta.
 *
 * ─── PERCHÉ ESISTE, e perché non esisteva ────────────────────────────────────
 *
 * Su questo componente non c'era **nessun** test: né sull'invio, né sull'upload, né
 * sullo svuotamento del campo. Eppure è il punto in cui un messaggio si perde o si
 * salva — fino al 2026-09-07 svuotava il riquadro PRIMA di sapere l'esito, quindi un
 * invio rifiutato (genitore moroso, allegato fuori bucket, 500) faceva sparire il
 * testo senza dire niente: il messaggio era perso e chi l'aveva scritto credeva di
 * averlo mandato.
 *
 * ─── IL MOTIVO PRECISO PER CUI È NATO ────────────────────────────────────────
 *
 * `e2e/chat.spec.ts` è diventata rossa in CI e l'ipotesi era che il ramo nuovo
 * (`if (esito === false) return`) impedisse l'invio dei messaggi con allegato.
 * Questi quattro casi hanno **falsificato** quell'ipotesi in pochi secondi:
 * l'invio con allegato funziona, e il rifiuto conserva il chip invece di perderlo.
 * La causa vera era un'altra — la spec sforava il tetto di 30 s di Playwright — e
 * senza questo file la si sarebbe cercata nel posto sbagliato.
 *
 * Un componente senza test non è «semplice»: è un posto dove le ipotesi non si
 * possono verificare.
 */

vi.mock('next-intl', () => {
  const t = (k: string) => k
  return {
    useTranslations: () => Object.assign(t, { rich: t, markup: t, raw: t, has: () => true }),
    useLocale: () => 'it',
  }
})
// Il bottone «Scatta foto» nativo trascina Capacitor: qui non c'entra.
vi.mock('@/components/features/native/ScattaFotoButton', () => ({ ScattaFotoButton: () => null }))

import { ChatInput } from '@/components/features/chat/ChatInput'

const PERCORSO = 'gen-1/abc-allegato.png'

beforeEach(() => {
  // `POST /api/chat/upload` risponde col PERCORSO nel bucket privato, non con un
  // link firmato: è la forma introdotta da S32 (2026-08-01).
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ path: PERCORSO, name: 'allegato.png', attachment_type: 'image' }),
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function allega() {
  const file = new File(['x'], 'allegato.png', { type: 'image/png' })
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [file] },
  })
  // Il chip d'anteprima compare a upload FINITO: attenderlo è anche la prova che
  // l'upload è andato.
  await screen.findByText('allegato.png')
}

const invia = () => fireEvent.click(screen.getByLabelText('chatInputAriaInvia'))

describe('invio con allegato', () => {
  it('manda il contenuto, il riferimento nel bucket e il tipo', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput onSend={onSend} />)
    await allega()
    invia()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    // Senza testo il contenuto è la stringa fissa: è quella che il thread mostra,
    // ed è quella che la spec E2E cerca a schermo.
    expect(onSend).toHaveBeenCalledWith('📎 Allegato', PERCORSO, 'image')
  })

  it('testo e allegato insieme: vince il testo scritto', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ChatInput onSend={onSend} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ciao' } })
    await allega()
    invia()
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('ciao', PERCORSO, 'image'))
  })

  it('a invio riuscito il chip sparisce', async () => {
    render(<ChatInput onSend={vi.fn().mockResolvedValue(true)} />)
    await allega()
    invia()
    await waitFor(() => expect(screen.queryByText('allegato.png')).toBeNull())
  })
})

describe('quando il server rifiuta: non si perde niente', () => {
  it('l\'allegato RESTA agganciato', async () => {
    render(<ChatInput onSend={vi.fn().mockResolvedValue(false)} />)
    await allega()
    invia()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('allegato.png')).not.toBeNull()
  })

  it('il TESTO resta nel riquadro: è la differenza fra «riprova» e «riscrivilo»', async () => {
    render(<ChatInput onSend={vi.fn().mockResolvedValue(false)} />)
    const campo = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(campo, { target: { value: 'non perdermi' } })
    invia()
    await new Promise((r) => setTimeout(r, 20))
    expect(campo.value).toBe('non perdermi')
  })

  it('un chiamante che NON dichiara l\'esito si comporta come prima', async () => {
    // `undefined` vale «andata»: le tre pagine sono state convertite una alla volta,
    // e una che non restituisce niente non deve restare col campo pieno per sempre.
    render(<ChatInput onSend={vi.fn().mockResolvedValue(undefined)} />)
    const campo = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(campo, { target: { value: 'ciao' } })
    invia()
    await waitFor(() => expect(campo.value).toBe(''))
  })
})

describe('la corsa fra un invio in volo e un allegato appena caricato', () => {
  /**
   * ⚠️ IL DIFETTO CHE HA FATTO ROSSA `e2e/chat.spec.ts`, e che nessuno dei test qui
   * sopra vedeva — perché tutti risolvono `onSend` all'istante.
   *
   * Dal 2026-09-07 `handleSend` ATTENDE `onSend` prima di svuotare il composer: è
   * ciò che impedisce di perdere un messaggio rifiutato. Ma svuotare DOPO significa
   * svuotare in un momento in cui lo stato può essere cambiato — e in quel momento
   * `setAttachment(null)` cancellava un allegato caricato NEL FRATTEMPO.
   *
   * Non è teoria: è la sequenza esatta della spec E2E, letta dal trace di rete
   * della CI. `POST /api/chat/messages` parte a +8,3 s e ci mette **2.658 ms**;
   * `POST /api/chat/upload` parte a +8,4 s e finisce prima. Quando la prima si
   * risolve, l'allegato è già agganciato — e veniva buttato via. Poi il pulsante
   * «Invia» risulta disabilitato (`!text.trim() && !attachment`), il secondo invio
   * non parte, e nel trace c'è UNA sola POST per due messaggi mandati.
   *
   * Prima della modifica il difetto non poteva esistere: `onSend` non veniva atteso
   * e lo svuotamento era sincrono, quindi avveniva molto prima che l'upload
   * finisse. È una regressione introdotta da un rimedio giusto, e il rimedio del
   * rimedio è non sovrascrivere mai uno stato che è cambiato mentre si aspettava.
   *
   * ⚠️ NON È SOLO UN PROBLEMA DEL TEST: chiunque mandi un messaggio e nel frattempo
   * alleghi un file si vedrebbe sparire l'allegato, in silenzio.
   */
  it('un allegato caricato MENTRE l\'invio è in volo non viene buttato via', async () => {
    let sblocca: (v: boolean) => void = () => {}
    const onSend = vi.fn(() => new Promise<boolean>((r) => { sblocca = r }))
    render(<ChatInput onSend={onSend} />)

    // 1. si manda un testo, e la risposta TARDA (come i 2,6 s della CI)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'primo' } })
    invia()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))

    // 2. nel frattempo si allega un file, e l'upload finisce PRIMA della risposta
    await allega()

    // 3. ora la risposta arriva
    sblocca(true)

    // 4. l'allegato deve essere ancora lì: non l'ha mandato nessuno
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
    expect(screen.queryByText('allegato.png')).not.toBeNull()
  })

  it('e resta inviabile: il pulsante non deve restare disabilitato', async () => {
    let sblocca: (v: boolean) => void = () => {}
    const onSend = vi.fn(() => new Promise<boolean>((r) => { sblocca = r }))
    render(<ChatInput onSend={onSend} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'primo' } })
    invia()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await allega()
    sblocca(true)
    await waitFor(() => expect(screen.getByLabelText('chatInputAriaInvia')).not.toBeDisabled())

    invia()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(onSend).toHaveBeenLastCalledWith('📎 Allegato', PERCORSO, 'image')
  })

  it('lo stesso vale per il TESTO scritto mentre l\'invio è in volo', async () => {
    let sblocca: (v: boolean) => void = () => {}
    const onSend = vi.fn(() => new Promise<boolean>((r) => { sblocca = r }))
    render(<ChatInput onSend={onSend} />)
    const campo = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(campo, { target: { value: 'primo' } })
    invia()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    fireEvent.change(campo, { target: { value: 'secondo, scritto mentre partiva il primo' } })
    sblocca(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(campo.value).toBe('secondo, scritto mentre partiva il primo')
  })
})
