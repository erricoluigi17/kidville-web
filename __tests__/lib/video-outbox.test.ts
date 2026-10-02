// @vitest-environment node

/**
 * IL CONSUMO DI `video_outbox`, ESTRATTO DALLA RETENTION IN `src/lib/media/video/outbox/`.
 *
 * Fino a questa consegna la coda la consumava solo la retention
 * (`/api/gdpr/retention-video`), con il motore e il registro dei destinatari scritti dentro
 * la route. Ora i consumatori sono due — la retention, che prende tutto, e il runner, che
 * prende solo i tipi suoi — e il motore sta in un modulo che li serve entrambi. La suite della
 * retention (`__tests__/api/gdpr-retention-video.test.ts`) prova che il comportamento della
 * route non è cambiato; questa prova il modulo in sé, per ciò che alla retention non serviva:
 * il filtro per tipo, il limite, e l'estensione del registro.
 *
 * ─── DUE LIVELLI DI PROVA, E PERCHÉ SONO DUE ────────────────────────────────
 *
 * 1. Un doppio SCRIPTATO di `supabase`, che registra ogni chiamata. Prova che cosa il modulo
 *    CHIEDE: quale RPC, con quali argomenti, in che ordine, e che cosa grida.
 * 2. PGlite con le RPC VERE (`video_outbox_claim`, `_sent`, `_fail`, lette dal file di
 *    migrazione sul disco). Prova che cosa SUCCEDE alla coda: il backoff è del database, la
 *    quarantena pure, e un doppio che rispondesse «ok» a tutto direbbe di sì a un consumo che
 *    brucia i venticinque tentativi in sedici millisecondi — è la misura che ha scritto il
 *    backoff, e un mock piatto è verde con e senza.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'

// ═══════════════════════════════════════════════════════════════════════════════
// I DOPPI, E TUTTO CIÒ CHE VA DICHIARATO PRIMA DEGLI IMPORT
// ═══════════════════════════════════════════════════════════════════════════════

const CRON_SECRET = 'segreto-di-prova-outbox-non-usato-altrove'

const h = vi.hoisted(() => ({
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown>; errore: unknown }[],
  // ── per la prova che la route della retention colleghi il modulo coi numeri di sempre ──
  rpc: [] as { nome: string; argomenti: Record<string, unknown> }[],
  claim: { ok: true, eventi: [] as unknown[] } as unknown,
  senzaScadenzaPerIntent: 0,
}))

vi.mock('@/lib/logging/logger', () => ({
  logEvento: (evento: string, livello: string, campi: Record<string, unknown>, errore?: unknown) => {
    h.eventi.push({ evento, livello, campi, errore })
  },
  logErrore: () => {},
  logOk: () => {},
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: vi.fn(async () => ({ user: null, response: new Response('no', { status: 403 }) })),
}))

// Il client della route: risponde «niente da fare» a tutto tranne che al claim, che è l'unica
// cosa che qui interessa. Le altre fasi della retention hanno la loro suite.
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => {
    const query = () => {
      const qb: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'not', 'lte', 'order', 'limit', 'in']) qb[m] = () => qb
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null, count: h.senzaScadenzaPerIntent }).then(res)
      return qb
    }
    return {
      from: query,
      rpc: (nome: string, argomenti: Record<string, unknown>) => {
        h.rpc.push({ nome, argomenti })
        if (nome === 'video_outbox_claim') return Promise.resolve({ data: h.claim, error: null })
        return Promise.resolve({ data: { ok: true }, error: null })
      },
      storage: {
        from: () => ({
          remove: () => Promise.resolve({ data: [], error: null }),
          list: () => Promise.resolve({ data: [], error: null }),
        }),
      },
    }
  },
}))

import { POST } from '@/app/api/gdpr/retention-video/route'
import {
  consumaOutbox,
  DESTINATARI,
  LEASE_PREDEFINITA_SECONDI,
  OUTBOX_NON_ESEGUITO,
  ricevutaRetention,
  type Destinatario,
  type EsitoConsegna,
  type EventoOutbox,
  type RegistroDestinatari,
} from '@/lib/media/video/outbox'

const INTENT = '30000000-0000-4000-8000-000000000003'

type Chiamata = { nome: string; argomenti: Record<string, unknown> }
type Risposta = { data: unknown; error: unknown }

let contatore = 0

function evento(tipo: string, extra: Partial<EventoOutbox> = {}): EventoOutbox {
  contatore += 1
  return {
    id: `60000000-0000-4000-8000-${String(contatore).padStart(12, '0')}`,
    intent_id: INTENT,
    revision: 1,
    event_type: tipo,
    attempts: 1,
    ...extra,
  }
}

const preso = (...eventi: EventoOutbox[]): Risposta => ({ data: { ok: true, eventi }, error: null })

/** Il doppio scriptato: registra ogni RPC e ogni query, e risponde come gli si dice. */
function doppio(
  opzioni: {
    claim?: Risposta
    chiusura?: (c: Chiamata) => Risposta
    conteggio?: { count: number | null; error: unknown }
  } = {},
) {
  const chiamate: Chiamata[] = []
  const query: {
    tabella: string
    colonne?: string
    opzioni?: unknown
    clausole: { metodo: string; argomenti: unknown[] }[]
  }[] = []
  const supabase = {
    rpc: (nome: string, argomenti: Record<string, unknown>) => {
      const chiamata = { nome, argomenti }
      chiamate.push(chiamata)
      if (nome === 'video_outbox_claim') {
        return Promise.resolve(opzioni.claim ?? { data: { ok: true, eventi: [] }, error: null })
      }
      return Promise.resolve(opzioni.chiusura ? opzioni.chiusura(chiamata) : { data: { ok: true }, error: null })
    },
    from: (tabella: string) => {
      const registro: (typeof query)[number] = { tabella, clausole: [] }
      query.push(registro)
      const qb: Record<string, unknown> = {}
      qb.select = (colonne: string, opz?: unknown) => {
        registro.colonne = colonne
        registro.opzioni = opz
        return qb
      }
      for (const m of ['eq', 'is']) {
        qb[m] = (...argomenti: unknown[]) => {
          registro.clausole.push({ metodo: m, argomenti })
          return qb
        }
      }
      qb.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: null, ...(opzioni.conteggio ?? { count: 0, error: null }) }).then(res)
      return qb
    },
  } as unknown as SupabaseClient
  return { supabase, chiamate, query }
}

