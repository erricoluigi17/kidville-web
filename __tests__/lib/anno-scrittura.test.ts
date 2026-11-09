import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// Compito 3.2: `resolveAnnoScrittura`, `annoDellaData`, `annoPerScritturaPubblica`, `conAnno`.
// Database FINTO con `anni_sede`, `correzioni_anno_chiuso` e la RPC `anno_di`. L'orologio non conta
// mai: gli stati sono scritti nel finto, e un test controlla che `Date.now` non venga letto.

const logger = vi.hoisted(() => ({
  logEvento: vi.fn(),
  logOk: vi.fn(),
  logErrore: vi.fn(),
}))
vi.mock('@/lib/logging/logger', () => logger)
vi.mock('@/lib/sezioni/docenti', () => ({ sezioniDiUtente: vi.fn() }))
vi.mock('@/lib/supabase/server-client', () => ({ createAdminClientConHeader: vi.fn() }))

import { resolveAnnoScrittura, annoDellaData } from '@/lib/auth/scope'
import { annoPerScritturaPubblica } from '@/lib/anno/pubblico'
import { conAnno, type EsitoAnno } from '@/lib/anno/tipi'
import type { AppUser } from '@/lib/auth/require-staff'

// ── uuid finti ────────────────────────────────────────────────────────────────
const SEDE = '22222222-2222-4222-8222-222222222222'
const SEDE_UNICA = '33333333-3333-4333-8333-333333333333'
// `anni_scolastici.id`
const A1 = 'a1111111-1111-4111-8111-111111111111'
const A2 = 'a2222222-2222-4222-8222-222222222222'
const A3 = 'a3333333-3333-4333-8333-333333333333'
const A9 = 'a9999999-9999-4999-8999-999999999999'
// `anni_sede.id`
const S1 = 'b1111111-1111-4111-8111-111111111111'
const S2 = 'b2222222-2222-4222-8222-222222222222'
const S3 = 'b3333333-3333-4333-8333-333333333333'
const SU = 'b4444444-4444-4444-8444-444444444444'

type Riga = {
  id: string; scuola_id: string; anno_id: string; stato: string
  domande_aperte: boolean; inizio: string; fine: string
}

function righeNormali(): Riga[] {
  return [
    { id: S1, scuola_id: SEDE, anno_id: A1, stato: 'chiuso', domande_aperte: false, inizio: '2025-09-01', fine: '2026-08-31' },
    { id: S2, scuola_id: SEDE, anno_id: A2, stato: 'corrente', domande_aperte: false, inizio: '2026-09-01', fine: '2027-08-31' },
    { id: S3, scuola_id: SEDE, anno_id: A3, stato: 'in_preparazione', domande_aperte: false, inizio: '2027-09-01', fine: '2028-08-31' },
    { id: SU, scuola_id: SEDE_UNICA, anno_id: A2, stato: 'corrente', domande_aperte: false, inizio: '2026-09-01', fine: '2027-08-31' },
  ]
}

/** Agosto: nessun `corrente` (il vecchio è `in_chiusura`, il nuovo `in_preparazione`). */
function righeAgosto(): Riga[] {
  const r = righeNormali()
  r[1].stato = 'in_chiusura'
  return r
}

// `guardia`: il valore di `anno_regole.guardia_attiva` (default: accesa, così i 409 restano 409);
// `regoleErrore`: la lettura di `anno_regole` fallisce con quel codice.
type Opzioni = {
  righe?: Riga[]; indietro?: boolean; inserimentoFallisce?: boolean
  guardia?: boolean; regoleErrore?: string
  /** La lettura di prova di `listino_voci.scadenza` (4.5.15, I4) fallisce con questo codice. */
  listinoErrore?: string
}

