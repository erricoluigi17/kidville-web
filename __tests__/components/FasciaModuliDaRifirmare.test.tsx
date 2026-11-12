import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'

/**
 * LA FASCIA «MODULI DA RIFIRMARE» (compito 4.8.6).
 *
 * Tre cose sotto misura: la fascia compare SOLO se la route consegna almeno un modulo; il pulsante «Firma»
 * passa il figlio e il modulo a chi ospita la fascia (che apre il flusso di firma esistente); una lettura
 * che non riesce non diventa un errore a schermo né in console, ma lascia una riga nel registro.
 *
 * Il «nessuna fascia» si prova DOPO che la fetch è partita e si è risolta (un'assenza prima dell'arrivo dei
 * dati sarebbe vera comunque), e ogni caso di assenza ha accanto il caso gemello con i dati.
 *
 * Nessun dato reale: uuid, nomi e date sono inventati.
 */

const FIGLIO_A = 'a1000000-0000-4000-8000-00000000000a'
const FIGLIO_B = 'b1000000-0000-4000-8000-00000000000b'
const FIGLI = [
  { id: FIGLIO_A, nome: 'Bimba', cognome: 'Di Prova' },
  { id: FIGLIO_B, nome: 'Bimbo', cognome: 'Di Prova' },
]
const UTENTE = '99999999-9999-4999-8999-999999999991'

const log = vi.hoisted(() => ({ righe: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/logging/client', () => ({
  logClient: (riga: Record<string, unknown>) => void log.righe.push(riga),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Errore'),
}))

vi.mock('next-intl', async () => {
  const cataloghi: Record<string, Record<string, unknown>> = {
    annoRifirma: (await import('../../messages/it/annoRifirma.json')).default,
    prestampatiGenitore: (await import('../../messages/it/prestampatiGenitore.json')).default,
  }
  const { IntlMessageFormat } = await import('intl-messageformat')
  const foglia = (gruppo: Record<string, unknown> | undefined, chiave: string): string | undefined => {
    let corrente: unknown = gruppo
    for (const pezzo of chiave.split('.')) {
      if (typeof corrente !== 'object' || corrente === null) return undefined
      corrente = (corrente as Record<string, unknown>)[pezzo]
    }
    return typeof corrente === 'string' ? corrente : undefined
  }
  const useTranslations = (ns: string) => {
    const t = (chiave: string, valori?: Record<string, unknown>) => {
      const grezza = foglia(cataloghi[ns], chiave) ?? `${ns}.${chiave}`
      return valori ? String(new IntlMessageFormat(grezza, 'it').format(valori)) : grezza
    }
    return t
  }
  return { useTranslations, useLocale: () => 'it' }
})

import { FasciaModuliDaRifirmare } from '@/components/features/parent/FasciaModuliDaRifirmare'

const gruppo = (alunno_id: string, giorno: string) => ({
  alunno_id,
  moduli: [{ slug: 'delega_ritiro', chiaveEtichetta: 'modelli.delegaRitiro', ultimaFirma: giorno }],
})

function rispondi(corpo: unknown, status = 200) {
  const f = vi.fn(async () => new Response(JSON.stringify(corpo), { status }))
  vi.stubGlobal('fetch', f)
  return f
}

/** La fetch è partita e la sua risposta è stata consumata dal componente. */
async function attendiLettura(f: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(f).toHaveBeenCalled())
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

let errori: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  log.righe = []
  errori = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  errori.mockRestore()
})