/** Un destinatario che registra chi riceve e risponde con l'esito dato (o lo calcola). */
function destinatario(esito: EsitoConsegna | (() => EsitoConsegna | Promise<EsitoConsegna>)) {
  const visti: EventoOutbox[] = []
  const contesti: { operazione: string }[] = []
  const fn: Destinatario = async (_supabase, ev, contesto) => {
    visti.push(ev)
    contesti.push(contesto)
    return typeof esito === 'function' ? esito() : esito
  }
  return { fn, visti, contesti }
}

const chiamateDi = (chiamate: Chiamata[], nome: string) => chiamate.filter((c) => c.nome === nome)
const logDi = (esito: string) => h.eventi.filter((e) => e.campi.esito === esito)
const OPERAZIONE = 'video-prova'

beforeEach(() => {
  h.eventi = []
  h.rpc = []
  h.claim = { ok: true, eventi: [] }
  h.senzaScadenzaPerIntent = 0
})

// ═══════════════════════════════════════════════════════════════════════════════
// 1. IL FILTRO PER TIPO
// ═══════════════════════════════════════════════════════════════════════════════

describe('il filtro per tipo: chi consuma solo i propri eventi lascia stare gli altri', () => {
  it('consegna i tipi richiesti e NON tocca gli altri: né consegnati, né falliti', async () => {
    const a1 = evento('tipo.mio')
    const altrui = evento('tipo.altrui')
    const a2 = evento('tipo.mio')
    const { supabase, chiamate } = doppio({ claim: preso(a1, altrui, a2) })
    const mio = destinatario({ consegnato: true })
    const dellAltro = destinatario({ consegnato: true })

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      tipi: ['tipo.mio'],
      destinatari: { 'tipo.mio': mio.fn, 'tipo.altrui': dellAltro.fn },
    })

    expect(esito).toEqual({ esito: 'ok', presi: 3, inviati: 2, falliti: 0, senzaDestinatario: 0, saltati: 1 })
    expect(mio.visti.map((e) => e.id)).toEqual([a1.id, a2.id])
    expect(dellAltro.visti, 'il destinatario di un tipo fuori filtro è stato chiamato').toEqual([])
    // Solo i due eventi propri sono stati chiusi, e come consegnati: sull'altro non si è
    // chiamata nessuna RPC di chiusura.
    expect(chiamateDi(chiamate, 'video_outbox_sent').map((c) => c.argomenti.p_evento_id)).toEqual([a1.id, a2.id])
    expect(chiamateDi(chiamate, 'video_outbox_fail')).toEqual([])
    expect(chiamate.some((c) => c.argomenti.p_evento_id === altrui.id), 'l\'evento altrui è stato chiuso').toBe(false)
  })

  it('un tipo fuori filtro senza destinatario NON grida: non è affar suo', async () => {
    // Il caso che sbaglia chi applica il filtro DOPO la ricerca del destinatario: il runner
    // si metterebbe a gridare `outbox-senza-destinatario` per eventi che non deve gestire, e
    // li farebbe fallire con DESTINATARIO_ASSENTE bruciando i loro tentativi.
    const { supabase, chiamate } = doppio({ claim: preso(evento('tipo.ignoto')) })

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      tipi: ['tipo.mio'],
      destinatari: {},
    })

    expect(esito).toMatchObject({ presi: 1, inviati: 0, falliti: 0, senzaDestinatario: 0, saltati: 1 })
    expect(chiamateDi(chiamate, 'video_outbox_fail')).toEqual([])
    expect(logDi('outbox-senza-destinatario')).toEqual([])
  })

  it('senza filtro consegna tutti i tipi, e la riga del giro resta quella di sempre (nessun `n_saltati`)', async () => {
    const { supabase, chiamate } = doppio({ claim: preso(evento('tipo.a'), evento('tipo.b')) })
    const a = destinatario({ consegnato: true })
    const b = destinatario({ consegnato: true })

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      destinatari: { 'tipo.a': a.fn, 'tipo.b': b.fn },
    })

    expect(esito).toMatchObject({ presi: 2, inviati: 2, saltati: 0 })
    expect(chiamateDi(chiamate, 'video_outbox_sent')).toHaveLength(2)
    // La retention legge questa riga da `app_log`: il filtro non deve cambiarne la forma.
    const riga = logDi('outbox-svuotato')[0]
    expect(riga.campi).toEqual({
      operazione: OPERAZIONE,
      esito: 'outbox-svuotato',
      n_righe: 2,
      n_inviati: 2,
      n_falliti: 0,
      n_senza_destinatario: 0,
    })
  })

  it('con il filtro la riga del giro dichiara anche quanti eventi ha saltato', async () => {
    const { supabase } = doppio({ claim: preso(evento('tipo.mio'), evento('tipo.altrui'), evento('tipo.altrui')) })

    await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      tipi: ['tipo.mio'],
      destinatari: { 'tipo.mio': destinatario({ consegnato: true }).fn },
    })

    expect(logDi('outbox-svuotato')[0].campi).toMatchObject({ n_righe: 3, n_inviati: 1, n_saltati: 2 })
  })

  it('un elenco vuoto non prende niente: sarebbe consumare un tentativo a ogni evento per saltarli tutti', async () => {
    const { supabase, chiamate } = doppio({ claim: preso(evento('tipo.mio')) })

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10, tipi: [] })

    expect(chiamate, 'con un filtro vuoto il giro ha comunque chiamato il database').toEqual([])
    expect(esito).toEqual({ ...OUTBOX_NON_ESEGUITO, esito: 'nessun-tipo' })
    // Un errore di chi chiama non è una nota a piè di pagina: livello `error`.
    const grido = logDi('outbox-nessun-tipo')[0]
    expect(grido?.livello).toBe('error')
    expect(grido?.campi.operazione).toBe(OPERAZIONE)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. IL LIMITE E LA LEASE
