import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Scrittura, ErrorePostgrest } from '../fixtures/finto-supabase'

/**
 * IMPREPARATI LATO GENITORE (compito G1, spec 2026-09-24 «2 Primaria»).
 *
 *  · POST: il tipo è SEMPRE «giustificato»; la notifica ai docenti porta alla
 *    pagina Valutazioni della classe, non più all'appello.
 *  · PATCH / DELETE: solo le PROPRIE dichiarazioni (origine genitore, creato_da =
 *    chi chiama, figlio suo), e solo finché il giorno dichiarato non è passato in
 *    data di Roma — anche la nuova data non può essere nel passato. L'annullamento
 *    ritira la notifica ai docenti ancora in coda (e solo quella).
 *  · GET dei voti: gli impreparati di entrambi i tipi, quelli del docente solo
 *    dopo il buffer di 10', con `modificabile_dal_genitore`.
 *
 * Il database è il finto client che APPLICA i filtri: un filtro tolto dalla route
 * (autore, origine, data) rende rossa la prova che lo riguarda.
 */

const SEDE = 'a1a1a1a1-0000-4000-8000-00000000000a'
const SEZ = 'd4d4d4d4-0000-4000-8000-00000000000d'
const SEZ_ALTRA = 'd5d5d5d5-0000-4000-8000-00000000000d'
const ALUNNO = 'c3c3c3c3-1111-4111-8111-cccccccccccc'
const IO = 'e1e1e1e1-0000-4000-8000-00000000000e'
const ALTRO_GENITORE = 'e2e2e2e2-0000-4000-8000-00000000000e'
const DOCENTE = 'f1f1f1f1-0000-4000-8000-00000000000f'
const MAT = '0a0a0a0a-0000-4000-8000-0000000000aa'
const MAT_2 = '0b0b0b0b-0000-4000-8000-0000000000bb'
const MAT_ALTRA_CLASSE = '0c0c0c0c-0000-4000-8000-0000000000cc'

const G_FUTURA = '11111111-0000-4000-8000-000000000001'
const G_OGGI = '11111111-0000-4000-8000-000000000002'
const G_PASSATA = '11111111-0000-4000-8000-000000000003'
const G_ALTRUI = '11111111-0000-4000-8000-000000000004'
const G_DOCENTE_VECCHIA = '11111111-0000-4000-8000-000000000005'
const G_DOCENTE_FRESCA = '11111111-0000-4000-8000-000000000006'
const G_DOCENTE_MIA = '11111111-0000-4000-8000-000000000007'
const G_MIA_FRESCA = '11111111-0000-4000-8000-000000000008'

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  legame: vi.fn(),
  logScrittura: vi.fn(),
  notificaEvento: vi.fn(),
  docentiDiSezione: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, ErrorePostgrest>,
  /** Simula il DB E2E della CI, NON migrato: la colonna `tipo` non esiste. */
  senzaColonnaTipo: false,
  /** Eseguito fra la lettura della route e la sua scrittura condizionata. */
  primaDellaScrittura: null as null | (() => void),
}))