function finto(o: Opzioni = {}) {
  const righe = o.righe ?? righeNormali()
  const scritture: Array<{ tabella: string; righe: Array<Record<string, unknown>> }> = []
  let progressivo = 0

  const errIndietro = { code: 'PGRST205', message: 'Could not find the table in the schema cache' }

  const supabase = {
    from(tabella: string) {
      const filtri: Array<[string, unknown]> = []
      const b = {
        select() { return b },
        eq(col: string, val: unknown) { filtri.push([col, val]); return b },
        limit() { return b },
        insert(nuove: Array<Record<string, unknown>>) {
          if (o.inserimentoFallisce) {
            return { select: async () => ({ data: null, error: { code: '23514', message: 'Failing row contains (segreto)' } }) }
          }
          scritture.push({ tabella, righe: nuove })
          const conId = nuove.map(() => ({ id: `c${++progressivo}000000-0000-4000-8000-00000000000${progressivo}` }))
          return { select: async () => ({ data: conId, error: null }) }
        },
        then(ok: (v: unknown) => unknown) {
          if (o.indietro) return Promise.resolve({ data: null, error: errIndietro }).then(ok)
          if (tabella === 'anno_regole') {
            if (o.regoleErrore) return Promise.resolve({ data: null, error: { code: o.regoleErrore, message: 'x' } }).then(ok)
            return Promise.resolve({ data: [{ guardia_attiva: o.guardia ?? true }], error: null }).then(ok)
          }
          if (tabella === 'listino_voci' && o.listinoErrore) {
            return Promise.resolve({ data: null, error: { code: o.listinoErrore, message: 'x' } }).then(ok)
          }
          const dati = tabella === 'anni_sede'
            ? righe.filter((r) => filtri.every(([c, v]) => (r as Record<string, unknown>)[c] === v))
            : []
          return Promise.resolve({ data: dati, error: null }).then(ok)
        },
      }
      return b
    },
    async rpc(nome: string, args: { p_scuola: string; p_giorno: string }) {
      if (o.indietro) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
      if (nome !== 'anno_di') return { data: null, error: { code: 'PGRST202', message: 'no' } }
      const r = righe.find((x) => x.scuola_id === args.p_scuola && x.inizio <= args.p_giorno && args.p_giorno <= x.fine)
      return { data: r ? r.anno_id : null, error: null }
    },
  }
  return { supabase: supabase as unknown as SupabaseClient, scritture }
}

// ── utenti e richieste ────────────────────────────────────────────────────────
const SEGRETERIA: AppUser = { id: '11111111-1111-4111-8111-111111111111', role: 'segreteria' }
const DIREZIONE: AppUser = { id: '11111111-1111-4111-8111-222222222222', role: 'admin' }
const COORDINATORE: AppUser = { id: '11111111-1111-4111-8111-333333333333', role: 'coordinator' }
const DOCENTE: AppUser = { id: '11111111-1111-4111-8111-444444444444', role: 'educator' }

function richiesta(cookie?: string): NextRequest {
  return new NextRequest('https://app.example/api/x', cookie ? { headers: { cookie } } : undefined)
}

async function leggi(r: EsitoAnno | NextResponse): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!(r instanceof NextResponse)) throw new Error('atteso un NextResponse, ricevuto un esito')
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}

function esito(r: EsitoAnno | NextResponse): EsitoAnno {
  if (r instanceof NextResponse) throw new Error('atteso un esito, ricevuta una risposta ' + r.status)
  return r
}

/** Tutti gli argomenti di tutte le chiamate al logger, come testo. */
function tuttoIlLog(): string {
  return JSON.stringify([logger.logEvento.mock.calls, logger.logOk.mock.calls, logger.logErrore.mock.calls])
}

beforeEach(() => vi.clearAllMocks())

