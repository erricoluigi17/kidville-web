/**
 * «Ingresso alle 2026-» — il difetto che 490 famiglie leggevano ogni giorno.
 *
 * `PresenzeTodayCard` mostra al genitore l'ora d'ingresso di suo figlio prendendola
 * da `presenze.orario_entrata`, e la ricavava con `v.slice(0, 5)`. Quella riga è
 * corretta su `'08:45:00'` — la forma che il suo commento dava per scontata — ma per
 * il nido e l'infanzia la colonna contiene un ISO completo
 * (`2026-09-07T10:35:04.428Z`), e i suoi primi cinque caratteri sono **`2026-`**.
 *
 * Misurato in produzione il 2026-09-07: **450 righe d'appello su 450** con quella
 * forma, e **490 genitori** che stavano leggendo quella frase in quel momento. Il
 * difetto era vivo da mesi e non lo vedeva nessun test, perché nessun test guardava
 * questa stringa.
 *
 * Qui si guarda. E si guarda la frase INTERA, non solo il numero: è quella che sta
 * sullo schermo di una persona.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

/** next-intl col catalogo VERO, e con l'interpolazione: la frase deve uscire tutta. */
vi.mock('next-intl', async () => {
  const home: Record<string, string> = (await import('../../messages/it/home.json')).default
  const useTranslations = (ns?: string) => {
    const t = (key: string, valori?: Record<string, unknown>) => {
      const grezzo = ns === 'home' ? home[key] : undefined
      if (grezzo == null) return ns ? `${ns}.${key}` : key
      return grezzo.replace(/\{(\w+)\}/g, (_m, k) => String(valori?.[k] ?? `{${k}}`))
    }
    return Object.assign(t, { rich: t, markup: t, raw: (k: string) => k, has: () => true })
  }
  return {
    useTranslations,
    useLocale: () => 'it',
    useFormatter: () => ({ number: (v: unknown) => String(v), dateTime: (v: unknown) => String(v) }),
    NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  }
})

/** Il logger del client: si guarda CHE venga chiamato quando le presenze non arrivano. */
const logClient = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logging/client', () => ({
  logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'sconosciuto'),
}))

import { PresenzeTodayCard } from '@/components/features/parent/home/PresenzeTodayCard'

const risposta = (oggi: Record<string, unknown>) => ({
  ok: true,
  json: async () => ({
    success: true,
    data: {
      schoolType: 'infanzia',
      oggi: { stato: null, orario_entrata: null, orario_uscita: null, ...oggi },
      riepilogo: { presenze: 1, assenze: 0, ritardi: 0, uscite: 0 },
    },
  }),
})

function montaCon(oggi: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(risposta(oggi)))
  render(<PresenzeTodayCard studentId="alu-1" parentId="gen-1" />)
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PresenzeTodayCard — l\'ora d\'ingresso che il genitore legge', () => {
  // Dal 2026-09-26 l'ora d'ingresso compare SOLO sul ritardo (decisione del titolare,
  // compito A1): per questo i casi di FORMA qui sotto passano per 'ritardo'. Il caso
  // 'presente' ha il suo blocco, più in basso.
  it('la riga vera dello 0-6: 10:35Z diventa «Ingresso alle 12:35», non «2026-»', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '2026-09-07T10:35:04.428Z' })
    expect(await screen.findByText('Ingresso alle 12:35')).toBeTruthy()
  })

  it('e in nessun caso lo schermo mostra un pezzo di data', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '2026-09-07T10:35:04.428Z' })
    await waitFor(() => expect(screen.queryByText(/Ingresso alle/)).toBeTruthy())
    expect(screen.queryByText(/2026-/)).toBeNull()
  })

  it('d\'inverno la stessa ora UTC vale un\'ora in meno: l\'offset non è cablato', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '2026-01-15T10:35:00Z' })
    expect(await screen.findByText('Ingresso alle 11:35')).toBeTruthy()
  })

  it('ritardo: la frase è la stessa e l\'ora è quella italiana', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '2026-09-07T07:50:00Z' })
    expect(await screen.findByText('Ingresso alle 09:50')).toBeTruthy()
  })

  it('uscita anticipata: anche l\'uscita passava per lo stesso taglio', async () => {
    montaCon({ stato: 'uscita_anticipata', orario_uscita: '2026-09-07T11:06:57.549Z' })
    expect(await screen.findByText('Uscita alle 13:06')).toBeTruthy()
  })

  it('la forma HH:MM:SS continua a funzionare: era l\'unica che il taglio azzeccava', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '08:45:00' })
    expect(await screen.findByText('Ingresso alle 08:45')).toBeTruthy()
  })

  it('la forma HH:MM del seed e dello storico', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '08:45' })
    expect(await screen.findByText('Ingresso alle 08:45')).toBeTruthy()
  })

  it('la forma ISO naïve della primaria: le cifre sono già italiane', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '2026-09-04T09:40:00' })
    expect(await screen.findByText('Ingresso alle 09:40')).toBeTruthy()
  })

  it('ritardo senza orario: la frase del ritardo, non una vuota', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: null })
    // «Entrato in ritardo» è ANCHE il titolo dello stato: si prende il sottotitolo (<p>).
    expect(await screen.findByText('Entrato in ritardo', { selector: 'p' })).toBeTruthy()
    expect(screen.queryByText(/Ingresso alle/)).toBeNull()
  })
})

