import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import * as XLSX from 'xlsx'
import { SEDE_A, SEDE_B, NOME_SEDE_A, NOME_SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// W2-M — Export del Registro di Protocollo: un documento che non mente più.
//
// Difetto chiuso qui (rilievo R8 dell'audit 2026-07-31). `protocolli` è UNIQUE su
// `(scuola_id, anno, numero)`: la numerazione RIPARTE DA 1 in ogni sede. L'export
// filtrava correttamente `.in('scuola_id', sedi)` ma poi (1) intestava il PDF a
// `denominazioneScuola(sedi[0])` con ripiego al letterale `'Kidville'` e (2) non
// aveva nessuna colonna che dicesse a quale plesso appartenesse un numero. Un
// export su tre sedi produceva quindi un «Registro di protocollo <anno>»
// intestato a UNA sede sola e pieno di numeri DUPLICATI: un documento di
// rilevanza amministrativa (DPR 445) che risulta falso.
//
// Terzo difetto: la riga di audit GDPR era attribuita a `sedi[0]` anche quando
// l'export copriva tre plessi — la colonna `scuolaId` diceva il falso.
// =============================================================================

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ANNO = 2026

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  pdfTesti: [] as string[],
  pdfTabella: null as { head?: unknown[][]; body?: unknown[][] } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture }),
  }
})
// jsPDF non gira volentieri in ambiente di test e non è ciò che si sta provando:
// qui interessa COSA finisce sul documento (intestazione e righe), non come è
// disegnato. Si cattura il testo e le opzioni della tabella.
vi.mock('jspdf', () => ({
  jsPDF: class {
    setFillColor() {}
    rect() {}
    setTextColor() {}
    setFont() {}
    setFontSize() {}
    text(t: string) {
      h.pdfTesti.push(String(t))
    }
    output() {
      return new ArrayBuffer(8)
    }
  },
}))
vi.mock('jspdf-autotable', () => ({
  default: (_doc: unknown, opts: { head?: unknown[][]; body?: unknown[][] }) => {
    h.pdfTabella = opts
  },
}))

import { GET } from '@/app/api/admin/protocolli/export/route'

const protocollo = (scuolaId: string, numero: number, oggetto: string) => ({
  scuola_id: scuolaId,
  anno: ANNO,
  numero,
  tipo: 'ingresso',
  data_registrazione: `${ANNO}-03-0${numero}T09:30:00`,
  oggetto,
  mittente: 'Comune',
  destinatario: null,
  mezzo: 'pec',
  rif_prot_mittente: null,
  rif_data_mittente: null,
  impronta_sha256: 'a'.repeat(64),
  allegati_descrizione: null,
  emergenza: false,
  annullata_at: null,
  annullo_motivo: null,
  categoria: { nome: 'Enti e istituzioni' },
})

const dbBase = (): DBFinto => ({
  utenti_scuole: [
    { utente_id: ID_ADMIN, scuola_id: SEDE_A },
    { utente_id: ID_ADMIN, scuola_id: SEDE_B },
  ],
  schools: [
    { id: SEDE_A, nome: NOME_SEDE_A },
    { id: SEDE_B, nome: NOME_SEDE_B },
  ],
  // Stesso NUMERO in due sedi: è il caso che rendeva falso il documento.
  protocolli: [
    protocollo(SEDE_B, 1, 'ASL — sopralluogo Beta'),
    protocollo(SEDE_A, 1, 'Comune — contributo Alfa'),
    protocollo(SEDE_A, 2, 'USR — circolare Alfa'),
  ],
  audit_scritture_docente: [],
})

function getReq(qs = '', cookie?: string): NextRequest {
  return {
    url: `http://localhost/api/admin/protocolli/export${qs ? `?${qs}` : ''}`,
    method: 'GET',
    headers: new Headers(),
    cookies: {
      get: (nome: string) =>
        nome === 'sedi_attive' && cookie !== undefined ? { name: nome, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

async function fogli(res: Response): Promise<Record<string, unknown>[]> {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()))
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]])
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.pdfTesti = []
  h.pdfTabella = null
  h.requireStaff.mockResolvedValue({
    user: { id: ID_ADMIN, role: 'admin', scuola_id: SEDE_A },
  })
})