describe('resolveAnnoScrittura — l\'ordine di risoluzione', () => {
  it('1 · dichiarato: a3 (in preparazione) alla segreteria; a un docente 403 ANNO_NON_VISIBILE', async () => {
    const { supabase, scritture } = finto()
    const r = esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, { dichiarato: A3 }))
    expect(r).toEqual({ annoSedeId: S3, annoId: A3, stato: 'in_preparazione', gettone: undefined })
    expect(r.gettone).toBeUndefined()
    expect(scritture).toHaveLength(0)

    const no = await leggi(await resolveAnnoScrittura(richiesta(), supabase, DOCENTE, SEDE, { dichiarato: A3 }))
    expect(no.status).toBe(403)
    expect(no.body.codice).toBe('ANNO_NON_VISIBILE')
    expect(scritture).toHaveLength(0)
  })

  it('2 · cookie: anno_attivo=a1 senza dichiarato → 409 ANNO_CHIUSO; il dichiarato vince sul cookie', async () => {
    const { supabase, scritture } = finto()
    const chiuso = await leggi(await resolveAnnoScrittura(richiesta(`anno_attivo=${A1}`), supabase, SEGRETERIA, SEDE))
    expect(chiuso.status).toBe(409)
    expect(chiuso.body.codice).toBe('ANNO_CHIUSO')
    expect(scritture).toHaveLength(0)

    const vince = esito(await resolveAnnoScrittura(richiesta(`anno_attivo=${A1}`), supabase, SEGRETERIA, SEDE, { dichiarato: A2 }))
    expect(vince.annoId).toBe(A2)
    expect(vince.stato).toBe('corrente')
  })

  it('2b · un cookie che non è un uuid si ignora, come se mancasse', async () => {
    const { supabase } = finto()
    for (const cattivo of ['anno_attivo=non-un-uuid', 'anno_attivo=', `anno_attivo=${A1}x`]) {
      const r = esito(await resolveAnnoScrittura(richiesta(cattivo), supabase, SEGRETERIA, SEDE))
      expect(r.annoId, cattivo).toBe(A2)
    }
  })

  it('2c · il cookie lo segue solo lo staff, come in lettura: un docente col cookie su a3 scrive su a2 (warn), la segreteria su a3', async () => {
    const { supabase } = finto()
    const docente = esito(await resolveAnnoScrittura(richiesta(`anno_attivo=${A3}`), supabase, DOCENTE, SEDE))
    expect(docente.annoId).toBe(A2)
    const avvisi = logger.logEvento.mock.calls.filter((c) => c[1] === 'warn').map((c) => (c[2] as { tipo?: string }).tipo)
    expect(avvisi).toContain('anno-cookie-ignorato-ruolo')

    logger.logEvento.mockClear()
    // senza cookie nessun warn
    esito(await resolveAnnoScrittura(richiesta(), supabase, DOCENTE, SEDE))
    expect(tuttoIlLog()).not.toContain('anno-cookie-ignorato-ruolo')

    const staff = esito(await resolveAnnoScrittura(richiesta(`anno_attivo=${A3}`), supabase, SEGRETERIA, SEDE))
    expect(staff.annoId).toBe(A3)
    expect(tuttoIlLog()).not.toContain('anno-cookie-ignorato-ruolo')
  })

  it('3 · unico corrente: niente dichiarato né cookie → a2, senza leggere l\'orologio', async () => {
    const { supabase } = finto()
    const spia = vi.spyOn(Date, 'now')
    try {
      const r = esito(await resolveAnnoScrittura(richiesta(), supabase, DOCENTE, SEDE))
      expect(r).toEqual({ annoSedeId: S2, annoId: A2, stato: 'corrente' })
      const unica = esito(await resolveAnnoScrittura(richiesta(), supabase, DOCENTE, SEDE_UNICA))
      expect(unica.annoSedeId).toBe(SU)
      expect(spia).not.toHaveBeenCalled()
    } finally {
      spia.mockRestore()
    }
  })

  it('4 · agosto: nessun corrente, nessun cookie, nessun dichiarato → 400 ANNO_DA_SPECIFICARE, warn, zero scritture', async () => {
    const { supabase, scritture } = finto({ righe: righeAgosto() })
    const r = await leggi(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE))
    expect(r.status).toBe(400)
    expect(r.body.codice).toBe('ANNO_DA_SPECIFICARE')
    expect(scritture).toHaveLength(0)
    const chiamata = logger.logEvento.mock.calls.find((c) => c[2]?.tipo === 'anno-scrittura-ambigua')
    expect(chiamata).toBeDefined()
    expect(chiamata![0]).toBe('anno-scolastico')
    expect(chiamata![1]).toBe('warn')
    // Ruling P17: il codice sta in `error_code`, mai in `codice` (non è nella lista bianca).
    expect(chiamata![2].error_code).toBe('ANNO_DA_SPECIFICARE')
    expect('codice' in chiamata![2]).toBe(false)
    expect(chiamata![2]).toMatchObject({
      azione: 'resolveAnnoScrittura', utente: SEGRETERIA.id, ruolo: 'segreteria', anni_candidati: 2,
    })
  })

  it('5 · ANNO_NON_DELLA_SEDE: un anno che la sede non ha → 400 + warn con error_code', async () => {
    const { supabase, scritture } = finto()
    const r = await leggi(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE_UNICA, { dichiarato: A3 }))
    expect(r.status).toBe(400)
    expect(r.body.codice).toBe('ANNO_NON_DELLA_SEDE')
    expect(scritture).toHaveLength(0)
    const w = logger.logEvento.mock.calls.find((c) => c[2]?.error_code === 'ANNO_NON_DELLA_SEDE')
    expect(w?.[1]).toBe('warn')
    expect(w?.[2] && 'codice' in w[2]).toBe(false)
    // Un uuid sconosciuto qualunque: stessa risposta. Anche dal cookie.
    expect((await leggi(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, { dichiarato: A9 }))).status).toBe(400)
    expect((await leggi(await resolveAnnoScrittura(richiesta(`anno_attivo=${A9}`), supabase, SEGRETERIA, SEDE))).body.codice).toBe('ANNO_NON_DELLA_SEDE')
  })
})

