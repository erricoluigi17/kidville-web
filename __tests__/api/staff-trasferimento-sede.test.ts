import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'
import {
  SEDE_A, SEDE_B, SEDE_C, SEDE_E2E,
  NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C, NOME_SEDE_E2E,
} from '../fixtures/sedi'

/* ═════════════════════════════════════════════════════════════════════════════
 * SPOSTARE DI SEDE UN MEMBRO DELLO STAFF — `PATCH /api/admin/staff`.
 *
 * ─── IL DIFETTO DI PARTENZA: SPOSTATO AD AVERSA, ANCORA IN CLASSE A CESA ─────
 *
 * La rotta accettava già `scuola_id`, ma il replace delle classi partiva SOLO se
 * il corpo portava `section_ids`. Il corpo minimo di uno spostamento — `{ id,
 * scuola_id }` — lasciava quindi in piedi le `utenti_sezioni` del plesso di
 * partenza: un docente spostato continuava a risultare assegnato a una sezione
 * dell'altra sede, e da lì `sezioniVisibili` gli apriva il registro di bambini
 * che non sono più i suoi. Nessun errore, nessun log: 200 e via.
 *
 * Misurato in produzione il 2026-09-04, in sola lettura: **65 righe
 * `utenti_sezioni` su 51 persone** legano oggi uno staff a una sezione della sua
 * stessa sede — cioè 51 spostamenti su 75 dipendenti sarebbero rimasti agganciati
 * (fino a 5 sezioni per persona). Altre **2** righe puntano già a una sezione di
 * un'ALTRA sede.
 *
 * ─── L'ALTRA METÀ: `utenti_scuole` ──────────────────────────────────────────
 *
 * Il ponte multi-plesso non veniva toccato. `staffScuola` (le notifiche) unisce
 * `utenti.scuola_id` E `utenti_scuole` PER QUALUNQUE RUOLO: una riga rimasta
 * indietro continua a far arrivare alla persona spostata gli avvisi del plesso
 * che ha lasciato — allergie, mensa, panic-alert — senza che niente lo dica.
 *
 * ─── CHI PUÒ SPOSTARE, E VERSO DOVE ─────────────────────────────────────────
 *
 * Dal 2026-09-04 anche la SEGRETERIA sposta di sede, ma **solo** la sede: ruolo,
 * gradi e classi restano alla Direzione (`puoModificareIncaricoStaff`). La
 * DIREZIONE sposta verso tutte le sedi REALI, comprese quelle che non sono fra le
 * proprie — che è il caso d'uso — mentre il BERSAGLIO resta protetto da
 * `assertUtenteInScope`.
 *
 * ─── IL FINTO CLIENT È QUELLO CHE PROIETTA ──────────────────────────────────
 *
 * `finto-supabase` non emula la proiezione di `select()`: senza
 * `creaFintoSupabaseConProiezione` questo file resterebbe verde anche se la rotta
 * smettesse di CHIEDERE `ruolo` nella riga del bersaglio — e senza quel campo il
 * predicato deciderebbe su `undefined`, cioè si negherebbe tutto in silenzio.
 * ═════════════════════════════════════════════════════════════════════════════ */

const ADMIN_A = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1'
const SEG_A = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1'
const EDU_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const EDU_B = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'
/** Sta in una sede che l'admin NON ha: è il bersaglio fuori perimetro. */
const EDU_C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
/**
 * Il bersaglio del SUPERINSIEME: sta in A e porta addosso tre assegnazioni di
 * tre sedi diverse — la propria (`SEZ_A1`), una TERZA sede (`SEZ_C1`) e quella
 * dove sta andando (`SEZ_B1`). Esiste perché il caso non si poteva scrivere su
 * `EDU_A` senza spostargli sotto i piedi i conteggi di mezzo file: le sue classi
 * sono l'insieme che ogni altro test qui dentro dà per scontato.
 */
const EDU_D = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2'

const SEZ_A1 = 'aaaa1111-1111-4111-8111-111111111111'
const SEZ_A2 = 'aaaa2222-2222-4222-8222-222222222222'
const SEZ_B1 = 'bbbb1111-1111-4111-8111-111111111111'
const SEZ_C1 = 'cccc1111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logScrittura: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
  proiezioni: [] as Proiezione[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/audit/scrittura', () => ({ logScrittura: h.logScrittura }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
  const finto = () =>
    creaFintoSupabaseConProiezione(
      h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }, h.proiezioni,
    )
  return { createAdminClient: async () => finto(), createClient: async () => finto() }
})

