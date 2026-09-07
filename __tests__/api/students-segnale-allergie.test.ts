import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'
import { SEDE_A } from '../fixtures/sedi'

// =============================================================================
// «ALLERGIE» E «NOTE MEDICHE» SONO DUE COLONNE DIVERSE, E L'ELENCO LE DISTINGUE.
//
// `GET /api/admin/students` mandava un booleano solo — `ha_note_mediche` — e la
// pagina ci accendeva un indicatore chiamato «Allergie». Ma `note_mediche` è la
// casella che il modulo d'iscrizione etichetta «Note Mediche (BES, DSA,
// patologie)»: un bambino con una nota medica e nessuna allergia veniva contato
// fra gli allergici, e uno con «arachidi» scritto in `allergies` non lo era.
//
// ─── LA MISURA, CON LA SUA DATA E LA SUA SCADENZA ─────────────────────────────
// Rimisurato in produzione il 2026-09-07 alle 14 (sola lettura, soli conteggi),
// **657 iscritti non archiviati**: 44 con nota medica, 63 con un testo in
// `allergies`, 6 di quei testi sono negazioni ⇒ **57 operativi** e **27
// conteggiabili** (i soli 14 UE), **29** bambini con la nota e nessuna allergia
// operativa.
//
// ⚠️ QUESTI NUMERI SONO UNA FOTOGRAFIA, NON UN INVARIANTE, e questo commento è
// nato sbagliato proprio per averlo dimenticato: portava «646 / 41 / 60» accanto
// a un «27» corretto a metà, cioè due misure di giorni diversi nella stessa
// frase. Gli iscritti crescono di qualche unità al giorno (AGENTS.md tiene il
// conto e lo vede raddoppiare), quindi ogni numero qui sopra invecchia: chi ne
// ha bisogno rifà il conteggio — è una LETTURA, non ferma nessuno — invece di
// copiarlo da questa riga.
//
// L'invariante che questo file misura non è nessuno di quei numeri: è che i DUE
// SEGNALI vengano da DUE COLONNE diverse, e resta vero a qualunque conteggio.
//
// ⚠️ TRE ALUNNI DISGIUNTI, NON UNO. Un mock con un solo alunno che ha ENTRAMBI i
// campi valorizzati sarebbe verde con e senza la correzione: i due booleani
// verrebbero comunque tutti e due `true`. È la disgiunzione che rende visibile la
// differenza, ed è il caso 1 (solo nota medica) quello che prima falliva.
// =============================================================================

const SOLO_NOTA = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SOLO_ALLERGIA = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const NEGAZIONE = '33333333-3333-4333-8333-cccccccccccc'
const FUORI_DAI_14 = '44444444-4444-4444-8444-dddddddddddd'
const ADMIN = 'adm-1'

// Sentinelle: nessun dato reale, ognuna al posto di un dato reale.
const NOTA_MEDICA = 'NOTA-MEDICA-SENTINELLA'
const TESTO_ALLERGIA = 'arachidi'

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

const req = (url: string) => new NextRequest(`http://localhost${url}`)

