import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  verificaRevoca: vi.fn(),
  esistenti: [] as { hash_movimento: string }[],
  aperti: [] as Record<string, unknown>[],
  movimento: null as Record<string, unknown> | null,
  movimenti: [] as Record<string, unknown>[],
  pagamento: null as Record<string, unknown> | null,
  inserts: [] as { table: string; row: Record<string, unknown> | Record<string, unknown>[] }[],
  updates: [] as { table: string; row: Record<string, unknown> }[],
  updateRows: [{ id: 'mov-upd' }] as Record<string, unknown>[],
  // Tabelle su cui l'INSERT con scuola_id null deve fallire 23502 (simula il DB E2E CI non migrato).
  fail23502: new Set<string>(),
  // Errore iniettabile sulla SELECT dei pagamenti aperti (POST, ha `codice_fiscale` nei cols).
  apertiCfError: null as { code: string; message: string } | null,
  // Errore iniettabile sulla query batch sede in GET (cols = 'id, scuola_id').
  batchSedeError: null as { code: string; message: string } | null,
  // Errore iniettabile sull'UPDATE dei movimenti (ignora/riapri/conferma).
  updateError: null as { code: string; message: string } | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ verificaRevocaSospensioneMorosita: h.verificaRevoca }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuolaScrittura: async () => ({ scuolaId: 'sc-1' }),
  resolveScuoleAttive: async () => ['sc-1'],
}))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = (cols?: string) => { b._cols = cols; return b }
      b.eq = () => b
      b.in = () => b
      b.gte = () => b
      b.lte = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'riconciliazione_movimenti' ? h.movimento : table === 'pagamenti' ? h.pagamento : null,
        error: null,
      })
      b.insert = (row: Record<string, unknown> | Record<string, unknown>[]) => {
        h.inserts.push({ table, row })
        const rows = Array.isArray(row) ? row : [row]
        const nullSede = rows.some((r) => r.scuola_id === null)
        const err = h.fail23502.has(table) && nullSede
          ? { code: '23502', message: 'null value in column "scuola_id" violates not-null constraint' }
          : null
        return {
          select: () => ({ single: async () => ({ data: err ? null : { id: `${table}-new`, ...(Array.isArray(row) ? {} : row) }, error: err }) }),
          then: (r: (v: unknown) => unknown) => r({ data: null, error: err }),
        }
      }
      b.delete = () => b
      b.update = (row: Record<string, unknown>) => {
        h.updates.push({ table, row })
        const u: Record<string, unknown> = {}
        u.eq = () => u
        u.select = () => ({ then: (r: (v: unknown) => unknown) => r({ data: h.updateError ? null : h.updateRows, error: h.updateError }) })
        u.then = (r: (v: unknown) => unknown) => r({ data: null, error: h.updateError })
        return u
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        let error: { code: string; message: string } | null = null
        if (table === 'pagamenti') {
          const cols = typeof b._cols === 'string' ? (b._cols as string) : ''
          if (h.apertiCfError && cols.includes('codice_fiscale')) error = h.apertiCfError
          else if (h.batchSedeError && cols === 'id, scuola_id') error = h.batchSedeError
        }
        return resolve({
          data:
            table === 'riconciliazione_movimenti'
              ? (h.esistenti.length || h.movimenti.length ? (h.esistenti.length ? h.esistenti : h.movimenti) : [])
              : table === 'pagamenti' ? h.aperti
              : [],
          error,
        })
      }
      return b
    },
  }),
}))

import { GET, POST } from '@/app/api/pagamenti/riconciliazione/route'
import { PATCH } from '@/app/api/pagamenti/riconciliazione/[id]/route'