import { PATCH } from '@/app/api/admin/staff/route'

const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/staff', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function dbBase(): DBFinto {
  return {
    utenti: [
      { id: ADMIN_A, nome: 'Dora', cognome: 'Direzione', email: 'dir@x.test', ruolo: 'admin', scuola_id: SEDE_A, gradi: [] },
      { id: SEG_A, nome: 'Sara', cognome: 'Sportello', email: 'seg@x.test', ruolo: 'segreteria', scuola_id: SEDE_A, gradi: [] },
      { id: EDU_A, nome: 'Anna', cognome: 'Alfa', email: 'anna@x.test', ruolo: 'educator', scuola_id: SEDE_A, gradi: ['infanzia'] },
      { id: EDU_B, nome: 'Bruno', cognome: 'Beta', email: 'bruno@x.test', ruolo: 'educator', scuola_id: SEDE_B, gradi: [] },
      { id: EDU_C, nome: 'Carla', cognome: 'Gamma', email: 'carla@x.test', ruolo: 'educator', scuola_id: SEDE_C, gradi: [] },
      { id: EDU_D, nome: 'Dina', cognome: 'Delta', email: 'dina@x.test', ruolo: 'educator', scuola_id: SEDE_A, gradi: [] },
    ],
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
      { id: SEDE_C, nome: NOME_SEDE_C },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ],
    scuole: [
      { id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }, { id: SEDE_C, attiva: true },
    ],
    sections: [
      { id: SEZ_A1, name: '2 ANNI', scuola_id: SEDE_A, school_type: 'infanzia' },
      { id: SEZ_A2, name: '3 ANNI', scuola_id: SEDE_A, school_type: 'infanzia' },
      { id: SEZ_B1, name: '2 ANNI', scuola_id: SEDE_B, school_type: 'infanzia' },
      { id: SEZ_C1, name: '2 ANNI', scuola_id: SEDE_C, school_type: 'infanzia' },
    ],
    utenti_sezioni: [
      { utente_id: EDU_A, section_id: SEZ_A1 },
      { utente_id: EDU_A, section_id: SEZ_A2 },
      { utente_id: EDU_B, section_id: SEZ_B1 },
      // `EDU_D`: tre sedi addosso a una persona sola. Le due righe di mezzo
      // (`SEZ_C1`, `SEZ_B1`) sono ciò che distingue «si sgancia tutto ciò che
      // non è del plesso d'ARRIVO» da «si sgancia ciò che era della PARTENZA»,
      // e senza di esse quella differenza non la misurava nessuno.
      { utente_id: EDU_D, section_id: SEZ_A1 },
      { utente_id: EDU_D, section_id: SEZ_C1 },
      { utente_id: EDU_D, section_id: SEZ_B1 },
    ],
    // L'admin ha A e B, NON C: spostare verso C è il caso d'uso.
    // `EDU_A` ha una riga di ponte sulla PROPRIA sede: è quella che resterebbe
    // indietro dopo lo spostamento.
    utenti_scuole: [
      { utente_id: ADMIN_A, scuola_id: SEDE_A },
      { utente_id: ADMIN_A, scuola_id: SEDE_B },
      { utente_id: EDU_A, scuola_id: SEDE_A },
    ],
  }
}

const riga = (id: string): Riga | undefined => h.db.utenti.find((u) => u.id === id)
const scrittureSu = (t: string) => h.scritture.filter((s) => s.tabella === t)
const sezioniDi = (id: string) => h.db.utenti_sezioni.filter((r) => r.utente_id === id)
const ponteDi = (id: string) => h.db.utenti_scuole.filter((r) => r.utente_id === id)
const eventiCon = (esito: string) =>
  h.logEvento.mock.calls.filter((c) => (c[2] as { esito?: string })?.esito === esito)

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.proiezioni = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN_A, role: 'admin', scuola_id: SEDE_A } })
})