describe('resolveAnnoScrittura — gli stati protetti e i gettoni', () => {
  it('6 · in_chiusura: il docente 409; segreteria e direzione ricevono un gettone `agosto`', async () => {
    const { supabase, scritture } = finto({ righe: righeAgosto() })
    const no = await leggi(await resolveAnnoScrittura(richiesta(), supabase, DOCENTE, SEDE, { dichiarato: A2 }))
    expect(no.status).toBe(409)
    expect(no.body.codice).toBe('ANNO_CHIUSO')
    expect(scritture).toHaveLength(0)

    for (const utente of [SEGRETERIA, DIREZIONE, COORDINATORE]) {
      scritture.length = 0
      const r = esito(await resolveAnnoScrittura(richiesta(), supabase, utente, SEDE, { dichiarato: A2 }))
      expect(r.stato).toBe('in_chiusura')
      expect(r.gettone).toBeTruthy()
      expect(scritture).toHaveLength(1)
      expect(scritture[0].tabella).toBe('correzioni_anno_chiuso')
      expect(scritture[0].righe).toEqual([
        { utente_id: utente.id, ruolo: utente.role, anno_sede_id: S2, codice: 'agosto' },
      ])
      // `scade_il` = +10 minuti lo mette il DEFAULT della colonna: l'app non passa un orologio.
      expect('scade_il' in scritture[0].righe[0]).toBe(false)
    }
  })

  it('7 · chiuso: senza correzione 409; con correzione gettone `correzione` col motivo NELLA RIGA e in nessun log', async () => {
    const { supabase, scritture } = finto()
    const senza = await leggi(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, { dichiarato: A1 }))
    expect(senza.status).toBe(409)
    expect(scritture).toHaveLength(0)

    const MOTIVO = 'errore di battitura'
    const r = esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, {
      dichiarato: A1, correzione: { motivo: `  ${MOTIVO}  ` },
    }))
    expect(r).toMatchObject({ annoSedeId: S1, annoId: A1, stato: 'chiuso' })
    expect(r.gettone).toBeTruthy()
    expect(scritture[0].righe).toEqual([
      { utente_id: SEGRETERIA.id, ruolo: 'segreteria', anno_sede_id: S1, codice: 'correzione', motivo: MOTIVO },
    ])
    expect(tuttoIlLog()).not.toContain(MOTIVO)
  })

  it('7b · il motivo non esce nemmeno se la creazione del gettone fallisce (il CHECK riporta la riga)', async () => {
    const { supabase } = finto({ inserimentoFallisce: true })
    const MOTIVO = 'testo riservato del motivo'
    const r = await leggi(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, {
      dichiarato: A1, correzione: { motivo: MOTIVO },
    }))
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain(MOTIVO)
    expect(tuttoIlLog()).not.toContain(MOTIVO)
    expect(tuttoIlLog()).not.toContain('segreto') // il messaggio di Postgres non va nel log
    expect(logger.logEvento.mock.calls.some((c) => c[2]?.error_code === '23514')).toBe(true)
  })

  it('7c · motivo vuoto o di soli spazi → 400 MOTIVO_OBBLIGATORIO e nessun gettone', async () => {
    const { supabase, scritture } = finto()
    for (const motivo of ['', '   ', '\n\t ']) {
      const r = await leggi(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, {
        dichiarato: A1, correzione: { motivo },
      }))
      expect(r.status, JSON.stringify(motivo)).toBe(400)
      expect(r.body.codice).toBe('MOTIVO_OBBLIGATORIO')
    }
    expect(scritture).toHaveLength(0)
  })

  it('7d · un docente con `correzione` → 409, mai un gettone (nemmeno con un motivo vuoto)', async () => {
    const { supabase, scritture } = finto()
    for (const motivo of ['errore di battitura', '']) {
      const r = await leggi(await resolveAnnoScrittura(richiesta(), supabase, DOCENTE, SEDE, {
        dichiarato: A1, correzione: { motivo },
      }))
      expect(r.status).toBe(409)
      expect(r.body.codice).toBe('ANNO_CHIUSO')
    }
    expect(scritture).toHaveLength(0)
  })

  it('7e · una correzione su un anno corrente non crea nessun gettone', async () => {
    const { supabase, scritture } = finto()
    const r = esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, {
      dichiarato: A2, correzione: { motivo: 'inutile' },
    }))
    expect(r.gettone).toBeUndefined()
    expect(scritture).toHaveLength(0)
  })

  it('8 · usi: 3 → tre gettoni distinti, stesso anno_sede_id e stesso utente; usi: 11 → 10; usi strani → 1', async () => {
    const { supabase, scritture } = finto()
    const r = esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, {
      dichiarato: A1, correzione: { motivo: 'm' }, usi: 3,
    }))
    expect(r.gettoni).toHaveLength(3)
    expect(new Set(r.gettoni).size).toBe(3)
    expect(r.gettone).toBe(r.gettoni![0])
    const righe = scritture[0].righe
    expect(righe).toHaveLength(3)
    expect(new Set(righe.map((x) => x.anno_sede_id))).toEqual(new Set([S1]))
    expect(new Set(righe.map((x) => x.utente_id))).toEqual(new Set([SEGRETERIA.id]))

    for (const [usi, attesi] of [[11, 10], [1000, 10], [0, 1], [-4, 1], [2.9, 2], [Number.NaN, 1]] as const) {
      scritture.length = 0
      await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, { dichiarato: A1, correzione: { motivo: 'm' }, usi })
      expect(scritture[0].righe, `usi=${usi}`).toHaveLength(attesi)
    }
  })

  it('9 · uuid in maiuscolo nel dichiarato e nel cookie → stessa risposta della forma minuscola', async () => {
    const { supabase } = finto()
    const minuscolo = esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, { dichiarato: A3 }))
    const maiuscolo = esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE, { dichiarato: A3.toUpperCase() }))
    expect(maiuscolo).toEqual(minuscolo)
    expect(maiuscolo.annoId).toBe(A3) // la forma canonica, quella del database

    const dalCookie = esito(await resolveAnnoScrittura(richiesta(`anno_attivo=${A3.toUpperCase()}`), supabase, SEGRETERIA, SEDE))
    expect(dalCookie).toEqual(minuscolo)
  })
})

