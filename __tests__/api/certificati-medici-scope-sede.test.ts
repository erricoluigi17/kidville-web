import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// Certificati medici — dato sanitario (art. 9 GDPR) di un MINORE. Due route lo
// servivano autorizzando il solo RUOLO:
//
//  · parent/medical-certificates/file:GET — `isStaff` saltava ogni verifica:
//    chi era `educator` di qualunque plesso scaricava il PDF del certificato di
//    un bambino di un'altra sede, bastandogli l'id del certificato.
//  · teacher/medical-certificates:GET — il gate `assertClasseNomeInScope` c'era,
//    ma scattava solo con `?class_name=` e non filtrava le righe: senza
//    parametro tornavano i certificati di TUTTE le sedi (periodo di malattia,
//    note cliniche libere, `file_path`); con `?class_name=2 ANNI` entravano
//    anche gli omonimi dell'altro plesso.
//
// È il caso di scuola descritto nel commento di `assertClasseNomeInScope`:
// gate e filtro sono due presidi diversi e servono entrambi.
// =============================================================================

const SEDE_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const SEDE_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const ALU_A = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = 'b2b2b2b2-2222-4222-8222-bbbbbbbbbbbb'
const CERT_A = 'c1c1c1c1-1111-4111-8111-cccccccccccc'
const CERT_B = 'c2c2c2c2-2222-4222-8222-dddddddddddd'
const OMONIMA = '2 ANNI'
const SOLO_B = 'SOLO SEDE B'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireDocente: vi.fn(),
  genitoreHasFiglio: vi.fn(),
  scaricati: [] as string[],
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: h.requireUser,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/anagrafiche/legami', () => ({ genitoreHasFiglio: h.genitoreHasFiglio }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // Il finto client non ha `storage`: qui si aggiunge un download che REGISTRA
  // ciò che è stato scaricato. Serve alla prova più importante — che dopo un 403
  // il file sanitario non sia mai stato toccato.
  const conStorage = () => {
    const base = creaFintoSupabase(h.db, h.tabelle) as unknown as Record<string, unknown>
    base.storage = {
      from: () => ({
        download: async (path: string) => {
          h.scaricati.push(path)
          return { data: { arrayBuffer: async () => new ArrayBuffer(4) }, error: null }
        },
      }),
    }
    return base
  }
  return { createAdminClient: async () => conStorage(), createClient: async () => conStorage() }
})

import { GET as GET_FILE } from '@/app/api/parent/medical-certificates/file/route'
import { GET as GET_ELENCO } from '@/app/api/teacher/medical-certificates/route'

const reqFile = (id: string) =>
  new NextRequest(`http://localhost/api/parent/medical-certificates/file?id=${id}`)