// ═══════════════════════════════════════════════════════════════════════════════

describe('il limite e la lease passano al claim come li dichiara chi chiama', () => {
  it('limite e lease del chiamante arrivano alla RPC, senza numeri propri', async () => {
    const { supabase, chiamate } = doppio()

    await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 5, leaseSecondi: 45 })

    expect(chiamateDi(chiamate, 'video_outbox_claim')).toHaveLength(1)
    expect(chiamateDi(chiamate, 'video_outbox_claim')[0].argomenti).toMatchObject({
      p_limite: 5,
      p_lease_seconds: 45,
    })
  })

  it('senza una lease dichiarata si usano i 120 secondi di sempre', async () => {
    const { supabase, chiamate } = doppio()

    await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 25 })

    expect(LEASE_PREDEFINITA_SECONDI).toBe(120)
    expect(chiamateDi(chiamate, 'video_outbox_claim')[0].argomenti).toMatchObject({
      p_limite: 25,
      p_lease_seconds: 120,
    })
  })

  it('un limite che il database rifiuta (fuori da 1..100) non fa partire il giro, e si grida col suo codice', async () => {
    const { supabase, chiamate } = doppio({ claim: { data: { ok: false, code: 'BAD_INPUT' }, error: null } })

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 500 })

    expect(esito).toEqual({ ...OUTBOX_NON_ESEGUITO, esito: 'claim-rifiutato' })
    expect(chiamate.map((c) => c.nome)).toEqual(['video_outbox_claim'])
    const grido = logDi('outbox-claim-rifiutato')[0]
    expect(grido.livello).toBe('error')
    expect(grido.campi.error_code).toBe('BAD_INPUT')
  })

  it('la lease del claim è la STESSA che chiude ogni evento; due giri hanno due lease diverse', async () => {
    const primo = doppio({ claim: preso(evento('tipo.a'), evento('tipo.b')) })
    const secondo = doppio({ claim: preso(evento('tipo.a')) })
    const registro = {
      'tipo.a': destinatario({ consegnato: true }).fn,
      'tipo.b': destinatario({ consegnato: false, codice: 'NON_PRONTO' }).fn,
    }

    await consumaOutbox(primo.supabase, { operazione: OPERAZIONE, limite: 10, destinatari: registro })
    await consumaOutbox(secondo.supabase, { operazione: OPERAZIONE, limite: 10, destinatari: registro })

    const lease = chiamateDi(primo.chiamate, 'video_outbox_claim')[0].argomenti.p_lease_owner
    expect(typeof lease).toBe('string')
    // Il database rifiuta una chiusura con una lease che non è quella del claim: `sent` e
    // `fail` devono portare la stessa.
    expect(chiamateDi(primo.chiamate, 'video_outbox_sent')[0].argomenti.p_lease_owner).toBe(lease)
    expect(chiamateDi(primo.chiamate, 'video_outbox_fail')[0].argomenti.p_lease_owner).toBe(lease)
    // E due giri non condividono la lease: altrimenti l'uno chiuderebbe gli eventi dell'altro.
    expect(chiamateDi(secondo.chiamate, 'video_outbox_claim')[0].argomenti.p_lease_owner).not.toBe(lease)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. IL TIPO SENZA DESTINATARIO
// ═══════════════════════════════════════════════════════════════════════════════

describe('un tipo senza destinatario si grida e si rimette in attesa: MAI dichiarato inviato', () => {
  it('si chiude con `DESTINATARIO_ASSENTE`, si grida a livello `error` e non si chiama `sent`', async () => {
    const ignoto = evento('tipo.inesistente', { attempts: 7 })
    const { supabase, chiamate } = doppio({ claim: preso(ignoto) })

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10, destinatari: {} })

    expect(esito).toMatchObject({ presi: 1, inviati: 0, falliti: 1, senzaDestinatario: 1 })
    expect(chiamateDi(chiamate, 'video_outbox_sent')).toEqual([])
    expect(chiamateDi(chiamate, 'video_outbox_fail')[0].argomenti).toMatchObject({
      p_evento_id: ignoto.id,
      p_error_code: 'DESTINATARIO_ASSENTE',
    })
    const grido = logDi('outbox-senza-destinatario')[0]
    // Configurazione mancante = livello `error`, mai `info` (AGENTS.md, regola 4).
    expect(grido.livello).toBe('error')
    expect(grido.campi).toMatchObject({ operazione: OPERAZIONE, intent_id: INTENT, n_tentativi: 7 })
  })

  it('un tipo che somiglia a una proprietà di `Object` non trova un destinatario ereditato', async () => {
    // `video_outbox_event_type_chk` (`^[a-z][a-z0-9_.-]*$`) ammette `constructor`: con
    // `registro[tipo]` quell'evento troverebbe la funzione `Object` e la chiamerebbe come un
    // destinatario, fallendo con `CONSEGNA_FALLITA` senza che il grido «nessun destinatario» parta.
    const { supabase, chiamate } = doppio({ claim: preso(evento('constructor')) })

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10 })

    expect(esito).toMatchObject({ senzaDestinatario: 1, inviati: 0 })
    expect(chiamateDi(chiamate, 'video_outbox_sent')).toEqual([])
    expect(chiamateDi(chiamate, 'video_outbox_fail')[0].argomenti.p_error_code).toBe('DESTINATARIO_ASSENTE')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. IL FALLIMENTO DI UN DESTINATARIO, E IL BACKOFF CHE LO SEGUE
// ═══════════════════════════════════════════════════════════════════════════════

describe('un destinatario che non riesce rimette l\'evento in attesa col suo codice', () => {
  it('un esito negativo chiude con `video_outbox_fail` e il codice del destinatario, mai con `sent`', async () => {
    const e = evento('tipo.a')
    const { supabase, chiamate } = doppio({ claim: preso(e) })

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      destinatari: { 'tipo.a': destinatario({ consegnato: false, codice: 'NON_PRONTO' }).fn },
    })

    expect(esito).toMatchObject({ presi: 1, inviati: 0, falliti: 1, senzaDestinatario: 0 })
    expect(chiamateDi(chiamate, 'video_outbox_sent')).toEqual([])
    expect(chiamateDi(chiamate, 'video_outbox_fail')[0].argomenti).toMatchObject({
      p_evento_id: e.id,
      p_error_code: 'NON_PRONTO',
    })
  })

  it('un esito negativo senza codice si chiude con `CONSEGNA_FALLITA`', async () => {
    const { supabase, chiamate } = doppio({ claim: preso(evento('tipo.a')) })

    await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      destinatari: { 'tipo.a': destinatario({ consegnato: false }).fn },
    })

    expect(chiamateDi(chiamate, 'video_outbox_fail')[0].argomenti.p_error_code).toBe('CONSEGNA_FALLITA')
  })

  it('un destinatario che LANCIA fallisce quell\'evento e non ferma quelli che stanno dietro', async () => {
    const rotto = evento('tipo.rotto', { attempts: 3 })
    const sano = evento('tipo.sano')
    const { supabase, chiamate } = doppio({ claim: preso(rotto, sano) })
    const eccezione = new Error('il destinatario è esploso')

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      destinatari: {
        'tipo.rotto': async () => {
          throw eccezione
        },
        'tipo.sano': destinatario({ consegnato: true }).fn,
      },
    })

    expect(esito).toMatchObject({ presi: 2, inviati: 1, falliti: 1 })
    expect(chiamateDi(chiamate, 'video_outbox_fail')[0].argomenti).toMatchObject({
      p_evento_id: rotto.id,
      p_error_code: 'DESTINATARIO_ECCEZIONE',
    })
    expect(chiamateDi(chiamate, 'video_outbox_sent')[0].argomenti.p_evento_id).toBe(sano.id)
    // Un `catch` che non logga è un bug: la riga c'è, a livello `error`, e porta l'eccezione
    // vera come errore (il logger la serializza e la redige) invece del solo messaggio.
    const grido = logDi('outbox-consegna-eccezione')[0]
    expect(grido.livello).toBe('error')
    expect(grido.errore).toBe(eccezione)
    expect(grido.campi).toMatchObject({ operazione: OPERAZIONE, intent_id: INTENT, n_tentativi: 3 })
  })

  it('una chiusura che il database RIFIUTA conta fra i falliti e si grida col suo codice', async () => {
    const { supabase } = doppio({
      claim: preso(evento('tipo.a')),
      chiusura: () => ({ data: { ok: false, code: 'LEASE_MISMATCH' }, error: null }),
    })

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      destinatari: { 'tipo.a': destinatario({ consegnato: true }).fn },
    })

    // Consegnato ma non chiuso: non si conta fra gli inviati, perché la coda lo ripresenterà.
    expect(esito).toMatchObject({ inviati: 0, falliti: 1 })
    const grido = logDi('outbox-chiusura-rifiutata')[0]
    expect(grido.livello).toBe('error')
    expect(grido.campi).toMatchObject({ error_code: 'LEASE_MISMATCH', intent_id: INTENT })
  })

  it('una chiusura che il database non RISPONDE conta fra i falliti e si grida col suo codice', async () => {
    const errore = { code: '57014', message: 'canceled' }
    const { supabase } = doppio({
      claim: preso(evento('tipo.a')),
      chiusura: () => ({ data: null, error: errore }),
    })

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      destinatari: { 'tipo.a': destinatario({ consegnato: true }).fn },
    })

    expect(esito).toMatchObject({ inviati: 0, falliti: 1 })
    const grido = logDi('outbox-chiusura-fallita')[0]
    expect(grido.livello).toBe('error')
    expect(grido.campi.error_code).toBe('57014')
    expect(grido.errore).toBe(errore)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. IL CLAIM CHE NON RIESCE, E I LOG DEL GIRO