describe('schema indietro (il database della CI) e conAnno', () => {
  it('10 · PGRST205 su anni_sede → schemaIndietro, nessun 5xx, info `schema-anno-indietro`', async () => {
    const { supabase, scritture } = finto({ indietro: true })
    const r = esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE))
    expect(r).toEqual({ annoSedeId: null, annoId: null, stato: null, schemaIndietro: true })
    expect(scritture).toHaveLength(0)
    const i = logger.logEvento.mock.calls.find((c) => c[2]?.tipo === 'schema-anno-indietro')
    expect(i?.[0]).toBe('anno-scolastico')
    expect(i?.[1]).toBe('info')
    expect(logger.logErrore).not.toHaveBeenCalled()
  })

  it('10b · conAnno: {} con schemaIndietro, { anno_id } con un anno normale', async () => {
    const { supabase } = finto({ indietro: true })
    expect(conAnno(esito(await resolveAnnoScrittura(richiesta(), supabase, SEGRETERIA, SEDE)))).toEqual({})
    const { supabase: ok } = finto()
    const normale = esito(await resolveAnnoScrittura(richiesta(), ok, SEGRETERIA, SEDE))
    expect(conAnno(normale)).toEqual({ anno_id: A2 })
  })

  it('10c · un errore che NON è schema indietro è un 500 con log `error`', async () => {
    const guasto = {
      from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { code: '57014', message: 'timeout' } }) }) }),
    } as unknown as SupabaseClient
    const r = await leggi(await resolveAnnoScrittura(richiesta(), guasto, SEGRETERIA, SEDE))
    expect(r.status).toBe(500)
    expect(logger.logEvento.mock.calls.some((c) => c[1] === 'error' && c[2]?.tipo === 'anno-lettura-fallita')).toBe(true)
  })
})