// ─────────────────────────────────────────────────────────────────────────────
// Il gate di rotta
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — il gate ammette anche la Segreteria', () => {
  it('chiede admin, coordinator E segreteria (la riserva sui CAMPI viene dopo)', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_A }))
    expect(h.requireStaff).toHaveBeenCalledWith(expect.anything(), ['admin', 'coordinator', 'segreteria'])
  })

  it('403 se il gate nega: nessuna lettura e nessuna scrittura', async () => {
    h.requireStaff.mockResolvedValue({ response: NextResponse.json({}, { status: 403 }) })
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(403)
    expect(h.tabelle).toEqual([])
    expect(h.scritture).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La Segreteria: la sede sì, il resto no
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — la Segreteria non cambia il RUOLO', () => {
  beforeEach(() => {
    h.requireStaff.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
  })

  it('403 con codice, e il ruolo resta quello di prima', async () => {
    const res = await PATCH(patch({ id: EDU_A, ruolo: 'admin', section_ids: [SEZ_A1, SEZ_A2] }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('INCARICO_STAFF_RISERVATO')
    expect(riga(EDU_A)?.ruolo).toBe('educator')
    expect(h.scritture).toEqual([])
  })

  it('il tentativo lascia una riga di log: è un segnale di sicurezza da contare', async () => {
    await PATCH(patch({ id: EDU_A, ruolo: 'admin' }))
    const righe = eventiCon('incarico-riservato')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('warn')
    expect(righe[0][2]).toMatchObject({ stato: 'riservato-direzione' })
  })

  it('403 anche sul solo tocco di un account di DIREZIONE, sede compresa', async () => {
    const res = await PATCH(patch({ id: ADMIN_A, scuola_id: SEDE_A }))
    expect(res.status).toBe(403)
    expect(eventiCon('incarico-riservato')[0][2]).toMatchObject({ stato: 'bersaglio-direzione' })
    expect(h.scritture).toEqual([])
  })

  it('403 se cambia le CLASSI assegnate: decidono quali bambini vede un educator', async () => {
    const res = await PATCH(patch({ id: EDU_A, section_ids: [SEZ_A1] }))
    expect(res.status).toBe(403)
    expect(sezioniDi(EDU_A)).toHaveLength(2)
    expect(scrittureSu('utenti_sezioni')).toEqual([])
  })

  it('403 se manda `gradi`: quel campo la scheda non lo manda mai, quindi è deliberato', async () => {
    const res = await PATCH(patch({ id: EDU_A, gradi: ['primaria'] }))
    expect(res.status).toBe(403)
    expect(riga(EDU_A)?.gradi).toEqual(['infanzia'])
  })

  it('il salvataggio del form INTERO che non cambia niente passa: 200, e niente si muove', async () => {
    // La scheda rimanda sempre ruolo e classi, e l'ORDINE delle classi è quello
    // in cui l'operatore ha premuto le pillole. Se contassero per PRESENZA — o
    // se l'insieme si confrontasse per posizione — la Segreteria si vedrebbe
    // negare ogni salvataggio.
    const res = await PATCH(patch({
      id: EDU_A, ruolo: 'educator', scuola_id: SEDE_A, section_ids: [SEZ_A2, SEZ_A1],
    }))
    expect(res.status).toBe(200)
    expect(riga(EDU_A)).toMatchObject({ ruolo: 'educator', scuola_id: SEDE_A })
    expect(sezioniDi(EDU_A).map((r) => r.section_id).sort()).toEqual([SEZ_A1, SEZ_A2].sort())
    expect(ponteDi(EDU_A)).toHaveLength(1)
  })

  it('resta dentro le PROPRIE sedi: verso un plesso non suo è 403 «sede non accessibile»', async () => {
    // ⚠️ Oggi «le proprie» per una segreteria è SEMPRE una sola: `scuoleDiUtente`
    // legge il ponte `utenti_scuole` solo per `role === 'admin'`. Il permesso
    // esiste, il corridoio è largo un passo — e questo test diventerà il primo a
    // parlare il giorno in cui qualcuno allargherà quella funzione.
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La Direzione sposta anche verso una sede che non è la sua
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — la destinazione', () => {
  it('la Direzione sposta verso una sede REALE che non è fra le proprie', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_C)
  })

  it('la sede di collaudo E2E non è una destinazione', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_E2E }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_A)
  })

  it('una sede che non esiste è negata, e il tentativo si conta', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: '99999999-9999-4999-8999-999999999999' }))
    expect(res.status).toBe(403)
    expect(eventiCon('trasferimento-destinazione-negata')).toHaveLength(1)
  })

  it('la destinazione in MAIUSCOLO passa, e si scrive la forma CANONICA del database', async () => {
    // In Postgres `uuid` è un TIPO: 'CCCC…' e 'cccc…' sono lo stesso valore.
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C.toUpperCase() }))
    expect(res.status).toBe(200)
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_C)
  })

  it('`scuola_id: null` non è una destinazione: 400, e non si scrive NULL su una colonna NOT NULL', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: null }))
    expect(res.status).toBe(400)
    expect((await res.json()).codice).toBe('SEDE_DA_SPECIFICARE')
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_A)
    expect(scrittureSu('utenti')).toEqual([])
  })

  it('500 onesto se l\'elenco delle sedi non si legge: «vuoto» non è «rotto»', async () => {
    h.errori = { schools: { code: '42P01', message: 'relation does not exist' } }
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LETTURA_FALLITA')
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_A)
  })

  it('il bersaglio di una sede FUORI perimetro resta irraggiungibile', async () => {
    // L'admin ha A e B nel ponte, non C: `assertUtenteInScope` ferma tutto prima
    // ancora che si sappia che ruolo abbia questa persona.
    const res = await PATCH(patch({ id: EDU_C, scuola_id: SEDE_A }))
    expect(res.status).toBe(403)
    expect(riga(EDU_C)?.scuola_id).toBe(SEDE_C)
    expect(h.scritture).toEqual([])
  })

  it('un bersaglio che non esiste affatto è 404', async () => {
    const res = await PATCH(patch({ id: '88888888-8888-4888-8888-888888888888', scuola_id: SEDE_C }))
    expect(res.status).toBe(404)
    expect(h.scritture).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL DIFETTO VERO: le classi della sede di partenza
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — il trasferimento sgancia le classi del plesso lasciato', () => {
  it('anche SENZA `section_ids`: è il corpo minimo di un pulsante «Sposta di sede»', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_A)).toEqual([])
    // E solo le sue: il collega dell'altra sede non c'entra niente.
    expect(sezioniDi(EDU_B)).toHaveLength(1)
  })

  it('le classi rimandate dal form INTERO non tornano indietro, e nessun insert parte', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C, section_ids: [SEZ_A1, SEZ_A2] }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_A)).toEqual([])
    expect(scrittureSu('utenti_sezioni').filter((s) => s.operazione === 'insert')).toEqual([])
  })

  it('e lo dice: un campo scartato in silenzio è il difetto da cui veniamo', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C, section_ids: [SEZ_A1] }))
    const righe = eventiCon('trasferimento-classi-sganciate')
    expect(righe).toHaveLength(1)
    expect(righe[0][2]).toMatchObject({ n: 2 })
  })

  it('la STESSA sede non è un trasferimento: le classi non si toccano', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_A }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_A)).toHaveLength(2)
    expect(h.scritture).toEqual([])
  })

  it('senza trasferimento il replace classico continua a funzionare', async () => {
    const res = await PATCH(patch({ id: EDU_A, section_ids: [SEZ_A2] }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_A).map((r) => r.section_id)).toEqual([SEZ_A2])
  })

  it('500 se lo sgancio fallisce, e la persona NON è stata spostata', async () => {
    // L'ordine è «prima si sgancia, poi si sposta». Al rovescio, un delete
    // fallito lascerebbe la persona nella sede nuova ANCORA agganciata alle
    // classi della vecchia: cioè esattamente il difetto, con un 500 sopra.
    h.errori = { 'utenti_sezioni:delete': { code: '42501', message: 'permission denied' } }
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(500)
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'altra metà: il ponte `utenti_scuole`
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — il ponte multi-plesso segue lo spostamento', () => {
  it('la riga della sede LASCIATA viene rimossa: `staffScuola` la unisce per qualunque ruolo', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(ponteDi(EDU_A)).toEqual([])
    // Il ponte di chi non si è mosso resta intatto.
    expect(ponteDi(ADMIN_A)).toHaveLength(2)
  })

  it('senza trasferimento il ponte non si tocca', async () => {
    await PATCH(patch({ id: EDU_A, section_ids: [SEZ_A1] }))
    expect(ponteDi(EDU_A)).toHaveLength(1)
  })

  it('ponte ASSENTE (DB della CI non migrato): lo spostamento va avanti lo stesso', async () => {
    h.errori = { utenti_scuole: { code: '42P01', message: 'relation does not exist' } }
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_C)
  })

  it('ponte illeggibile per un ALTRO motivo: si ferma, e non si sposta nessuno', async () => {
    // «Tabella assente» è la CI non migrata; un permesso negato no. Andare avanti
    // lascerebbe la persona spostata e ancora fra lo staff del plesso lasciato.
    h.errori = { 'utenti_scuole:delete': { code: '42501', message: 'permission denied' } }
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(500)
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Il successo si logga
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — il trasferimento riuscito lascia traccia', () => {
  it('una riga `info` con sede di arrivo, sede di partenza e conteggi', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    const righe = eventiCon('trasferimento-sede-eseguito')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('info')
    expect(righe[0][2]).toMatchObject({
      operazione: 'admin/staff:PATCH',
      azione: 'trasferimento-sede',
      sede: SEDE_C,
      sede_precedente: SEDE_A,
      sezioni_sganciate: 2,
      ponte_rimosso: 1,
    })
  })

  it('nessun dato personale nella riga: solo uuid, ruolo e conteggi', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    const corpo = JSON.stringify(eventiCon('trasferimento-sede-eseguito')[0][2])
    expect(corpo).not.toContain('Anna')
    expect(corpo).not.toContain('anna@x.test')
  })

  it('l\'audit resta `update`: `azione` ha tre soli valori ammessi dal CHECK a database', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(h.logScrittura).toHaveBeenCalledTimes(1)
    expect(h.logScrittura.mock.calls[0][1]).toMatchObject({ azione: 'update' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La riga del bersaglio si LEGGE davvero (la proiezione morde)
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — il ruolo del bersaglio arriva dal database', () => {
  it('la lettura del bersaglio chiede `ruolo`: senza, il predicato deciderebbe su undefined', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    const letture = h.proiezioni.filter((p) => p.tabella === 'utenti')
    expect(letture.some((p) => /\bruolo\b/.test(p.colonne))).toBe(true)
  })

  it('un ruolo bersaglio SCONOSCIUTO è negato anche alla Direzione (fail-closed)', async () => {
    h.db.utenti = h.db.utenti.map((u) => (u.id === EDU_A ? { ...u, ruolo: 'direttore_didattico' } : u))
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(403)
    expect(eventiCon('incarico-riservato')[0][2]).toMatchObject({ stato: 'bersaglio-sconosciuto' })
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_A)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// LE CLASSI DEL PLESSO D'ARRIVO — la metà che il primo giro aveva scartato
// ─────────────────────────────────────────────────────────────────────────────

/* ⚠️ È IL FLUSSO REALE DELLA SCHEDA, non un corpo di fantasia. In «Modifica»
 * `StaffDetailPanel` filtra le pillole delle classi sulla sede scelta nella
 * tendina (`sezioniPerSede`, riga 1234) e salva il form INTERO: chi cambia il
 * plesso e spunta una classe del plesso NUOVO manda esattamente questo corpo —
 * le vecchie, che restano spuntate ma non si vedono più, e le nuove.
 *
 * Fino al 2026-09-04 quella richiesta rispondeva **200 senza assegnare niente**,
 * e `valore_dopo.section_ids` dell'audit diceva il contrario di ciò che stava nel
 * database: peggio dello scarto, perché una traccia che mente porta chi indaga
 * lontano dal guasto invece che dentro. */
describe('PATCH /api/admin/staff — le classi del plesso d\'ARRIVO si applicano', () => {
  it('con [A1, B1] verso B: A1 se ne va e B1 viene assegnata davvero', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_A1, SEZ_B1] }))
    expect(res.status).toBe(200)
    expect(riga(EDU_A)?.scuola_id).toBe(SEDE_B)
    expect(sezioniDi(EDU_A).map((r) => r.section_id)).toEqual([SEZ_B1])
  })

  it('l\'audit registra le sezioni SCRITTE, non quelle CHIESTE', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_A1, SEZ_B1] }))
    const dopo = h.logScrittura.mock.calls[0][1] as { valoreDopo: { section_ids?: unknown } }
    expect(dopo.valoreDopo.section_ids).toEqual([SEZ_B1])
  })

  it('senza `section_ids` non si aggancia niente: il corpo non ha chiesto classi', async () => {
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_A)).toEqual([])
    expect(scrittureSu('utenti_sezioni').filter((s) => s.operazione === 'insert')).toEqual([])
  })

  it('si scrive la forma CANONICA del database, non la stringa arrivata dal client', async () => {
    // In Postgres `uuid` è un TIPO: 'BBBB…' e 'bbbb…' sono lo stesso valore, e
    // scrivere quella del client renderebbe due righe uguali distinguibili in
    // JavaScript — che è come questo repo si è già procurato un 403 sulla
    // propria sede.
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_B1.toUpperCase()] }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_A).map((r) => r.section_id)).toEqual([SEZ_B1])
  })

  it('500 se l\'aggancio fallisce: mai un 200 su un trasferimento fatto a metà', async () => {
    h.errori = { 'utenti_sezioni:insert': { code: '42501', message: 'permission denied' } }
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_B1] }))
    expect(res.status).toBe(500)
  })

  it('una classe che non è del plesso d\'arrivo NON si assegna, nemmeno alla Direzione', async () => {
    // `SEZ_C1` è di SEDE_C: chiederla mentre si sposta verso B non la fa entrare
    // per la porta di servizio del trasferimento.
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_C1] }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_A)).toEqual([])
  })

  it('la Segreteria non passa di qui: assegnare una classe è un cambio di CLASSI', async () => {
    // La riserva sui campi viene PRIMA della destinazione, quindi il codice è
    // quello dell'incarico: la Segreteria sposta, non assegna.
    h.requireStaff.mockResolvedValue({ user: { id: SEG_A, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_B1] }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('INCARICO_STAFF_RISERVATO')
    expect(h.scritture).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LO SCARTO SI DICE, E NON DIPENDE DALLO SGANCIO
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/staff — le classi chieste e non onorate lasciano una riga', () => {
  it('anche quando non c\'era NIENTE da sganciare: le due righe sono indipendenti', async () => {
    // Bersaglio senza nessuna classe: `trasferimento-classi-sganciate` non parte,
    // ed è il caso in cui fino al 2026-09-04 `section_ids` spariva in silenzio.
    h.db.utenti_sezioni = h.db.utenti_sezioni.filter((r) => r.utente_id !== EDU_A)
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_A1] }))
    expect(res.status).toBe(200)
    expect(eventiCon('trasferimento-classi-sganciate')).toHaveLength(0)
    const righe = eventiCon('trasferimento-classi-scartate')
    expect(righe).toHaveLength(1)
    expect(righe[0][1]).toBe('warn')
    expect(righe[0][2]).toMatchObject({ operazione: 'admin/staff:PATCH', n: 1 })
  })

  it('conta le SCARTATE, non le chieste: [A1, B1] verso B ne scarta una sola', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_A1, SEZ_B1] }))
    expect(eventiCon('trasferimento-classi-scartate')[0][2]).toMatchObject({ n: 1 })
  })

  it('nessuna riga quando ogni classe chiesta è stata onorata', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_B1] }))
    expect(eventiCon('trasferimento-classi-scartate')).toEqual([])
  })

  it('nessuna riga quando il corpo non chiedeva classi affatto', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B }))
    expect(eventiCon('trasferimento-classi-scartate')).toEqual([])
  })

  it('nessun dato personale nella riga dello scarto: solo uuid e conteggi', async () => {
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_B, section_ids: [SEZ_A1] }))
    const corpo = JSON.stringify(eventiCon('trasferimento-classi-scartate')[0][2])
    expect(corpo).not.toContain('Anna')
    expect(corpo).not.toContain('anna@x.test')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IL SUPERINSIEME: non «ciò che era della partenza», ma «ciò che non è dell'arrivo»
