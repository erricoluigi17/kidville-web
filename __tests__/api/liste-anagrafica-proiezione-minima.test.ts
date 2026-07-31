import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// W8 — Le LISTE d'anagrafica consegnavano il fascicolo, non l'elenco.
//
//  · `GET /api/admin/students` restituiva 43 campi per alunno, fra cui
//    `note_mediche` e `allergies` (dato sanitario), `is_bes_dsa` (art. 9 GDPR),
//    `documento_path`, `importo_retta_mensile`, `genitori_separati`,
//    `retta_split_config`, `intestatario_fatture` — più l'embed
//    `student_parents ( … parents (*) )` e `delegates (*)`, cioè l'anagrafica
//    COMPLETA di ogni adulto collegato (codice fiscale, tipo e numero del
//    documento d'identità, indirizzo, recapiti) per OGNI riga dell'elenco.
//  · `GET /api/admin/parents` restituiva `select('*')`: `fiscal_code`,
//    `document_number`, `documento_path`, residenza, `consensi_gdpr`.
//
// Il dettaglio esiste già e ha il suo gate di sede (`admin/students/[id]`,
// `admin/parents/[id]`): la lista deve portare quel che la lista MOSTRA.
//
// Le colonne tenute qui sotto non sono un'opinione: vengono dalla lettura dei
// componenti che consumano queste due route —
//   students → `StudentTable`/`StudentRowCard` (cognome, nome, sede, data di
//     nascita, classe, stato, indicatore allergie), la ricerca e l'export CSV
//     di `/admin/students` (codice fiscale), i filtri «frequentanti» di
//     `PaymentsDashboard`/`GeneratoreCategoria`/`FiscalePanel` e di
//     `students/sezioni/[id]` (`section_id`, `classe_sezione`);
//   parents  → la stessa tabella in modalità «adulti» (nome, cognome, email,
//     telefono, codice fiscale, sede) e `TransazioniPanel` (nome, cognome).
//
// LA NOTA MEDICA È UN CASO A SÉ. La lista non ne mostra il TESTO: accende un
// indicatore «Allergie». La route continua quindi a leggerla, ma restituisce
// solo il booleano `ha_note_mediche`; il testo resta dietro la scheda alunno.
//
// ⚠️ METODO. `finto-supabase` non emula la proiezione (righe intere): qui si usa
// `creaFintoSupabaseConProiezione`, che proietta come PostgREST. Senza,
// «il numero del documento non esce» sarebbe verde anche col difetto.
// =============================================================================

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const PAR_A = '0a0a0a0a-1111-4111-8111-aaaaaaaaaaaa'
const PAR_B = '0b0b0b0b-2222-4222-8222-bbbbbbbbbbbb'
const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const ADMIN = 'adm-1'