describe('GET /api/admin/protocolli/export — XLSX su più sedi', () => {
  it('ogni riga dice la SUA sede: i due «n. 1» non sono più indistinguibili', async () => {
    const res = await GET(getReq(`formato=xlsx&anno=${ANNO}`))

    expect(res.status).toBe(200)
    const righe = await fogli(res)
    expect(righe).toHaveLength(3)
    // La segnatura è la stessa in due sedi diverse: senza la colonna «Sede» il
    // registro conteneva due «0000001/2026» indistinguibili.
    expect(righe.map((r) => [r.Sede, r.Numero])).toEqual([
      [NOME_SEDE_A, `0000001/${ANNO}`],
      [NOME_SEDE_A, `0000002/${ANNO}`],
      [NOME_SEDE_B, `0000001/${ANNO}`],
    ])
  })

  it('con UNA sola sede selezionata escono solo le sue righe, con la sua etichetta', async () => {
    const res = await GET(getReq(`formato=xlsx&anno=${ANNO}`, SEDE_B))

    expect(res.status).toBe(200)
    const righe = await fogli(res)
    expect(righe.map((r) => r.Oggetto)).toEqual(['ASL — sopralluogo Beta'])
    expect(righe[0].Sede).toBe(NOME_SEDE_B)
  })
})

describe('GET /api/admin/protocolli/export — PDF: intestazione e colonna Sede', () => {
  it('l\'intestazione elenca TUTTE le sedi esportate, non solo la prima', async () => {
    const res = await GET(getReq(`formato=pdf&anno=${ANNO}`))

    expect(res.status).toBe(200)
    const intestazione = h.pdfTesti[0]
    expect(intestazione).toContain(NOME_SEDE_A.toUpperCase())
    expect(intestazione).toContain(NOME_SEDE_B.toUpperCase())
  })

  it('la tabella ha la colonna «Sede» e la riporta su ogni riga', async () => {
    const res = await GET(getReq(`formato=pdf&anno=${ANNO}`))

    expect(res.status).toBe(200)
    expect(h.pdfTabella?.head?.[0]).toContain('Sede')
    const colonna = (h.pdfTabella?.head?.[0] as string[]).indexOf('Sede')
    expect((h.pdfTabella?.body ?? []).map((r) => (r as string[])[colonna])).toEqual([
      NOME_SEDE_A,
      NOME_SEDE_A,
      NOME_SEDE_B,
    ])
  })

  it('con una sola sede l\'intestazione è il suo nome (nessun letterale «Kidville»)', async () => {
    const res = await GET(getReq(`formato=pdf&anno=${ANNO}`, SEDE_A))

    expect(res.status).toBe(200)
    expect(h.pdfTesti[0]).toBe(NOME_SEDE_A.toUpperCase())
  })
})

describe('GET /api/admin/protocolli/export — audit GDPR', () => {
  it('una riga di audit PER SEDE esportata, mai tutte attribuite alla prima', async () => {
    const res = await GET(getReq(`formato=xlsx&anno=${ANNO}`))

    expect(res.status).toBe(200)
    const audit = scrittureSu('audit_scritture_docente')
    expect(audit).toHaveLength(2)
    expect(audit.map((s) => (s.valori[0] as { scuola_id: string }).scuola_id).sort()).toEqual(
      [SEDE_A, SEDE_B].sort()
    )
    expect(audit[0].valori[0]).toMatchObject({ entita_tipo: 'export_protocolli', azione: 'insert' })
  })
})

describe('GET /api/admin/protocolli/export — perimetro vuoto', () => {
  it('nessuna sede in perimetro ⇒ 403, nessun file e nessun audit', async () => {
    const res = await GET(getReq(`formato=xlsx&anno=${ANNO}`, 'ffffffff-0000-4000-8000-00000000000f'))

    expect(res.status).toBe(403)
    expect(scrittureSu('audit_scritture_docente')).toEqual([])
    expect(h.tabelle).not.toContain('protocolli')
  })
})
