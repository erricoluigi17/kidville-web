import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import type { Proiezione } from '../fixtures/proiezione'
import {
  SEDE_A, SEDE_B, SEDE_C, SEDE_E2E,
  NOME_SEDE_A, NOME_SEDE_B, NOME_SEDE_C, NOME_SEDE_E2E,
} from '../fixtures/sedi'

// =============================================================================
// SPOSTARE UN BAMBINO DA UNA SEDE ALL'ALTRA — `PATCH /api/admin/students`.
//
// ─── IL DIFETTO DI PARTENZA: 200, E NON SI SPOSTAVA NIENTE ───────────────────
//
// `patchBodySchema` è uno `z.object` NON strict e non conteneva `scuola_id`:
// zod scartava la chiave PRIMA dell'handler, senza errore e senza log, e la
// route rispondeva **200** su un trasferimento mai avvenuto. Fino al
// 2026-09-03 l'unica strada per spostare un bambino era una `UPDATE` a mano sul
// database che contiene le anagrafiche di oltre seicento minori.
//
// ─── LE TRE COSE CHE SI ROMPONO SE SI CAMBIA SOLO LA SEDE ────────────────────
//
//  1. `section_id`/`classe_sezione` — il trigger `sync_alunno_section_id`
//     riparte su INSERT, su cambio del NOME della classe o se `section_id` è
//     NULL: cambiando **solo** la sede il bambino resta agganciato alla sezione
//     del plesso di prima. Vanno azzerati NELLA STESSA UPDATE.
//  2. `gruppo_mensa_id` — punta a un gruppo che nella sede nuova non esiste.
//  3. `utenti.scuola_id` del GENITORE — è derivato dai figli, ed è la sede con
//     cui vengono registrate la richiesta GDPR e la notifica dei moduli firmati.
//
// ─── PERCHÉ NON `resolveScuolaScrittura` ────────────────────────────────────
//
// Quella funzione risolve la sede di una riga NUOVA e pretende che sia fra
// quelle dell'utente: su un trasferimento negherebbe con 403 esattamente il caso
// d'uso — il bambino che va in un plesso in cui NON è ancora. Qui la
// destinazione la decide `destinazioniConsentite` (Direzione → tutte le sedi
// reali; Segreteria → solo le proprie), mentre il BERSAGLIO resta protetto da
// `assertAlunnoInScope`. Il fixture lo rende verificabile: l'admin ha in
// `utenti_scuole` solo A e B, e sposta verso C.
//
// ─── IL FINTO CLIENT È QUELLO CHE PROIETTA ───────────────────────────────────
//
// `finto-supabase` non emula la proiezione di `select()`, e qui quel limite
// morderebbe due volte: sul nome delle sedi di destinazione e sulla riga letta
// per l'audit. Si usa `creaFintoSupabaseConProiezione`.
//
// ⚠️ E il nodo `alunni` dentro `student_parents` è LA STESSA riga di `db.alunni`,
// non una copia: `sedeDelGenitore` fa un join `!inner`, e una copia congelata
// alla sede vecchia farebbe passare il riallineo dei genitori qualunque cosa
// faccia il codice — cioè il «mock piatto verde con e senza la correzione».
// =============================================================================

const ADMIN = 'aaaa0000-0000-4000-8000-000000000001'
const SEGRETERIA = 'aaaa0000-0000-4000-8000-000000000002'

const ALU_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const ALU_ARCH = '11111111-1111-4111-8111-aaaaaaaaaaab'
const ALU_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'

const SEC_A = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const SEC_B = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const SEC_C = '33333333-3333-4333-8333-cccccccccccc'
const GM_A = '44444444-4444-4444-8444-aaaaaaaaaaaa'
const GM_C = '44444444-4444-4444-8444-cccccccccccc'

