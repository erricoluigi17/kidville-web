import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// Compito 4.2.3: `annoDalCookie` e `resolveAnnoLettura` (l'anno su cui LEGGERE).
// Database FINTO con `anni_sede` e la RPC `anno_attivo`; gli stati sono scritti nel finto,
// l'orologio non conta.

const logger = vi.hoisted(() => ({ logEvento: vi.fn(), logOk: vi.fn(), logErrore: vi.fn() }))
vi.mock('@/lib/logging/logger', () => logger)
vi.mock('@/lib/sezioni/docenti', () => ({ sezioniDiUtente: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClientConHeader: vi.fn() }))

import { redact } from '@/lib/logging/redact'
import { annoDalCookie, resolveAnnoLettura, COOKIE_ANNO, type AnnoLettura } from '@/lib/auth/scope'
import type { AppUser } from '@/lib/auth/require-staff'

const SEDE = '22222222-2222-4222-8222-222222222222'
const ALTRA_SEDE = '33333333-3333-4333-8333-333333333333'
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const A9 = 'a9999999-9999-4999-8999-999999999999'
const S1 = 'b1111111-1111-4111-8111-111111111111'
const S2 = 'b2222222-2222-4222-8222-222222222222'
const S3 = 'b3333333-3333-4333-8333-333333333333'
const SX = 'b5555555-5555-4555-8555-555555555555'

type Riga = { id: string; scuola_id: string; anno_id: string; stato: string; domande_aperte: boolean; inizio: string }

function righeNormali(): Riga[] {
  return [
    { id: S1, scuola_id: SEDE, anno_id: A1, stato: 'chiuso', domande_aperte: false, inizio: '2025-09-01' },
    { id: S2, scuola_id: SEDE, anno_id: A2, stato: 'corrente', domande_aperte: false, inizio: '2026-09-01' },
    { id: S3, scuola_id: SEDE, anno_id: A3, stato: 'iscrizioni_aperte', domande_aperte: true, inizio: '2027-09-01' },
    // un anno che esiste solo per un'altra sede
    { id: SX, scuola_id: ALTRA_SEDE, anno_id: A9, stato: 'corrente', domande_aperte: false, inizio: '2026-09-01' },
  ]
}

/** Agosto: il 2026/27 è `in_chiusura`, nessun `corrente`: l'attivo è ancora il 2026/27. */
function righeAgosto(): Riga[] {
  const r = righeNormali()
  r[1].stato = 'in_chiusura'
  return r
}

type Opzioni = { righe?: Riga[]; indietro?: 'tabella' | 'funzione'; guasto?: boolean; senzaAttivo?: boolean }

function finto(o: Opzioni = {}) {
  const righe = o.righe ?? righeNormali()
  const supabase = {
    from(tabella: string) {
      const filtri: Array<[string, unknown]> = []
      const b = {
        select() { return b },
        eq(col: string, val: unknown) { filtri.push([col, val]); return b },
        then(ok: (v: unknown) => unknown) {
          if (o.indietro === 'tabella') return Promise.resolve({ data: null, error: { code: 'PGRST205', message: 'x' } }).then(ok)
          if (o.guasto) return Promise.resolve({ data: null, error: { code: '57014', message: 'timeout segreto' } }).then(ok)
          const dati = tabella === 'anni_sede'
            ? righe.filter((r) => filtri.every(([c, v]) => (r as Record<string, unknown>)[c] === v))
            : []
          return Promise.resolve({ data: dati, error: null }).then(ok)
        },
      }
      return b
    },
    async rpc(nome: string, args: { p_scuola: string }) {
      if (o.indietro === 'funzione') return { data: null, error: { code: 'PGRST202', message: 'x' } }
      if (nome !== 'anno_attivo') return { data: null, error: { code: 'PGRST202', message: 'no' } }
      if (o.senzaAttivo) return { data: null, error: null }
      const passati = righe
        .filter((r) => r.scuola_id === args.p_scuola && ['corrente', 'in_chiusura', 'chiuso'].includes(r.stato))
        .sort((a, b) => (a.inizio < b.inizio ? 1 : -1))
      return { data: passati[0]?.id ?? null, error: null }
    },
  }
  return supabase as unknown as SupabaseClient
}

const SEGRETERIA: AppUser = { id: '11111111-1111-4111-8111-111111111111', role: 'segreteria' }
const DOCENTE: AppUser = { id: '11111111-1111-4111-8111-444444444444', role: 'educator' }
const GENITORE: AppUser = { id: '11111111-1111-4111-8111-555555555555', role: 'genitore' }

function richiesta(cookie?: string): NextRequest {
  return new NextRequest('https://app.example/api/x', cookie ? { headers: { cookie } } : undefined)
}
const conAnnoCookie = (v: string) => richiesta(`${COOKIE_ANNO}=${v}`)