describe('annoDellaData', () => {
  it('11 · 2026-08-31 → a1 (chiuso), 2026-09-01 → a2; la segreteria su a1 senza correzione → 409', async () => {
    const { supabase, scritture } = finto()
    const spia = vi.spyOn(Date, 'now')
    try {
      const corrente = esito(await annoDellaData(supabase, DOCENTE, SEDE, '2026-09-01'))
      expect(corrente).toEqual({ annoSedeId: S2, annoId: A2, stato: 'corrente' })
      const confine = await leggi(await annoDellaData(supabase, SEGRETERIA, SEDE, '2026-08-31'))
      expect(confine.status).toBe(409)
      expect(confine.body.codice).toBe('ANNO_CHIUSO')
      expect(scritture).toHaveLength(0)
      expect(spia).not.toHaveBeenCalled()
    } finally {
      spia.mockRestore()
    }
    const corretto = esito(await annoDellaData(supabase, SEGRETERIA, SEDE, '2026-08-31', { correzione: { motivo: 'm' } }))
    expect(corretto).toMatchObject({ annoSedeId: S1, annoId: A1, stato: 'chiuso' })
    expect(corretto.gettone).toBeTruthy()
  })

  it('11b · un giorno senza anno → 500 GIORNO_SENZA_ANNO con logErrore', async () => {
    const { supabase } = finto()
    const r = await leggi(await annoDellaData(supabase, SEGRETERIA, SEDE, '2031-01-01'))
    expect(r.status).toBe(500)
    expect(r.body.codice).toBe('GIORNO_SENZA_ANNO')
    expect(logger.logErrore).toHaveBeenCalledTimes(1)
  })

  it('11c · schema indietro → schemaIndietro, nessun 5xx', async () => {
    const { supabase } = finto({ indietro: true })
    const r = esito(await annoDellaData(supabase, SEGRETERIA, SEDE, '2026-09-01'))
    expect(r.schemaIndietro).toBe(true)
    expect(conAnno(r)).toEqual({})
  })
})

describe('annoPerScritturaPubblica', () => {
  it('12 · il corrente della sede; annoId ignorato se domande_aperte è false; accettato se è true', async () => {
    // 4.5.7: se NESSUN anno ha le domande aperte la porta è chiusa (`chiuso`), non "il corrente comunque".
    const { supabase: chiuse } = finto()
    expect(await annoPerScritturaPubblica(chiuse, SEDE)).toEqual({ annoSedeId: null, annoId: null, chiuso: true })

    const righeCorrente = righeNormali()
    righeCorrente[1].domande_aperte = true
    const { supabase } = finto({ righe: righeCorrente })
    expect(await annoPerScritturaPubblica(supabase, SEDE)).toEqual({ annoSedeId: S2, annoId: A2 })
    expect(await annoPerScritturaPubblica(supabase, SEDE, { annoId: A3 })).toEqual({ annoSedeId: S2, annoId: A2 })

    const righe = righeNormali()
    righe[2].domande_aperte = true
    const { supabase: aperte } = finto({ righe })
    expect(await annoPerScritturaPubblica(aperte, SEDE, { annoId: A3 })).toEqual({ annoSedeId: S3, annoId: A3 })
    expect(await annoPerScritturaPubblica(aperte, SEDE, { annoId: A3.toUpperCase() })).toEqual({ annoSedeId: S3, annoId: A3 })
  })

  it('12b · schema indietro; in agosto senza annoId → senzaAnno (mai un rifiuto)', async () => {
    const { supabase: indietro } = finto({ indietro: true })
    expect(await annoPerScritturaPubblica(indietro, SEDE)).toEqual({ annoSedeId: null, annoId: null, schemaIndietro: true })
    // 4.5.7: con tutte le domande sospese sarebbe `chiuso`; qui il nuovo anno le ha aperte e manca solo il `corrente`.
    const righeAgostoAperte = righeAgosto()
    righeAgostoAperte[2].domande_aperte = true
    const { supabase: agosto } = finto({ righe: righeAgostoAperte })
    logger.logEvento.mockClear()
    expect(await annoPerScritturaPubblica(agosto, SEDE)).toEqual({ annoSedeId: null, annoId: null, senzaAnno: true })
    // P18: senza il warn, ad agosto ogni domanda pubblica finirebbe senza anno e nessuno lo vedrebbe.
    const w = logger.logEvento.mock.calls.find((c) => c[2]?.tipo === 'anno-pubblico-senza-corrente')
    expect(w?.[0]).toBe('anno-scolastico')
    expect(w?.[1]).toBe('warn')
    expect(w?.[2].error_code).toBe('ANNO_DA_SPECIFICARE')
    expect('codice' in w![2]).toBe(false)
    expect(w?.[2].scuola_id).toBe(SEDE)
  })

  it('12c · non riceve `request`: nessun cookie può influire (la firma è (supabase, scuolaId, opzioni))', () => {
    expect(annoPerScritturaPubblica.length).toBeLessThanOrEqual(3)
    // Un cookie nel processo non cambia niente: la funzione non ha modo di leggerlo.
    expect(annoPerScritturaPubblica.toString()).not.toMatch(/cookie/i)
  })
})