// Sentinelle: nessun dato reale, ma ognuna al posto di un dato reale.
const NOTA_MEDICA = 'NOTA-MEDICA-SENTINELLA'
const ALLERGIA = 'ALLERGIA-SENTINELLA'
const DOC_MINORE = 'documenti/minore-sentinella.pdf'
const DOC_ADULTO_NUM = 'DOCUMENTO-ADULTO-SENTINELLA'
const DOC_ADULTO_PATH = 'documenti/adulto-sentinella.pdf'
const INDIRIZZO_ADULTO = 'VIA-SENTINELLA-ADULTO'
const RETTA = 987.65

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  proiezioni: [] as { tabella: string; colonne: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
  const crea = () =>
    creaFintoSupabaseConProiezione(h.db, h.tabelle, {}, h.proiezioni as Proiezione[])
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { GET as STUDENTS } from '@/app/api/admin/students/route'
import { GET as PARENTS } from '@/app/api/admin/parents/route'

const req = (url: string) => new NextRequest(`http://localhost${url}`)

const dbBase = (): DBFinto => ({
  utenti_scuole: [{ utente_id: ADMIN, scuola_id: SEDE_A }],
  utenti_sezioni: [],
  sections: [{ id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' }],
  alunni: [
    {
      id: ALU_A,
      scuola_id: SEDE_A,
      nome: 'Alfa',
      cognome: 'AaaSedeA',
      data_nascita: '2022-03-01',
      codice_fiscale: 'CFALFA00A01H501Z',
      classe_sezione: '2 ANNI',
      section_id: SEC_A,
      stato: 'iscritto',
      // Tutto ciò che segue NON deve uscire da una LISTA.
      note_mediche: NOTA_MEDICA,
      allergies: ALLERGIA,
      allergeni: ['glutine'],
      is_bes_dsa: true,
      note_bes: 'NOTE-BES-SENTINELLA',
      documento_path: DOC_MINORE,
      importo_retta_mensile: RETTA,
      genitori_separati: true,
      retta_split_config: { quote: [{ importo: 100 }] },
      intestatario_fatture: { tipo: 'adult', adult_id: PAR_A },
      invoice_holder_details: { codice_fiscale: 'CFINTEST00A01H501Z' },
      residence_address: 'VIA-SENTINELLA-MINORE',
      zip_code: '80100',
      consenso_privacy: true,
      usa_pannolino: false,
      numero_domanda_sidi: 'SIDI-000',
      creato_il: '2026-01-01T00:00:00.000Z',
      // Embed che la lista si portava dietro riga per riga.
      student_parents: [{ relation_type: 'mother', is_primary: true, parents: { id: PAR_A, document_number: DOC_ADULTO_NUM } }],
      delegates: [{ id: 'del-1', document_number: DOC_ADULTO_NUM }],
    },
    {
      id: ALU_B,
      scuola_id: SEDE_B,
      nome: 'Beta',
      cognome: 'CccSedeB',
      data_nascita: '2021-05-05',
      classe_sezione: '2 ANNI',
      stato: 'iscritto',
      note_mediche: null,
    },
  ],
  student_parents: [
    { student_id: ALU_A, parent_id: PAR_A },
    { student_id: ALU_B, parent_id: PAR_B },
  ],
  parents: [
    {
      id: PAR_A,
      first_name: 'Anna',
      last_name: 'DiAlfa',
      emails: ['anna@example.invalid'],
      phone_numbers: ['0000000000'],
      fiscal_code: 'CFANNA00A41H501Z',
      // Fuori dalla lista.
      document_type: 'carta_identita',
      document_number: DOC_ADULTO_NUM,
      documento_path: DOC_ADULTO_PATH,
      residence_address: INDIRIZZO_ADULTO,
      residence_city: 'Città',
      zip_code: '80100',
      birth_date: '1990-01-01',
      birth_city: 'Città',
      citizenship: 'IT',
      consensi_gdpr: { marketing: false },
      auth_user_id: 'acc-anna',
      intestatario_default: true,
      onboarded_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      // Nodo annidato per il join `!inner` del ramo `?student_id=`: lo mette il
      // fixture, non la stringa di select (vedi `finto-supabase`).
      student_parents: [{ student_id: ALU_A }],
    },
    {
      id: PAR_B,
      first_name: 'Bruna',
      last_name: 'DiBeta',
      emails: ['bruna@example.invalid'],
      fiscal_code: 'CFBRUNA00A41H501Z',
      document_number: 'DOCUMENTO-SEDE-B',
      student_parents: [{ student_id: ALU_B }],
    },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.proiezioni = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'segreteria', scuola_id: SEDE_A } })
})

const colonneDi = (tabella: string) =>
  h.proiezioni.filter((p) => p.tabella === tabella).map((p) => p.colonne)

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/students
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/students — l\'elenco porta quel che l\'elenco mostra', () => {
  it('ogni riga ha ESATTAMENTE le chiavi che l\'interfaccia usa', async () => {
    const res = await STUDENTS(req('/api/admin/students?limit=1000'))
    expect(res.status).toBe(200)
    const righe = (await res.json()) as Record<string, unknown>[]
    expect(righe).toHaveLength(1)
    expect(Object.keys(righe[0]).sort()).toEqual(
      [
        'classe_sezione',
        'codice_fiscale',
        'cognome',
        'data_nascita',
        'ha_note_mediche',
        'id',
        'nome',
        'scuola_id',
        'section_id',
        'stato',
      ].sort(),
    )
  })

  it('niente dato sanitario, niente documento, niente dato economico nel corpo', async () => {
    const res = await STUDENTS(req('/api/admin/students?limit=1000'))
    const corpo = await res.text()
    expect(corpo).not.toContain(NOTA_MEDICA)
    expect(corpo).not.toContain(ALLERGIA)
    expect(corpo).not.toContain('NOTE-BES-SENTINELLA')
    expect(corpo).not.toContain(DOC_MINORE)
    expect(corpo).not.toContain(String(RETTA))
    expect(corpo).not.toContain('is_bes_dsa')
    expect(corpo).not.toContain('genitori_separati')
    expect(corpo).not.toContain('retta_split_config')
    expect(corpo).not.toContain('intestatario_fatture')
  })

  it('l\'anagrafica degli adulti collegati non viaggia più riga per riga', async () => {
    const res = await STUDENTS(req('/api/admin/students?limit=1000'))
    const corpo = await res.text()
    expect(corpo).not.toContain('student_parents')
    expect(corpo).not.toContain('delegates')
    expect(corpo).not.toContain(DOC_ADULTO_NUM)
  })

  it('l\'indicatore «Allergie» resta acceso: `ha_note_mediche` è booleano, non testo', async () => {
    const res = await STUDENTS(req('/api/admin/students?limit=1000'))
    const righe = (await res.json()) as { ha_note_mediche: unknown }[]
    expect(righe[0].ha_note_mediche).toBe(true)
  })

  it('senza nota medica l\'indicatore è `false` (non `null`, non assente)', async () => {
    ;(h.db.alunni[0] as Record<string, unknown>).note_mediche = null
    const res = await STUDENTS(req('/api/admin/students?limit=1000'))
    const righe = (await res.json()) as { ha_note_mediche: unknown }[]
    expect(righe[0].ha_note_mediche).toBe(false)
  })

  it('la query non chiede più le colonne del fascicolo', async () => {
    await STUDENTS(req('/api/admin/students?limit=1000'))
    const chieste = colonneDi('alunni').join(' | ')
    for (const colonna of [
      'allergies', 'allergeni', 'is_bes_dsa', 'documento_path', 'importo_retta_mensile',
      'genitori_separati', 'retta_split_config', 'intestatario_fatture', 'invoice_holder_details',
      'residence_address', 'zip_code', 'consenso_privacy', 'numero_domanda_sidi',
      'student_parents', 'delegates',
    ]) {
      expect(chieste).not.toContain(colonna)
    }
  })

  it('il filtro di sede resta: l\'alunno dell\'altro plesso non compare', async () => {
    const res = await STUDENTS(req('/api/admin/students?limit=1000'))
    const righe = (await res.json()) as { id: string }[]
    expect(righe.map((r) => r.id)).toEqual([ALU_A])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/parents
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/parents — l\'elenco adulti non è il fascicolo dell\'adulto', () => {
  it('ogni riga ha ESATTAMENTE le chiavi che l\'interfaccia usa', async () => {
    const res = await PARENTS(req('/api/admin/parents'))
    expect(res.status).toBe(200)
    const righe = (await res.json()) as Record<string, unknown>[]
    expect(righe).toHaveLength(1)
    expect(Object.keys(righe[0]).sort()).toEqual(
      ['emails', 'first_name', 'fiscal_code', 'id', 'last_name', 'phone_numbers', 'scuole_ids'].sort(),
    )
  })

  it('numero e percorso del documento d\'identità, residenza e consensi restano fuori', async () => {
    const res = await PARENTS(req('/api/admin/parents'))
    const corpo = await res.text()
    expect(corpo).not.toContain(DOC_ADULTO_NUM)
    expect(corpo).not.toContain(DOC_ADULTO_PATH)
    expect(corpo).not.toContain(INDIRIZZO_ADULTO)
    expect(corpo).not.toContain('consensi_gdpr')
    expect(corpo).not.toContain('auth_user_id')
  })

  it('`scuole_ids` (la sede dedotta dai figli) sopravvive alla riduzione', async () => {
    const res = await PARENTS(req('/api/admin/parents'))
    const righe = (await res.json()) as { id: string; scuole_ids: string[] }[]
    expect(righe[0].id).toBe(PAR_A)
    expect(righe[0].scuole_ids).toEqual([SEDE_A])
  })

  it('?student_id: la scheda economica riceve solo ciò che legge', async () => {
    // Unico consumatore di questo ramo: `StudentEconomicSection`, che cerca
    // l'intestatario di famiglia predefinito. Legge `id` e `intestatario_default`.
    const res = await PARENTS(req(`/api/admin/parents?student_id=${ALU_A}`))
    expect(res.status).toBe(200)
    const righe = (await res.json()) as Record<string, unknown>[]
    expect(righe).toHaveLength(1)
    expect(Object.keys(righe[0]).sort()).toEqual(['id', 'intestatario_default', 'student_parents'].sort())
    expect(righe[0].intestatario_default).toBe(true)
    expect(JSON.stringify(righe[0])).not.toContain(DOC_ADULTO_NUM)
  })
})
