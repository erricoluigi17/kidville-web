import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// UNA CLASSE A UN BAMBINO «IN ARRIVO» — `PATCH /api/admin/students` (4.5.15, C2).
//
// Il bambino la cui domanda è per l'anno dopo non ha una classe di oggi: il vincolo
// `alunni_in_arrivo_senza_sezione` la vieta. Prima, chi gliene sceglieva una dalla
// scheda riceveva un 500 generico («violates check constraint …»). Ora:
//   · la route lo ferma prima, con un 422 e un codice che la scheda sa tradurre;
//   · se il vincolo scatta lo stesso (un'altra via), il 23514 diventa lo stesso 422.
// Salvare la scheda SENZA toccare la classe (la correzione di un dato) resta lecito.
// =============================================================================

const ADMIN = 'aaaa0000-0000-4000-8000-000000000001'
const ALU_ARRIVO = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ISCRITTO = '11111111-1111-4111-8111-aaaaaaaaaaab'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
  proiezioni: [] as Proiezione[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
  const finto = () =>
    creaFintoSupabaseConProiezione(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }, h.proiezioni)
  return { createAdminClient: async () => finto(), createClient: async () => finto() }
})

import { PATCH } from '@/app/api/admin/students/route'

const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/students', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function dbBase(): DBFinto {
  const alunni: Riga[] = [
    {
      id: ALU_ARRIVO, nome: 'Alfa', cognome: 'Arrivo', scuola_id: SEDE_A,
      section_id: null, classe_sezione: null, gruppo_mensa_id: null,
      stato: 'in_arrivo', archiviato_il: null, note_mediche: null, codice_fiscale: 'CF-ARRIVO',
    },
    {
      id: ALU_ISCRITTO, nome: 'Beta', cognome: 'Frequenta', scuola_id: SEDE_A,
      section_id: SEC_A, classe_sezione: '2 ANNI', gruppo_mensa_id: null,
      stato: 'iscritto', archiviato_il: null, note_mediche: null, codice_fiscale: 'CF-ISCRITTO',
    },
  ]
  return {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    scuole: [{ id: SEDE_A, attiva: true }],
    utenti_scuole: [{ utente_id: ADMIN, scuola_id: SEDE_A }],
    utenti_sezioni: [],
    sections: [{ id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' }],
    gruppi_mensa: [],
    alunni,
    parents: [],
    student_parents: [],
    legame_genitori_alunni: [],
    utenti: [],
    audit_scritture_docente: [],
  }
}

const riga = (id: string) => h.db.alunni.find((a) => a.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.proiezioni = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

describe('PATCH /api/admin/students — la classe a un bambino «in arrivo»', () => {
  it('assegnare una classe a un bambino in arrivo è un 422 con il suo codice, e non scrive niente', async () => {
    const res = await PATCH(patch({ id: ALU_ARRIVO, classe_sezione: '2 ANNI' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ codice: 'ALUNNO_IN_ARRIVO_SENZA_CLASSE' })
    expect(riga(ALU_ARRIVO)?.classe_sezione).toBeNull()
    expect(h.scritture.filter((s) => s.tabella === 'alunni')).toEqual([])
  })

  it('il vincolo del database che scatta lo stesso (23514) diventa lo stesso 422, non un 500', async () => {
    h.errori = {
      'alunni:update': { code: '23514', message: 'new row for relation "alunni" violates check constraint "alunni_in_arrivo_senza_sezione"' },
    }
    // Una correzione qualunque della scheda: la guardia sulla classe non c'entra, è il database a rifiutare.
    const res = await PATCH(patch({ id: ALU_ARRIVO, note_mediche: 'x' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ codice: 'ALUNNO_IN_ARRIVO_SENZA_CLASSE' })
  })

  it('correggere un altro dato della scheda in arrivo, senza toccare la classe, passa', async () => {
    const res = await PATCH(patch({ id: ALU_ARRIVO, nome: 'Alfa Maria' }))
    expect(res.status).toBe(200)
    expect(riga(ALU_ARRIVO)?.nome).toBe('Alfa Maria')
  })

  it('chi frequenta può cambiare classe come prima: la guardia riguarda solo chi è in arrivo', async () => {
    const res = await PATCH(patch({ id: ALU_ISCRITTO, classe_sezione: '2 ANNI' }))
    expect(res.status).not.toBe(422)
  })
})
