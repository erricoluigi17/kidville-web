import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

// =============================================================================
// IL CONTRATTO FRA CHI SBLOCCA E CHI LEGGE LO SBLOCCO — per i tipi NUOVI.
//
// `primaria/sblocca:POST` SCRIVE una riga in `sblocchi_audit`;
// `src/lib/primaria/permesso-voce.ts` la LEGGE per decidere se una voce oltre
// il termine si può ancora modificare. Fra i due il medium è una TABELLA, e una
// tabella non ha una firma che il compilatore possa controllare: se un lato
// cambia la forma (la `data` come timestamp, il tipo scritto diverso da quello
// cercato, la sezione non registrata sul giorno…) ciascun test di unità resta
// verde col suo fixture, e torna il guasto «200 che non sblocca niente».
//
// Qui girano DAVVERO tutte e due le metà sullo stesso `h.db`: la route ci
// scrive, `verificaPermessoVoce`/`statoVoci` ci leggono. `creaFintoSupabase`
// filtra e scrive per davvero. Lo scope di sede della route gira col modulo
// reale (`utenti_scuole`). Per il registro lo stesso contratto è collaudato in
// `primaria-sblocco-slot-contratto-registro.test.ts`.
// =============================================================================

const DIRIGENTE = 'd1919e00-0000-4000-8000-000000000001'
const MAESTRA = 'd0ce0001-0000-4000-8000-000000000002'
const SEZ_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const SEZ_B = 'bbbb2222-0000-4000-8000-0000000000b2'
const LEZIONE_A = 'e9157200-0000-4000-8000-00000000000a'
const LEZIONE_B = 'e9157200-0000-4000-8000-00000000000b'
const FIRMA_A = 'e9157200-0000-4000-8000-0000000000f1'
const FIRMA_B = 'e9157200-0000-4000-8000-0000000000f2'
const ALLEGATO = 'e9157200-0000-4000-8000-0000000000a7'
const IMPREPARATO = 'e9157200-0000-4000-8000-0000000000c1'
const IMPREPARATO_2 = 'e9157200-0000-4000-8000-0000000000c2'
const VALUTAZIONE = 'e9157200-0000-4000-8000-0000000000d1'
const VALUTAZIONE_B = 'e9157200-0000-4000-8000-0000000000d2'

/** 12:00 del 10/09/2026 a Roma: il termine è di 2 giorni. */
const ADESSO = new Date('2026-09-10T10:00:00Z')
const LUNEDI = '2026-09-07' // oltre il termine
const VENERDI_PRIMA = '2026-09-04' // oltre il termine
const IERI = '2026-09-09' // entro

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as Scrittura[],
}))

vi.mock('@/lib/logging/logger', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))
vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
// UN SOLO database finto per le due metà: è il medium del contratto.
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase: crea } = await import('../fixtures/finto-supabase')
  return { createAdminClient: async () => crea(h.db, [], { scritture: h.scritture }) }
})

import { POST as SBLOCCA } from '@/app/api/primaria/sblocca/route'
import { chiaveVoce, statoVoci, verificaPermessoVoce, type VocePrimaria } from '@/lib/primaria/permesso-voce'

const maestra: AppUser = { id: MAESTRA, role: 'educator' }

/** Il lettore, sullo STESSO `h.db` su cui ha scritto la route. */
const lettore = (): SupabaseClient => creaFintoSupabase(h.db, [], {}) as unknown as SupabaseClient

function sblocca(body: Record<string, unknown>) {
  return SBLOCCA({
    url: `http://localhost/api/primaria/sblocca?userId=${DIRIGENTE}`,
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ motivazione: 'correzione autorizzata dalla Direzione', ...body }),
  } as unknown as NextRequest)
}

function voce(extra: Partial<VocePrimaria> & Pick<VocePrimaria, 'tipo' | 'id'>): VocePrimaria {
  return { autoreId: MAESTRA, sectionId: SEZ_A, scuolaId: SEDE_A, dataEvento: LUNEDI, ...extra }
}

const permesso = (v: VocePrimaria) => verificaPermessoVoce(lettore(), maestra, v, ADESSO)
const BLOCCATA = { ok: false, stato: 423, codice: 'VOCE_BLOCCATA', giorniLimite: 2 }

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: '2A' },
    { id: SEZ_B, scuola_id: SEDE_B, name: '2B' },
  ],
  utenti_scuole: [
    { utente_id: DIRIGENTE, scuola_id: SEDE_A },
    { utente_id: DIRIGENTE, scuola_id: SEDE_B },
  ],
  utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZ_A }],
  admin_settings: [
    { scuola_id: SEDE_A, timelock_giorni_classe_orale: 2, timelock_giorni_scritto_pratico: 15 },
    { scuola_id: SEDE_B, timelock_giorni_classe_orale: 2, timelock_giorni_scritto_pratico: 15 },
  ],
  registro_orario: [
    { id: LEZIONE_A, section_id: SEZ_A, scuola_id: SEDE_A, data: LUNEDI, ora_lezione: 2 },
    { id: LEZIONE_B, section_id: SEZ_B, scuola_id: SEDE_B, data: LUNEDI, ora_lezione: 2 },
  ],
  firme_docenti: [
    { id: FIRMA_A, registro_id: LEZIONE_A, maestra_id: MAESTRA },
    { id: FIRMA_B, registro_id: LEZIONE_B, maestra_id: MAESTRA },
  ],
  allegati_registro: [{ id: ALLEGATO, registro_id: LEZIONE_A, eliminato_il: null }],
  giustifiche_didattiche: [
    { id: IMPREPARATO, section_id: SEZ_A, data: LUNEDI, origine: 'docente' },
    { id: IMPREPARATO_2, section_id: SEZ_A, data: LUNEDI, origine: 'docente' },
  ],
  valutazioni: [],
  note_disciplinari: [],
  sblocchi_audit: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.scritture = []
  h.requireStaff.mockResolvedValue({
    user: { id: DIRIGENTE, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A },
  })
})