describe('annoPerScritturaPubblica · la finestra del deploy (4.5.15, I4)', () => {
  // `domande_aperte` nasce spento per tutte le righe e lo riempie M45d, la stessa migrazione che crea `listino_voci.scadenza`.
  // Finché la colonna non c'è, "nessun anno offerto" non vuol dire "iscrizioni chiuse": vuol dire "il riempimento non è ancora passato".
  const eventi = (tipo: string) => logger.logEvento.mock.calls.filter((c) => c[2]?.tipo === tipo)
  beforeEach(() => logger.logEvento.mockClear())

  it('colonna ASSENTE (42703): la domanda si accetta come oggi (schema indietro), non è "chiuso"', async () => {
    const { supabase } = finto({ listinoErrore: '42703' })
    expect(await annoPerScritturaPubblica(supabase, SEDE)).toEqual({ annoSedeId: null, annoId: null, schemaIndietro: true })
    expect(eventi('anno-pubblico-chiuso')).toHaveLength(0)
  })

  it('colonna presente e flag spento: chiuso, e il log sale a `warn` perché a essere chiuso è il corrente', async () => {
    const { supabase } = finto()
    expect(await annoPerScritturaPubblica(supabase, SEDE)).toEqual({ annoSedeId: null, annoId: null, chiuso: true })
    const chiuso = eventi('anno-pubblico-chiuso')
    expect(chiuso).toHaveLength(1)
    expect(chiuso[0][1]).toBe('warn')
  })

  it('colonna presente, flag spento e NESSUN corrente (solo anni chiusi o in preparazione): chiuso, log `info`', async () => {
    const righe = righeNormali().filter((r) => r.stato !== 'corrente')
    const { supabase } = finto({ righe })
    expect(await annoPerScritturaPubblica(supabase, SEDE)).toEqual({ annoSedeId: null, annoId: null, chiuso: true })
    expect(eventi('anno-pubblico-chiuso')[0][1]).toBe('info')
  })

  it('errore GENERICO nella lettura di prova: non si chiude, la domanda si accetta e si dice con un `warn`', async () => {
    const { supabase } = finto({ listinoErrore: '57014' })
    expect(await annoPerScritturaPubblica(supabase, SEDE)).toEqual({ annoSedeId: null, annoId: null, schemaIndietro: true })
    expect(eventi('anno-pubblico-chiuso')).toHaveLength(0)
    const sonda = eventi('anno-pubblico-sonda-listino-fallita')
    expect(sonda).toHaveLength(1)
    expect(sonda[0][1]).toBe('warn')
  })

  it('con un anno che accetta domande la lettura di prova non serve: nemmeno la si tenta', async () => {
    const righe = righeNormali()
    righe[1].domande_aperte = true
    const { supabase } = finto({ righe, listinoErrore: '42703' })
    expect(await annoPerScritturaPubblica(supabase, SEDE)).toEqual({ annoSedeId: S2, annoId: A2 })
  })
})