/** Anagrafica `parents` del genitore con UN figlio solo (si riallinea). */
const PAR_UNO = '55555555-5555-4555-8555-000000000001'
/** Anagrafica `parents` del genitore con DUE figli in DUE plessi (non si tocca). */
const PAR_DUE = '55555555-5555-4555-8555-000000000002'
/** I rispettivi account `utenti`. */
const ACC_UNO = '66666666-6666-4666-8666-000000000001'
const ACC_DUE = '66666666-6666-4666-8666-000000000002'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  db: {} as DBFinto,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  errori: {} as Record<string, { code: string; message?: string }>,
  proiezioni: [] as Proiezione[],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: h.logEvento,
  logErrore: h.logErrore,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabaseConProiezione } = await import('../fixtures/proiezione')
  const finto = () =>
    creaFintoSupabaseConProiezione(
      h.db, h.tabelle, { scritture: h.scritture, errori: h.errori }, h.proiezioni,
    )
  return { createAdminClient: async () => finto(), createClient: async () => finto() }
})

import { PATCH } from '@/app/api/admin/students/route'

const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/students', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

function dbBase(): DBFinto {
  const alunni: Riga[] = [
    {
      id: ALU_A, nome: 'Alfa', cognome: 'AaaSedeA', scuola_id: SEDE_A,
      section_id: SEC_A, classe_sezione: '2 ANNI', gruppo_mensa_id: GM_A,
      stato: 'iscritto', archiviato_il: null,
      note_mediche: 'NOTA-MEDICA-A', codice_fiscale: 'CF-ALFA-A',
    },
    {
      id: ALU_ARCH, nome: 'Archiviato', cognome: 'AaaSedeA', scuola_id: SEDE_A,
      section_id: null, classe_sezione: null, gruppo_mensa_id: null,
      stato: 'ritirato', archiviato_il: '2026-08-01T10:00:00.000Z',
      note_mediche: null, codice_fiscale: 'CF-ARCH-A',
    },
    {
      id: ALU_B, nome: 'Beta', cognome: 'CccSedeB', scuola_id: SEDE_B,
      section_id: SEC_B, classe_sezione: '2 ANNI', gruppo_mensa_id: null,
      stato: 'iscritto', archiviato_il: null,
      note_mediche: 'NOTA-MEDICA-B', codice_fiscale: 'CF-BETA-B',
    },
  ]
  return {
    schools: [
      { id: SEDE_A, nome: NOME_SEDE_A },
      { id: SEDE_B, nome: NOME_SEDE_B },
      { id: SEDE_C, nome: NOME_SEDE_C },
      { id: SEDE_E2E, nome: NOME_SEDE_E2E },
    ],
    scuole: [
      { id: SEDE_A, attiva: true }, { id: SEDE_B, attiva: true }, { id: SEDE_C, attiva: true },
    ],
    // L'admin NON ha SEDE_C fra le proprie: è il caso d'uso del trasferimento.
    utenti_scuole: [
      { utente_id: ADMIN, scuola_id: SEDE_A },
      { utente_id: ADMIN, scuola_id: SEDE_B },
    ],
    utenti_sezioni: [],
    sections: [
      { id: SEC_A, scuola_id: SEDE_A, name: '2 ANNI' },
      { id: SEC_B, scuola_id: SEDE_B, name: '2 ANNI' },
      { id: SEC_C, scuola_id: SEDE_C, name: '3 ANNI' },
    ],
    gruppi_mensa: [
      { id: GM_A, scuola_id: SEDE_A, nome: 'Turno Alfa' },
      { id: GM_C, scuola_id: SEDE_C, nome: 'Turno Gamma' },
    ],
    alunni,
    parents: [
      { id: PAR_UNO, auth_user_id: ACC_UNO },
      { id: PAR_DUE, auth_user_id: ACC_DUE },
    ],
    // ⚠️ Il nodo `alunni` è la STESSA riga, non una copia: vedi la testata.
    student_parents: [
      { student_id: ALU_A, parent_id: PAR_UNO, alunni: alunni[0] },
      { student_id: ALU_A, parent_id: PAR_DUE, alunni: alunni[0] },
      { student_id: ALU_B, parent_id: PAR_DUE, alunni: alunni[2] },
    ],
    legame_genitori_alunni: [],
    utenti: [
      { id: ACC_UNO, scuola_id: SEDE_A, ruolo: 'genitore' },
      { id: ACC_DUE, scuola_id: SEDE_A, ruolo: 'genitore' },
    ],
    audit_scritture_docente: [],
  }
}

