import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/pagamenti/fattura — il campo `intestatario`, e i due rifiuti nuovi.
 *
 * ─── COSA SORVEGLIA ──────────────────────────────────────────────────────────
 *  1. Il body ibrido (`adult_id` PIÙ i campi anagrafici) è respinto da zod, non
 *     ripulito in silenzio: accettarlo mezzo significherebbe lasciar intestare
 *     una fattura a un genitore vero con un codice fiscale scritto dal browser.
 *  2. I due 409 nuovi portano un `codice`, dichiarato in `CODICI_ERRORE` e
 *     tradotto in ITALIANO e in INGLESE. Senza, l'utente inglese leggerebbe la
 *     prosa italiana del server — il difetto che il lock `errori-con-codice`
 *     esiste per impedire.
 *  3. Il server NON scrive `alunni.intestatario_fatture`: una scelta fatta per
 *     UN pagamento non deve cambiare l'anagrafica del bambino. Se lo facesse,
 *     una fattura andata storta lascerebbe dietro di sé un intestatario nuovo su
 *     tutte le rette future, e nessuno saprebbe perché.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  emetti: vi.fn(),
  updates: [] as { table: string; row: unknown }[],
}))

vi.mock('@/lib/auth/scope', () => ({
  assertPagamentoInScope: vi.fn(async () => null),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: null, error: null })
      b.update = (row: unknown) => ({
        eq: async () => {
          h.updates.push({ table, row })
          return { error: null }
        },
      })
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null })
      return b
    },
    storage: { from: () => ({ download: async () => ({ data: null }) }) },
  }),
}))
vi.mock('@/lib/aruba/emissione', () => ({ emettiFatturaPagamento: h.emetti }))

import { POST } from '@/app/api/pagamenti/fattura/route'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const ADULTO = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'

