import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto } from '../fixtures/finto-supabase'

/**
 * Agosto, armadietto e modulistica: un docente (`educator`) assegnato a una classe dell'anno `in_chiusura`
 * (`sola_lettura: true` per `sezioni_visibili_docente`) NON scrive. Segreteria/admin e il docente con la
 * classe dell'anno corrente (`sola_lettura: false`) sì. Il gate è quello VERO (`assertAlunnoScrivibile`):
 * cambia solo l'esito della funzione SQL.
 *
 * Il caso della galleria (`gallery/route`, `gallery/upload*`, `gallery/ripristina`) e di
 * `primaria/allegati/sostituisci` NON è qui: vedi il report (nessuna sezione scritta / gate già dentro
 * `allegatoDaGestire` / solo staff).
 */

const DOCENTE = '33333333-3333-4333-8333-333333333333'
const SEGRETERIA = '44444444-4444-4444-8444-444444444444'
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEZIONE = '55555555-5555-4555-8555-555555555551'
const ALUNNO = 'c0000000-0000-4000-8000-000000000003'
const RICHIESTA = 'a0000000-0000-4000-8000-000000000001'
const FORM = 'b0000000-0000-4000-8000-000000000002'

const h = vi.hoisted(() => ({
  db: {} as unknown,
  solaLettura: true,
  requireDocente: vi.fn(),
  requireParentOfStudent: vi.fn(),
}))

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => {
      const finto = crea(h.db as DBFinto, [], {
        rpc: {
          sezioni_visibili_docente: () => ({ data: [{ section_id: SEZIONE, sola_lettura: h.solaLettura }], error: null }),
        } as never,
      })
      const storage = {
        from: () => ({ upload: async () => ({ data: { path: 'x' }, error: null }) }),
      }
      return new Proxy(finto as object, {
        get: (t, p, r) => (p === 'storage' ? storage : Reflect.get(t, p, r)),
      })
    },
  }
})
vi.mock('@/lib/auth/require-staff', () => ({ requireDocente: h.requireDocente }))
vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParentOfStudent }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: vi.fn(async () => undefined) }))
vi.mock('@/lib/armadietto/richieste', () => ({ riconciliaRichieste: vi.fn(async () => undefined) }))
vi.mock('@/lib/anagrafiche/legami', () => ({ getGenitoriDiAlunno: vi.fn(async () => []) }))

import { PATCH as requestsPATCH } from '@/app/api/locker/requests/route'
import { POST as inventoryPOST, PATCH as inventoryPATCH } from '@/app/api/locker/inventory/route'
import { POST as modulisticaPOST } from '@/app/api/teacher/modulistica/route'

const utenteDocente = { id: DOCENTE, role: 'educator', scuola_id: SEDE, scuole_ids: [SEDE] }
const utenteSegreteria = { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE, scuole_ids: [SEDE] }

function come(utente: typeof utenteDocente) {
  h.requireDocente.mockResolvedValue({ user: utente })
  h.requireParentOfStudent.mockResolvedValue({ user: utente })
}

function json(url: string, method: string, corpo: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  })
}

function rifiutata(codice: unknown) {
  return codice === 'SEZIONE_IN_CHIUSURA' || codice === 'SEZIONE_SOLA_LETTURA'
}

beforeEach(() => {
  h.solaLettura = true
  h.db = {
    utenti: [
      { id: DOCENTE, scuola_id: SEDE, scuole_ids: [SEDE], role: 'educator' },
      { id: SEGRETERIA, scuola_id: SEDE, scuole_ids: [SEDE], role: 'segreteria' },
    ],
    utenti_sezioni: [{ utente_id: DOCENTE, section_id: SEZIONE }],
    sections: [{ id: SEZIONE, name: 'Girasoli', school_type: 'infanzia', scuola_id: SEDE }],
    alunni: [{ id: ALUNNO, section_id: SEZIONE, scuola_id: SEDE }],
    armadietto: [],
    armadietto_richieste: [{ id: RICHIESTA, alunno_id: ALUNNO, stato: 'aperta' }],
    forms_submissions: [],
  }
  come(utenteDocente)
})