// ═══════════════════════════════════════════════════════════════════════════════

describe('quando il claim non riesce il giro si ferma e lo dice', () => {
  it('lo schema che non c\'è (PGRST202) è un `warn` e un esito `schema-assente`, non un guasto', async () => {
    // Il database E2E della CI non è migrato: là la coda non esiste, e non è un incidente.
    const errore = { code: 'PGRST202', message: 'no' }
    const { supabase, chiamate } = doppio({ claim: { data: null, error: errore } })

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10 })

    expect(esito).toEqual({ ...OUTBOX_NON_ESEGUITO, esito: 'schema-assente' })
    expect(chiamate.map((c) => c.nome)).toEqual(['video_outbox_claim'])
    expect(logDi('outbox-claim-fallito')[0].livello).toBe('warn')
    // Il corpo dell'errore non si butta mai via: arriva al logger com'è, che lo serializza e lo redige.
    expect(logDi('outbox-claim-fallito')[0].errore).toBe(errore)
  })

  it('un errore VERO dello stesso claim è un `error` e un esito `claim-fallito`: i due casi non si confondono', async () => {
    const errore = { code: '57014', message: 'canceled' }
    const { supabase } = doppio({ claim: { data: null, error: errore } })

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10 })

    expect(esito).toEqual({ ...OUTBOX_NON_ESEGUITO, esito: 'claim-fallito' })
    expect(logDi('outbox-claim-fallito')[0].errore).toBe(errore)
    expect(logDi('outbox-claim-fallito')[0].livello).toBe('error')
    expect(logDi('outbox-claim-fallito')[0].campi.error_code).toBe('57014')
  })

  it('il successo si logga anche a zero, con l\'operazione di chi chiama: «nessun log» non è «coda vuota»', async () => {
    const { supabase } = doppio()

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10 })

    expect(esito).toEqual({ esito: 'ok', presi: 0, inviati: 0, falliti: 0, senzaDestinatario: 0, saltati: 0 })
    const riga = logDi('outbox-svuotato')[0]
    expect(riga.livello).toBe('info')
    expect(riga.campi).toMatchObject({ operazione: OPERAZIONE, n_righe: 0 })
  })

  it('il conto iniziale è congelato: chi lo legge in un `finally` non può sporcarlo per tutti', () => {
    expect(Object.isFrozen(OUTBOX_NON_ESEGUITO)).toBe(true)
    expect(OUTBOX_NON_ESEGUITO).toEqual({
      esito: 'non-eseguito',
      presi: 0,
      inviati: 0,
      falliti: 0,
      senzaDestinatario: 0,
      saltati: 0,
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. IL REGISTRO, E IL POSTO IN CUI SI AGGIUNGE UN TIPO
// ═══════════════════════════════════════════════════════════════════════════════

describe('il registro dei destinatari', () => {
  it('i tre tipi che esistono dal 2026-09 hanno un destinatario (un tipo nuovo si aggiunge, non sostituisce)', () => {
    // `arrayContaining` e non uguaglianza: chi registra un tipo nuovo non deve dover toccare
    // questa prova.
    expect(Object.keys(DESTINATARI)).toEqual(
      expect.arrayContaining(['intent.superseded', 'intent.revoked', 'gallery.published']),
    )
    for (const tipo of ['intent.superseded', 'intent.revoked', 'gallery.published']) {
      expect(typeof DESTINATARI[tipo]).toBe('function')
    }
  })

  it('un tipo nuovo si registra con UNA riga e il motore lo consegna, con payload, età e operazione del chiamante', async () => {
    // È l'uso che ne farà chi pubblica in automatico: legge `payload` e `created_at` dell'evento
    // preso, e sa con quale etichetta scrivere i propri log.
    const nuovo = evento('tipo.nuovo', {
      payload: { job_id: '40000000-0000-4000-8000-00000000000a' },
      created_at: '2026-10-02T10:00:00.000Z',
    })
    const { supabase, chiamate } = doppio({ claim: preso(nuovo) })
    const suo = destinatario({ consegnato: true })
    const registro: RegistroDestinatari = { ...DESTINATARI, 'tipo.nuovo': suo.fn }

    const esito = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 5,
      tipi: ['tipo.nuovo'],
      destinatari: registro,
    })

    expect(esito).toMatchObject({ presi: 1, inviati: 1 })
    expect(suo.visti).toEqual([nuovo])
    expect(suo.contesti).toEqual([{ operazione: OPERAZIONE }])
    expect(chiamateDi(chiamate, 'video_outbox_sent')).toHaveLength(1)
  })

  describe('la ricevuta della retention (`intent.superseded`, `intent.revoked`, `gallery.published`)', () => {
    const contesto = { operazione: OPERAZIONE }

    it('chiede un CONTEGGIO dei job senza scadenza dell\'intent, e con zero consegna', async () => {
      const { supabase, query } = doppio({ conteggio: { count: 0, error: null } })

      const esito = await ricevutaRetention(supabase, evento('intent.revoked'), contesto)

      expect(esito).toEqual({ consegnato: true })
      expect(query).toHaveLength(1)
      expect(query[0].tabella).toBe('video_jobs')
      // `head: true` con `count: exact`: da questa query non esce nessun percorso.
      expect(query[0].colonne).toBe('id')
      expect(query[0].opzioni).toEqual({ count: 'exact', head: true })
      expect(query[0].clausole).toEqual([
        { metodo: 'eq', argomenti: ['intent_id', INTENT] },
        { metodo: 'is', argomenti: ['original_delete_after', null] },
        { metodo: 'is', argomenti: ['original_deleted_at', null] },
      ])
    })

    it('con job ancora senza scadenza NON consegna, si grida e si dice cosa cercare', async () => {
      const { supabase } = doppio({ conteggio: { count: 2, error: null } })

      const esito = await ricevutaRetention(supabase, evento('intent.superseded'), contesto)

      expect(esito).toEqual({ consegnato: false, codice: 'ORIGINALI_SENZA_SCADENZA' })
      const grido = logDi('outbox-originali-senza-scadenza')[0]
      expect(grido.livello).toBe('error')
      expect(grido.campi).toMatchObject({ operazione: OPERAZIONE, intent_id: INTENT, n_righe: 2 })
    })

    it('se la lettura fallisce non consegna: «non so» non è «a posto»', async () => {
      const errore = { code: '57014', message: 'canceled' }
      const { supabase } = doppio({ conteggio: { count: null, error: errore } })

      const esito = await ricevutaRetention(supabase, evento('gallery.published'), contesto)

      expect(esito).toEqual({ consegnato: false, codice: 'RICEVUTA_NON_LETTA' })
      const grido = logDi('outbox-ricevuta-fallita')[0]
      expect(grido.livello).toBe('error')
      expect(grido.campi).toMatchObject({ operazione: OPERAZIONE, error_code: '57014' })
      expect(grido.errore).toBe(errore)
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 7. CONTRO LE RPC VERE — PGlite, e il file di migrazione letto dal disco
// ═══════════════════════════════════════════════════════════════════════════════
//
// Qui non c'è nessuna risposta scritta a mano: claim, chiusura e fallimento sono il SQL che
// verrà applicato in produzione. È l'unico modo di provare ciò che il database decide —
// il backoff, la quarantena, il tetto del claim — invece di ciò che il modulo chiede.

const CARTELLA_MIGRAZIONI = join(process.cwd(), 'supabase/migrations')
const SCHEMA = readFileSync(join(CARTELLA_MIGRAZIONI, '20260916190000_video_jobs.sql'), 'utf8')
const TRANSIZIONI = readFileSync(join(CARTELLA_MIGRAZIONI, '20260916190100_video_job_transitions.sql'), 'utf8')
const CICLO_DI_VITA = readFileSync(join(CARTELLA_MIGRAZIONI, '20260916190200_video_intent_lifecycle.sql'), 'utf8')

const SEDE = '10000000-0000-4000-8000-000000000001'
const OWNER = '20000000-0000-4000-8000-000000000002'

let db: PGlite
let chiavi = 0

/** Il database come lo trova la migrazione: i ruoli di Supabase, gli schemi minimi, e basta. */
async function preparaDatabase() {
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean NOT NULL DEFAULT false,
      file_size_limit bigint,
      allowed_mime_types text[],
      updated_at timestamptz DEFAULT now()
    );

    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.utenti (
      id uuid PRIMARY KEY REFERENCES auth.users(id),
      scuola_id uuid NOT NULL REFERENCES public.schools(id)
    );

    CREATE TABLE public.log_migrazioni (payload jsonb NOT NULL);
    CREATE FUNCTION public.app_log_registra(righe jsonb)
    RETURNS int
    LANGUAGE plpgsql
    AS $$
    BEGIN
      INSERT INTO public.log_migrazioni(payload) VALUES (righe);
      RETURN 1;
    END $$;

    INSERT INTO public.schools(id) VALUES ('${SEDE}');
    INSERT INTO auth.users(id) VALUES ('${OWNER}');
    INSERT INTO public.utenti(id, scuola_id) VALUES ('${OWNER}', '${SEDE}');

    INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
    VALUES
      ('gallery', 'gallery', false, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news', 'news', true, 52428800, ARRAY['image/jpeg', 'video/mp4']),
      ('news_bozze', 'news_bozze', false, 52428800, ARRAY['image/jpeg', 'video/mp4']);
  `)
  await db.exec(SCHEMA)
  await db.exec(TRANSIZIONI)
  await db.exec(CICLO_DI_VITA)
}

/**
 * Accoda un evento di un tipo qualunque. Ogni evento ha il suo intent: la chiave
 * `(intent, revisione, tipo)` è unica, e l'ordine del claim è per `created_at`, quindi
 * `secondiFa` decide chi viene prima.
 */
async function accodaEvento(tipo: string, secondiFa: number, payload: object = {}): Promise<string> {
  chiavi += 1
  const aperto = await db.query<{ risultato: { intent: { id: string; revision: number } } }>(`
    SELECT public.video_intent_open(
      '${OWNER}', '${SEDE}', 'news', 'publish', '{}'::jsonb,
      'k-${chiavi}', '${OWNER}/k-${chiavi}/source', NULL, NULL
    ) AS risultato
  `)
  const { id: intentId, revision } = aperto.rows[0].risultato.intent
  const evento = await db.query<{ id: string }>(`
    INSERT INTO public.video_outbox(intent_id, revision, event_type, payload, created_at)
    VALUES ('${intentId}', ${revision}, '${tipo}', '${JSON.stringify(payload)}'::jsonb,
            now() - interval '${secondiFa} seconds')
    RETURNING id
  `)
  return evento.rows[0].id
}

/** Lo stato vero della coda, riga per riga, nell'ordine del claim. */
async function statoCoda() {
  const { rows } = await db.query<{
    id: string
    event_type: string
    attempts: number
    inviato: boolean
    lease_residua_s: number | null
  }>(`
    SELECT id, event_type, attempts,
           sent_at IS NOT NULL AS inviato,
           extract(epoch FROM (lease_expires_at - now()))::float8 AS lease_residua_s
    FROM public.video_outbox
    ORDER BY created_at, id
  `)
  return rows
}

/** Fa scadere ogni lease: si sposta la scadenza invece di dormire, che nessuno aspetta cinque secondi veri. */
async function scadonoLeLease() {
  await db.exec(`
    UPDATE public.video_outbox SET lease_expires_at = now() - interval '1 second'
    WHERE sent_at IS NULL AND lease_expires_at IS NOT NULL
  `)
}

/** `supabase.rpc` che esegue davvero la funzione SQL, con gli argomenti per nome, e risponde come PostgREST. */
function clientPglite() {
  const chiamate: Chiamata[] = []
  const supabase = {
    rpc: async (nome: string, argomenti: Record<string, unknown>) => {
      chiamate.push({ nome, argomenti })
      const nomi = Object.keys(argomenti)
      try {
        const { rows } = await db.query<{ risultato: unknown }>(
          `SELECT public.${nome}(${nomi.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS risultato`,
          nomi.map((n) => argomenti[n]),
        )
        return { data: rows[0].risultato, error: null }
      } catch (errore) {
        // PostgREST non lancia: ritorna `{ error }`, con il SQLSTATE come `code`.
        const e = errore as { code?: string; message?: string }
        return { data: null, error: { code: e.code ?? 'sconosciuto', message: e.message ?? '' } }
      }
    },
  } as unknown as SupabaseClient
  return { supabase, chiamate }
}

describe('contro le RPC vere: ciò che la coda fa davvero', () => {
  // Il timeout esplicito: `hookTimeout` resta al default di 10 s, e un PGlite da zero con
  // tre migrazioni sotto un'altra suite pesante in parallelo può sfondarlo (vedi
  // `video-intents.test.ts`, che ha pagato lo stesso rosso).
  beforeEach(async () => {
    db = new PGlite()
    await preparaDatabase()
  }, 60_000)

  afterEach(async () => {
    await db.close()
  })

  it('il LIMITE è un tetto vero: a ogni giro si prendono solo `limite` eventi, e si arriva in fondo', async () => {
    for (let n = 0; n < 7; n += 1) await accodaEvento('tipo.a', 100 - n)
    const { supabase } = clientPglite()
    const registro = { 'tipo.a': destinatario({ consegnato: true }).fn }
    const giro = () => consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 3, destinatari: registro })

    expect(await giro()).toMatchObject({ presi: 3, inviati: 3 })
    expect((await statoCoda()).filter((r) => r.inviato)).toHaveLength(3)
    expect(await giro()).toMatchObject({ presi: 3, inviati: 3 })
    expect(await giro()).toMatchObject({ presi: 1, inviati: 1 })
    expect(await giro()).toMatchObject({ presi: 0, inviati: 0 })
    expect((await statoCoda()).every((r) => r.inviato)).toBe(true)
  })

  it('il FILTRO lascia intatti gli altri tipi: restano da consegnare e li consegna chi li sa', async () => {
    await accodaEvento('tipo.mio', 40)
    await accodaEvento('tipo.altrui', 30)
    await accodaEvento('tipo.mio', 20)
    await accodaEvento('tipo.altrui', 10)
    const { supabase, chiamate } = clientPglite()
    const mio = destinatario({ consegnato: true })
    const dellAltro = destinatario({ consegnato: true })
    const registro = { 'tipo.mio': mio.fn, 'tipo.altrui': dellAltro.fn }

    // Il consumatore filtrato: due eventi suoi consegnati, due altrui presi e lasciati.
    const filtrato = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      tipi: ['tipo.mio'],
      destinatari: registro,
    })
    expect(filtrato).toMatchObject({ presi: 4, inviati: 2, saltati: 2, falliti: 0 })
    expect(dellAltro.visti).toEqual([])
    expect(chiamateDi(chiamate, 'video_outbox_fail')).toEqual([])
    expect(
      (await statoCoda()).map((r) => [r.event_type, r.inviato]),
      'il filtro ha chiuso (o perso) un evento che non era suo',
    ).toEqual([
      ['tipo.mio', true],
      ['tipo.altrui', false],
      ['tipo.mio', true],
      ['tipo.altrui', false],
    ])

    // Gli altrui non sono persi né in quarantena: scaduta la lease, li prende chi li sa consegnare.
    await scadonoLeLease()
    const completo = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10, destinatari: registro })
    expect(completo).toMatchObject({ presi: 2, inviati: 2, saltati: 0 })
    expect(dellAltro.visti).toHaveLength(2)
    expect((await statoCoda()).every((r) => r.inviato)).toBe(true)
  })

  it('il BACKOFF è del database: un destinatario che fallisce NON brucia i 25 tentativi in un giro solo', async () => {
    // Regressione misurata prima della correzione di `video_outbox_fail`: con la lease
    // rilasciata al fallimento, un solo evento perdeva tutti e 25 i tentativi in 16
    // millisecondi, e finiva in quarantena per un 5xx di passaggio. Qui il consumo drena la
    // coda a ripetizione, senza aspettare niente.
    await accodaEvento('tipo.a', 10)
    const { supabase } = clientPglite()
    const guasto = destinatario({ consegnato: false, codice: 'GUASTO_DI_PASSAGGIO' })
    const registro = { 'tipo.a': guasto.fn }

    const giri = []
    for (let n = 0; n < 30; n += 1) {
      giri.push(await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10, destinatari: registro }))
    }

    expect(giri[0]).toMatchObject({ presi: 1, falliti: 1, inviati: 0 })
    expect(giri.slice(1).map((g) => g.presi), 'un evento appena fallito è tornato subito prendibile').toEqual(
      new Array(29).fill(0),
    )
    expect(guasto.visti).toHaveLength(1)
    const [riga] = await statoCoda()
    expect(riga.attempts).toBe(1)
    expect(riga.inviato).toBe(false)
    // L'attesa è quella di `video_outbox_fail` (5 s al primo tentativo), non la lease intera
    // del claim (120 s): se il modulo non chiamasse `fail`, qui resterebbero ~120.
    expect(riga.lease_residua_s).toBeGreaterThan(0)
    expect(riga.lease_residua_s).toBeLessThanOrEqual(30)

    // Passata l'attesa l'evento torna, e il contatore è avanzato.
    await scadonoLeLease()
    const dopo = await consumaOutbox(supabase, {
      operazione: OPERAZIONE,
      limite: 10,
      destinatari: { 'tipo.a': destinatario({ consegnato: true }).fn },
    })
    expect(dopo).toMatchObject({ presi: 1, inviati: 1 })
    expect((await statoCoda())[0]).toMatchObject({ attempts: 2, inviato: true })
  })

  it('un tipo SENZA destinatario non si consegna mai: dopo venticinque prese è in quarantena e nessuno lo riprende', async () => {
    // Il tetto è quello di `video_outbox_attempts_chk`: a 25 il claim non lo rivede più, e
    // `video_riconciliazione` lo conta (`outbox_in_quarantena`). Qui lo si porta fin lì, un
    // giro per volta, facendo scadere la lease fra l'uno e l'altro.
    await accodaEvento('tipo.orfano', 10)
    const { supabase, chiamate } = clientPglite()

    const presi: number[] = []
    const senza: number[] = []
    for (let n = 0; n < 30; n += 1) {
      await scadonoLeLease()
      const giro = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10, destinatari: {} })
      expect(giro.inviati, `al giro ${n + 1} un evento senza destinatario è stato dichiarato inviato`).toBe(0)
      presi.push(giro.presi)
      senza.push(giro.senzaDestinatario)
    }

    expect(presi).toEqual([...new Array(25).fill(1), ...new Array(5).fill(0)])
    expect(senza).toEqual([...new Array(25).fill(1), ...new Array(5).fill(0)])
    const [riga] = await statoCoda()
    expect(riga).toMatchObject({ event_type: 'tipo.orfano', attempts: 25, inviato: false })
    expect(chiamateDi(chiamate, 'video_outbox_sent')).toEqual([])
    expect(
      chiamateDi(chiamate, 'video_outbox_fail').every((c) => c.argomenti.p_error_code === 'DESTINATARIO_ASSENTE'),
    ).toBe(true)
    // Venticinque grida, una per presa: la quarantena non è mai silenziosa.
    expect(logDi('outbox-senza-destinatario')).toHaveLength(25)
  })

  it('un destinatario che LANCIA rimette in attesa quell\'evento col backoff, e gli altri passano', async () => {
    await accodaEvento('tipo.rotto', 20)
    await accodaEvento('tipo.sano', 10)
    const { supabase } = clientPglite()
    const registro: RegistroDestinatari = {
      'tipo.rotto': async () => {
        throw new Error('esploso')
      },
      'tipo.sano': destinatario({ consegnato: true }).fn,
    }

    const esito = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 10, destinatari: registro })

    expect(esito).toMatchObject({ presi: 2, inviati: 1, falliti: 1 })
    const [rotto, sano] = await statoCoda()
    expect(rotto).toMatchObject({ event_type: 'tipo.rotto', inviato: false, attempts: 1 })
    expect(rotto.lease_residua_s).toBeGreaterThan(0)
    expect(rotto.lease_residua_s).toBeLessThanOrEqual(30)
    expect(sano).toMatchObject({ event_type: 'tipo.sano', inviato: true })
  })

  it('il database rifiuta un limite fuori da 1..100 e il modulo lo dice invece di fingere un giro vuoto', async () => {
    await accodaEvento('tipo.a', 10)
    const { supabase } = clientPglite()

    const zero = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 0 })
    const troppi = await consumaOutbox(supabase, { operazione: OPERAZIONE, limite: 101 })

    expect(zero).toEqual({ ...OUTBOX_NON_ESEGUITO, esito: 'claim-rifiutato' })
    expect(troppi).toEqual({ ...OUTBOX_NON_ESEGUITO, esito: 'claim-rifiutato' })
    expect(logDi('outbox-claim-rifiutato').map((r) => r.campi.error_code)).toEqual(['BAD_INPUT', 'BAD_INPUT'])
    expect((await statoCoda())[0]).toMatchObject({ attempts: 0, inviato: false })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 8. LA ROUTE DELLA RETENTION USA IL MODULO, CON I NUMERI DI SEMPRE
// ═══════════════════════════════════════════════════════════════════════════════

describe('la route della retention collega il motore condiviso senza cambiare i numeri', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = CRON_SECRET
  })

  const chiamata = () =>
    new Request('http://localhost/api/gdpr/retention-video', {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET },
    }) as unknown as Parameters<typeof POST>[0]

  it('prende 25 eventi per giro con una lease di 120 secondi, e nessun filtro per tipo', async () => {
    await POST(chiamata())

    const claim = h.rpc.filter((r) => r.nome === 'video_outbox_claim')
    expect(claim).toHaveLength(1)
    // I numeri di oggi: un cambio qui cambia il carico della retention, e la suite della
    // route non li guarda.
    expect(claim[0].argomenti).toMatchObject({ p_limite: 25, p_lease_seconds: 120 })
  })

  it('tutte le righe del consumo portano `operazione: video-retention`, quella che i controlli leggono', async () => {
    h.claim = {
      ok: true,
      eventi: [
        { id: 'e1', intent_id: INTENT, revision: 1, event_type: 'intent.superseded', attempts: 1 },
        { id: 'e2', intent_id: INTENT, revision: 1, event_type: 'tipo.inesistente', attempts: 1 },
      ],
    }

    const res = await POST(chiamata())

    // Una PRESENZA prima delle assenze: il giro ha davvero consumato.
    expect(await res.json()).toMatchObject({
      outbox_presi: 2,
      outbox_inviati: 1,
      outbox_falliti: 1,
      outbox_senza_destinatario: 1,
    })
    const righe = h.eventi.filter((e) => String(e.campi.esito).startsWith('outbox-'))
    expect(righe.map((r) => r.campi.esito).sort()).toEqual(['outbox-senza-destinatario', 'outbox-svuotato'])
    expect(righe.every((r) => r.campi.operazione === 'video-retention')).toBe(true)
  })

  it('non tiene una copia propria del consumo: il claim, la chiusura e il registro stanno nel modulo', () => {
    // «Due copie della stessa decisione divergono il giorno in cui qualcuno ne corregge una
    // sola». Il testo è letto GREZZO, commenti compresi: un lock che togliesse i commenti
    // potrebbe sbagliare nel toglierli e restare verde a vuoto, uno che li legge può solo
    // sbagliare per eccesso. Per questo la route non nomina nemmeno le RPC di chiusura.
    const sorgente = readFileSync(
      join(process.cwd(), 'src/app/api/gdpr/retention-video/route.ts'),
      'utf8',
    )
    expect(sorgente, 'la route non chiama più il motore condiviso').toMatch(/\bconsumaOutbox\(/)
    for (const rpc of ['video_outbox_claim', 'video_outbox_sent', 'video_outbox_fail']) {
      expect(sorgente, `la route nomina ${rpc}: il consumo vive in src/lib/media/video/outbox`).not.toContain(rpc)
    }
    expect(sorgente).not.toMatch(/\b(svuotaOutbox|ricevutaRetention|DESTINATARI)\b/)
  })
})
