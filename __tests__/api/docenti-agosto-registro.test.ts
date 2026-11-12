import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * PR 4.9, giro 1-bis: dal giorno dopo l'`ultimo_giorno_aperto` l'anno passa a `in_chiusura` e la maestra
 * (`educator`) deve restare in SOLA LETTURA sulle sue classi; la segreteria scrive sempre. Le route di
 * scrittura del registro che si fermavano al gate di LETTURA (`assertAlunnoInScope`) lasciavano scrivere la
 * maestra: a guardia DB spenta (la produzione) nessun altro la ferma.
 *
 * Il gate è quello VERO (`assertAlunnoScrivibile`): cambia solo l'esito della funzione SQL
 * `sezioni_visibili_docente` (`sola_lettura`), come in `primaria-scrutinio-sezione-sola-lettura.test.ts`.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const DOCENTE = '33333333-3333-4333-8333-333333333333'
const SEGRETERIA = '44444444-4444-4444-8444-444444444444'
const SEZIONE = '55555555-5555-4555-8555-555555555551'
const ALUNNO = 'c0000000-0000-4000-8000-000000000003'
const CERTIFICATO = 'e0000000-0000-4000-8000-000000000005'

const h = vi.hoisted(() => ({
  db: {} as unknown,
  solaLettura: true,
  requireDocente: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  const finto = () =>
    crea(h.db as DBFinto, [], {
      rpc: {
        sezioni_visibili_docente: () => ({
          data: [{ section_id: '55555555-5555-4555-8555-555555555551', sola_lettura: h.solaLettura }],
          error: null,
        }),
      } as never,
    })
  return {
    createAdminClient: async () => finto(),
    createClient: async () => finto(),
  }
})
vi.mock('@/lib/auth/require-staff', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireDocente: h.requireDocente,
}))

import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import * as attendance from '@/app/api/attendance/daily/route'
import * as diary from '@/app/api/diary/route'
import * as diaryEntries from '@/app/api/diary/entries/route'
import * as notes from '@/app/api/notes/route'
import * as medicalCertificates from '@/app/api/teacher/medical-certificates/route'

const OGGI = oggiFiscaleISO()

function utente(role: 'educator' | 'segreteria') {
  return role === 'educator'
    ? { id: DOCENTE, role, scuola_id: SEDE, scuole_ids: [SEDE] }
    : { id: SEGRETERIA, role, scuola_id: SEDE, scuole_ids: [SEDE] }
}

function imposta(role: 'educator' | 'segreteria', solaLettura: boolean) {
  h.solaLettura = solaLettura
  h.requireDocente.mockResolvedValue({ user: utente(role) })
}

const json = (url: string, method: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const senzaCorpo = (url: string, method: string) => new NextRequest(`http://localhost${url}`, { method })

beforeEach(() => {
  h.db = {
    utenti: [
      { id: DOCENTE, scuola_id: SEDE, scuole_ids: [SEDE], role: 'educator' },
      { id: SEGRETERIA, scuola_id: SEDE, scuole_ids: [SEDE], role: 'segreteria' },
    ],
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: SEZIONE }],
    sections: [{ id: SEZIONE, name: 'Girasoli', school_type: 'infanzia', scuola_id: SEDE }],
    alunni: [{ id: ALUNNO, nome: 'Prova', cognome: 'Test', section_id: SEZIONE, scuola_id: SEDE, classe_sezione: 'Girasoli' }],
    presenze: [{ id: 'f0000000-0000-4000-8000-000000000006', alunno_id: ALUNNO, data: OGGI, stato: 'presente', scuola_id: SEDE, registrato_da: DOCENTE }],
    eventi_diario: [],
    daily_routines: [],
    note_disciplinari: [],
    certificati_medici: [{ id: CERTIFICATO, alunno_id: ALUNNO, stato: 'in_attesa' }],
    anni_scolastici: [],
    parents: [],
    parent_alunni: [],
  }
})

type Chiamata = () => Promise<Response>

/** Un caso per ogni handler di scrittura della route: la maestra con la classe in chiusura è fermata. */
function provaRoute(nome: string, chiamate: Record<string, Chiamata>) {
  describe(nome, () => {
    for (const [handler, chiama] of Object.entries(chiamate)) {
      it(`${handler}: educator con classe in chiusura → 403 SEZIONE_IN_CHIUSURA / SEZIONE_SOLA_LETTURA`, async () => {
        imposta('educator', true)
        const res = await chiama()
        expect(res.status).toBe(403)
        expect((await res.json()).codice).toMatch(/^SEZIONE_(IN_CHIUSURA|SOLA_LETTURA)$/)
      })
      it(`${handler}: segreteria passa (il gate non la ferma)`, async () => {
        imposta('segreteria', true)
        const res = await chiama()
        const corpo = await res.clone().json().catch(() => ({}))
        expect(corpo.codice ?? '').not.toMatch(/^SEZIONE_(IN_CHIUSURA|SOLA_LETTURA)$/)
        expect(res.status).toBeLessThan(400)
      })
      it(`${handler}: educator con classe corrente passa (il gate non la ferma)`, async () => {
        imposta('educator', false)
        const res = await chiama()
        const corpo = await res.clone().json().catch(() => ({}))
        expect(corpo.codice ?? '').not.toMatch(/^SEZIONE_(IN_CHIUSURA|SOLA_LETTURA)$/)
        expect(res.status).toBeLessThan(400)
      })
    }
  })
}

provaRoute('attendance/daily', {
  POST: () => attendance.POST(json('/api/attendance/daily', 'POST', { alunno_id: ALUNNO, data: OGGI, stato: 'presente' })),
  PATCH: () => attendance.PATCH(json('/api/attendance/daily', 'PATCH', { alunno_id: ALUNNO, data: OGGI, orario_entrata: '08:30' })),
  DELETE: () => attendance.DELETE(senzaCorpo(`/api/attendance/daily?alunno_id=${ALUNNO}&data=${OGGI}`, 'DELETE')),
})

provaRoute('diary', {
  POST: () => diary.POST(json('/api/diary', 'POST', { alunno_id: ALUNNO, classe_id: SEZIONE, tipo_evento: 'pranzo' })),
})

provaRoute('diary/entries', {
  POST: () => diaryEntries.POST(json('/api/diary/entries', 'POST', { alunno_id: ALUNNO, tipo_evento: 'pranzo', dettagli: { valore: 'tutto' } })),
  DELETE: () => diaryEntries.DELETE(senzaCorpo(`/api/diary/entries?alunno_id=${ALUNNO}&tipo_evento=pranzo`, 'DELETE')),
})

provaRoute('notes', {
  POST: () => notes.POST(json('/api/notes', 'POST', { alunnoIds: [ALUNNO], categoria: 'comportamento', testo: 'Nota di prova' })),
})

provaRoute('teacher/medical-certificates', {
  PATCH: () => medicalCertificates.PATCH(json('/api/teacher/medical-certificates', 'PATCH', { id: CERTIFICATO, esito: 'validato' })),
})