/**
 * A1 — Il genitore NON vede l'ora del «presente».
 *
 * Nido e infanzia salvano l'ora del tocco sull'appello (resta per docenti e
 * segreteria), ma per il genitore «presente» basta: l'ora compare solo sul ritardo,
 * dove è quella registrata o corretta dal docente. Si aspetta la PRESENZA della frase
 * neutra, poi si guarda che l'ora non ci sia — mai un `waitFor` su un'assenza.
 */
describe('PresenzeTodayCard — il presente non porta l\'ora (A1)', () => {
  it('presente con l\'ora del tocco salvata: «Presente oggi», e nessuna ora a schermo', async () => {
    montaCon({ stato: 'presente', orario_entrata: '2026-09-07T10:35:04.428Z' })
    expect(await screen.findByText('Presente oggi')).toBeTruthy()
    expect(screen.queryByText(/Ingresso alle/)).toBeNull()
    expect(screen.queryByText(/12:35/)).toBeNull()
  })

  it('presente con l\'ora in forma HH:MM: stessa cosa', async () => {
    montaCon({ stato: 'presente', orario_entrata: '08:45' })
    expect(await screen.findByText('Presente oggi')).toBeTruthy()
    expect(screen.queryByText(/08:45/)).toBeNull()
  })

  it('presente senza orario: la frase neutra, come prima', async () => {
    montaCon({ stato: 'presente', orario_entrata: null })
    expect(await screen.findByText('Presente oggi')).toBeTruthy()
    expect(screen.queryByText(/Ingresso alle/)).toBeNull()
  })

  it('uscita anticipata: l\'ora d\'INGRESSO non compare, quella d\'uscita sì', async () => {
    montaCon({
      stato: 'uscita_anticipata',
      orario_entrata: '2026-09-07T06:10:00Z',
      orario_uscita: '2026-09-07T11:06:57.549Z',
    })
    expect(await screen.findByText('Uscita alle 13:06')).toBeTruthy()
    expect(screen.queryByText(/Ingresso alle/)).toBeNull()
    expect(screen.queryByText(/08:10/)).toBeNull()
  })
})

/**
 * Regola 6 di AGENTS.md: il riquadro che ripiega su «non disponibili» lascia traccia del
 * perché — sia sull'eccezione di rete sia su una risposta regolare ma non `ok`.
 */
describe('PresenzeTodayCard — le presenze che non arrivano non sono un silenzio', () => {
  it('risposta 500: «non disponibili» a schermo e una riga di log con lo stato', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }))
    render(<PresenzeTodayCard studentId="alu-1" parentId="gen-1" />)
    expect(await screen.findByText('Presenze non disponibili al momento.')).toBeTruthy()
    expect(logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'warn', evento: 'fetch', stato: 500 }),
    )
  })

  it('rete assente: «non disponibili» a schermo e una riga di log col nome dell\'errore', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(<PresenzeTodayCard studentId="alu-1" parentId="gen-1" />)
    expect(await screen.findByText('Presenze non disponibili al momento.')).toBeTruthy()
    expect(logClient).toHaveBeenCalledTimes(1)
    expect(logClient.mock.calls[0][0].messaggio).toContain('TypeError')
  })
})