vi.mock('@/lib/auth/require-staff', async (originale) => {
  const reale = await originale<typeof import('@/lib/auth/require-staff')>()
  return { ...reale, requireUser: h.requireUser }
})
vi.mock('@/lib/anagrafiche/legami', () => ({
  verificaLegameGenitore: h.legame,
  genitoreHasFiglio: async (...a: unknown[]) => (await h.legame(...a)) === 'si',
}))
vi.mock('@/lib/alunni/attivo', () => ({ verificaAlunnoAttivo: async () => 'attivo' }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notificaEvento }))
vi.mock('@/lib/sezioni/docenti', () => ({ docentiDiSezione: h.docentiDiSezione }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  // Una query che nomina `tipo` su un DB senza la colonna risponde come PostgREST:
  // 42703 in lettura, PGRST204 in scrittura. Il resto della catena si accetta e si
  // ignora (la risposta è comunque l'errore), come fa il server vero.
  const rifiuto = (code: string) => {
    const risposta = { data: null, error: { code, message: 'colonna tipo inesistente' } }
    const catena: Record<string, unknown> = {}
    const proxy: unknown = new Proxy(catena, {
      get: (_t, prop) =>
        prop === 'then'
          ? (ok: (v: unknown) => unknown) => Promise.resolve(risposta).then(ok)
          : () => proxy,
    })
    return proxy
  }
  const crea = () => {
    const client = creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.errori, rpc: {} })
    const from = client.from.bind(client)
    return Object.assign(Object.create(client), {
      from: (tabella: string) => {
        const b = from(tabella)
        if (tabella !== 'giustifiche_didattiche') return b
        return Object.assign(Object.create(b), {
          select: (col?: string, ...r: unknown[]) =>
            h.senzaColonnaTipo && /\btipo\b/.test(col ?? '') ? rifiuto('42703') : b.select(col as string, ...(r as [])),
          insert: (v: Record<string, unknown>, ...r: unknown[]) =>
            h.senzaColonnaTipo && v && 'tipo' in v ? rifiuto('PGRST204') : b.insert(v, ...(r as [])),
          // La corsa fra la lettura della route e la sua scrittura: il gancio gira
          // quando la route costruisce l'update/delete, cioè DOPO la sua lettura.
          update: (...r: unknown[]) => {
            h.primaDellaScrittura?.()
            return (b.update as (...a: unknown[]) => unknown)(...r)
          },
          delete: (...r: unknown[]) => {
            h.primaDellaScrittura?.()
            return (b.delete as (...a: unknown[]) => unknown)(...r)
          },
        })
      },
    })
  }
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { POST, PATCH, DELETE } from '@/app/api/parent/giustifiche-didattiche/route'
import { GET as votiGET } from '@/app/api/parent/primaria/valutazioni/route'
import { dataRomaDi } from '@/lib/primaria/timelock'

