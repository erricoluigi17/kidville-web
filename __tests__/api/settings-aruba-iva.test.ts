import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'

/**
 * LE RIGHE IVA NON SI SALVANO PIÙ ALLA CIECA.
 *
 * `admin/settings/aruba:PATCH` validava `iva` con `z.unknown().optional()`. Una riga
 * `{causale:'iscrizione', aliquota:0}` — senza `natura` — si salvava senza un fiato e
 * arrivava intatta fino allo SdI, che la scarta con **00401**. Il gemello è **00400**:
 * un'aliquota maggiore di zero CON una natura. Misurato altrove in questo repo
 * (`__tests__/lib/aruba/iva-coerenza.test.ts`): lo XSD ufficiale accetta entrambi i
 * documenti, quindi il collaudo del tracciato — la difesa più forte del generatore —
 * su questo punto è cieco.
 *
 * Il costo di quel salvataggio non è un messaggio d'errore: è un numero bruciato sul
 * sezionale, perché `prossimo_numero_fattura_sezionale` scrive il contatore prima
 * dell'upload. Per questo la regola è imposta all'INGRESSO, dove correggere costa un
 * clic, e ri-verificata prima di consumare un numero.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  upserted: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async () => {
  const { SEDE_A: SEDE } = await import('../fixtures/sedi')
  return { resolveScuolaScrittura: async () => ({ scuolaId: SEDE }) }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.maybeSingle = async () => ({ data: h.existing, error: null })
      b.upsert = async (row: Record<string, unknown>) => {
        h.upserted = row
        return { error: null }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/settings/aruba/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/settings/aruba', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

beforeEach(() => {
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1' }, response: null })
  h.upserted = null
  h.existing = null
})

/** Il testo di tutti i messaggi di `details`, per non dipendere dall'ordine delle issue. */
async function motivi(res: Response): Promise<string> {
  const body = (await res.json()) as { details?: { path: string; message: string }[] }
  return JSON.stringify(body.details ?? [])
}

describe('PATCH /api/admin/settings/aruba — coerenza fra aliquota e natura', () => {
  it('aliquota 0 SENZA natura: 400, e NIENTE viene scritto', async () => {
    const res = await PATCH(req({ scuola_id: SEDE_A, iva: [{ causale: 'iscrizione', aliquota: 0 }] }))
    expect(res.status).toBe(400)
    expect(await motivi(res)).toContain('00401')
    expect(h.upserted, 'una configurazione che produce scarti non deve arrivare a database').toBeNull()
  })

  it('aliquota 22 CON natura: 400 (è lo scarto 00400)', async () => {
    const res = await PATCH(req({ scuola_id: SEDE_A, iva: [{ causale: 'gadget', aliquota: 22, natura: 'N4' }] }))
    expect(res.status).toBe(400)
    expect(await motivi(res)).toContain('00400')
    expect(h.upserted).toBeNull()
  })

  it('una natura inventata non passa: sono ammesse N1…N7 e le sotto-nature', async () => {
    const res = await PATCH(req({ scuola_id: SEDE_A, iva: [{ causale: 'retta', aliquota: 0, natura: 'N9' }] }))
    expect(res.status).toBe(400)
    const ok = await PATCH(req({ scuola_id: SEDE_A, iva: [{ causale: 'retta', aliquota: 0, natura: 'N2.1' }] }))
    expect(ok.status).toBe(200)
  })

  it('una causale vuota non è una riga: 400', async () => {
    const res = await PATCH(req({ scuola_id: SEDE_A, iva: [{ causale: '   ', aliquota: 0, natura: 'N4' }] }))
    expect(res.status).toBe(400)
  })

  it('LE DUE COMBINAZIONI GIUSTE si salvano, col riferimento normativo', async () => {
    const righe = [
      { causale: 'retta', aliquota: 0, natura: 'N4', riferimento_normativo: 'Esente art. 10 DPR 633/1972' },
      { causale: 'gadget', aliquota: 22 },
    ]
    const res = await PATCH(req({ scuola_id: SEDE_A, iva: righe }))
    expect(res.status).toBe(200)
    const salvato = (h.upserted?.aruba_config as { iva: unknown[] }).iva
    expect(salvato).toHaveLength(2)
    expect(salvato[0]).toMatchObject({ natura: 'N4', riferimento_normativo: 'Esente art. 10 DPR 633/1972' })
  })

  it('gli ALTRI campi restano com\'erano: si è stretta `iva`, non tutto il pannello', async () => {
    // Restringere per errore username/ambiente avrebbe rotto la configurazione delle
    // sedi già attive: questo caso è ciò che tiene separata la regola dal resto.
    const res = await PATCH(req({ scuola_id: SEDE_A, username: 'utente@scuola.it', ambiente: 'production', abilitato: true }))
    expect(res.status).toBe(200)
    expect(h.upserted?.aruba_config).toMatchObject({ username: 'utente@scuola.it', ambiente: 'production', abilitato: true })
  })
})