describe('GIORNO della classe: la route scrive, permesso-voce ritrova', () => {
  it('prima 423; dopo lo sblocco del giorno ogni voce di quella classe e data passa', async () => {
    const valutazione = voce({ tipo: 'valutazione', id: VALUTAZIONE })
    const impreparato = voce({ tipo: 'impreparato', id: IMPREPARATO })
    expect(await permesso(valutazione)).toEqual(BLOCCATA)
    expect(await permesso(impreparato)).toEqual(BLOCCATA)

    const res = await SBLOCCA_GIORNO(SEZ_A, LUNEDI)
    expect(res.status).toBe(200)
    expect(h.db.sblocchi_audit).toHaveLength(1)

    expect(await permesso(valutazione)).toEqual({ ok: true })
    expect(await permesso(impreparato)).toEqual({ ok: true })
  })

  it('NON vale per un’altra classe né per un’altra data (anche nel batch)', async () => {
    expect((await SBLOCCA_GIORNO(SEZ_A, LUNEDI)).status).toBe(200)

    const stessa = voce({ tipo: 'valutazione', id: VALUTAZIONE })
    const altraClasse = voce({ tipo: 'valutazione', id: VALUTAZIONE_B, sectionId: SEZ_B, scuolaId: SEDE_B })
    const altraData = voce({ tipo: 'impreparato', id: IMPREPARATO_2, dataEvento: VENERDI_PRIMA })
    expect(await permesso(altraData)).toEqual(BLOCCATA)

    const r = await statoVoci(lettore(), { id: DIRIGENTE, role: 'coordinator' }, [stessa, altraClasse, altraData], ADESSO)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esiti.get(chiaveVoce('valutazione', VALUTAZIONE))).toMatchObject({ bloccata: false, modificabile: true })
    expect(r.esiti.get(chiaveVoce('valutazione', VALUTAZIONE_B))).toMatchObject({ bloccata: true, modificabile: false })
    expect(r.esiti.get(chiaveVoce('impreparato', IMPREPARATO_2))).toMatchObject({ bloccata: true, modificabile: false })
  })
})

describe('VOCE: impreparato, firma e allegato', () => {
  it('IMPREPARATO: sbloccato quello, e solo quello', async () => {
    const questo = voce({ tipo: 'impreparato', id: IMPREPARATO })
    const altro = voce({ tipo: 'impreparato', id: IMPREPARATO_2 })
    expect(await permesso(questo)).toEqual(BLOCCATA)

    const res = await sblocca({ entitaTipo: 'impreparato', entitaId: IMPREPARATO })
    expect(res.status).toBe(200)

    expect(await permesso(questo)).toEqual({ ok: true })
    // Stessa classe, stesso giorno, altra riga: lo sblocco per voce non si allarga.
    expect(await permesso(altro)).toEqual(BLOCCATA)
  })

  it('FIRMA: la firma sbloccata passa, quella di un’altra classe no', async () => {
    const firmaA = voce({ tipo: 'firma', id: FIRMA_A, oraLezione: 2 })
    const firmaB = voce({ tipo: 'firma', id: FIRMA_B, oraLezione: 2, sectionId: SEZ_B, scuolaId: SEDE_B })
    expect(await permesso(firmaA)).toEqual(BLOCCATA)

    const res = await sblocca({ entitaTipo: 'firma', entitaId: FIRMA_A })
    expect(res.status).toBe(200)

    expect(await permesso(firmaA)).toEqual({ ok: true })
    expect(await permesso(firmaB)).toEqual(BLOCCATA)
  })

  it('ALLEGATO: sbloccato per voce, passa', async () => {
    const allegato = voce({ tipo: 'allegato', id: ALLEGATO })
    expect(await permesso(allegato)).toEqual(BLOCCATA)
    expect((await sblocca({ entitaTipo: 'allegato', entitaId: ALLEGATO })).status).toBe(200)
    expect(await permesso(allegato)).toEqual({ ok: true })
  })
})

describe('Voce sbloccata e SPOSTATA su un’altra data', () => {
  it('serve anche lo sblocco del giorno di arrivo; entro il termine no', async () => {
    expect((await sblocca({ entitaTipo: 'impreparato', entitaId: IMPREPARATO })).status).toBe(200)

    const spostata = voce({ tipo: 'impreparato', id: IMPREPARATO, nuovaDataEvento: VENERDI_PRIMA })
    expect(await permesso(spostata)).toEqual(BLOCCATA)
    expect(await permesso(voce({ tipo: 'impreparato', id: IMPREPARATO, nuovaDataEvento: IERI }))).toEqual({ ok: true })

    expect((await SBLOCCA_GIORNO(SEZ_A, VENERDI_PRIMA)).status).toBe(200)
    expect(await permesso(spostata)).toEqual({ ok: true })
  })
})

function SBLOCCA_GIORNO(sectionId: string, data: string) {
  return sblocca({ entitaTipo: 'giorno', sectionId, data })
}