/** La riga come sta ADESSO nel finto database, non la copia della risposta. */
const riga = (id: string) => h.db.alunni.find((a) => a.id === id)
const utente = (id: string) => h.db.utenti.find((u) => u.id === id)
const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)
const audit = () => h.db.audit_scritture_docente

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.proiezioni = []
  h.requireStaff.mockResolvedValue({ user: { id: ADMIN, role: 'admin', scuola_id: SEDE_A } })
})

// ─────────────────────────────────────────────────────────────────────────────
// Chi può spostare, e verso dove
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — chi può spostare e verso dove', () => {
  it('la Direzione sposta verso una sede che NON è fra le proprie', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_C)
  })

  it('il solo `scuola_id` basta: non è «Nessun campo da aggiornare»', async () => {
    // ⚠️ La trappola: `scuola_id` non sta in `allowedFields` (e non deve starci,
    // altrimenti passerebbe senza essere validato), quindi con un corpo di due
    // chiavi `updates` resta vuoto e la guardia risponderebbe 400 su un
    // trasferimento perfettamente legittimo.
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: ALU_A, scuola_id: SEDE_C })
  })

  it('la segreteria NON sposta fuori dal proprio plesso: 403 e niente scritto', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_B }))
    expect(res.status).toBe(403)
    expect((await res.json()).codice).toBe('SEDE_NON_ACCESSIBILE')
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_A)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('la sede di collaudo E2E non è una destinazione, nemmeno per la Direzione', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_E2E }))
    expect(res.status).toBe(403)
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_A)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('una sede che non esiste è rifiutata, non «indovinata»', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: '99999999-9999-4999-8999-999999999999' }))
    expect(res.status).toBe(403)
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_A)
  })

  it('l\'`educator` non sposta nessuno: il gate viene prima, e non è allargato', async () => {
    // Due cose in una. La prima: `requireStaff` senza secondo argomento ammette
    // `['admin','coordinator','segreteria']` — l'educator è fuori per costruzione,
    // e questa asserzione diventa rossa il giorno in cui qualcuno allarga l'elenco
    // per far passare «solo una lettura». La seconda: davanti a un diniego la route
    // non tocca NESSUNA tabella, quindi non c'è modo di far trapelare una riga
    // provando a scriverla.
    h.requireStaff.mockResolvedValue({
      response: NextResponse.json({ error: 'Accesso negato' }, { status: 403 }),
    })
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(403)
    expect(h.requireStaff.mock.calls[0].slice(1)).toEqual([])
    expect(h.tabelle).toEqual([])
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_A)
  })

  it('il bambino di un\'altra sede resta irraggiungibile, e non trapela niente di lui', async () => {
    h.requireStaff.mockResolvedValue({ user: { id: SEGRETERIA, role: 'segreteria', scuola_id: SEDE_A } })
    const res = await PATCH(patch({ id: ALU_B, scuola_id: SEDE_A }))
    const testo = await res.text()
    expect(res.status).toBe(403)
    expect(testo).not.toContain('NOTA-MEDICA-B')
    expect(testo).not.toContain('CF-BETA-B')
    expect(riga(ALU_B)?.scuola_id).toBe(SEDE_B)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La forma dell'uuid — in Postgres `uuid` è un TIPO, non una stringa
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — la destinazione in MAIUSCOLO', () => {
  it('è accettata, e finisce in archivio nella forma CANONICA del database', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C.toUpperCase() }))
    expect(res.status).toBe(200)
    // Non `SEDE_C.toUpperCase()`: ciò che si scrive è il valore LETTO da
    // `schools`, mai la stringa arrivata dal client.
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_C)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cosa si perde: classe, sezione, gruppo mensa
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — il trasferimento azzera classe e mensa', () => {
  it('sezione, nome della classe e gruppo mensa vanno a NULL nella stessa UPDATE', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    const dopo = riga(ALU_A)
    expect(dopo?.scuola_id).toBe(SEDE_C)
    expect(dopo?.section_id).toBeNull()
    expect(dopo?.classe_sezione).toBeNull()
    expect(dopo?.gruppo_mensa_id).toBeNull()
    // Una sola UPDATE: azzerare in un secondo giro lascerebbe una finestra in cui
    // il bambino è nella sede nuova e ancora agganciato alla sezione vecchia.
    expect(scrittureSu('alunni')).toHaveLength(1)
    expect(scrittureSu('alunni')[0].valori[0]).toMatchObject({
      scuola_id: SEDE_C, section_id: null, classe_sezione: null, gruppo_mensa_id: null,
    })
  })

  it('anche la classe mandata NELLA STESSA richiesta viene azzerata, e la riga di ritorno lo dice', async () => {
    // È il salvataggio del form intero: la scheda rimanda la classe che c'era.
    const res = await PATCH(patch({
      id: ALU_A, scuola_id: SEDE_C, section_id: SEC_C, classe_sezione: '3 ANNI',
    }))
    expect(res.status).toBe(200)
    const corpo = (await res.json()) as { section_id: unknown; classe_sezione: unknown }
    expect(corpo.section_id).toBeNull()
    expect(corpo.classe_sezione).toBeNull()
    expect(riga(ALU_A)?.section_id).toBeNull()
  })

  it('e lascia una riga di log: un campo scartato in silenzio è il difetto di partenza', async () => {
    await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C, classe_sezione: '3 ANNI' }))
    const righe = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'trasferimento-classe-azzerata',
    )
    expect(righe).toHaveLength(1)
  })

  it('senza trasferimento la classe NON viene toccata (nessuna regressione)', async () => {
    const res = await PATCH(patch({ id: ALU_A, nome: 'Alfredo' }))
    expect(res.status).toBe(200)
    const dopo = riga(ALU_A)
    expect(dopo?.section_id).toBe(SEC_A)
    expect(dopo?.classe_sezione).toBe('2 ANNI')
    expect(dopo?.gruppo_mensa_id).toBe(GM_A)
  })

  it('la sede UGUALE a quella attuale non è un trasferimento: non azzera niente', async () => {
    // Il salvataggio del form intero manda sempre la sede corrente: se contasse
    // come trasferimento, ogni salvataggio di una scheda sganciherebbe il
    // bambino dalla sua classe.
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_A, nome: 'Alfredo' }))
    expect(res.status).toBe(200)
    const dopo = riga(ALU_A)
    expect(dopo?.nome).toBe('Alfredo')
    expect(dopo?.section_id).toBe(SEC_A)
    expect(dopo?.classe_sezione).toBe('2 ANNI')
    expect(dopo?.gruppo_mensa_id).toBe(GM_A)
  })

  it('la stessa sede E NIENT\'ALTRO resta un 400 onesto, non una UPDATE vuota', async () => {
    // La guardia «Nessun campo da aggiornare» si è dovuta allentare per far
    // passare `{ id, scuola_id }`; se quella sede non è un trasferimento, senza
    // un secondo controllo partirebbe un UPDATE con il payload VUOTO.
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_A }))
    expect(res.status).toBe(400)
    expect(scrittureSu('alunni')).toHaveLength(0)
    expect(riga(ALU_A)?.section_id).toBe(SEC_A)
  })

  it('la stessa sede scritta in MAIUSCOLO non è un trasferimento', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_A.toUpperCase(), nome: 'Alfredo' }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.section_id).toBe(SEC_A)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'alunno archiviato
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — un bambino archiviato non si sposta', () => {
  it('409 con codice, sede invariata e nessuna scrittura', async () => {
    const res = await PATCH(patch({ id: ALU_ARCH, scuola_id: SEDE_C }))
    expect(res.status).toBe(409)
    expect((await res.json()).codice).toBe('STATO_ALUNNO_ARCHIVIATO')
    expect(riga(ALU_ARCH)?.scuola_id).toBe(SEDE_A)
    expect(scrittureSu('alunni')).toHaveLength(0)
  })

  it('il rifiuto si vede nei log', async () => {
    await PATCH(patch({ id: ALU_ARCH, scuola_id: SEDE_C }))
    const righe = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'trasferimento-su-archiviato-rifiutato',
    )
    expect(righe).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La sede del genitore
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — la sede dell\'account genitore segue i figli', () => {
  it('il genitore con UN figlio si sposta con lui', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(utente(ACC_UNO)?.scuola_id).toBe(SEDE_C)
  })

  it('il genitore con DUE figli in DUE plessi non viene toccato: non esiste una sede giusta', async () => {
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(utente(ACC_DUE)?.scuola_id).toBe(SEDE_A)
    const scritte = scrittureSu('utenti').flatMap((s) => s.colpite.map((r) => r.id))
    expect(scritte).not.toContain(ACC_DUE)
  })

  it('l\'esito del riallineo è scritto nei log, anche quando non cambia niente', async () => {
    await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    const riepilogo = h.logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string })?.esito === 'riallineo-sedi-genitori',
    )
    expect(riepilogo).toBeDefined()
    expect(riepilogo?.[2]).toMatchObject({ aggiornati: 1, ambigui: 1 })
  })

  it('la SEDE non si scarta mai: PGRST204 su `scuola_id` è 500, non un 200 a vuoto', async () => {
    // ─────────────────────────────────────────────────────────────────────────
    // IL DIFETTO DI PARTENZA, RIENTRATO DA UNA PORTA LATERALE.
    //
    // `scuola_id` non era nello schema zod e veniva scartato in silenzio: la
    // route rispondeva 200 e non spostava nessuno. Il ciclo di resilienza di
    // questa PATCH fa una cosa che le somiglia moltissimo — toglie la colonna
    // che il database dice di non conoscere e riprova — ed è giusto che la
    // faccia, perché il DB E2E della CI non è migrato e un campo in più non
    // deve far fallire tutto.
    //
    // Ma su un TRASFERIMENTO quello scarto ricrea il difetto esatto: l'UPDATE
    // riesce senza la sede, e la risposta è 200 su uno spostamento mai
    // avvenuto. La riga che lo impedisce (`if (trasferimento && col ===
    // 'scuola_id') break`) esisteva già; a non esistere era un test che la
    // vedesse fallire, e una difesa che nessun test ha mai visto mordere è
    // decorazione: rilievo del critico, 2026-09-04.
    // ─────────────────────────────────────────────────────────────────────────
    h.errori = {
      'alunni:update': {
        code: 'PGRST204',
        message: "Could not find the 'scuola_id' column of 'alunni' in the schema cache",
      },
    }
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))

    // Rumoroso e vero, invece che silenzioso e falso.
    expect(res.status).not.toBe(200)
    // E soprattutto: il bambino è rimasto dov'era.
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_A)
    // Nessuno scarto: se comparisse, vorrebbe dire che la sede è stata buttata.
    const scarti = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { azione?: string })?.azione === 'colonna-assente-scartata',
    )
    expect(scarti.map((c) => (c[2] as { esito?: string })?.esito)).not.toContain('scuola_id')
  })

  it('...ma le ALTRE colonne si scartano ancora: il degrado pulito non si rompe', async () => {
    // Il controllo negativo del test qui sopra. Senza questo, la correzione più
    // comoda — «non scartare mai niente» — passerebbe, e il DB E2E della CI,
    // che non è migrato, tornerebbe a far fallire l'intera PATCH per un campo
    // che quell'ambiente non conosce.
    h.errori = {
      'alunni:update': {
        code: 'PGRST204',
        message: "Could not find the 'nome' column of 'alunni' in the schema cache",
      },
    }
    await PATCH(patch({ id: ALU_A, nome: 'Beta' }))

    const scarti = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { azione?: string })?.azione === 'colonna-assente-scartata',
    )
    expect(scarti.map((c) => (c[2] as { esito?: string })?.esito)).toContain('nome')
  })

  it('se il riallineo si rompe, il trasferimento resta valido e l\'errore NON si perde', async () => {
    // Fail-open verso il chiamante: il bambino è già stato spostato, e far
    // fallire adesso lascerebbe l'operazione riuscita a metà. Ma non muto.
    h.errori = { 'utenti:update': { code: 'PGRST301', message: 'permission denied' } }
    const res = await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(res.status).toBe(200)
    expect(riga(ALU_A)?.scuola_id).toBe(SEDE_C)
    const errori = h.logEvento.mock.calls.filter((c) => c[1] === 'error')
    expect(errori.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// L'audit e il log del successo
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/students — la traccia del trasferimento', () => {
  it('l\'audit registra il bambino, la sede di PARTENZA e quella di ARRIVO', async () => {
    await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(audit()).toHaveLength(1)
    const r = audit()[0] as Record<string, unknown>
    expect(r.entita_tipo).toBe('alunni')
    expect(r.entita_id).toBe(ALU_A)
    // La colonna porta la sede di PARTENZA: `admin/audit` filtra per le sedi di
    // chi guarda, e `assertAlunnoInScope` garantisce che chi ha spostato avesse
    // in perimetro la sede di partenza — non quella d'arrivo. Con la sede
    // d'arrivo, la riga sarebbe invisibile proprio a chi l'ha scritta.
    expect(r.scuola_id).toBe(SEDE_A)
    expect(r.valore_dopo).toMatchObject({
      scuola_id: SEDE_C,
      trasferimento_sede: { da: SEDE_A, a: SEDE_C },
    })
  })

  it('l\'`azione` dell\'audit è una delle TRE che il database accetta', async () => {
    // ⚠️ Il finto client non emula i CHECK, e questo qui esiste davvero:
    //   audit_scritture_docente_azione_check
    //     CHECK (azione = ANY (ARRAY['insert','update','delete']))
    // verificato su `pg_constraint` in produzione il 2026-09-04. Scrivere
    // `azione: 'trasferimento-sede'` sarebbe passato in questa suite e in
    // produzione avrebbe prodotto un `23514` che `logScrittura` inghiotte: la
    // riga d'audit dell'operazione più delicata dell'anagrafica non sarebbe MAI
    // esistita. Il trasferimento si riconosce da `valore_dopo`, non dall'azione.
    await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    expect(['insert', 'update', 'delete']).toContain(audit()[0].azione)
  })

  it('il SUCCESSO si logga: senza, «nessun log» non distingue «tutto ok» da «non è partito niente»', async () => {
    await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    const ok = h.logEvento.mock.calls.filter(
      (c) => (c[2] as { esito?: string })?.esito === 'trasferimento-sede-eseguito',
    )
    expect(ok).toHaveLength(1)
    expect(ok[0][1]).toBe('info')
    expect(ok[0][2]).toMatchObject({
      operazione: 'admin/students:PATCH', alunno: ALU_A, sede: SEDE_C, sede_precedente: SEDE_A,
    })
  })

  it('nessun dato personale del bambino finisce nei log del trasferimento', async () => {
    await PATCH(patch({ id: ALU_A, scuola_id: SEDE_C }))
    const testo = JSON.stringify(h.logEvento.mock.calls)
    expect(testo).not.toContain('NOTA-MEDICA-A')
    expect(testo).not.toContain('CF-ALFA-A')
    expect(testo).not.toContain('Alfa')
  })
})
