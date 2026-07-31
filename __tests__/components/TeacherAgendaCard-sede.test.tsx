import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TeacherAgendaCard } from '@/components/features/teacher/TeacherAgendaCard'

// =============================================================================
// W3-A — l'agenda della home docente parla per IDENTITÀ di sezione.
//
// Difetto chiuso qui (R105, lato client). La card mandava solo il NOME della
// classe. Dal 2026-07-31 `sezionePerNomeInScope` (agenda/route.ts) è
// fail-closed: un nome che esiste in due sedi ⇒ 400 «Specificare la sede». Fino
// a ieri invece «ne prendeva una» — verificato in produzione: l'admin con il
// SedeSelector su Cesa cliccava la chip «2 ANNI» di Cesa e l'evento, con la sua
// notifica alle famiglie, veniva archiviato ad AVERSA.
//
// Con `section_id` la domanda non si pone più: la sezione è quella cliccata.
// =============================================================================

const SEC = 'aaaa1111-0000-4000-8000-0000000000a1'
const ID_DOCENTE = 'd0000000-0000-4000-8000-00000000ed00'

interface Chiamata { url: string; init?: RequestInit }
const chiamate: Chiamata[] = []

const h = vi.hoisted(() => ({
  esitoPost: { ok: true, status: 201, body: {} as unknown },
}))

const risposta = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as unknown as Response

beforeEach(() => {
  chiamate.length = 0
  h.esitoPost = { ok: true, status: 201, body: { success: true } }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      chiamate.push({ url, init })
      if (init?.method === 'POST') {
        return risposta(h.esitoPost.body, h.esitoPost.ok, h.esitoPost.status)
      }
      return risposta({ success: true, data: [] })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const corpoPost = (): Record<string, unknown> => {
  const post = chiamate.find((c) => c.init?.method === 'POST')
  return post ? (JSON.parse(String(post.init?.body)) as Record<string, unknown>) : {}
}

async function creaEvento(titolo = 'Uscita al parco') {
  fireEvent.change(screen.getByPlaceholderText(/titolo/i), { target: { value: titolo } })
  fireEvent.click(screen.getByRole('button', { name: /aggiungi/i }))
  await waitFor(() => expect(chiamate.some((c) => c.init?.method === 'POST')).toBe(true))
}

describe('TeacherAgendaCard — la sezione viaggia per id', () => {
  it('la lettura chiede `section_id`, non il nome', async () => {
    render(<TeacherAgendaCard sezione="2 ANNI" sectionId={SEC} userId={ID_DOCENTE} />)

    await waitFor(() => expect(chiamate.length).toBeGreaterThan(0))
    const get = chiamate.find((c) => c.init?.method !== 'POST')
    expect(get?.url).toContain(`section_id=${SEC}`)
  })

  it('la creazione manda `section_id`: la route non deve più indovinare la sede', async () => {
    render(<TeacherAgendaCard sezione="2 ANNI" sectionId={SEC} userId={ID_DOCENTE} />)
    await creaEvento()

    expect(corpoPost()).toMatchObject({ section_id: SEC, titolo: 'Uscita al parco' })
  })

  it('senza identità di sezione (contratto vecchio) resta il nome, e il server decide', async () => {
    render(<TeacherAgendaCard sezione="2 ANNI" sectionId={null} userId={ID_DOCENTE} />)
    await creaEvento()

    expect(corpoPost()).toMatchObject({ sezione: '2 ANNI' })
    expect(corpoPost().section_id).toBeUndefined()
  })

  it('400 dal server ⇒ il titolo NON si perde e il messaggio del server è visibile', async () => {
    h.esitoPost = {
      ok: false,
      status: 400,
      body: { error: 'Specificare la sede: più classi con questo nome (usare section_id)' },
    }
    render(<TeacherAgendaCard sezione="2 ANNI" sectionId={null} userId={ID_DOCENTE} />)
    await creaEvento('Riunione genitori')

    expect(await screen.findByText(/specificare la sede/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/titolo/i)).toHaveValue('Riunione genitori')
  })
})