const dbBase = (): DBFinto => ({
  sections: [
    { id: 'sec-a', scuola_id: SEDE_A, name: OMONIMA },
    { id: 'sec-b', scuola_id: SEDE_B, name: OMONIMA },
    { id: 'sec-b2', scuola_id: SEDE_B, name: SOLO_B },
  ],
  utenti_scuole: [],
  utenti_sezioni: [{ utente_id: 'ed1', section_id: 'sec-a' }],
  alunni: [
    { id: ALU_A, nome: 'Alfa', cognome: 'Sede-A', classe_sezione: OMONIMA, section_id: 'sec-a', scuola_id: SEDE_A },
    { id: ALU_B, nome: 'Beta', cognome: 'Sede-B', classe_sezione: OMONIMA, section_id: 'sec-b', scuola_id: SEDE_B },
  ],
  certificati_medici: [
    {
      id: CERT_A, alunno_id: ALU_A, file_path: 'certificati/sede-a.pdf', stato: 'in_validazione',
      note: 'DIAGNOSI-A', data_inizio: '2026-07-01', data_fine: '2026-07-10',
      alunno: { nome: 'Alfa', cognome: 'Sede-A', classe_sezione: OMONIMA, scuola_id: SEDE_A },
    },
    {
      id: CERT_B, alunno_id: ALU_B, file_path: 'certificati/sede-b.pdf', stato: 'in_validazione',
      note: 'DIAGNOSI-B', data_inizio: '2026-07-01', data_fine: '2026-07-10',
      alunno: { nome: 'Beta', cognome: 'Sede-B', classe_sezione: OMONIMA, scuola_id: SEDE_B },
    },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scaricati = []
  h.genitoreHasFiglio.mockResolvedValue(false)
})

describe('GET /api/parent/medical-certificates/file — il ruolo non basta', () => {
  it('educator della sede A: 403 sul certificato di un minore della sede B, e il PDF non viene scaricato', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET_FILE(reqFile(CERT_B))
    expect(res.status).toBe(403)
    expect(h.scaricati).toEqual([])
  })

  it('segreteria della sede A: 403 sul certificato della sede B', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'seg1', role: 'segreteria', scuola_id: SEDE_A } })
    const res = await GET_FILE(reqFile(CERT_B))
    expect(res.status).toBe(403)
    expect(h.scaricati).toEqual([])
  })

  it('educator della sede A: scarica il certificato di un alunno della propria sezione', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET_FILE(reqFile(CERT_A))
    expect(res.status).toBe(200)
    expect(h.scaricati).toEqual(['certificati/sede-a.pdf'])
  })

  it('genitore collegato: scarica (il percorso famiglia resta invariato)', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-b', role: 'genitore', scuola_id: SEDE_B } })
    h.genitoreHasFiglio.mockResolvedValue(true)
    const res = await GET_FILE(reqFile(CERT_B))
    expect(res.status).toBe(200)
    expect(h.scaricati).toEqual(['certificati/sede-b.pdf'])
  })

  it('genitore NON collegato: 403 e nessun download', async () => {
    h.requireUser.mockResolvedValue({ user: { id: 'gen-a', role: 'genitore', scuola_id: SEDE_A } })
    h.genitoreHasFiglio.mockResolvedValue(false)
    const res = await GET_FILE(reqFile(CERT_B))
    expect(res.status).toBe(403)
    expect(h.scaricati).toEqual([])
  })
})

describe('GET /api/teacher/medical-certificates — elenco isolato per sede', () => {
  it('SENZA class_name: solo i certificati della propria sede (era il caso peggiore)', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET_ELENCO(new NextRequest('http://localhost/api/teacher/medical-certificates'))
    expect(res.status).toBe(200)
    const corpo = await res.text()
    expect(corpo).toContain('DIAGNOSI-A')
    // Nota clinica, cognome e percorso del file dell'altra sede: tutti fuori.
    expect(corpo).not.toContain('DIAGNOSI-B')
    expect(corpo).not.toContain('Sede-B')
    expect(corpo).not.toContain('sede-b.pdf')
  })

  it('classi OMONIME: `?class_name=2 ANNI` non porta dentro gli omonimi dell\'altra sede', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET_ELENCO(
      new NextRequest(`http://localhost/api/teacher/medical-certificates?class_name=${encodeURIComponent(OMONIMA)}`),
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.map((r: { id: string }) => r.id)).toEqual([CERT_A])
    expect(JSON.stringify(j)).not.toContain('DIAGNOSI-B')
  })

  it('403 su una classe di un\'altra sede, senza leggere i certificati', async () => {
    h.requireDocente.mockResolvedValue({ user: { id: 'ed1', role: 'educator', scuola_id: SEDE_A } })
    const res = await GET_ELENCO(
      new NextRequest(`http://localhost/api/teacher/medical-certificates?class_name=${encodeURIComponent(SOLO_B)}`),
    )
    expect(res.status).toBe(403)
    expect(h.tabelle).not.toContain('certificati_medici')
  })

  it('utente senza alcun plesso: elenco vuoto, non elenco completo', async () => {
    // Il degrado deve NEGARE, non aprire: `resolveScuoleAttive` torna [] e
    // `.in('alunno.scuola_id', [])` non deve mai diventare «nessun filtro».
    h.requireDocente.mockResolvedValue({ user: { id: 'orfano', role: 'segreteria', scuola_id: null } })
    const res = await GET_ELENCO(new NextRequest('http://localhost/api/teacher/medical-certificates'))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toEqual([])
  })
})
