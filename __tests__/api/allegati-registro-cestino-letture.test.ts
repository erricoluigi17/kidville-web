// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Riga } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'
import { allegatiRegistroViviDalJoin } from '@/lib/primaria/cestino-allegati-registro'

// =============================================================================
// R2 — LE LETTURE ANNIDATE degli allegati del registro escludono il CESTINO.
//
// Tre route leggono gli allegati DENTRO la lezione (`registro_orario.select('…,
// allegati_registro(…)')`): il registro del docente, i compiti della classe e le
// lezioni del genitore. Prima di R2 un allegato eliminato (o sostituito, o rimasto
// senza lezione) usciva in tutte e tre — nelle ultime due con un link FIRMATO al
// file. Qui ogni lezione porta un allegato vivo e uno nel cestino, e si guarda che
// cosa esce e che cosa si chiede di firmare allo Storage.
//
// Il fixture non costruisce i join: gli allegati annidati li mette il test, come
// PostgREST li restituirebbe con `eliminato_il` fra le colonne dell'embed.
// =============================================================================

const SEZ = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const DOCENTE = '99999999-1111-4111-8111-aaaaaaaaaaaa'
const ALUNNO = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const LEZ = '22222222-0000-4000-8000-000000000001'
const VIVO = '66666666-0000-4000-8000-000000000001'
const CESTINATO = '66666666-0000-4000-8000-000000000002'
const P_VIVO = `registro/${LEZ}/1757000000000-vivo.pdf`
const P_CESTINATO = `registro/${LEZ}/1757000000001-cestino.pdf`

const OGGI = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })

const h = vi.hoisted(() => ({
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  firmati: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', async (originale) => ({
  ...(await originale<Record<string, unknown>>()),
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/auth/require-parent', () => ({
  requireParentOfStudent: (...a: unknown[]) => h.requireParentOfStudent(...a),
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () => {
    const client = creaFintoSupabase(h.db, h.tabelle) as unknown as { storage: unknown }
    client.storage = {
      from: (bucket: string) => ({
        createSignedUrls: async (percorsi: string[]) => {
          h.firmati.push(...percorsi)
          return {
            data: percorsi.map((p) => ({ path: p, signedUrl: `https://finto/${bucket}/${p}?t=1`, error: null })),
            error: null,
          }
        },
      }),
    }
    return client
  }
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { GET as GET_REGISTRO } from '@/app/api/primaria/registro/route'
import { GET as GET_COMPITI } from '@/app/api/primaria/compiti/route'
import { GET as GET_GENITORE } from '@/app/api/parent/primaria/route'

const allegatiAnnidati = (): Riga[] => [
  { id: VIVO, ambito: 'compiti', tipo: 'pdf', file_url: P_VIVO, file_name: 'vivo.pdf', eliminato_il: null },
  {
    id: CESTINATO, ambito: 'compiti', tipo: 'pdf', file_url: P_CESTINATO, file_name: 'eliminato.pdf',
    eliminato_il: new Date(Date.now() - 3_600_000).toISOString(),
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.tabelle.length = 0
  h.firmati.length = 0
  h.requireDocente.mockResolvedValue({ user: { id: DOCENTE, role: 'educator', scuola_id: SEDE_A }, response: null })
  h.requireParentOfStudent.mockResolvedValue({ user: { id: 'gen-1', role: 'genitore' }, response: null })
  h.db = {
    sections: [{ id: SEZ, name: '1A', scuola_id: SEDE_A, school_type: 'primaria' }],
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: SEZ }],
    utenti_scuole: [],
    utenti: [],
    alunni: [{ id: ALUNNO, nome: 'Alfa', cognome: 'Beta', section_id: SEZ, scuola_id: SEDE_A }],
    admin_settings: [],
    campanelle: [],
    orario_settimanale: [],
    materie: [],
    presenze: [],
    valutazioni: [],
    note_disciplinari: [],
    registro_orario: [
      {
        id: LEZ, scuola_id: SEDE_A, section_id: SEZ, data: OGGI, ora_lezione: 2,
        materia: null, materia_id: null, argomento: 'Le frazioni', compiti: 'Esercizi 3 e 4',
        data_consegna_compiti: null, locked_il: null,
        materie: { nome: 'Matematica' },
        firme_docenti: [],
        registro_destinatari: [],
        allegati_registro: allegatiAnnidati(),
      },
    ],
  } as Record<string, Riga[]>
})

describe('le letture annidate di allegati_registro escludono il cestino', () => {
  it('il registro del docente (primaria/registro:GET) non mostra l’allegato eliminato', async () => {
    const res = await GET_REGISTRO(
      new NextRequest(`http://localhost/api/primaria/registro?sectionId=${SEZ}&data=${OGGI}`),
    )
    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo.righeLette).toBe(true)
    const allegati = corpo.data.righe[0].allegati_registro as Array<{ id: string }>
    expect(allegati.map((a) => a.id)).toEqual([VIVO])
  })

  it('i compiti della classe (primaria/compiti:GET): fuori, e MAI firmato', async () => {
    const res = await GET_COMPITI(new NextRequest(`http://localhost/api/primaria/compiti?sectionId=${SEZ}`))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    const allegati = (corpo.data?.compiti ?? corpo.compiti)[0].allegati as Array<{ id: string }>
    expect(allegati.map((a) => a.id)).toEqual([VIVO])
    expect(h.firmati).toEqual([P_VIVO])
  })

  it('le lezioni del genitore (parent/primaria:GET): fuori, e MAI firmato', async () => {
    const res = await GET_GENITORE(new NextRequest(`http://localhost/api/parent/primaria?studentId=${ALUNNO}`))
    expect(res.status).toBe(200)
    const corpo = await res.json()
    const allegati = corpo.data.lezioni[0].allegati as Array<{ id: string }>
    expect(allegati.map((a) => a.id)).toEqual([VIVO])
    expect(h.firmati).toEqual([P_VIVO])
    expect(JSON.stringify(corpo)).not.toContain(CESTINATO)
  })
})

describe('allegatiRegistroViviDalJoin', () => {
  it('tiene i vivi (null o chiave assente) e scarta il cestino; null/undefined → []', () => {
    expect(
      allegatiRegistroViviDalJoin([
        { id: 'a', eliminato_il: null },
        { id: 'b' },
        { id: 'c', eliminato_il: '2026-09-20T08:00:00.000Z' },
      ]).map((a) => a.id),
    ).toEqual(['a', 'b'])
    expect(allegatiRegistroViviDalJoin(null)).toEqual([])
    expect(allegatiRegistroViviDalJoin(undefined)).toEqual([])
  })
})