async function leggi(r: AnnoLettura | null | NextResponse): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!(r instanceof NextResponse)) throw new Error('atteso un NextResponse, ricevuto ' + JSON.stringify(r))
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}
function esito(r: AnnoLettura | null | NextResponse): AnnoLettura {
  if (r === null || r instanceof NextResponse) throw new Error('atteso un esito')
  return r
}
const tuttoIlLog = () => JSON.stringify([logger.logEvento.mock.calls, logger.logOk.mock.calls, logger.logErrore.mock.calls])
const tipiWarn = () => logger.logEvento.mock.calls.filter((c) => c[1] === 'warn').map((c) => (c[2] as { tipo: string }).tipo)

beforeEach(() => vi.clearAllMocks())

describe('annoDalCookie', () => {
  it('il nome del cookie è anno_attivo', () => expect(COOKIE_ANNO).toBe('anno_attivo'))

  it("legge l'uuid", () => {
    expect(annoDalCookie(conAnnoCookie(A2))).toBe(A2)
  })

  it('ignora ciò che non è un uuid, o manca', () => {
    expect(annoDalCookie(conAnnoCookie('2026-27'))).toBeNull()
    expect(annoDalCookie(conAnnoCookie('a2222222'))).toBeNull()
    expect(annoDalCookie(richiesta())).toBeNull()
  })

  it('maiuscole: lo stesso uuid in maiuscolo esce in forma canonica', () => {
    expect(annoDalCookie(conAnnoCookie(A2.toUpperCase()))).toBe(A2)
  })
})

