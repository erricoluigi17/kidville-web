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