const dbBase = (): DBFinto => ({
  utenti_scuole: [{ utente_id: ADMIN, scuola_id: SEDE_A }],
  utenti_sezioni: [],
  sections: [],
  alunni: [
    {
      // 1. SOLO la nota medica. È il caso che prima falliva: usciva
      //    `ha_allergie` acceso (allora era l'unico segnale) su un bambino che
      //    un'allergia non ce l'ha.
      id: SOLO_NOTA,
      scuola_id: SEDE_A,
      nome: 'Alfa',
      cognome: 'AaaNota',
      classe_sezione: '2 ANNI',
      stato: 'iscritto',
      note_mediche: NOTA_MEDICA,
      allergies: null,
      allergeni: [],
    },
    {
      // 2. SOLO l'allergia, scritta a mano e riconosciuta fra i 14 UE.
      id: SOLO_ALLERGIA,
      scuola_id: SEDE_A,
      nome: 'Beta',
      cognome: 'BbbAllergia',
      classe_sezione: '2 ANNI',
      stato: 'iscritto',
      note_mediche: null,
      allergies: TESTO_ALLERGIA,
      allergeni: [],
    },
    {
      // 3. Il testo che dice «niente»: non è un'allergia, è il modo in cui
      //    qualcuno ha scritto di non averne.
      id: NEGAZIONE,
      scuola_id: SEDE_A,
      nome: 'Gamma',
      cognome: 'CccNessuna',
      classe_sezione: '2 ANNI',
      stato: 'iscritto',
      note_mediche: null,
      allergies: 'nessuna',
      allergeni: [],
    },
    {
      // 4. Allergia VERA fuori dai 14 UE: il contatore non la vede — è la
      //    conseguenza dichiarata della scelta del titolare, non una svista —
      //    ma l'elenco della cucina sì (`haAllergiaOperativa`, altrove).
      id: FUORI_DAI_14,
      scuola_id: SEDE_A,
      nome: 'Delta',
      cognome: 'DddFragole',
      classe_sezione: '2 ANNI',
      stato: 'iscritto',
      note_mediche: null,
      allergies: 'fragole',
      allergeni: [],
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

const righe = async () => {
  const res = await STUDENTS(req('/api/admin/students?limit=1000'))
  expect(res.status).toBe(200)
  const corpo = (await res.json()) as Record<string, unknown>[]
  return new Map(corpo.map((r) => [r.id as string, r]))
}

describe('GET /api/admin/students — `ha_allergie` non è `ha_note_mediche`', () => {
  it('1. solo nota medica → ha_allergie false, ha_note_mediche true', async () => {
    const r = (await righe()).get(SOLO_NOTA)!
    expect(r.ha_allergie).toBe(false)
    expect(r.ha_note_mediche).toBe(true)
  })

  it('2. solo allergia («arachidi») → ha_allergie true, ha_note_mediche false', async () => {
    const r = (await righe()).get(SOLO_ALLERGIA)!
    expect(r.ha_allergie).toBe(true)
    expect(r.ha_note_mediche).toBe(false)
  })

  it('3. «nessuna» non è un\'allergia → ha_allergie false', async () => {
    const r = (await righe()).get(NEGAZIONE)!
    expect(r.ha_allergie).toBe(false)
  })

  it('4. «fragole» resta fuori dal CONTATORE (scelta dichiarata, non difetto)', async () => {
    const r = (await righe()).get(FUORI_DAI_14)!
    expect(r.ha_allergie).toBe(false)
  })

  it('i due segnali sono BOOLEANI e ci sono su ogni riga (mai `null`, mai assenti)', async () => {
    for (const r of (await righe()).values()) {
      expect(typeof r.ha_allergie, JSON.stringify(r.id)).toBe('boolean')
      expect(typeof r.ha_note_mediche, JSON.stringify(r.id)).toBe('boolean')
    }
  })

  it('il TESTO non esce: né la nota medica né il testo delle allergie', async () => {
    const res = await STUDENTS(req('/api/admin/students?limit=1000'))
    const corpo = await res.text()
    expect(corpo).not.toContain(NOTA_MEDICA)
    expect(corpo).not.toContain(TESTO_ALLERGIA)
    expect(corpo).not.toContain('fragole')
    // La chiave `"note_mediche"` col suo virgolettato: `ha_note_mediche` la
    // contiene come sottostringa, e cercarla nuda renderebbe questa riga rossa
    // per la ragione sbagliata.
    expect(corpo).not.toContain('"note_mediche"')
    expect(corpo).not.toContain('"allergies"')
    expect(corpo).not.toContain('"allergeni"')
  })

  it('gli allergeni SPUNTATI accendono il segnale anche senza testo', async () => {
    ;(h.db.alunni[0] as Record<string, unknown>).allergeni = ['glutine']
    const r = (await righe()).get(SOLO_NOTA)!
    expect(r.ha_allergie).toBe(true)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// IL DB E2E DELLA CI NON È MIGRATO: colonna assente ⇒ 200 con gli indicatori
// spenti, MAI un 500. Il ciclo `42703` toglie la colonna e ripete la query.
//
// ⚠️ IL TETTO DEL CICLO ERA 5 E LE COLONNE CHE POSSONO MANCARE SONO SEI. Con
// `allergies` e `allergeni` l'elenco delle colonne «non garantite» è cresciuto:
// `note_mediche`, `allergies`, `allergeni` e le tre dell'archiviazione. Un tetto
// più basso del numero di colonne assenti non degrada — toglie le prime cinque e
// poi risponde 500 — cioè il degrado «pulito» smette di esserlo senza che nessuno
// tocchi una riga. Questa prova tiene quel tetto onesto.
// ─────────────────────────────────────────────────────────────────────────────
describe('GET /api/admin/students — degrado 42703 su un DB senza le colonne', () => {
  /** Le sei colonne che il DB E2E può non avere. */
  const ASSENTI = [
    'note_mediche', 'allergies', 'allergeni',
    'archiviato_il', 'archiviato_classe_sezione', 'spazio_liberato_il',
  ]

  it('con SEI colonne assenti risponde 200 e i due segnali sono `false`', async () => {
    const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
    let rifiuti = 0

    // Finto PostgREST che rifiuta UNA colonna per volta, col codice e il testo
    // veri (`column alunni.<x> does not exist`): è così che la route scopre quale
    // togliere. Il Proxy di `finto-supabase` ha la sola trappola `get`, quindi la
    // scrittura di `select` arriva al bersaglio (stessa tecnica di `proiezione`).
    const crea = () => {
      const client = creaFintoSupabaseConProiezione(h.db, h.tabelle, {}, h.proiezioni as Proiezione[])
      const from = (client as unknown as { from: (t: string) => unknown }).from.bind(client)
      ;(client as unknown as { from: (t: string) => unknown }).from = (tabella: string) => {
        const b = from(tabella) as Record<string, unknown>
        if (tabella !== 'alunni') return b
        const selOriginale = (b.select as (c?: string, o?: unknown) => unknown).bind(b)
        b.select = (colonne?: string, opts?: unknown) => {
          const chieste = String(colonne ?? '').split(',').map((c) => c.trim())
          const mancante = ASSENTI.find((c) => chieste.includes(c))
          const catena = selOriginale(colonne, opts)
          if (!mancante) return catena
          rifiuti++
          const esito = {
            data: null,
            error: { code: '42703', message: `column alunni.${mancante} does not exist`, details: null, hint: null },
            count: null,
          }
          // Catena che risponde con l'errore qualunque filtro le si appenda.
          const finta: Record<string, unknown> = {
            then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
              Promise.resolve(esito).then(ok, ko),
          }
          for (const m of ['select', 'order', 'range', 'in', 'eq', 'neq', 'not', 'is', 'or', 'gte', 'lte', 'limit', 'single', 'maybeSingle']) {
            finta[m] = () => finta
          }
          return finta
        }
        return b
      }
      return client
    }

    vi.doMock('@/lib/supabase/server-client', () => ({
      createAdminClient: async () => crea(),
      createClient: async () => crea(),
    }))
    vi.resetModules()
    try {
      const { GET } = await import('@/app/api/admin/students/route')
      const res = await GET(req('/api/admin/students?limit=1000'))
      // Controllo positivo: senza rifiuti la prova non misurerebbe nulla — un 200
      // e «zero colonne tolte» hanno lo stesso colore.
      expect(rifiuti, 'il finto DB non ha mai rifiutato una colonna').toBe(ASSENTI.length)
      expect(res.status).toBe(200)
      const corpo = (await res.json()) as Record<string, unknown>[]
      expect(corpo.length).toBe(4)
      for (const r of corpo) {
        expect(r.ha_allergie).toBe(false)
        expect(r.ha_note_mediche).toBe(false)
      }
    } finally {
      vi.doUnmock('@/lib/supabase/server-client')
      vi.resetModules()
    }
  })
})