describe('resolveAnnoLettura', () => {
  it("predefinito: senza cookie vale l'anno attivo, eAttivo true", async () => {
    const r = esito(await resolveAnnoLettura(richiesta(), finto(), SEGRETERIA, SEDE))
    expect(r).toEqual({ annoSedeId: S2, annoId: A2, stato: 'corrente', eAttivo: true })
  })

  it("agosto: il 2026/27 in chiusura è ancora l'anno attivo", async () => {
    const r = esito(await resolveAnnoLettura(richiesta(), finto({ righe: righeAgosto() }), SEGRETERIA, SEDE))
    expect(r).toEqual({ annoSedeId: S2, annoId: A2, stato: 'in_chiusura', eAttivo: true })
  })

  it("scelta: col cookie sul 2027/28 la segreteria riceve quell'anno, eAttivo false", async () => {
    const r = esito(await resolveAnnoLettura(conAnnoCookie(A3), finto(), SEGRETERIA, SEDE))
    expect(r).toEqual({ annoSedeId: S3, annoId: A3, stato: 'iscrizioni_aperte', eAttivo: false })
  })

  it('il dichiarato vince sul cookie', async () => {
    const r = esito(await resolveAnnoLettura(conAnnoCookie(A3), finto(), SEGRETERIA, SEDE, { dichiarato: A1 }))
    expect(r).toMatchObject({ annoSedeId: S1, annoId: A1, stato: 'chiuso', eAttivo: false })
  })

  it('maiuscole: ANNO in maiuscolo è lo stesso anno, e esce in forma canonica', async () => {
    const r = esito(await resolveAnnoLettura(conAnnoCookie(A3.toUpperCase()), finto(), SEGRETERIA, SEDE))
    expect(r.annoId).toBe(A3)
    expect(r.annoSedeId).toBe(S3)
    const d = esito(await resolveAnnoLettura(richiesta(), finto(), SEGRETERIA, SEDE, { dichiarato: ` ${A3.toUpperCase()} ` }))
    expect(d.annoId).toBe(A3)
  })

  it("cookie con un anno di un'altra sede → 403 ANNO_NON_ACCESSIBILE e warn senza il valore", async () => {
    const r = await leggi(await resolveAnnoLettura(conAnnoCookie(A9), finto(), SEGRETERIA, SEDE))
    expect(r.status).toBe(403)
    expect(r.body.codice).toBe('ANNO_NON_ACCESSIBILE')
    expect(tipiWarn()).toContain('anno-lettura-cookie-fuori-scope')
    expect(tuttoIlLog()).not.toContain(A9)
  })

  it('la fonte della richiesta rifiutata esce in chiaro attraverso redact() vero (cookie o dichiarato)', async () => {
    await resolveAnnoLettura(conAnnoCookie(A9), finto(), SEGRETERIA, SEDE)
    await resolveAnnoLettura(richiesta(), finto(), SEGRETERIA, SEDE, { dichiarato: A9 })
    const righe = logger.logEvento.mock.calls
      .filter((c) => c[2]?.tipo === 'anno-lettura-cookie-fuori-scope')
      .map((c) => redact(c[2]) as Record<string, unknown>)
    expect(righe.map((r) => r.esito)).toEqual(['cookie', 'dichiarato'])
    expect(JSON.stringify(righe)).not.toContain('[redatto')
  })

  it('cookie con un uuid che non è un anno → 403; dichiarato inesistente → lo stesso', async () => {
    const x = 'deadbeef-dead-4ead-8ead-deadbeefdead'
    expect((await leggi(await resolveAnnoLettura(conAnnoCookie(x), finto(), SEGRETERIA, SEDE))).body.codice).toBe('ANNO_NON_ACCESSIBILE')
    const d = await leggi(await resolveAnnoLettura(richiesta(), finto(), SEGRETERIA, SEDE, { dichiarato: x }))
    expect(d.status).toBe(403)
    expect(d.body.codice).toBe('ANNO_NON_ACCESSIBILE')
    expect(tipiWarn().filter((t) => t === 'anno-lettura-cookie-fuori-scope')).toHaveLength(2)
  })

  it('cookie fuori forma: ignorato come se mancasse, e il suo valore non entra nel log', async () => {
    const segreto = 'valore-segreto-del-cookie'
    const r = esito(await resolveAnnoLettura(conAnnoCookie(segreto), finto(), SEGRETERIA, SEDE))
    expect(r.annoId).toBe(A2)
    expect(tuttoIlLog()).not.toContain(segreto)
  })

  it("docente con il cookie sul 2027/28: legge l'anno attivo, cookie ignorato, warn", async () => {
    const r = esito(await resolveAnnoLettura(conAnnoCookie(A3), finto(), DOCENTE, SEDE))
    expect(r).toEqual({ annoSedeId: S2, annoId: A2, stato: 'corrente', eAttivo: true })
    expect(tipiWarn()).toContain('anno-cookie-ignorato-ruolo')
  })

  it('genitore idem; senza cookie nessun warn', async () => {
    const r = esito(await resolveAnnoLettura(conAnnoCookie(A3), finto(), GENITORE, SEDE))
    expect(r.annoId).toBe(A2)
    expect(tipiWarn()).toContain('anno-cookie-ignorato-ruolo')
    logger.logEvento.mockClear()
    esito(await resolveAnnoLettura(richiesta(), finto(), GENITORE, SEDE))
    expect(tipiWarn()).not.toContain('anno-cookie-ignorato-ruolo')
  })

  it('docente che dichiara un anno iscrizioni_aperte → 403 ANNO_NON_VISIBILE', async () => {
    const r = await leggi(await resolveAnnoLettura(richiesta(), finto(), DOCENTE, SEDE, { dichiarato: A3 }))
    expect(r.status).toBe(403)
    expect(r.body.codice).toBe('ANNO_NON_VISIBILE')
  })

  it('docente che dichiara un anno chiuso lo legge, con eAttivo false', async () => {
    const r = esito(await resolveAnnoLettura(richiesta(), finto(), DOCENTE, SEDE, { dichiarato: A1 }))
    expect(r).toMatchObject({ annoId: A1, stato: 'chiuso', eAttivo: false })
  })

  it('database non migrato (tabella o funzione assente) → null con un solo evento info', async () => {
    for (const indietro of ['tabella', 'funzione'] as const) {
      logger.logEvento.mockClear()
      expect(await resolveAnnoLettura(richiesta(), finto({ indietro }), SEGRETERIA, SEDE)).toBeNull()
      const info = logger.logEvento.mock.calls.filter((c) => c[0] === 'anno-scolastico' && c[1] === 'info')
      expect(info).toHaveLength(1)
      expect((info[0][2] as { tipo: string }).tipo).toBe('calendario-non-disponibile')
    }
  })

  it('il motivo del degrado esce in chiaro dalla redazione vera (sotto `esito`, non `motivo`)', async () => {
    await resolveAnnoLettura(richiesta(), finto({ indietro: 'tabella' }), SEGRETERIA, SEDE)
    const info = logger.logEvento.mock.calls.find((c) => c[0] === 'anno-scolastico' && c[1] === 'info')
    expect(redact(info?.[2])).toMatchObject({ tipo: 'calendario-non-disponibile', esito: 'schema-indietro' })
  })

  it('un altro errore → 500 con log error, senza il messaggio del database', async () => {
    const r = await leggi(await resolveAnnoLettura(richiesta(), finto({ guasto: true }), SEGRETERIA, SEDE))
    expect(r.status).toBe(500)
    expect(logger.logEvento.mock.calls.some((c) => c[1] === 'error')).toBe(true)
    expect(JSON.stringify(r.body)).not.toContain('segreto')
  })

  it('la sede non ha nessun anno attivo e nessuno è scelto → null', async () => {
    logger.logEvento.mockClear()
    expect(await resolveAnnoLettura(richiesta(), finto({ senzaAttivo: true }), SEGRETERIA, SEDE)).toBeNull()
    // il degrado si vede: una riga `info` col motivo (sotto `esito`, l'unica chiave in chiaro per un motivo)
    const info = logger.logEvento.mock.calls.filter(
      (c) => c[1] === 'info' && (c[2] as { tipo?: string })?.tipo === 'calendario-non-disponibile',
    )
    expect(info).toHaveLength(1)
    expect(info[0][2]).toMatchObject({ esito: 'nessun-anno-attivo' })
    expect(redact(info[0][2])).toMatchObject({ esito: 'nessun-anno-attivo' })
  })
})