describe('P48 · finché la guardia è spenta un anno chiuso non si rifiuta: si osserva', () => {
  const osservati = () => logger.logEvento.mock.calls.filter((c) => c[2]?.tipo === 'anno-chiuso-osservato')

  it('chiuso dichiarato senza correzione: guardia spenta → osservato (conAnno = {}), un warn; accesa → 409; lettura in errore → osservato', async () => {
    const spenta = finto({ guardia: false })
    const o = esito(await resolveAnnoScrittura(richiesta(), spenta.supabase, SEGRETERIA, SEDE, { dichiarato: A1 }))
    expect(o.osservato).toBe(true)
    expect(o.annoId).toBeNull()
    expect(o.gettone).toBeUndefined()
    expect(conAnno(o)).toEqual({})
    expect(spenta.scritture).toHaveLength(0)
    expect(osservati()).toHaveLength(1)
    const w = osservati()[0]
    expect(w[0]).toBe('anno-scolastico')
    expect(w[1]).toBe('warn')
    expect(w[2]).toMatchObject({ azione: 'resolveAnnoScrittura', error_code: 'ANNO_CHIUSO', anno_sede_id: S1 })
    expect('codice' in w[2]).toBe(false)
    expect('motivo' in w[2]).toBe(false)

    const accesa = finto({ guardia: true })
    const r = await leggi(await resolveAnnoScrittura(richiesta(), accesa.supabase, SEGRETERIA, SEDE, { dichiarato: A1 }))
    expect(r.status).toBe(409)
    expect(r.body.codice).toBe('ANNO_CHIUSO')

    logger.logEvento.mockClear()
    for (const codice of ['XX000', 'PGRST205']) {
      const rotta = finto({ regoleErrore: codice })
      const e = esito(await resolveAnnoScrittura(richiesta(), rotta.supabase, SEGRETERIA, SEDE, { dichiarato: A1 }))
      expect(e.osservato).toBe(true)
      expect(conAnno(e)).toEqual({})
    }
    expect(osservati()).toHaveLength(2)
  })

  it('in_chiusura, docente: stessa regola (guardia spenta → osservato; accesa → 409); lo staff riceve ancora il gettone', async () => {
    const spenta = finto({ righe: righeAgosto(), guardia: false })
    const o = esito(await resolveAnnoScrittura(richiesta(), spenta.supabase, DOCENTE, SEDE, { dichiarato: A2 }))
    expect(o.osservato).toBe(true)
    expect(conAnno(o)).toEqual({})
    expect(osservati()).toHaveLength(1)
    const accesa = finto({ righe: righeAgosto(), guardia: true })
    expect((await leggi(await resolveAnnoScrittura(richiesta(), accesa.supabase, DOCENTE, SEDE, { dichiarato: A2 }))).status).toBe(409)
    const staff = esito(await resolveAnnoScrittura(richiesta(), spenta.supabase, SEGRETERIA, SEDE, { dichiarato: A2 }))
    expect(staff.osservato).toBeUndefined()
    expect(staff.gettone).toBeDefined()
  })

  it('il ramo con correzione e ANNO_NON_VISIBILE non cambiano; annoDellaData applica la stessa regola', async () => {
    const f = finto({ guardia: false })
    const c = esito(await resolveAnnoScrittura(richiesta(), f.supabase, SEGRETERIA, SEDE, { dichiarato: A1, correzione: { motivo: 'rettifica' } }))
    expect(c.osservato).toBeUndefined()
    expect(c.gettone).toBeDefined()
    expect((await leggi(await resolveAnnoScrittura(richiesta(), f.supabase, DOCENTE, SEDE, { dichiarato: A3 }))).status).toBe(403)
    const d = esito(await annoDellaData(f.supabase, SEGRETERIA, SEDE, '2026-03-10'))
    expect(d.osservato).toBe(true)
    expect(conAnno(d)).toEqual({})
    const acc = finto({ guardia: true })
    expect((await leggi(await annoDellaData(acc.supabase, SEGRETERIA, SEDE, '2026-03-10'))).status).toBe(409)
  })
})

afterEach(() => vi.restoreAllMocks())
