import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

import { SEDE_A, SEDE_B, SEDE_C, NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C } from '../fixtures/sedi'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  T6-B · IL GENITORE NON HA UNA SEDE, E NON DEVE AVERLA                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * La scheda del bambino ha un comando «Sposta di sede»; questa **non deve
 * averlo**, ed è una decisione di modello dati, non di interfaccia.
 *
 *  1. `parents` NON HA `scuola_id`, e non deve averlo. È esattamente ciò che
 *     permette a un genitore di avere figli in due plessi diversi — in
 *     produzione ce ne sono quattro. Una colonna di sede sul genitore
 *     costringerebbe a sceglierne uno dei due, e da lì in avanti metà della sua
 *     famiglia risulterebbe altrove.
 *
 *  2. ⚠️ `PATCH /api/admin/parents` VALIDA CON `z.object({id}).loose()`: accetta
 *     QUALUNQUE chiave e la passa all'`update`. Una `scuola_id` che partisse da
 *     questa scheda non verrebbe respinta — arriverebbe a PostgREST, che
 *     risponderebbe `PGRST204` sull'INTERO corpo, cioè **nessun salvataggio,
 *     mai**, per tutti i campi della scheda. È la stessa forma del difetto già
 *     pagato l'11 agosto con `student_parents` (vedi `corpoGenitoreDaSalvare`):
 *     lì il corpo si costruisce per ELENCO proprio perché nessuno lo protegge a
 *     valle. Questo file tiene chiusa la porta.
 *
 *  3. LE SEDI DEI FIGLI SI VEDONO LO STESSO. Toglierle sarebbe l'errore opposto:
 *     chi apre la scheda di un genitore con due figli in due plessi deve
 *     vederlo, altrimenti l'unica lettura possibile è «questa famiglia sta a
 *     Giugliano», che è falsa. È informazione in SOLA LETTURA, e il rimando
 *     dice dove si agisce: sulla scheda del BAMBINO.
 */

const logClientSpia = vi.fn()
vi.mock('@/lib/logging/client', () => ({
  logClient: (...a: unknown[]) => logClientSpia(...a),
  nomeErrore: () => 'Error',
}))

const ID_GENITORE = '00000000-0000-4000-8000-000000000001'

/** Un genitore con DUE figli in DUE plessi diversi: il caso che il modello dati protegge. */
const GENITORE_DUE_PLESSI = {
  id: ID_GENITORE,
  first_name: 'Prova',
  last_name: 'Esempio',
  gender: 'F',
  birth_date: '1985-03-07',
  birth_city: null,
  birth_province: null,
  birth_nation: null,
  fiscal_code: null,
  emails: ['prova@esempio.test'],
  phone_numbers: [],
  residence_address: null,
  residence_street_number: null,
  residence_city: null,
  residence_province: null,
  zip_code: null,
  student_parents: [
    {
      relation_type: 'mother',
      is_primary: true,
      alunni: { id: 'al-1', nome: 'Uno', cognome: 'Esempio', classe_sezione: 'LEONI', scuola_id: SEDE_B, student_parents: [] },
    },
    {
      relation_type: 'mother',
      is_primary: false,
      alunni: { id: 'al-2', nome: 'Due', cognome: 'Esempio', classe_sezione: 'GIRASOLI', scuola_id: SEDE_A, student_parents: [] },
    },
  ],
}

const TRE_SEDI = [
  { id: SEDE_A, nome: NOME_SEDE_A },
  { id: SEDE_B, nome: NOME_SEDE_B },
  { id: SEDE_C, nome: NOME_SEDE_C },
]

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(String(url), 'http://t.test')
    if (u.pathname === '/api/admin/sedi/destinazioni') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: TRE_SEDI, motivo: 'ok' }) })
    }
    if (u.pathname.startsWith('/api/admin/parents/')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => GENITORE_DUE_PLESSI })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => cleanup())

import { ParentDetailPanel, corpoGenitoreDaSalvare } from '@/components/features/admin/ParentDetailPanel'

describe('ParentDetailPanel — la sede è del bambino, non del genitore', () => {
  it('⚠️ il corpo del PATCH non porta MAI `scuola_id`, nemmeno se il form ne ha una', () => {
    // `.loose()` accetterebbe la chiave e PostgREST rifiuterebbe l'intero corpo:
    // la lista bianca in scrittura è l'unica difesa, e sta qui.
    const corpo = corpoGenitoreDaSalvare({
      first_name: 'Prova',
      last_name: 'Esempio',
      // Una chiave che `parents` non ha, arrivata da chissà dove.
      ...({ scuola_id: SEDE_A } as Record<string, unknown>),
    } as never)

    expect(Object.keys(corpo)).not.toContain('scuola_id')
    expect(corpo).not.toHaveProperty('scuola_id')
  })

  it('nessun selettore di sede e nessun comando di trasferimento sulla scheda del genitore', async () => {
    render(<ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} />)

    await screen.findByTestId('parent-sedi-figli')

    expect(document.querySelector('select[name="trasferimento_sede"]')).toBeNull()
    expect(screen.queryByTestId('trasferimento-sede')).toBeNull()
    expect(screen.queryByTestId('trasferimento-sede-comando')).toBeNull()
    // E nessun campo che scriva una sede sul genitore, con qualunque nome.
    expect(document.querySelector('[name="scuola_id"]')).toBeNull()
  })

  it('le sedi dei DUE figli si vedono, per nome, e sono due diverse', async () => {
    render(<ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} />)

    // Si asserisce dentro la riga del figlio, non su tutta la pagina: `getByText`
    // pesca i sosia, e un nome di sede che comparisse altrove renderebbe verde
    // un blocco che non esiste.
    const uno = await screen.findByTestId('parent-figlio-al-1')
    const due = await screen.findByTestId('parent-figlio-al-2')
    expect(uno.textContent).toContain(NOME_SEDE_B)
    expect(due.textContent).toContain(NOME_SEDE_A)
    expect(uno.textContent).not.toContain(NOME_SEDE_A)
  })

  it('spiega dove si agisce: sulla scheda del BAMBINO, non su questa', async () => {
    render(<ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} />)

    const nota = await screen.findByTestId('parent-sedi-figli-nota')
    expect(nota.textContent?.trim().length ?? 0).toBeGreaterThan(30)
  })

  it('sede non risolvibile: si dice, e NON si stampa un uuid a schermo', async () => {
    fetchMock.mockImplementation((url: string) => {
      const u = new URL(String(url), 'http://t.test')
      if (u.pathname === '/api/admin/sedi/destinazioni') {
        // Nessuna delle due sedi dei figli è fra quelle note a chi guarda.
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: [{ id: SEDE_C, nome: NOME_SEDE_C }], motivo: 'ok' }) })
      }
      if (u.pathname.startsWith('/api/admin/parents/')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => GENITORE_DUE_PLESSI })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} />)

    const uno = await screen.findByTestId('parent-figlio-al-1')
    await waitFor(() => expect(uno.textContent).not.toContain(SEDE_B))
    expect(document.body.textContent).not.toContain(SEDE_B)
  })
})
