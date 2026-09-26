/**
 * A5 (2026-09-26) · la card «Oggi a scuola» dice quando il ritardo o l'uscita di
 * oggi sono GIUSTIFICATI dal docente (es. terapia), con la nota.
 *
 * I campi arrivano da `GET /api/parent/presenze` (contratto A2):
 * `oggi.assenza_oraria_giustificata` (sempre booleano) e `oggi.note_appello`.
 * Lo stato non cambia — il bambino non era in classe — quindi l'ora del ritardo o
 * dell'uscita resta dov'è (logica di A1, non toccata) e si AGGIUNGE la frase
 * «Ritardo giustificato: terapia» con «Queste ore non contano nelle assenze.».
 *
 * Catalogo vero, frase intera; si aspetta sempre una PRESENZA prima di guardare
 * un'assenza.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

import itHome from '../../messages/it/home.json'
import enHome from '../../messages/en/home.json'

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

vi.mock('@/lib/logging/client', () => ({
  logClient: vi.fn(),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'sconosciuto'),
}))

import { PresenzeTodayCard } from '@/components/features/parent/home/PresenzeTodayCard'

function montaCon(oggi: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          schoolType: 'primaria',
          oggi: {
            stato: null,
            orario_entrata: null,
            orario_uscita: null,
            assenza_oraria_giustificata: false,
            note_appello: null,
            ...oggi,
          },
          riepilogo: { presenze: 10, assenze: 0, ritardi: 1, uscite: 0 },
        },
      }),
    }),
  )
  render(<PresenzeTodayCard studentId="alu-1" parentId="gen-1" />)
}

const frase = (modello: string, nota: string) => modello.replace('{nota}', nota)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PresenzeTodayCard — ritardo/uscita giustificati (A5)', () => {
  it('ritardo giustificato: la nota, «non contano», e l’ora d’ingresso resta', async () => {
    montaCon({
      stato: 'ritardo',
      orario_entrata: '2026-09-26T10:05:00',
      assenza_oraria_giustificata: true,
      note_appello: 'terapia',
    })
    expect(await screen.findByText(frase(itHome.presenzeGiustificataRitardo, 'terapia'))).toBeTruthy()
    expect(screen.getByText(itHome.presenzeGiustificataNonConta)).toBeTruthy()
    expect(screen.getByText('Ingresso alle 10:05')).toBeTruthy()
  })

  it('uscita anticipata giustificata: la frase dell’uscita, non quella del ritardo', async () => {
    montaCon({
      stato: 'uscita_anticipata',
      orario_uscita: '2026-09-26T11:30:00',
      assenza_oraria_giustificata: true,
      note_appello: 'logopedia',
    })
    expect(await screen.findByText(frase(itHome.presenzeGiustificataUscita, 'logopedia'))).toBeTruthy()
    expect(screen.getByText(itHome.presenzeGiustificataNonConta)).toBeTruthy()
    expect(screen.getByText('Uscita alle 11:30')).toBeTruthy()
    expect(screen.queryByText(frase(itHome.presenzeGiustificataRitardo, 'logopedia'))).toBeNull()
  })

  it('flag acceso ma nota vuota: «Ritardo giustificato» senza due punti appesi', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '08:45', assenza_oraria_giustificata: true, note_appello: '  ' })
    expect(await screen.findByText(itHome.presenzeGiustificataRitardoSenzaNota)).toBeTruthy()
    expect(screen.getByText(itHome.presenzeGiustificataNonConta)).toBeTruthy()
  })

  it('uscita giustificata con nota vuota: «Uscita anticipata giustificata», non la frase del ritardo', async () => {
    montaCon({
      stato: 'uscita_anticipata',
      orario_uscita: '2026-09-26T11:30:00',
      assenza_oraria_giustificata: true,
      note_appello: '  ',
    })
    expect(await screen.findByText(itHome.presenzeGiustificataUscitaSenzaNota)).toBeTruthy()
    expect(screen.getByText(itHome.presenzeGiustificataNonConta)).toBeTruthy()
    expect(screen.getByText('Uscita alle 11:30')).toBeTruthy()
    expect(screen.queryByText(itHome.presenzeGiustificataRitardoSenzaNota)).toBeNull()
  })

  it('CONTROLLO: ritardo NON giustificato con nota → nessuna frase di giustificazione, e la nota non esce', async () => {
    montaCon({ stato: 'ritardo', orario_entrata: '08:45', assenza_oraria_giustificata: false, note_appello: 'traffico' })
    expect(await screen.findByText('Ingresso alle 08:45')).toBeTruthy()
    expect(screen.queryByText(itHome.presenzeGiustificataNonConta)).toBeNull()
    expect(screen.queryByText(/traffico/)).toBeNull()
  })

  it('flag vero su uno stato che non si giustifica (presente/assente): niente frase', async () => {
    montaCon({ stato: 'assente', assenza_oraria_giustificata: true, note_appello: 'febbre' })
    expect(await screen.findByText('Assente per oggi')).toBeTruthy()
    expect(screen.queryByText(itHome.presenzeGiustificataNonConta)).toBeNull()
    expect(screen.queryByText(/febbre/)).toBeNull()
    cleanup()
    vi.unstubAllGlobals()

    montaCon({ stato: 'presente', assenza_oraria_giustificata: true, note_appello: 'fisioterapia' })
    expect(await screen.findByText(itHome.presenzePresenteOggi)).toBeTruthy()
    expect(screen.queryByText(itHome.presenzeGiustificataNonConta)).toBeNull()
    expect(screen.queryByText(/fisioterapia/)).toBeNull()
  })

  it('server più vecchio senza i campi: la card resta com’era', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            schoolType: 'primaria',
            oggi: { stato: 'ritardo', orario_entrata: '08:45', orario_uscita: null },
            riepilogo: { presenze: 10, assenze: 0, ritardi: 1, uscite: 0 },
          },
        }),
      }),
    )
    render(<PresenzeTodayCard studentId="alu-1" parentId="gen-1" />)
    expect(await screen.findByText('Ingresso alle 08:45')).toBeTruthy()
    expect(screen.queryByText(itHome.presenzeGiustificataNonConta)).toBeNull()
  })
})

describe('PresenzeTodayCard — le frasi A5 esistono in entrambe le lingue', () => {
  it('it ed en, con la nota interpolata', () => {
    const chiavi = [
      'presenzeGiustificataRitardo',
      'presenzeGiustificataUscita',
      'presenzeGiustificataRitardoSenzaNota',
      'presenzeGiustificataUscitaSenzaNota',
      'presenzeGiustificataNonConta',
    ] as const
    for (const k of chiavi) {
      expect(typeof itHome[k], `it: ${k}`).toBe('string')
      expect(typeof enHome[k], `en: ${k}`).toBe('string')
    }
    expect(enHome.presenzeGiustificataRitardo).toContain('{nota}')
    expect(enHome.presenzeGiustificataUscita).toContain('{nota}')
  })
})