function post(body: unknown) {
  return new Request('http://localhost/api/pagamenti/fattura', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const personaCompleta = {
  tipo: 'persona',
  codice_fiscale: 'PRLCRL80A01H501Z',
  nome: 'Carlo',
  cognome: 'Perlini',
  indirizzo: 'Via delle Prove',
  cap: '81030',
  comune: 'Cesa',
  provincia: 'CE',
  numero_civico: '9',
}

beforeEach(() => {
  vi.clearAllMocks()
  h.updates.length = 0
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.emetti.mockResolvedValue({ ok: true, fatturaStato: 'in_attesa', uploadFileName: 'IT_x.xml.p7m', numero: 2328 })
})

describe('POST /api/pagamenti/fattura — `intestatario` nel corpo', () => {
  it('l’intestatario scelto arriva al motore, non si perde per strada', async () => {
    const res = await POST(post({ pagamento_id: PID, intestatario: { tipo: 'adult', adult_id: ADULTO } }))
    expect(res.status).toBe(200)
    expect(h.emetti).toHaveBeenCalledWith(expect.anything(), PID, { id: 'staff-1' }, {
      intestatarioScelto: { tipo: 'adult', adult_id: ADULTO },
    })
  })

  it('senza `intestatario` il motore riceve la stessa chiamata di sempre', async () => {
    await POST(post({ pagamento_id: PID }))
    expect(h.emetti).toHaveBeenCalledWith(expect.anything(), PID, { id: 'staff-1' }, { intestatarioScelto: undefined })
  })

  it('la persona digitata passa intera, provincia e civico compresi', async () => {
    await POST(post({ pagamento_id: PID, intestatario: personaCompleta }))
    expect(h.emetti.mock.calls[0][3]).toEqual({ intestatarioScelto: personaCompleta })
  })

  it('body IBRIDO (adult_id + campi anagrafici) → 400 di zod, e il motore non parte', async () => {
    const res = await POST(
      post({
        pagamento_id: PID,
        intestatario: { tipo: 'adult', adult_id: ADULTO, nome: 'Carlo', cognome: 'Perlini' },
      }),
    )
    expect(res.status).toBe(400)
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it('`tipo: \'ente\'` → 400: nessun cessionario ente, per decisione del titolare', async () => {
    const res = await POST(
      post({ pagamento_id: PID, intestatario: { tipo: 'ente', denominazione: 'Comune di Cesa' } }),
    )
    expect(res.status).toBe(400)
    expect(h.emetti).not.toHaveBeenCalled()
  })

  it('IL SERVER NON SCRIVE MAI `intestatario_fatture` sulla scheda del bambino', async () => {
    await POST(post({ pagamento_id: PID, intestatario: personaCompleta }))
    const suAlunni = h.updates.filter((u) => u.table === 'alunni')
    expect(suAlunni, 'una scelta per UN pagamento non cambia l’anagrafica del bambino').toEqual([])
    const conIntestatario = h.updates.filter((u) => JSON.stringify(u.row).includes('intestatario_fatture'))
    expect(conIntestatario).toEqual([])
  })
})

describe('i due rifiuti nuovi portano un `codice` TRADOTTO', () => {
  it('pagamento ripartito → 409 con `INTESTATARIO_IN_CONFLITTO_CON_QUOTE`', async () => {
    h.emetti.mockResolvedValue({
      ok: false,
      motivo: 'intestatario_in_conflitto',
      messaggio: 'Questo pagamento è ripartito fra due genitori…',
      httpStatus: 409,
    })
    const res = await POST(post({ pagamento_id: PID, intestatario: { tipo: 'adult', adult_id: ADULTO } }))
    const j = await res.json()
    expect(res.status).toBe(409)
    expect(j.codice).toBe('INTESTATARIO_IN_CONFLITTO_CON_QUOTE')
  })

  it('fattura viva intestata ad altri → 409 con `FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO`', async () => {
    h.emetti.mockResolvedValue({
      ok: false,
      motivo: 'gia_emessa_altro_intestatario',
      messaggio: 'Questo pagamento ha già una fattura viva (Asilo 2328/2026)…',
      httpStatus: 409,
    })
    const res = await POST(post({ pagamento_id: PID }))
    const j = await res.json()
    expect(res.status).toBe(409)
    expect(j.codice).toBe('FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO')
    // La prosa del server resta accanto al codice: dice QUALE documento c'è già,
    // e quel dettaglio nessun catalogo lo può contenere.
    expect(j.error).toContain('Asilo 2328')
  })

  it('adulto non di questo bambino → 422 con `INTESTATARIO_NON_DEL_BAMBINO`', async () => {
    h.emetti.mockResolvedValue({
      ok: false,
      motivo: 'intestatario_non_del_bambino',
      messaggio: 'L’intestatario scelto non risulta fra i genitori di questo bambino…',
      httpStatus: 422,
    })
    const res = await POST(post({ pagamento_id: PID, intestatario: { tipo: 'adult', adult_id: ADULTO } }))
    const j = await res.json()
    expect(res.status).toBe(422)
    expect(j.codice).toBe('INTESTATARIO_NON_DEL_BAMBINO')
  })

  it('gli altri rifiuti non cambiano forma (il 422 di sempre)', async () => {
    h.emetti.mockResolvedValue({
      ok: false,
      motivo: 'intestatario_mancante',
      messaggio: 'Intestatario fattura non impostato sull’anagrafica',
      httpStatus: 422,
    })
    const res = await POST(post({ pagamento_id: PID }))
    const j = await res.json()
    expect(res.status).toBe(422)
    expect(j.data.motivo).toBe('intestatario_mancante')
  })

  it('i due codici sono DICHIARATI e tradotti in italiano e in inglese', async () => {
    const catIt = itShared as Record<string, string>
    const catEn = enShared as Record<string, string>
    for (const codice of [
      'INTESTATARIO_IN_CONFLITTO_CON_QUOTE',
      'FATTURA_GIA_EMESSA_ALTRO_INTESTATARIO',
      'INTESTATARIO_NON_DEL_BAMBINO',
    ]) {
      const chiave = (CODICI_ERRORE as Record<string, string>)[codice]
      expect(chiave, `${codice} non è dichiarato in CODICI_ERRORE`).toBeTruthy()
      expect(catIt[chiave]?.trim(), `${codice} senza voce italiana`).toBeTruthy()
      expect(catEn[chiave]?.trim(), `${codice} senza voce inglese`).toBeTruthy()
    }
  })
})