describe('locker/requests PATCH (evasa)', () => {
  const corpo = { id: RICHIESTA, alunno_id: ALUNNO, stato: 'evasa' }

  it('educator con la classe in chiusura → 403 SEZIONE_*', async () => {
    const res = await requestsPATCH(json('/api/locker/requests', 'PATCH', corpo))
    expect(res.status).toBe(403)
    expect(rifiutata((await res.json()).codice)).toBe(true)
  })

  it('segreteria passa', async () => {
    come(utenteSegreteria)
    const res = await requestsPATCH(json('/api/locker/requests', 'PATCH', corpo))
    expect(res.status).toBe(200)
  })

  it('educator con la classe corrente passa', async () => {
    h.solaLettura = false
    const res = await requestsPATCH(json('/api/locker/requests', 'PATCH', corpo))
    expect(res.status).toBe(200)
  })
})

describe('locker/inventory POST (carico) e PATCH (consumo)', () => {
  const carico = { alunno_id: ALUNNO, materiale: 'pannolini', quantita: 3 }
  const consumo = { alunno_id: ALUNNO, materiale: 'pannolini', quantita_usata: 1 }

  it('POST, educator con la classe in chiusura → 403 SEZIONE_*', async () => {
    const res = await inventoryPOST(json('/api/locker/inventory', 'POST', carico))
    expect(res.status).toBe(403)
    expect(rifiutata((await res.json()).codice)).toBe(true)
  })

  it('POST, segreteria passa', async () => {
    come(utenteSegreteria)
    const res = await inventoryPOST(json('/api/locker/inventory', 'POST', carico))
    expect(res.status).toBe(200)
  })

  it('POST, educator con la classe corrente passa', async () => {
    h.solaLettura = false
    const res = await inventoryPOST(json('/api/locker/inventory', 'POST', carico))
    expect(res.status).toBe(200)
  })

  it('POST, il genitore (legame) non è toccato dal gate di sezione', async () => {
    h.requireParentOfStudent.mockResolvedValue({
      user: { id: 'f0000000-0000-4000-8000-000000000009', role: 'genitore', scuola_id: SEDE, scuole_ids: [SEDE] },
      perLegame: true,
    })
    const res = await inventoryPOST(json('/api/locker/inventory', 'POST', carico))
    expect(res.status).toBe(200)
  })

  it('PATCH, educator con la classe in chiusura → 403 SEZIONE_*', async () => {
    const res = await inventoryPATCH(json('/api/locker/inventory', 'PATCH', consumo))
    expect(res.status).toBe(403)
    expect(rifiutata((await res.json()).codice)).toBe(true)
  })

  it('PATCH, segreteria passa', async () => {
    come(utenteSegreteria)
    const res = await inventoryPATCH(json('/api/locker/inventory', 'PATCH', consumo))
    expect(res.status).toBe(200)
  })

  it('PATCH, educator con la classe corrente passa', async () => {
    h.solaLettura = false
    const res = await inventoryPATCH(json('/api/locker/inventory', 'PATCH', consumo))
    expect(res.status).toBe(200)
  })
})

describe('teacher/modulistica POST (scansione cartacea)', () => {
  // `Request.formData()` con un `File` si pianta nell'ambiente di test: lo stesso finto degli altri upload.
  function multipart() {
    const campi: Record<string, unknown> = {
      form_id: FORM,
      student_id: ALUNNO,
      file: new File([new Uint8Array([1, 2, 3]) as unknown as BlobPart], 'modulo.pdf', { type: 'application/pdf' }),
    }
    return {
      headers: new Headers(),
      url: 'http://localhost/api/teacher/modulistica',
      formData: async () => ({ get: (k: string) => campi[k] ?? null }),
    } as unknown as Request
  }

  it('educator con la classe in chiusura → 403 SEZIONE_*', async () => {
    const res = await modulisticaPOST(multipart())
    expect(res.status).toBe(403)
    expect(rifiutata((await res.json()).codice)).toBe(true)
  })

  it('segreteria passa', async () => {
    come(utenteSegreteria)
    const res = await modulisticaPOST(multipart())
    expect(res.status).toBe(201)
  })

  it('educator con la classe corrente passa', async () => {
    h.solaLettura = false
    const res = await modulisticaPOST(multipart())
    expect(res.status).toBe(201)
  })
})