describe('la fascia compare solo con qualcosa da rifirmare', () => {
  it('con un modulo: titolo, modulo, figlio, giorno dell’ultima firma e il pulsante', async () => {
    const f = rispondi({ success: true, totale: 1, data: [gruppo(FIGLIO_A, '2026-10-10')] })
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)

    expect(await screen.findByRole('region', { name: 'Moduli da rifirmare' })).toBeTruthy()
    expect(screen.getByText('Delega al ritiro · Bimba Di Prova')).toBeTruthy()
    expect(screen.getByText(/Firmato il .*2026/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Firma: Delega al ritiro · Bimba Di Prova' })).toBeTruthy()
    expect(f).toHaveBeenCalledWith('/api/parent/prestampati/da-rifirmare', { headers: { 'x-user-id': UTENTE } })
    expect(screen.queryByText(/E altri/)).toBeNull()
  })

  it('elenco vuoto: nessuna fascia', async () => {
    const f = rispondi({ success: true, totale: 0, data: [] })
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)
    await attendiLettura(f)
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByText('Moduli da rifirmare')).toBeNull()
    expect(log.righe).toEqual([])
  })

  it('senza identità non chiede niente e non disegna niente', async () => {
    const f = rispondi({ success: true, totale: 1, data: [gruppo(FIGLIO_A, '2026-10-10')] })
    render(<FasciaModuliDaRifirmare userId={null} figli={FIGLI} onFirma={vi.fn()} />)
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(f).not.toHaveBeenCalled()
    expect(screen.queryByRole('region')).toBeNull()
  })
})

describe('il pulsante «Firma»', () => {
  it('passa il figlio e il modulo di QUELLA riga, non di un’altra', async () => {
    rispondi({ success: true, totale: 2, data: [gruppo(FIGLIO_A, '2026-09-02'), gruppo(FIGLIO_B, '2026-10-10')] })
    const onFirma = vi.fn()
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={onFirma} />)

    const secondo = await screen.findByRole('button', { name: 'Firma: Delega al ritiro · Bimbo Di Prova' })
    fireEvent.click(secondo)
    expect(onFirma).toHaveBeenCalledTimes(1)
    expect(onFirma).toHaveBeenCalledWith(FIGLIO_B, 'delega_ritiro')
  })

  it('l’ordine è quello della route: il più vecchio scaduto sta in alto', async () => {
    rispondi({ success: true, totale: 2, data: [gruppo(FIGLIO_B, '2026-09-02'), gruppo(FIGLIO_A, '2026-10-10')] })
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)
    await screen.findByRole('region')
    const pulsanti = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    expect(pulsanti).toEqual([
      'Firma: Delega al ritiro · Bimbo Di Prova',
      'Firma: Delega al ritiro · Bimba Di Prova',
    ])
  })
})

describe('oltre il tetto', () => {
  it('«e altri N» con la differenza fra il totale vero e i moduli consegnati', async () => {
    rispondi({ success: true, totale: 25, data: [gruppo(FIGLIO_A, '2026-09-02')] })
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)
    expect(await screen.findByText('E altri 24 moduli, che compaiono dopo questi.')).toBeTruthy()
  })

  it('al singolare quando ne manca uno solo', async () => {
    rispondi({ success: true, totale: 2, data: [gruppo(FIGLIO_A, '2026-09-02')] })
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)
    expect(await screen.findByText('E un altro modulo, che compare dopo questi.')).toBeTruthy()
  })
})

describe('una lettura che non riesce non diventa un errore', () => {
  it('500: nessuna fascia, nessun errore in console, una riga di registro', async () => {
    const f = rispondi({ error: 'Moduli da rifirmare non disponibili', codice: 'LETTURA_FALLITA' }, 500)
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)
    await attendiLettura(f)
    expect(screen.queryByRole('region')).toBeNull()
    expect(errori).not.toHaveBeenCalled()
    expect(log.righe).toContainEqual(expect.objectContaining({ livello: 'warn', stato: 500, route: '/parent/modulistica' }))
  })

  it('rete caduta: nessuna fascia, nessun errore in console, una riga di registro senza dati personali', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('rete')
    })
    vi.stubGlobal('fetch', f)
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)
    await attendiLettura(f)
    expect(screen.queryByRole('region')).toBeNull()
    expect(errori).not.toHaveBeenCalled()
    expect(JSON.stringify(log.righe)).not.toContain(UTENTE)
    expect(log.righe).toHaveLength(1)
  })

  it('un corpo che non ha la forma attesa vale come «non letto»', async () => {
    const f = rispondi({ success: true, data: 'no' })
    render(<FasciaModuliDaRifirmare userId={UTENTE} figli={FIGLI} onFirma={vi.fn()} />)
    await attendiLettura(f)
    expect(screen.queryByRole('region')).toBeNull()
    expect(log.righe).toHaveLength(1)
  })
})