// ─────────────────────────────────────────────────────────────────────────────

/* ⚠️ QUESTO BLOCCO ESISTE PER UN MUTANTE PRECISO. Sostituendo nel codice
 * `formaConfronto(sede) !== arrivo` con `formaConfronto(sede) === partenza` — la
 * versione «ovvia» della stessa regola — i test di questo file restavano TUTTI
 * verdi: nessuno aveva mai messo addosso a un bersaglio una classe che non fosse
 * né della partenza né dell'arrivo. Un test mai visto fallire non è un test. */
describe('PATCH /api/admin/staff — si sgancia il SUPERINSIEME, non solo il plesso lasciato', () => {
  it('la classe di una TERZA sede se ne va, e quella già nel plesso d\'arrivo RESTA', async () => {
    const res = await PATCH(patch({ id: EDU_D, scuola_id: SEDE_B }))
    expect(res.status).toBe(200)
    expect(riga(EDU_D)?.scuola_id).toBe(SEDE_B)
    // `SEZ_A1` (partenza) e `SEZ_C1` (terza sede) via; `SEZ_B1` è dove la
    // persona sta andando, e lì ci resta: sganciarla sarebbe togliere una classe
    // che nessuno ha chiesto di togliere.
    expect(sezioniDi(EDU_D).map((r) => r.section_id)).toEqual([SEZ_B1])
  })

  it('e il conteggio nel log dice DUE, non una', async () => {
    await PATCH(patch({ id: EDU_D, scuola_id: SEDE_B }))
    expect(eventiCon('trasferimento-classi-sganciate')[0][2]).toMatchObject({ n: 2 })
    expect(eventiCon('trasferimento-sede-eseguito')[0][2]).toMatchObject({ sezioni_sganciate: 2 })
  })

  it('il replace del form intero non resuscita la classe della terza sede', async () => {
    const res = await PATCH(patch({ id: EDU_D, scuola_id: SEDE_B, section_ids: [SEZ_A1, SEZ_C1, SEZ_B1] }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_D).map((r) => r.section_id)).toEqual([SEZ_B1])
    expect(eventiCon('trasferimento-classi-scartate')[0][2]).toMatchObject({ n: 2 })
  })

  it('`section_ids` che TOGLIE la classe del plesso d\'arrivo viene onorato: è un replace', async () => {
    const res = await PATCH(patch({ id: EDU_D, scuola_id: SEDE_B, section_ids: [] }))
    expect(res.status).toBe(200)
    expect(sezioniDi(EDU_D)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// NEI LOG, `ruolo` È IL RUOLO CHE HA DECISO — mai la veste indossata
// ─────────────────────────────────────────────────────────────────────────────

/* Le quattro insegnanti che sono anche genitori di un bambino della scuola
 * cambiano veste con un cookie, e con essa cambia `user.role`. Se le righe di
 * sicurezza di questa rotta portassero quella stringa sotto il nome `ruolo`, una
 * segretaria che sta guardando l'app come mamma comparirebbe nel conteggio dei
 * tentativi come `genitore`: un falso allarme, e insieme il travestimento
 * perfetto di un allarme vero — perché il potere con cui ha agito non sarebbe
 * scritto da nessuna parte. AUTORIZZAZIONE = ruoli reali, PRESENTAZIONE = veste. */
describe('PATCH /api/admin/staff — nei log `ruolo` è il ruolo che ha DECISO', () => {
  it('il diniego dice `segreteria`, non la veste da genitore di chi ha premuto', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEG_A, role: 'genitore', ruoli: ['segreteria'], scuola_id: SEDE_A } })
    const res = await PATCH(patch({ id: EDU_A, ruolo: 'admin' }))
    expect(res.status).toBe(403)
    const riga = eventiCon('incarico-riservato')[0][2] as { ruolo?: string; stato?: string }
    expect(riga.ruolo).toBe('segreteria')
    // `stato` resta il MOTIVO: è l'informazione per cui questa riga esiste.
    expect(riga.stato).toBe('riservato-direzione')
  })

  it('la destinazione negata dice `admin`, e la veste sta su `stato`', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: ADMIN_A, role: 'genitore', ruoli: ['admin'], scuola_id: SEDE_A } })
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_E2E }))
    expect(res.status).toBe(403)
    expect(eventiCon('trasferimento-destinazione-negata')[0][2]).toMatchObject({
      ruolo: 'admin', stato: 'genitore',
    })
  })

  it('il trasferimento riuscito dice `admin`, e la veste sta su `stato`', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: ADMIN_A, role: 'genitore', ruoli: ['admin'], scuola_id: SEDE_A } })
    const res = await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(eventiCon('trasferimento-sede-eseguito')[0][2]).toMatchObject({
      ruolo: 'admin', stato: 'genitore',
    })
  })

  it('la veste è la stessa del ruolo quando nessuno si è cambiato d\'abito', async () => {
    // Il caso normale — 617 utenti su 618 — deve restare leggibile: due campi
    // che dicono la stessa cosa, non una riga più povera di prima.
    await PATCH(patch({ id: EDU_A, scuola_id: SEDE_C }))
    expect(eventiCon('trasferimento-sede-eseguito')[0][2]).toMatchObject({
      ruolo: 'admin', stato: 'admin',
    })
  })
})