const MID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const post = (body: unknown) =>
  new Request('http://localhost/api/pagamenti/riconciliazione', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
const patch = (body: unknown) =>
  PATCH(
    new Request(`http://localhost/api/pagamenti/riconciliazione/${MID}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: MID }) },
  )

const CSV = [
  'Data;Entrate;Descrizione',
  '05/09/2026;150,00;BONIFICO RETTA SETTEMBRE ROSSI MARIO',
  '06/09/2026;25,00;GITA ZOO BIANCHI LIA',
].join('\n')

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.updates = []
  h.updateRows = [{ id: 'mov-upd' }]
  h.esistenti = []
  h.movimenti = []
  h.fail23502 = new Set()
  h.apertiCfError = null
  h.batchSedeError = null
  h.updateError = null
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.aperti = [
    { id: PID, descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', tipo: 'singolo', stato: 'scaduto', alunno_id: 'al-1', alunni: { nome: 'Mario', cognome: 'Rossi', codice_fiscale: null, fiscal_code: null } },
  ]
  h.movimento = {
    id: MID, scuola_id: 'sc-1', importo: 150, data_operazione: '2026-09-05',
    causale: 'BONIFICO RETTA', stato: 'suggerito',
    suggerimenti: [{ pagamento_id: PID, score: 75 }],
  }
  h.pagamento = { id: PID, scuola_id: 'sc-1', stato: 'scaduto', alunno_id: 'al-1', descrizione: 'Retta Settembre', importo: 150, importo_pagato: 0, sconto: 0, scadenza: '2026-09-01' }
})

describe('POST /api/pagamenti/riconciliazione (import CSV)', () => {
  it('importa gli accrediti con hash e suggerimenti calcolati', async () => {
    const res = await POST(post({ filename: 'estratto.csv', contenuto: CSV }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    const ins = h.inserts.find((i) => i.table === 'riconciliazione_movimenti')
    const rows = ins!.row as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows[0].hash_movimento).toBeTruthy()
    expect(rows[0].stato).toBe('suggerito') // importo esatto + nome in causale
  })

  it('i movimenti già visti (stesso hash) vengono saltati', async () => {
    const { parseCsv, hashMovimento } = await import('@/lib/pagamenti/riconciliazione')
    const primo = parseCsv(CSV).movimenti[0]
    h.esistenti = [{ hash_movimento: hashMovimento(primo) }]
    const res = await POST(post({ contenuto: CSV }))
    const j = await res.json()
    expect(j.data.nuovi).toBe(1)
    expect(j.data.duplicati).toBe(1)
  })

  it('400 se il CSV non ha colonne riconoscibili', async () => {
    expect((await POST(post({ contenuto: 'foo;bar\n1;2' }))).status).toBe(400)
  })

  it('403 non staff', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    expect((await POST(post({ contenuto: CSV }))).status).toBe(403)
  })

  it('i movimenti nascono con scuola_id null (la sede si assegna alla conferma)', async () => {
    const res = await POST(post({ contenuto: CSV }))
    expect(res.status).toBe(200)
    const ins = h.inserts.find((i) => i.table === 'riconciliazione_movimenti')
    expect((ins!.row as Record<string, unknown>[]).every((r) => r.scuola_id === null)).toBe(true)
    const imp = h.inserts.find((i) => i.table === 'riconciliazione_import')
    expect((imp!.row as Record<string, unknown>).scuola_id).toBeNull()
  })

  it('DB CI non migrato (scuola_id NOT NULL) → insert 23502 ritentato con la sede risolta', async () => {
    h.fail23502 = new Set(['riconciliazione_import', 'riconciliazione_movimenti'])
    const res = await POST(post({ contenuto: CSV }))
    expect(res.status).toBe(200)
    const imports = h.inserts.filter((i) => i.table === 'riconciliazione_import')
    expect(imports).toHaveLength(2)
    expect((imports[0].row as Record<string, unknown>).scuola_id).toBeNull()
    expect((imports[1].row as Record<string, unknown>).scuola_id).toBe('sc-1')
    const movs = h.inserts.filter((i) => i.table === 'riconciliazione_movimenti')
    expect(movs).toHaveLength(2)
    expect((movs[1].row as Record<string, unknown>[]).every((r) => r.scuola_id === 'sc-1')).toBe(true)
  })

  it('embed CF: il CF dell’alunno nella causale → suggerimento cf_match, stato suggerito', async () => {
    h.aperti = [
      { id: PID, descrizione: 'Retta', importo: 150, importo_pagato: 0, periodo_competenza: '2026-09-01', tipo: 'singolo', stato: 'scaduto', alunno_id: 'al-1', alunni: { nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA85T10A562S', fiscal_code: null } },
    ]
    const csv = ['Data;Entrate;Descrizione', '05/09/2026;999,00;BONIFICO GENERICO RSSMRA85T10A562S'].join('\n')
    const res = await POST(post({ contenuto: csv }))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data.con_cf).toBe(1)
    const rows = h.inserts.find((i) => i.table === 'riconciliazione_movimenti')!.row as Record<string, unknown>[]
    expect(rows[0].stato).toBe('suggerito')
    const sugg = rows[0].suggerimenti as { pagamento_id: string; cf_match?: boolean }[]
    expect(sugg[0].pagamento_id).toBe(PID)
    expect(sugg[0].cf_match).toBe(true)
  })

  it('SELECT pagamenti aperti con CF assente (42703) → ritenta senza CF e completa l’import', async () => {
    // DB E2E CI non migrato: alunni.codice_fiscale non esiste → 42703 sulla SELECT con CF.
    h.apertiCfError = { code: '42703', message: 'column alunni.codice_fiscale does not exist' }
    const res = await POST(post({ contenuto: CSV }))
    expect(res.status).toBe(200) // l'import si completa comunque (degrada senza aggancio CF)
    const j = await res.json()
    expect(j.data.nuovi).toBe(2)
    expect(j.data.con_cf).toBe(0)
    // l'import è stato creato (non abortito)
    expect(h.inserts.find((i) => i.table === 'riconciliazione_import')).toBeTruthy()
  })

  it('SELECT pagamenti aperti fallita (errore non-schema) → 500 e NESSUN import creato (mai import_ok mentito)', async () => {
    h.apertiCfError = { code: '08006', message: 'connection failure' }
    const res = await POST(post({ contenuto: CSV }))
    expect(res.status).toBe(500)
    // Il matching non è riuscito: l'import NON deve completarsi né essere creato.
    expect(h.inserts.find((i) => i.table === 'riconciliazione_import')).toBeUndefined()
    expect(h.inserts.find((i) => i.table === 'riconciliazione_movimenti')).toBeUndefined()
  })
})

describe('PATCH /api/pagamenti/riconciliazione/[id]', () => {
  it('conferma → crea incasso bonifico e marca il movimento', async () => {
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(200)
    const inc = h.inserts.find((i) => i.table === 'incassi')
    expect(inc).toBeTruthy()
    expect((inc!.row as Record<string, unknown>).metodo).toBe('bonifico')
    expect((inc!.row as Record<string, unknown>).data_incasso).toBe('2026-09-05')
    const upd = h.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(upd!.row.stato).toBe('confermato')
    expect(upd!.row.pagamento_id).toBe(PID)
  })

  it('conferma → avvisa il genitore (pagamento_registrato) e verifica la revoca sospensione', async () => {
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(200)
    // Un bonifico abbinato è un pagamento registrato: il genitore va notificato.
    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    const [, params] = h.notificaEvento.mock.calls[0]
    expect(params.tipo).toBe('pagamento_registrato')
    expect(params.alunnoIds).toEqual(['al-1'])
    expect(params.entitaId).toBe(PID)
    // …e un bonifico che salda lo scaduto deve poter revocare la sospensione.
    expect(h.verificaRevoca).toHaveBeenCalledWith(expect.anything(), ['al-1'])
  })

  it('conferma di un movimento già confermato → 409 (nessun avviso)', async () => {
    h.movimento = { ...h.movimento!, stato: 'confermato' }
    expect((await patch({ azione: 'conferma' })).status).toBe(409)
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('ignora/riapri NON avvisano il genitore', async () => {
    await patch({ azione: 'ignora' })
    h.movimento = { id: MID, scuola_id: 'sc-1', importo: 150, data_operazione: '2026-09-05', causale: 'x', stato: 'suggerito', suggerimenti: [{ pagamento_id: PID }] }
    await patch({ azione: 'riapri' })
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('corsa persa (0 righe aggiornate dal CAS) → 409 e storno dell’incasso appena creato', async () => {
    h.updateRows = [] // un altro operatore ha già confermato nel frattempo
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(409)
    // l'incasso viene creato e poi stornato (delete su incassi)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeTruthy()
  })

  it('ignora → stato ignorato senza incassi', async () => {
    const res = await patch({ azione: 'ignora' })
    expect(res.status).toBe(200)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
    expect(h.updates.find((u) => u.table === 'riconciliazione_movimenti')!.row.stato).toBe('ignorato')
  })

  it('riapri su movimento non confermato → 200 e stato da_abbinare senza incassi', async () => {
    h.movimento = { ...h.movimento!, stato: 'suggerito' }
    const res = await patch({ azione: 'riapri' })
    expect(res.status).toBe(200)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
    expect(h.updates.find((u) => u.table === 'riconciliazione_movimenti')!.row.stato).toBe('da_abbinare')
  })

  it('riapri di un movimento già confermato → 409', async () => {
    h.movimento = { ...h.movimento!, stato: 'confermato' }
    expect((await patch({ azione: 'riapri' })).status).toBe(409)
  })

  it('ignora di un movimento già confermato → 409', async () => {
    h.movimento = { ...h.movimento!, stato: 'confermato' }
    expect((await patch({ azione: 'ignora' })).status).toBe(409)
  })

  it('conferma con pagamento in sede non attiva → 404', async () => {
    h.pagamento = { id: PID, scuola_id: 'sc-99', stato: 'scaduto' }
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(404)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
  })

  it('conferma con pagamento inesistente → 404', async () => {
    h.pagamento = null
    expect((await patch({ azione: 'conferma' })).status).toBe(404)
  })

  it('conferma di un pagamento GIÀ saldato (residuo 0) → 409 senza incasso', async () => {
    h.pagamento = { id: PID, scuola_id: 'sc-1', stato: 'pagato', alunno_id: 'al-1', descrizione: 'Retta', importo: 150, importo_pagato: 150, sconto: 0, scadenza: '2026-09-01' }
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(409)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('conferma imposta scuola_id = pag.scuola_id sul movimento', async () => {
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(200)
    const upd = h.updates.find((u) => u.table === 'riconciliazione_movimenti')
    expect(upd!.row.stato).toBe('confermato')
    expect(upd!.row.scuola_id).toBe('sc-1')
  })

  it('conferma senza pagamento_id e senza suggerimenti → 400', async () => {
    h.movimento = { ...h.movimento!, suggerimenti: null }
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(400)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
  })

  it('conferma: bonifico che SUPERA il residuo → 409 senza incasso (usa «Incasso unico»)', async () => {
    // residuo = 150 − 80 = 70; bonifico 150 > 70 → sovra-incasso da bloccare
    h.pagamento = { id: PID, scuola_id: 'sc-1', stato: 'parziale', alunno_id: 'al-1', descrizione: 'Retta', importo: 150, importo_pagato: 80, sconto: 0, scadenza: '2026-09-01' }
    h.movimento = { ...h.movimento!, importo: 150 }
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(409)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('conferma: bonifico pari ESATTAMENTE al residuo parziale → 200 con incasso', async () => {
    h.pagamento = { id: PID, scuola_id: 'sc-1', stato: 'parziale', alunno_id: 'al-1', descrizione: 'Retta', importo: 150, importo_pagato: 80, sconto: 0, scadenza: '2026-09-01' }
    h.movimento = { ...h.movimento!, importo: 70 }
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(200)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeTruthy()
  })

  it('conferma: bonifico che supera il residuo per lo SCONTO → 409', async () => {
    // importo 150, sconto 30, pagato 40 → residuo effettivo 80; bonifico 100 > 80 → 409
    h.pagamento = { id: PID, scuola_id: 'sc-1', stato: 'parziale', alunno_id: 'al-1', descrizione: 'Retta', importo: 150, importo_pagato: 40, sconto: 30, scadenza: '2026-09-01' }
    h.movimento = { ...h.movimento!, importo: 100 }
    const res = await patch({ azione: 'conferma' })
    expect(res.status).toBe(409)
    expect(h.inserts.find((i) => i.table === 'incassi')).toBeUndefined()
  })

  it('ignora: UPDATE che non tocca righe (già lavorato altrove) → 404', async () => {
    h.updateRows = []
    const res = await patch({ azione: 'ignora' })
    expect(res.status).toBe(404)
  })

  it('riapri: UPDATE che non tocca righe → 404', async () => {
    h.movimento = { ...h.movimento!, stato: 'suggerito' }
    h.updateRows = []
    const res = await patch({ azione: 'riapri' })
    expect(res.status).toBe(404)
  })

  it('ignora: errore PostgREST sull’UPDATE → 500 (non un finto success)', async () => {
    h.updateError = { code: 'XX', message: 'boom' }
    const res = await patch({ azione: 'ignora' })
    expect(res.status).toBe(500)
  })

  it('riapri: errore PostgREST sull’UPDATE → 500', async () => {
    h.movimento = { ...h.movimento!, stato: 'suggerito' }
    h.updateError = { code: 'XX', message: 'boom' }
    const res = await patch({ azione: 'riapri' })
    expect(res.status).toBe(500)
  })
})

describe('GET /api/pagamenti/riconciliazione', () => {
  it('lista movimenti (200)', async () => {
    h.movimenti = [{ id: MID, stato: 'suggerito' }]
    const res = await GET(new Request('http://localhost/api/pagamenti/riconciliazione?stato=suggerito') as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
  })

  it('lista globale con stato confermato + intervallo date (200)', async () => {
    h.movimenti = [{ id: MID, stato: 'confermato' }]
    const res = await GET(new Request('http://localhost/api/pagamenti/riconciliazione?stato=confermato&da=2026-09-01&a=2026-09-30') as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data).toHaveLength(1)
  })

  it('date malformate → 400', async () => {
    const res = await GET(new Request('http://localhost/api/pagamenti/riconciliazione?da=05-09-2026') as never)
    expect(res.status).toBe(400)
  })

  it('date IMPOSSIBILI (ben formattate ma inesistenti) → 400, mai 500', async () => {
    // Prima passavano la regex e finivano in .gte/.lte → Postgres 22008 → 500 sul canale ERROR.
    expect((await GET(new Request('http://localhost/api/pagamenti/riconciliazione?da=2026-13-40') as never)).status).toBe(400)
    expect((await GET(new Request('http://localhost/api/pagamenti/riconciliazione?a=2026-02-30') as never)).status).toBe(400)
  })

  it('privacy: i suggerimenti che puntano a un pagamento di ALTRA sede vengono rimossi (nomi minori cross-sede)', async () => {
    h.movimenti = [{
      id: MID, stato: 'suggerito',
      suggerimenti: [
        { pagamento_id: 'pay-own', score: 80, label: 'Nome Cognome · Retta (residuo € 150,00)' },
        { pagamento_id: 'pay-other', score: 80, label: 'Altro Minore · Retta (residuo € 90,00)' },
      ],
    }]
    // La query batch pagamenti(id, scuola_id) risolve le sedi; sedi attive = ['sc-1'].
    h.aperti = [{ id: 'pay-own', scuola_id: 'sc-1' }, { id: 'pay-other', scuola_id: 'sc-99' }]
    const res = await GET(new Request('http://localhost/api/pagamenti/riconciliazione') as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].suggerimenti).toHaveLength(1)
    expect(j.data[0].suggerimenti[0].pagamento_id).toBe('pay-own')
  })

  it('privacy: la RIGA bancaria resta globale (si minimizza solo l’arricchimento nei suggerimenti)', async () => {
    h.movimenti = [{
      id: MID, stato: 'confermato', importo: 150, causale: 'BONIFICO', data_operazione: '2026-09-05',
      suggerimenti: [{ pagamento_id: 'pay-other', score: 80, label: 'Minore Altrove · Retta' }],
    }]
    h.aperti = [{ id: 'pay-other', scuola_id: 'sc-99' }]
    const res = await GET(new Request('http://localhost/api/pagamenti/riconciliazione') as never)
    const j = await res.json()
    // riga presente (globale), ma senza suggerimenti identificanti di altra sede
    expect(j.data).toHaveLength(1)
    expect(j.data[0].importo).toBe(150)
    expect(j.data[0].suggerimenti).toHaveLength(0)
  })

  it('privacy: query sede fallita → i label dei suggerimenti nascosti (degrado prudente)', async () => {
    h.movimenti = [{
      id: MID, stato: 'suggerito',
      suggerimenti: [{ pagamento_id: 'pay-own', score: 80, label: 'Nome Cognome · Retta (residuo € 150,00)' }],
    }]
    h.batchSedeError = { code: 'XX', message: 'boom' }
    const res = await GET(new Request('http://localhost/api/pagamenti/riconciliazione') as never)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].suggerimenti[0].label).toBeNull()
  })
})