// ── Date in data di ROMA, relative a oggi: nessun orologio congelato ─────────
function giorniDa(base: string, n: number): string {
  const d = new Date(`${base}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const OGGI = dataRomaDi(new Date())
const DOMANI = giorniDa(OGGI, 1)
const DOPODOMANI = giorniDa(OGGI, 2)
const IERI = giorniDa(OGGI, -1)
const UN_ORA_FA = new Date(Date.now() - 60 * 60_000).toISOString()
const DUE_MINUTI_FA = new Date(Date.now() - 2 * 60_000).toISOString()

const comeGenitore = (id: string = IO) =>
  h.requireUser.mockResolvedValue({ user: { id, role: 'genitore', ruolo: 'genitore', ruoli: ['genitore'], scuola_id: null } })

function dichiarazione(id: string, extra: Record<string, unknown>) {
  return {
    id,
    alunno_id: ALUNNO,
    section_id: SEZ,
    materia_id: MAT,
    motivo: 'MOTIVO-FAMIGLIA',
    origine: 'genitore',
    tipo: 'giustificato',
    creato_da: IO,
    creato_il: UN_ORA_FA,
    alunni: { scuola_id: SEDE },
    materie: { nome: 'Matematica' },
    ...extra,
  }
}

const dbBase = (): DBFinto => ({
  alunni: [{ id: ALUNNO, nome: 'Bambino', cognome: 'Collaudo', section_id: SEZ, scuola_id: SEDE }],
  sections: [
    { id: SEZ, scuola_id: SEDE, school_type: 'primaria' },
    { id: SEZ_ALTRA, scuola_id: SEDE, school_type: 'primaria' },
  ],
  materie: [
    { id: MAT, nome: 'Matematica', section_id: SEZ, attiva: true, ordine: 1 },
    { id: MAT_2, nome: 'Italiano', section_id: SEZ, attiva: true, ordine: 2 },
    { id: MAT_ALTRA_CLASSE, nome: 'Storia', section_id: SEZ_ALTRA, attiva: true, ordine: 1 },
  ],
  admin_settings: [{ scuola_id: SEDE, notif_buffer_valutazioni_min: 10 }],
  valutazioni: [],
  giustifiche_didattiche: [
    dichiarazione(G_FUTURA, { data: DOMANI }),
    dichiarazione(G_OGGI, { data: OGGI, materia_id: null, materie: null }),
    dichiarazione(G_PASSATA, { data: IERI }),
    dichiarazione(G_ALTRUI, { data: DOMANI, creato_da: ALTRO_GENITORE }),
    dichiarazione(G_DOCENTE_VECCHIA, {
      data: IERI, origine: 'docente', tipo: 'impreparato', creato_da: DOCENTE, motivo: null, creato_il: UN_ORA_FA,
    }),
    dichiarazione(G_DOCENTE_FRESCA, {
      data: OGGI, origine: 'docente', tipo: 'giustificato', creato_da: DOCENTE, creato_il: DUE_MINUTI_FA,
    }),
    // Un impreparato del DOCENTE che (per caso) porta il mio id come autore: non è
    // una dichiarazione della famiglia e il genitore non lo tocca.
    dichiarazione(G_DOCENTE_MIA, { data: DOMANI, origine: 'docente', tipo: 'impreparato', creato_da: IO }),
    // Dichiarata dal genitore DUE MINUTI FA: dentro la finestra dei 10', che però
    // vale solo per il docente — la famiglia vede subito ciò che ha appena scritto.
    dichiarazione(G_MIA_FRESCA, { data: DOMANI, creato_il: DUE_MINUTI_FA }),
  ],
  notifiche: [
    // In coda (push non ancora spedita): da ritirare quando il genitore annulla G_FUTURA.
    { id: 'n-coda', utente_id: DOCENTE, tipo: 'giustifica_ricevuta', entita_tipo: 'giustifica_didattica', entita_id: G_FUTURA, push_inviata_il: null, corpo: 'CORPO-VECCHIO' },
    // Già spedita: nessuna rettifica, resta.
    { id: 'n-spedita', utente_id: DOCENTE, tipo: 'giustifica_ricevuta', entita_tipo: 'giustifica_didattica', entita_id: G_FUTURA, push_inviata_il: UN_ORA_FA, corpo: 'CORPO-VECCHIO' },
    // Stesso tipo, ma di un'ALTRA dichiarazione: non si tocca.
    { id: 'n-altra', utente_id: DOCENTE, tipo: 'giustifica_ricevuta', entita_tipo: 'giustifica_didattica', entita_id: G_OGGI, push_inviata_il: null, corpo: 'CORPO-ALTRA' },
    // Stessa entità, tipo diverso: non si tocca.
    { id: 'n-tipo', utente_id: DOCENTE, tipo: 'altro_tipo', entita_tipo: 'giustifica_didattica', entita_id: G_FUTURA, push_inviata_il: null, corpo: 'CORPO-TIPO' },
  ],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.senzaColonnaTipo = false
  h.primaDellaScrittura = null
  comeGenitore()
  h.legame.mockResolvedValue('si')
  h.logScrittura.mockResolvedValue(undefined)
  h.notificaEvento.mockResolvedValue(undefined)
  h.docentiDiSezione.mockResolvedValue([DOCENTE])
})

const riga = (id: string) => (h.db.giustifiche_didattiche as Record<string, unknown>[]).find((r) => r.id === id)
const idNotifiche = () => (h.db.notifiche as Record<string, unknown>[]).map((n) => n.id).sort()

const patch = (body: unknown) =>
  PATCH(new NextRequest('http://localhost/api/parent/giustifiche-didattiche', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
const cancella = (id: string) =>
  DELETE(new NextRequest(`http://localhost/api/parent/giustifiche-didattiche?id=${id}`, { method: 'DELETE' }))
const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/parent/giustifiche-didattiche', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

// ─────────────────────────────────────────────────────────────────────────────

describe('POST — la dichiarazione del genitore', () => {
  it('scrive tipo «giustificato» e la notifica ai docenti porta alle Valutazioni, non all’appello', async () => {
    const res = await post({ studentId: ALUNNO, data: DOMANI, motivo: '  visita  ', materiaId: MAT })
    expect(res.status).toBe(201)
    const insert = h.scritture.find((s) => s.tabella === 'giustifiche_didattiche' && s.operazione === 'insert')
    expect(insert?.valori[0]).toMatchObject({
      tipo: 'giustificato', origine: 'genitore', creato_da: IO, alunno_id: ALUNNO, section_id: SEZ, motivo: 'visita',
    })
    const nuovoId = (insert?.colpite[0] as { id: string }).id

    expect(h.notificaEvento).toHaveBeenCalledTimes(1)
    const n = h.notificaEvento.mock.calls[0][1]
    expect(n.link).toBe(`/teacher/primaria/${SEZ}/valutazioni`)
    expect(n.link).not.toContain('/appello')
    expect(n).toMatchObject({ tipo: 'giustifica_ricevuta', entitaTipo: 'giustifica_didattica', entitaId: nuovoId, utenteIds: [DOCENTE] })
    // Nome e sede dalla lettura dell'alunno GIÀ controllata: una sola lettura di
    // `alunni`, e la sede della notifica è quella dell'alunno, mai null.
    expect(n.scuolaId).toBe(SEDE)
    expect(n.corpo).toBe(`Il genitore di Bambino Collaudo ha inviato una giustifica didattica per il ${DOMANI}.`)
    expect(h.tabelle.filter((t) => t === 'alunni')).toHaveLength(1)

    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    expect(h.logScrittura.mock.calls[0][1]).toMatchObject({ entitaTipo: 'impreparato', azione: 'insert', entitaId: nuovoId, scuolaId: SEDE })
    // Il motivo è testo libero su un minore: nell'audit c'è solo se c'era.
    expect(JSON.stringify(h.logScrittura.mock.calls[0][1])).not.toContain('visita')
  })

  it('un insert rifiutato risponde con un codice, mai col messaggio grezzo del database', async () => {
    h.errori = { 'giustifiche_didattiche:insert': { code: '23514', message: 'SEGRETO-DEL-DATABASE' } }
    const res = await post({ studentId: ALUNNO, data: DOMANI })
    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('IMPREPARATO_NON_SALVATO')
    expect(JSON.stringify(corpo)).not.toContain('SEGRETO-DEL-DATABASE')
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })
})

describe('PATCH — il genitore corregge la SUA dichiarazione', () => {
  it('data futura: aggiorna data, materia e motivo, e lascia la traccia d’audit', async () => {
    const res = await patch({ id: G_FUTURA, data: DOPODOMANI, materiaId: MAT_2, motivo: '  nuovo motivo ' })
    expect(res.status).toBe(200)
    expect(riga(G_FUTURA)).toMatchObject({ data: DOPODOMANI, materia_id: MAT_2, motivo: 'nuovo motivo', origine: 'genitore' })
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    const audit = h.logScrittura.mock.calls[0][1]
    expect(audit).toMatchObject({ entitaTipo: 'impreparato', entitaId: G_FUTURA, azione: 'update', scuolaId: SEDE, sectionId: SEZ })
    expect(audit.valorePrima).toMatchObject({ data: DOMANI, materia_id: MAT })
    expect(audit.valoreDopo).toMatchObject({ data: DOPODOMANI, materia_id: MAT_2 })
    expect(JSON.stringify(audit)).not.toContain('nuovo motivo')
  })

  it('il giorno stesso si può ancora modificare (data = oggi di Roma)', async () => {
    const res = await patch({ id: G_OGGI, motivo: null })
    expect(res.status).toBe(200)
    expect(riga(G_OGGI)?.motivo).toBeNull()
  })

  it('giorno dichiarato già passato: 409 IMPREPARATO_DATA_PASSATA e riga intatta', async () => {
    const prima = { ...riga(G_PASSATA) }
    const res = await patch({ id: G_PASSATA, data: DOMANI })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('IMPREPARATO_DATA_PASSATA')
    expect(riga(G_PASSATA)).toEqual(prima)
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('nuova data nel passato: 409, anche se quella di oggi sarebbe modificabile', async () => {
    const res = await patch({ id: G_FUTURA, data: IERI })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('IMPREPARATO_DATA_PASSATA')
    expect(riga(G_FUTURA)?.data).toBe(DOMANI)
  })

  it('la dichiarazione di un ALTRO genitore: 404 come se non esistesse, nessuna scrittura', async () => {
    const res = await patch({ id: G_ALTRUI, motivo: 'riscritto' })
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('IMPREPARATO_NON_TROVATO')
    expect(riga(G_ALTRUI)?.motivo).toBe('MOTIVO-FAMIGLIA')
    expect(h.scritture.filter((s) => s.operazione === 'update')).toEqual([])
  })

  it('un impreparato del DOCENTE non è modificabile dal genitore, nemmeno col suo id come autore', async () => {
    const res = await patch({ id: G_DOCENTE_MIA, motivo: 'riscritto' })
    expect(res.status).toBe(404)
    expect(riga(G_DOCENTE_MIA)?.motivo).toBe('MOTIVO-FAMIGLIA')
  })

  it('figlio non più suo (legame tolto): 403 dal gate di famiglia, nessuna scrittura', async () => {
    h.legame.mockResolvedValue('no')
    const res = await patch({ id: G_FUTURA, motivo: 'riscritto' })
    expect(res.status).toBe(403)
    expect(h.legame).toHaveBeenCalledWith(expect.anything(), IO, ALUNNO)
    expect(riga(G_FUTURA)?.motivo).toBe('MOTIVO-FAMIGLIA')
  })

  it('materia di un’altra classe: 400 IMPREPARATO_MATERIA_NON_VALIDA', async () => {
    const res = await patch({ id: G_FUTURA, materiaId: MAT_ALTRA_CLASSE })
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('IMPREPARATO_MATERIA_NON_VALIDA')
    expect(riga(G_FUTURA)?.materia_id).toBe(MAT)
  })

  it('la riga sparita fra lettura e scrittura (tolta da un docente): 404 NON_TROVATO, non «data passata»', async () => {
    h.primaDellaScrittura = () => {
      const t = h.db.giustifiche_didattiche as Record<string, unknown>[]
      t.splice(t.findIndex((r) => r.id === G_FUTURA), 1)
    }
    const res = await patch({ id: G_FUTURA, motivo: 'riscritto' })
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('IMPREPARATO_NON_TROVATO')
    expect(h.logScrittura).not.toHaveBeenCalled()
  })

  it('la mezzanotte scoccata fra lettura e scrittura: la riga c’è ancora, 409 DATA_PASSATA', async () => {
    h.primaDellaScrittura = () => { riga(G_FUTURA)!.data = IERI }
    const res = await patch({ id: G_FUTURA, motivo: 'riscritto' })
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('IMPREPARATO_DATA_PASSATA')
    expect(riga(G_FUTURA)?.motivo).toBe('MOTIVO-FAMIGLIA')
  })

  it('data spostata: il corpo delle notifiche di QUESTA dichiarazione dice il giorno nuovo, nessuna push nuova', async () => {
    const res = await patch({ id: G_FUTURA, data: DOPODOMANI })
    expect(res.status).toBe(200)
    const corpo = (id: string) => (h.db.notifiche as Record<string, unknown>[]).find((n) => n.id === id)?.corpo
    const atteso = `Il genitore di Bambino Collaudo ha inviato una giustifica didattica per il ${DOPODOMANI}.`
    expect(corpo('n-coda')).toBe(atteso)
    expect(corpo('n-spedita')).toBe(atteso)
    expect(corpo('n-altra')).toBe('CORPO-ALTRA')
    expect(corpo('n-tipo')).toBe('CORPO-TIPO')
    expect(idNotifiche()).toEqual(['n-altra', 'n-coda', 'n-spedita', 'n-tipo'])
    expect(h.notificaEvento).not.toHaveBeenCalled()
  })

  it('data NON cambiata: il corpo delle notifiche non si tocca', async () => {
    const res = await patch({ id: G_FUTURA, motivo: 'altro' })
    expect(res.status).toBe(200)
    expect(h.scritture.filter((s) => s.tabella === 'notifiche')).toEqual([])
  })

  it('corpo della notifica non aggiornabile: la modifica resta valida (200)', async () => {
    h.errori = { 'notifiche:update': { code: '57014', message: 'timeout' } }
    const res = await patch({ id: G_FUTURA, data: DOPODOMANI })
    expect(res.status).toBe(200)
    expect(riga(G_FUTURA)?.data).toBe(DOPODOMANI)
  })

  it('nessun campo da modificare: 400', async () => {
    const res = await patch({ id: G_FUTURA })
    expect(res.status).toBe(400)
  })

  it('non autenticato: la risposta del gate, e il corpo non si legge nemmeno', async () => {
    h.requireUser.mockResolvedValue({ response: NextResponse.json({ error: 'Non autenticato' }, { status: 401 }) })
    const res = await patch({ id: G_FUTURA, motivo: 'x' })
    expect(res.status).toBe(401)
    expect(h.tabelle).toEqual([])
  })
})

describe('DELETE — il genitore annulla la SUA dichiarazione', () => {
  it('cancella la riga e ritira SOLO la notifica ai docenti ancora in coda', async () => {
    const res = await cancella(G_FUTURA)
    expect(res.status).toBe(200)
    expect(riga(G_FUTURA)).toBeUndefined()
    // Via la sola notifica in coda di QUESTA dichiarazione: la spedita resta (nessuna
    // rettifica), e restano quella di un'altra dichiarazione e quella di un altro tipo.
    expect(idNotifiche()).toEqual(['n-altra', 'n-spedita', 'n-tipo'])
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    expect(h.logScrittura.mock.calls[0][1]).toMatchObject({
      entitaTipo: 'impreparato', entitaId: G_FUTURA, azione: 'delete', scuolaId: SEDE, valoreDopo: null,
    })
  })

  it('giorno già passato: 409, riga e notifiche intatte', async () => {
    const res = await cancella(G_PASSATA)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('IMPREPARATO_DATA_PASSATA')
    expect(riga(G_PASSATA)).toBeDefined()
    expect(idNotifiche()).toEqual(['n-altra', 'n-coda', 'n-spedita', 'n-tipo'])
  })

  it('il giorno stesso si può ancora annullare', async () => {
    const res = await cancella(G_OGGI)
    expect(res.status).toBe(200)
    expect(riga(G_OGGI)).toBeUndefined()
    expect(idNotifiche()).toEqual(['n-coda', 'n-spedita', 'n-tipo'])
  })

  it('la dichiarazione di un altro genitore: 404, niente cancellato, notifiche intatte', async () => {
    const res = await cancella(G_ALTRUI)
    expect(res.status).toBe(404)
    expect(riga(G_ALTRUI)).toBeDefined()
    expect(idNotifiche()).toHaveLength(4)
  })

  it('la riga sparita fra lettura e cancellazione: 404 NON_TROVATO, notifiche intatte', async () => {
    h.primaDellaScrittura = () => {
      const t = h.db.giustifiche_didattiche as Record<string, unknown>[]
      t.splice(t.findIndex((r) => r.id === G_FUTURA), 1)
    }
    const res = await cancella(G_FUTURA)
    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('IMPREPARATO_NON_TROVATO')
    expect(idNotifiche()).toHaveLength(4)
  })

  it('la mezzanotte scoccata fra lettura e cancellazione: 409 DATA_PASSATA, riga intatta', async () => {
    h.primaDellaScrittura = () => { riga(G_FUTURA)!.data = IERI }
    const res = await cancella(G_FUTURA)
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('IMPREPARATO_DATA_PASSATA')
    expect(riga(G_FUTURA)).toBeDefined()
    expect(idNotifiche()).toHaveLength(4)
  })

  it('un impreparato del docente: 404', async () => {
    const res = await cancella(G_DOCENTE_MIA)
    expect(res.status).toBe(404)
    expect(riga(G_DOCENTE_MIA)).toBeDefined()
  })
})

describe('GET dei voti — gli impreparati del figlio', () => {
  const leggi = async () => {
    const res = await votiGET(new NextRequest(`http://localhost/api/parent/primaria/valutazioni?studentId=${ALUNNO}`))
    expect(res.status).toBe(200)
    return (await res.json()) as {
      data: unknown[]
      impreparati: Array<Record<string, unknown>>
    }
  }

  it('entrambi i tipi; quelli del docente solo dopo il buffer di 10 minuti', async () => {
    const { impreparati } = await leggi()
    const ids = impreparati.map((i) => i.id).sort()
    // G_DOCENTE_FRESCA (creata 2 minuti fa) è ancora nella finestra del docente: non si vede.
    expect(ids).toEqual([G_ALTRUI, G_DOCENTE_MIA, G_DOCENTE_VECCHIA, G_FUTURA, G_MIA_FRESCA, G_OGGI, G_PASSATA].sort())
    const vecchia = impreparati.find((i) => i.id === G_DOCENTE_VECCHIA)
    expect(vecchia).toMatchObject({ tipo: 'impreparato', origine: 'docente', motivo: null, modificabile_dal_genitore: false })
  })

  it('la dichiarazione del GENITORE si vede subito, anche dentro i 10 minuti del docente', async () => {
    const { impreparati } = await leggi()
    expect(impreparati.find((i) => i.id === G_MIA_FRESCA)).toMatchObject({
      origine: 'genitore', tipo: 'giustificato', modificabile_dal_genitore: true,
    })
    // …mentre quella del docente di pari età resta nascosta: il buffer è 10.
    expect(impreparati.find((i) => i.id === G_DOCENTE_FRESCA)).toBeUndefined()
  })

  it('il buffer è quello della sede: a 0 minuti si vede anche l’impreparato appena segnato', async () => {
    h.db.admin_settings = [{ scuola_id: SEDE, notif_buffer_valutazioni_min: 0 }]
    const { impreparati } = await leggi()
    expect(impreparati.find((i) => i.id === G_DOCENTE_FRESCA)).toMatchObject({ tipo: 'giustificato', origine: 'docente' })
  })

  it('modificabile solo la PROPRIA dichiarazione, fino al giorno dichiarato compreso', async () => {
    const { impreparati } = await leggi()
    const mod = Object.fromEntries(impreparati.map((i) => [i.id, i.modificabile_dal_genitore]))
    expect(mod[G_FUTURA]).toBe(true)
    expect(mod[G_OGGI]).toBe(true)
    expect(mod[G_PASSATA]).toBe(false)
    expect(mod[G_ALTRUI]).toBe(false)
    expect(mod[G_DOCENTE_MIA]).toBe(false)
  })

  it('porta tipo, motivo, materia, data e origine — e mai chi l’ha scritto', async () => {
    const { impreparati } = await leggi()
    const f = impreparati.find((i) => i.id === G_FUTURA)
    expect(f).toMatchObject({
      tipo: 'giustificato', motivo: 'MOTIVO-FAMIGLIA', materiaId: MAT, materiaNome: 'Matematica', data: DOMANI, origine: 'genitore',
    })
    expect(impreparati.find((i) => i.id === G_OGGI)).toMatchObject({ materiaId: null, materiaNome: null })
    const testo = JSON.stringify(impreparati)
    expect(testo).not.toContain(IO)
    expect(testo).not.toContain(DOCENTE)
    expect(testo).not.toContain('creato_da')
  })

  it('una lettura fallita degli impreparati è 500 con codice, non una lista vuota', async () => {
    h.errori = { 'giustifiche_didattiche:select': { code: '57014', message: 'timeout' } }
    const res = await votiGET(new NextRequest(`http://localhost/api/parent/primaria/valutazioni?studentId=${ALUNNO}`))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
  })
})

describe('GET dei voti — una lettura fallita non si traveste da «nessun voto»', () => {
  for (const chiave of ['valutazioni:select', 'materie:select'] as const) {
    it(`${chiave} in errore: 500 LETTURA_FALLITA, non 200 con data vuota`, async () => {
      h.errori = { [chiave]: { code: '57014', message: 'SEGRETO-DEL-DATABASE' } }
      const res = await votiGET(new NextRequest(`http://localhost/api/parent/primaria/valutazioni?studentId=${ALUNNO}`))
      expect(res.status).toBe(500)
      const corpo = await res.json()
      expect(corpo.codice).toBe('LETTURA_FALLITA')
      expect(JSON.stringify(corpo)).not.toContain('SEGRETO-DEL-DATABASE')
    })
  }
})

describe('DB E2E della CI non migrato (senza la colonna `tipo`): si degrada, non si rompe', () => {
  it('POST: riprova senza `tipo` e la dichiarazione si salva', async () => {
    h.senzaColonnaTipo = true
    const res = await post({ studentId: ALUNNO, data: DOMANI })
    expect(res.status).toBe(201)
    const insert = h.scritture.find((s) => s.tabella === 'giustifiche_didattiche' && s.operazione === 'insert')
    expect(insert?.valori[0]).toMatchObject({ origine: 'genitore', creato_da: IO })
    expect(insert?.valori[0]).not.toHaveProperty('tipo')
  })

  it('GET: senza `tipo` il tipo si ricava dall’origine', async () => {
    h.senzaColonnaTipo = true
    for (const r of h.db.giustifiche_didattiche as Record<string, unknown>[]) delete r.tipo
    const res = await votiGET(new NextRequest(`http://localhost/api/parent/primaria/valutazioni?studentId=${ALUNNO}`))
    expect(res.status).toBe(200)
    const { impreparati } = (await res.json()) as { impreparati: Array<Record<string, unknown>> }
    expect(impreparati.find((i) => i.id === G_FUTURA)?.tipo).toBe('giustificato')
    expect(impreparati.find((i) => i.id === G_DOCENTE_VECCHIA)?.tipo).toBe('impreparato')
  })
})
