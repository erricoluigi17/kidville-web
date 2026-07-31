import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W3-A — home docente: le chip sono SEZIONI, non stringhe.
//
// Difetto chiuso qui (R106 lato client). `/api/educator-sections` rispondeva una
// lista di nomi; la home ne disegnava una chip per elemento con `key={s}` e le
// confrontava per nome (`const on = s === activeSection`). Con tre sedi «2 ANNI»
// esiste due volte: due chip con la STESSA chiave React, che si accendevano
// insieme e non erano distinguibili in alcun modo. Da quelle chip partono le
// presenze del giorno e `diary/students`, che restituisce le NOTE MEDICHE dei
// bambini: cliccare la seconda «2 ANNI» dava lo stesso risultato della prima.
//
// Qui si verifica il giro completo: identità nella chip → identità nella query.
// =============================================================================

const OMONIMA = '2 ANNI'
const ID_DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'
const SEC_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEC_B = 'bbbb2222-0000-4000-8000-0000000000b2'

const h = vi.hoisted(() => ({
  sezioni: [] as Record<string, unknown>[],
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/teacher',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: ID_DOCENTE, role: 'educator', ready: true }),
}))

vi.mock('@/lib/auth/use-teacher-gradi', () => ({
  useTeacherGradi: () => ({
    gradi: ['infanzia'],
    hasInfanzia: true,
    hasPrimaria: false,
    isPrimariaOnly: false,
    diarioPrimariaVisibile: false,
    ready: true,
  }),
}))

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        React.forwardRef(function M(
          { children, ...props }: { children?: React.ReactNode },
          ref: React.Ref<HTMLElement>,
        ) {
          const {
            initial, animate, exit, variants, transition, whileHover, whileTap, layout, layoutId,
            ...rest
          } = props as Record<string, unknown>
          void initial; void animate; void exit; void variants; void transition
          void whileHover; void whileTap; void layout; void layoutId
          return React.createElement(tag, { ...rest, ref }, children)
        }),
    },
  )
  return { motion, AnimatePresence: ({ children }: { children?: React.ReactNode }) => children }
})

import TeacherDashboardPage from '@/app/(dashboard)/teacher/page'

const chiamate: string[] = []

const risposta = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response

function montaFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    chiamate.push(url)
    if (url.startsWith('/api/educator-sections')) {
      return risposta({
        sectionNames: [...new Set(h.sezioni.map((s) => s.name as string))],
        sections: h.sezioni,
        role: 'educator',
      })
    }
    if (url.startsWith('/api/primaria/me')) {
      return risposta({ success: true, data: { gradi: ['infanzia'], funzioni: {} } })
    }
    if (url.startsWith('/api/avvisi')) return risposta([])
    if (url.startsWith('/api/agenda')) return risposta({ success: true, data: [] })
    return risposta([])
  })
}

const chiamateA = (percorso: string) => chiamate.filter((u) => u.startsWith(percorso))

beforeEach(() => {
  chiamate.length = 0
  h.sezioni = [
    { id: SEC_A, name: OMONIMA, scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, school_type: 'nido' },
    { id: SEC_B, name: OMONIMA, scuolaId: SEDE_B, scuolaNome: NOME_SEDE_B, school_type: 'nido' },
  ]
  vi.stubGlobal('fetch', montaFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Home docente — chip di sezione con identità', () => {
  it('due sezioni omonime di sedi diverse ⇒ due chip distinguibili («nome — sede»)', async () => {
    render(<TeacherDashboardPage />)

    const chipA = await screen.findByRole('button', { name: `${OMONIMA} — ${NOME_SEDE_A}` })
    const chipB = await screen.findByRole('button', { name: `${OMONIMA} — ${NOME_SEDE_B}` })
    expect(chipA).not.toBe(chipB)
    expect(chipA).toHaveAttribute('aria-pressed', 'true')
    expect(chipB).toHaveAttribute('aria-pressed', 'false')
  })

  it('le due chip omonime si accendono UNA alla volta (prima si accendevano insieme)', async () => {
    render(<TeacherDashboardPage />)

    const chipA = await screen.findByRole('button', { name: `${OMONIMA} — ${NOME_SEDE_A}` })
    const chipB = await screen.findByRole('button', { name: `${OMONIMA} — ${NOME_SEDE_B}` })

    fireEvent.click(chipB)
    await waitFor(() => expect(chipB).toHaveAttribute('aria-pressed', 'true'))
    expect(chipA).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(chipA)
    await waitFor(() => expect(chipA).toHaveAttribute('aria-pressed', 'true'))
    expect(chipB).toHaveAttribute('aria-pressed', 'false')
  })

  it('cliccando la chip della seconda sede, presenze e diario cambiano SEDE', async () => {
    render(<TeacherDashboardPage />)

    // La prima chip è attiva di default: le letture partono sulla sua sede.
    await waitFor(() => {
      expect(chiamateA('/api/attendance/daily').some((u) => u.includes(`scuola_id=${SEDE_A}`))).toBe(true)
    })
    expect(chiamateA('/api/diary/students').some((u) => u.includes(`scuola_id=${SEDE_A}`))).toBe(true)
    expect(chiamateA('/api/attendance/daily').some((u) => u.includes(`scuola_id=${SEDE_B}`))).toBe(false)

    fireEvent.click(await screen.findByRole('button', { name: `${OMONIMA} — ${NOME_SEDE_B}` }))

    await waitFor(() => {
      expect(chiamateA('/api/attendance/daily').some((u) => u.includes(`scuola_id=${SEDE_B}`))).toBe(true)
    })
    expect(chiamateA('/api/diary/students').some((u) => u.includes(`scuola_id=${SEDE_B}`))).toBe(true)
    // Il nome viaggia ancora (le route lo usano come filtro), ma non è più solo.
    expect(chiamateA('/api/diary/students').every((u) => u.includes('sezione=2+ANNI') || u.includes('sezione=2%20ANNI'))).toBe(true)
  })

  it('una sola sede in elenco ⇒ etichetta senza suffisso di sede', async () => {
    h.sezioni = [
      { id: SEC_A, name: OMONIMA, scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, school_type: 'nido' },
      { id: 'aaaa3333-0000-4000-8000-0000000000a3', name: '3 ANNI A', scuolaId: SEDE_A, scuolaNome: NOME_SEDE_A, school_type: 'infanzia' },
    ]
    render(<TeacherDashboardPage />)

    expect(await screen.findByRole('button', { name: OMONIMA })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: `${OMONIMA} — ${NOME_SEDE_A}` })).toBeNull()
  })
})
