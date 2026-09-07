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
  it('la riga vera dello 0-6: 10:35Z diventa «Ingresso alle 12:35», non «2026-»', async () => {
    montaCon({ stato: 'presente', orario_entrata: '2026-09-07T10:35:04.428Z' })
    expect(await screen.findByText('Ingresso alle 12:35')).toBeTruthy()
  })

  it('e in nessun caso lo schermo mostra un pezzo di data', async () => {
    montaCon({ stato: 'presente', orario_entrata: '2026-09-07T10:35:04.428Z' })
    await waitFor(() => expect(screen.queryByText(/Ingresso alle/)).toBeTruthy())
    expect(screen.queryByText(/2026-/)).toBeNull()
  })

  it('d\'inverno la stessa ora UTC vale un\'ora in meno: l\'offset non è cablato', async () => {
    montaCon({ stato: 'presente', orario_entrata: '2026-01-15T10:35:00Z' })
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
    montaCon({ stato: 'presente', orario_entrata: '08:45:00' })
    expect(await screen.findByText('Ingresso alle 08:45')).toBeTruthy()
  })

  it('la forma HH:MM del seed e dello storico', async () => {
    montaCon({ stato: 'presente', orario_entrata: '08:45' })
    expect(await screen.findByText('Ingresso alle 08:45')).toBeTruthy()
  })

  it('la forma ISO naïve della primaria: le cifre sono già italiane', async () => {
    montaCon({ stato: 'presente', orario_entrata: '2026-09-04T09:40:00' })
    expect(await screen.findByText('Ingresso alle 09:40')).toBeTruthy()
  })

  it('senza orario si cade sulla frase neutra, non su una vuota', async () => {
    montaCon({ stato: 'presente', orario_entrata: null })
    expect(await screen.findByText('Presente oggi')).toBeTruthy()
    expect(screen.queryByText(/Ingresso alle/)).toBeNull()
  })
})
