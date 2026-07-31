import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { AppRole, AppUser } from '@/lib/auth/require-staff'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A, SEDE_B, SEDE_C, SEDE_E2E } from '../../fixtures/sedi'
import {
  creaFintoSupabase,
  type DBFinto,
  type ErrorePostgrest,
  type Scrittura,
} from '../../fixtures/finto-supabase'

// =============================================================================
// IL TEST DEL MODULO CHE CONTIENE TUTTI I PRIMITIVI D'ISOLAMENTO.
//
// Fino al 2026-07-31 `src/lib/auth/scope.ts` non aveva **un solo test**: 83 file
// di `__tests__/` lo sostituivano con `vi.mock('@/lib/auth/scope', …)` e ZERO lo
// importavano davvero. Un primitivo non testato che sbaglia, sbaglia in tutte le
// 137 route che lo usano nello stesso istante — ed è esattamente quello che è
// successo: `resolveScuolaScrittura` ripiegava su `user.scuola_id` PRIMA di
// rispondere 400, quindi l'admin che non indicava la sede si vedeva archiviare i
// dati su Giugliano in silenzio, anche mentre guardava Aversa.
//
// Perciò qui il modulo si importa VERO e si esercita col finto client
// (`__tests__/fixtures/finto-supabase.ts`), che i filtri li applica davvero.
// L'unico mock è il logger, e serve ad ASSERIRE i log di sicurezza, non a
// zittirli.
//
// Regola di questa famiglia di test (audit 2026-07-30, due falsi verdi):
// mai `not.toBe(403)` come controllo positivo. Si asserisce il valore atteso —
// lo stato esatto e la sede esatta — e, dove c'è una scrittura, lo stato del
// database attraverso l'accumulatore `scritture`.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import {
  scuoleDiUtente,
  resolveScuoleAttive,
  resolveScuolaScrittura,
  vedeTutteLeClassi,
  sezioniVisibili,
  assertSezioneInScope,
  assertClasseNomeInScope,
  assertAlunniInSezione,
  assertUtenteInScope,
  assertPagamentoInScope,
  assertParentInScope,
  assertAlunnoInScope,
} from '@/lib/auth/scope'

// ── identità finte (nessun uuid di produzione, mai) ──────────────────────────

const ID_ADMIN = 'd0000000-0000-4000-8000-00000000ad00'
const ID_SEGRETERIA = 'd0000000-0000-4000-8000-00000000e600'
const ID_EDUCATOR = 'd0000000-0000-4000-8000-0000000ed000'
const ID_COORD = 'd0000000-0000-4000-8000-0000000c0000'
const ID_COLLEGA_A = 'd0000000-0000-4000-8000-00000000c0a0'
const ID_COLLEGA_B = 'd0000000-0000-4000-8000-00000000c0b0'

/** «GIRASOLI» esiste in ENTRAMBE le sedi: è l'omonimia che ha aperto le falle. */
const SEZ_A_GIRASOLI = 'facc0000-0000-4000-8000-0000000000a1'
const SEZ_A_TULIPANI = 'facc0000-0000-4000-8000-0000000000a2'
const SEZ_B_GIRASOLI = 'facc0000-0000-4000-8000-0000000000b1'

const ALU_A_ASSEGNATO = 'a1a10000-0000-4000-8000-0000000000a1'
const ALU_A_ALTRA_CLASSE = 'a1a10000-0000-4000-8000-0000000000a2'
const ALU_B = 'a1a10000-0000-4000-8000-0000000000b1'

const PAR_A = 'bab00000-0000-4000-8000-0000000000a1'
const PAR_B = 'bab00000-0000-4000-8000-0000000000b1'
const PAR_ORFANO = 'bab00000-0000-4000-8000-0000000000f0'

const PAG_A = 'ba500000-0000-4000-8000-0000000000a1'
const PAG_B = 'ba500000-0000-4000-8000-0000000000b1'
const PAG_SENZA_SEDE = 'ba500000-0000-4000-8000-0000000000f0'

// ── utenti ───────────────────────────────────────────────────────────────────

const utente = (id: string, role: AppRole, scuola_id: string | null): AppUser => ({
  id,
  role,
  scuola_id,
})

/** La Direzione: sede primaria A, ponte verso A, B e C. È l'unico multi-sede. */
const ADMIN_TRE_SEDI = utente(ID_ADMIN, 'admin', SEDE_A)
/** Segreteria: una sede sola, per modello. */
const SEGRETERIA_A = utente(ID_SEGRETERIA, 'segreteria', SEDE_A)
const COORD_A = utente(ID_COORD, 'coordinator', SEDE_A)
/** Educator della sede A, assegnato alla sola «GIRASOLI» di A. */
const EDUCATOR_A = utente(ID_EDUCATOR, 'educator', SEDE_A)
/** Un utente senza plesso: non deve poter scrivere da nessuna parte. */
const SENZA_SEDE = utente(ID_EDUCATOR, 'educator', null)

// ── database finto ───────────────────────────────────────────────────────────

function db(): DBFinto {
  return {
    utenti_scuole: [
      { utente_id: ID_ADMIN, scuola_id: SEDE_A },
      { utente_id: ID_ADMIN, scuola_id: SEDE_B },
      { utente_id: ID_ADMIN, scuola_id: SEDE_C },
      // Ponte presente anche per la segreteria: NON deve contare. È la riga che
      // dimostra che il modello «solo l'admin è multi-plesso» sta nel codice e
      // non nella disciplina di chi popola la tabella.
      { utente_id: ID_SEGRETERIA, scuola_id: SEDE_B },
    ],
    utenti_sezioni: [{ utente_id: ID_EDUCATOR, section_id: SEZ_A_GIRASOLI }],
    sections: [
      { id: SEZ_A_GIRASOLI, name: 'GIRASOLI', scuola_id: SEDE_A },
      { id: SEZ_A_TULIPANI, name: 'TULIPANI', scuola_id: SEDE_A },
      { id: SEZ_B_GIRASOLI, name: 'GIRASOLI', scuola_id: SEDE_B },
    ],
    utenti: [
      { id: ID_COLLEGA_A, scuola_id: SEDE_A, ruolo: 'educator' },
      { id: ID_COLLEGA_B, scuola_id: SEDE_B, ruolo: 'educator' },
    ],
    alunni: [
      { id: ALU_A_ASSEGNATO, scuola_id: SEDE_A, section_id: SEZ_A_GIRASOLI },
      { id: ALU_A_ALTRA_CLASSE, scuola_id: SEDE_A, section_id: SEZ_A_TULIPANI },
      { id: ALU_B, scuola_id: SEDE_B, section_id: SEZ_B_GIRASOLI },
    ],
    student_parents: [
      { parent_id: PAR_A, student_id: ALU_A_ASSEGNATO, alunni: { scuola_id: SEDE_A } },
      { parent_id: PAR_B, student_id: ALU_B, alunni: { scuola_id: SEDE_B } },
    ],
    // L'anagrafica esiste anche per il genitore SENZA figli collegati: è ciò che
    // distingue «non è tuo» da «non esiste» (vedi assertParentInScope).
    parents: [{ id: PAR_A }, { id: PAR_B }, { id: PAR_ORFANO }],
    pagamenti: [
      { id: PAG_A, scuola_id: SEDE_A },
      { id: PAG_B, scuola_id: SEDE_B },
      { id: PAG_SENZA_SEDE, scuola_id: null },
    ],
  }
}

/** Il finto client + i suoi accumulatori (letture e scritture). */
function client(opzioni: { errori?: Record<string, ErrorePostgrest> } = {}) {
  const dati = db()
  const lette: string[] = []
  const scritture: Scrittura[] = []
  return {
    supabase: creaFintoSupabase(dati, lette, { scritture, errori: opzioni.errori }),
    dati,
    lette,
    scritture,
  }
}

/** Una richiesta finta: al modulo serve solo `cookies.get('sedi_attive')`. */
function richiesta(cookie?: string): NextRequest {
  return {
    cookies: {
      get: (nome: string) =>
        cookie !== undefined && nome === 'sedi_attive' ? { value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

/** Estrae `{ status, error }` da una NextResponse di diniego. */
async function esito(res: unknown): Promise<{ status: number; error: string }> {
  const r = res as { status: number; json: () => Promise<{ error?: string }> }
  const body = await r.json()
  return { status: r.status, error: String(body.error ?? '') }
}

/** I log `warn`/`error` emessi, per tipo. */
const tipiLoggati = (livello: 'warn' | 'error'): string[] =>
  logEvento.mock.calls
    .filter((c) => c[1] === livello)
    .map((c) => String((c[2] as { tipo?: string })?.tipo ?? ''))

beforeEach(() => {
  logEvento.mockClear()
})

// =============================================================================
// scuoleDiUtente — chi è multi-plesso, e chi non lo diventa per una riga in più
// =============================================================================

describe('scuoleDiUtente', () => {
  it("l'admin somma la sede primaria e il ponte utenti_scuole, senza duplicati", async () => {
    const { supabase } = client()
    expect(await scuoleDiUtente(supabase, ADMIN_TRE_SEDI)).toEqual([SEDE_A, SEDE_B, SEDE_C])
  })

  it('la segreteria resta alla propria sede ANCHE con una riga di ponte verso un altro plesso', async () => {
    const { supabase, lette } = client()
    expect(await scuoleDiUtente(supabase, SEGRETERIA_A)).toEqual([SEDE_A])
    // E il ponte non lo legge nemmeno: la decisione è di modello, non di dato.
    expect(lette).not.toContain('utenti_scuole')
  })

  it("l'educator resta alla propria sede", async () => {
    const { supabase } = client()
    expect(await scuoleDiUtente(supabase, EDUCATOR_A)).toEqual([SEDE_A])
  })

  it('un utente senza sede primaria e senza ponte non ha nessun plesso', async () => {
    const { supabase } = client()
    expect(await scuoleDiUtente(supabase, SENZA_SEDE)).toEqual([])
  })

  // ── F3: la lettura fallita del ponte NON diventa «sei mono-sede» ───────────
  // PostgREST non lancia. Fino al 2026-07-31 qui `{ error }` non veniva
  // guardato: `data` era null, `extra` restava [] e l'admin di tre sedi
  // diventava di una sola — la PRIMARIA. Da lì `resolveScuolaScrittura`
  // imboccava il ramo `accessibili.length === 1` e archiviava il dato a
  // Giugliano senza il 400 e senza un warn: cioè esattamente il difetto che
  // l'audit aveva appena rimosso, rientrato da una porta laterale.
  it('errore di lettura del ponte ⇒ NESSUN plesso (fail-closed) e un log error', async () => {
    const { supabase } = client({
      errori: { utenti_scuole: { code: '42501', message: 'permission denied for table utenti_scuole' } },
    })
    expect(await scuoleDiUtente(supabase, ADMIN_TRE_SEDI)).toEqual([])
    expect(tipiLoggati('error')).toContain('sedi-utente-non-risolte')
  })

  it('errore di lettura ⇒ fail-closed anche quando il codice è di colonna (42703)', async () => {
    // `utenti_scuole.scuola_id` è nel baseline: su QUESTA lettura un 42703 non
    // significa «CI non migrata», significa che la colonna è sparita. Si nega.
    const { supabase } = client({ errori: { utenti_scuole: { code: '42703' } } })
    expect(await scuoleDiUtente(supabase, ADMIN_TRE_SEDI)).toEqual([])
    expect(tipiLoggati('error')).toContain('sedi-utente-non-risolte')
  })

  it('tabella ponte ASSENTE ⇒ la sola sede primaria, con un warn (DB non migrato)', async () => {
    // Unica deroga al fail-closed, e vale solo per la tabella INTERA mancante:
    // dove il ponte non esiste nessuno è multi-plesso, quindi la sede primaria
    // è la verità completa, non un restringimento silenzioso. Serve al DB E2E
    // della CI; in produzione lascia comunque una riga persistita.
    for (const code of ['42P01', 'PGRST205']) {
      logEvento.mockClear()
      const { supabase } = client({ errori: { utenti_scuole: { code } } })
      expect(await scuoleDiUtente(supabase, ADMIN_TRE_SEDI)).toEqual([SEDE_A])
      expect(tipiLoggati('warn')).toContain('sedi-utente-ponte-assente')
      expect(tipiLoggati('error')).not.toContain('sedi-utente-non-risolte')
    }
  })
})

// =============================================================================
// F3 — LA PROVA: un errore di LETTURA non deve diventare un PERMESSO.
//
// Il ponte `utenti_scuole` non si legge (permessi revocati, timeout, rete). Ogni
// funzione del modulo deve rispondere «non lo so, quindi no», non «allora sei di
// Giugliano». Le tre conseguenze si asseriscono qui, insieme, perché è la catena
// — non la singola funzione — a essere stata rotta.
// =============================================================================

describe('ponte utenti_scuole illeggibile', () => {
  const rotto = () =>
    client({ errori: { utenti_scuole: { code: '42501', message: 'permission denied' } } })

  it('la SCRITTURA è negata (403), non dirottata sulla sede primaria', async () => {
    const { supabase, scritture } = rotto()
    const r = await resolveScuolaScrittura(richiesta(), supabase, ADMIN_TRE_SEDI)
    expect(r.scuolaId).toBeUndefined()
    expect(await esito(r.response)).toEqual({
      status: 403,
      error: "Nessun plesso associato all'utente",
    })
    expect(scritture).toEqual([])
  })

  it('la scrittura è negata anche con il SedeSelector su una sede legittima', async () => {
    // Il cookie non è una fonte d'autorità: viene INTERSECATO con le sedi
    // accessibili, e se quelle non si sanno l'intersezione è vuota.
    const { supabase } = rotto()
    const r = await resolveScuolaScrittura(richiesta(SEDE_B), supabase, ADMIN_TRE_SEDI, SEDE_B)
    expect(r.scuolaId).toBeUndefined()
    expect((r.response as { status: number }).status).toBe(403)
  })

  it('le LETTURE restano senza perimetro-vuoto: nessuna sede attiva', async () => {
    const { supabase } = rotto()
    expect(await resolveScuoleAttive(richiesta(), supabase, ADMIN_TRE_SEDI)).toEqual([])
  })

  it("gli assert* negano: sezione, alunno e genitore del proprio plesso non passano più", async () => {
    const { supabase } = rotto()
    expect((await esito(await assertSezioneInScope(supabase, ADMIN_TRE_SEDI, SEZ_A_GIRASOLI))).status)
      .toBe(403)
    expect((await esito(await assertAlunnoInScope(supabase, ADMIN_TRE_SEDI, ALU_A_ASSEGNATO))).status)
      .toBe(403)
    expect((await esito(await assertParentInScope(supabase, ADMIN_TRE_SEDI, PAR_A))).status).toBe(403)
  })
})

// =============================================================================
// resolveScuoleAttive — il cookie del SedeSelector RESTRINGE, non allarga mai
// =============================================================================

describe('resolveScuoleAttive', () => {
  it('cookie ASSENTE ⇒ tutte le sedi accessibili', async () => {
    const { supabase } = client()
    expect(await resolveScuoleAttive(richiesta(), supabase, ADMIN_TRE_SEDI)).toEqual([
      SEDE_A,
      SEDE_B,
      SEDE_C,
    ])
  })

  it('cookie con un SOTTOINSIEME accessibile ⇒ solo quelle', async () => {
    const { supabase } = client()
    expect(await resolveScuoleAttive(richiesta(SEDE_B), supabase, ADMIN_TRE_SEDI)).toEqual([SEDE_B])
    expect(
      await resolveScuoleAttive(richiesta(`${SEDE_B},${SEDE_C}`), supabase, ADMIN_TRE_SEDI),
    ).toEqual([SEDE_B, SEDE_C])
  })

  it('cookie con sedi NON accessibili ⇒ nessuna sede (scope vuoto NEGA) e un warn', async () => {
    const { supabase } = client()
    // La segreteria di A col cookie su B: manomissione, oppure accesso revocato.
    expect(await resolveScuoleAttive(richiesta(SEDE_B), supabase, SEGRETERIA_A)).toEqual([])
    expect(tipiLoggati('warn')).toContain('sedi-attive-non-accessibili')
  })

  it('cookie MISTO ⇒ solo la parte accessibile, mai un allargamento', async () => {
    const { supabase } = client()
    expect(
      await resolveScuoleAttive(richiesta(`${SEDE_B},${SEDE_C}`), supabase, SEGRETERIA_A),
    ).toEqual([])
    expect(
      await resolveScuoleAttive(richiesta(`${SEDE_A},${SEDE_B}`), supabase, SEGRETERIA_A),
    ).toEqual([SEDE_A])
  })

  it('cookie vuoto ⇒ trattato come assente (nessun warn)', async () => {
    const { supabase } = client()
    expect(await resolveScuoleAttive(richiesta(''), supabase, ADMIN_TRE_SEDI)).toEqual([
      SEDE_A,
      SEDE_B,
      SEDE_C,
    ])
    expect(tipiLoggati('warn')).not.toContain('sedi-attive-non-accessibili')
  })
})

// =============================================================================
// resolveScuolaScrittura — «se non mi dai la sede la scelgo io» finisce qui
// =============================================================================

describe('resolveScuolaScrittura', () => {
  it('nessun plesso associato ⇒ 403 e nessuna sede', async () => {
    const { supabase, scritture } = client()
    const r = await resolveScuolaScrittura(richiesta(), supabase, SENZA_SEDE)
    expect(r.scuolaId).toBeUndefined()
    expect(await esito(r.response)).toEqual({
      status: 403,
      error: "Nessun plesso associato all'utente",
    })
    expect(scritture).toEqual([])
  })

  it('una sola sede accessibile ⇒ quella, senza bisogno di dichiararla', async () => {
    const { supabase } = client()
    const r = await resolveScuolaScrittura(richiesta(), supabase, SEGRETERIA_A)
    expect(r.response).toBeUndefined()
    expect(r.scuolaId).toBe(SEDE_A)
  })

  it('sede dichiarata e accessibile ⇒ quella, anche se non è la primaria', async () => {
    const { supabase } = client()
    const r = await resolveScuolaScrittura(richiesta(), supabase, ADMIN_TRE_SEDI, SEDE_B)
    expect(r.response).toBeUndefined()
    expect(r.scuolaId).toBe(SEDE_B)
  })

  it('PIÙ sedi accessibili, nessuna dichiarata e nessun cookie ⇒ 400, MAI la sede primaria', async () => {
    const { supabase } = client()
    const r = await resolveScuolaScrittura(richiesta(), supabase, ADMIN_TRE_SEDI)
    expect(r.scuolaId).toBeUndefined()
    expect(await esito(r.response)).toEqual({
      status: 400,
      error: 'Specificare la sede (scuola_id) per questa operazione',
    })
    // Il rifiuto si LOGGA: senza, «la scrittura non è mai partita» resta
    // indistinguibile da «non l'ha mai tentata nessuno» — l'ambiguità che nel
    // 2026-07 ha tenuto nascosto il guasto delle email per mesi.
    expect(tipiLoggati('warn')).toContain('sede-scrittura-ambigua')
  })

  it('cookie con UNA sola sede accessibile ⇒ quella', async () => {
    const { supabase } = client()
    const r = await resolveScuolaScrittura(richiesta(SEDE_C), supabase, ADMIN_TRE_SEDI)
    expect(r.response).toBeUndefined()
    expect(r.scuolaId).toBe(SEDE_C)
  })

  it('cookie con DUE sedi selezionate ⇒ 400: non si scrive su una sede appena deselezionata', async () => {
    const { supabase } = client()
    // Lo scenario dell'audit: l'operatore seleziona B e C — cioè TOGLIE A — e la
    // scrittura finiva comunque in A, la sua sede primaria.
    const r = await resolveScuolaScrittura(
      richiesta(`${SEDE_B},${SEDE_C}`),
      supabase,
      ADMIN_TRE_SEDI,
    )
    expect(r.scuolaId).toBeUndefined()
    expect((r.response as { status: number }).status).toBe(400)
  })

  // ── W2-B: la sede DICHIARATA e non accessibile si NEGA, non si sostituisce ──
  //
  // ⚠️ QUI IL COMPORTAMENTO ATTESO È CAMBIATO, e i due casi qui sotto prima
  // asserivano l'esatto contrario («dichiarata non accessibile ⇒ IGNORATA»).
  // Erano test veri su un difetto vero: fino al 2026-07-31 `resolveScuolaScrittura`
  // trattava una `preferita` fuori scope come se non fosse stata detta, e
  // proseguiva col cookie o con l'unica sede accessibile. Misurato sul campo:
  // `POST /api/mensa/alternative` con la sede di Cesa fatto da un utente di
  // Aversa rispondeva **200**, con la riga archiviata su **Aversa**. Nessun
  // errore, nessun log, il dato nel plesso sbagliato.
  //
  // Una scrittura che finisce nel plesso sbagliato IN SILENZIO è peggio di un
  // errore: l'errore lo vedi e lo correggi, il dato dirottato lo scopri mesi
  // dopo — o mai. E la stessa domanda aveva già due risposte diverse: in
  // LETTURA `restringiASedeRichiesta` (src/lib/auth/sede-richiesta.ts) rispondeva
  // già **403 «Sede non accessibile»** per il caso identico. Ora è una sola.
  //
  // Il ripiego era anche una difesa impossibile da tenere: era tamponato route
  // per route (`news/digest/genera` lo faceva a mano), e le chiamate sono 65 in
  // 54 file. Un tampone su 54 non è una difesa, è un promemoria.
  it('sede dichiarata NON accessibile ⇒ 403 «Sede non accessibile», MAI un ripiego (più sedi)', async () => {
    const { supabase, dati, scritture } = client()
    // L'admin ha A e B; gli si chiede di scrivere su C, che non è sua.
    dati.utenti_scuole = [
      { utente_id: ID_ADMIN, scuola_id: SEDE_A },
      { utente_id: ID_ADMIN, scuola_id: SEDE_B },
    ]
    const r = await resolveScuolaScrittura(richiesta(), supabase, ADMIN_TRE_SEDI, SEDE_C)
    expect(r.scuolaId).toBeUndefined()
    expect(await esito(r.response)).toEqual({ status: 403, error: 'Sede non accessibile' })
    expect(scritture).toEqual([])
  })

  it('sede dichiarata NON accessibile ⇒ 403 anche per chi ha UNA sola sede', async () => {
    // È il caso misurato: la segreteria di A dichiara B. Prima non si negava —
    // si scriveva su A, cioè si archiviava il dato in un plesso che l'operatore
    // non aveva nominato, rispondendo 200.
    const { supabase, scritture } = client()
    const r = await resolveScuolaScrittura(richiesta(), supabase, SEGRETERIA_A, SEDE_B)
    expect(r.scuolaId).toBeUndefined()
    expect(await esito(r.response)).toEqual({ status: 403, error: 'Sede non accessibile' })
    expect(scritture).toEqual([])
  })

  it('sede dichiarata NON accessibile ⇒ 403 anche se il cookie ne indica una sola accessibile', async () => {
    // Il ramo del cookie non deve MAI rattoppare una dichiarazione sbagliata:
    // se il client dice «scrivi su C» e C non è sua, la risposta è no — non
    // «allora te la scrivo su B, che avevi selezionato».
    const { supabase } = client()
    const r = await resolveScuolaScrittura(richiesta(SEDE_B), supabase, ADMIN_TRE_SEDI, SEDE_E2E)
    expect(r.scuolaId).toBeUndefined()
    expect(await esito(r.response)).toEqual({ status: 403, error: 'Sede non accessibile' })
  })

  it('il diniego si LOGGA come fuori-scope, e NON come ambiguità', async () => {
    // Due cose diverse: «non mi hai detto dove» (400, l'operatore deve scegliere)
    // e «mi hai detto una sede che non è tua» (403, che è un segnale di
    // sicurezza). Se finissero nello stesso contatore, il secondo sparirebbe
    // dentro il primo.
    const { supabase } = client()
    await resolveScuolaScrittura(richiesta(), supabase, SEGRETERIA_A, SEDE_B)
    expect(tipiLoggati('warn')).toEqual(['sede-scrittura-fuori-scope'])
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { tipo?: string })?.tipo === 'sede-scrittura-fuori-scope',
    )
    // Nel log solo uuid, ruolo e conteggi: la sede richiesta NON ci va in chiaro,
    // come nelle altre due chiamate del modulo.
    expect(riga?.[2]).toMatchObject({
      azione: 'resolveScuolaScrittura',
      utente: ID_SEGRETERIA,
      ruolo: 'segreteria',
      accessibili: 1,
    })
    expect(JSON.stringify(riga?.[2])).not.toContain(SEDE_B)
  })

  it('cookie manomesso con una sede altrui ⇒ non la usa: resta la propria', async () => {
    const { supabase } = client()
    const r = await resolveScuolaScrittura(richiesta(SEDE_B), supabase, SEGRETERIA_A)
    expect(r.response).toBeUndefined()
    expect(r.scuolaId).toBe(SEDE_A)
  })
})

// =============================================================================
// LA MUTAZIONE — perché uno status non è una prova.
//
// Un 403 con la riga scritta lo stesso è un falso verde, e il difetto misurato
// era proprio dell'altra forma: **200 con la riga nel plesso sbagliato**. Qui si
// guarda il DATABASE, non la risposta: `dati.<tabella>` (che il finto client crea
// solo se qualcuno ci scrive davvero) e l'accumulatore `scritture`.
//
// Il finto handler qui sotto non è una scorciatoia: è LETTERALMENTE il pattern
// che condividono tutti i 65 chiamanti di `resolveScuolaScrittura` — risolvi,
// esci se c'è la risposta, scrivi con la sede risolta. Se il resolver ripiega,
// questo handler scrive: è la catena vera, in tre righe.
// =============================================================================

/** La tabella del caso misurato (`POST /api/mensa/alternative`). Non sta nel
 *  fixture di partenza APPOSTA: se resta `undefined`, nessuno ci ha scritto. */
const TABELLA = 'mensa_alternative'

async function handlerCheScrive(
  supabase: SupabaseClient,
  req: NextRequest,
  u: AppUser,
  dichiarata?: string | null,
): Promise<{ status: number; error?: string }> {
  const sw = await resolveScuolaScrittura(req, supabase, u, dichiarata)
  if (sw.response) return await esito(sw.response)
  const { error } = await supabase
    .from(TABELLA)
    .insert({ scuola_id: sw.scuolaId, alunno_id: ALU_A_ASSEGNATO, richiesta: 'in bianco' })
  if (error) return { status: 500, error: 'db' }
  return { status: 201 }
}

describe('resolveScuolaScrittura — la scrittura, non lo status', () => {
  it('sede dichiarata FUORI SCOPE ⇒ 403 e NESSUNA riga, da nessuna parte', async () => {
    const { supabase, dati, scritture } = client()
    const r = await handlerCheScrive(supabase, richiesta(), SEGRETERIA_A, SEDE_B)
    expect(r).toEqual({ status: 403, error: 'Sede non accessibile' })
    // La prova che conta: l'insert non è mai partito. Non «è finito altrove»,
    // non «è finito con la sede sbagliata»: non esiste.
    expect(scritture).toEqual([])
    expect(dati[TABELLA]).toBeUndefined()
  })

  it('CONTROLLO POSITIVO: sede dichiarata e accessibile ⇒ 201 e la riga porta QUELLA sede', async () => {
    // Senza questo caso il test sopra sarebbe verde anche con un resolver che
    // nega sempre — cioè con la funzionalità distrutta.
    const { supabase, dati, scritture } = client()
    const r = await handlerCheScrive(supabase, richiesta(), ADMIN_TRE_SEDI, SEDE_B)
    expect(r).toEqual({ status: 201 })
    expect(dati[TABELLA]).toHaveLength(1)
    expect(dati[TABELLA][0]).toMatchObject({ scuola_id: SEDE_B, alunno_id: ALU_A_ASSEGNATO })
    expect(scritture).toHaveLength(1)
    expect(scritture[0].valori[0]).toMatchObject({ scuola_id: SEDE_B })
  })

  it('CONTROLLO POSITIVO: mono-sede senza dichiararla ⇒ 201 sulla propria (nessuna regressione)', async () => {
    const { supabase, dati } = client()
    const r = await handlerCheScrive(supabase, richiesta(), SEGRETERIA_A)
    expect(r).toEqual({ status: 201 })
    expect(dati[TABELLA][0]).toMatchObject({ scuola_id: SEDE_A })
  })

  it('sede NON dichiarata e ambigua ⇒ 400 e nessuna riga (il ramo che già c\'era)', async () => {
    const { supabase, dati } = client()
    const r = await handlerCheScrive(supabase, richiesta(), ADMIN_TRE_SEDI)
    expect(r.status).toBe(400)
    expect(dati[TABELLA]).toBeUndefined()
  })
})

// =============================================================================
// vedeTutteLeClassi / sezioniVisibili — il filtro per SEZIONE, fail-closed
// =============================================================================

describe('sezioniVisibili', () => {
  it('admin, coordinator e segreteria non hanno restrizione per sezione', async () => {
    const { supabase, lette } = client()
    for (const u of [ADMIN_TRE_SEDI, COORD_A, SEGRETERIA_A]) {
      expect(vedeTutteLeClassi(u)).toBe(true)
      expect(await sezioniVisibili(supabase, u)).toBeNull()
    }
    expect(lette).not.toContain('utenti_sezioni')
  })

  it("l'educator vede SOLO le sezioni assegnate", async () => {
    const { supabase } = client()
    expect(vedeTutteLeClassi(EDUCATOR_A)).toBe(false)
    expect(await sezioniVisibili(supabase, EDUCATOR_A)).toEqual([SEZ_A_GIRASOLI])
  })

  it("l'educator senza assegnazioni riceve [] — non «tutte quelle del plesso»", async () => {
    const { supabase, dati } = client()
    dati.utenti_sezioni = []
    expect(await sezioniVisibili(supabase, EDUCATOR_A)).toEqual([])
  })
})

// =============================================================================
// assertSezioneInScope
// =============================================================================

describe('assertSezioneInScope', () => {
  it('sezione di un ALTRO plesso ⇒ 403', async () => {
    const { supabase } = client()
    const r = await assertSezioneInScope(supabase, SEGRETERIA_A, SEZ_B_GIRASOLI)
    expect(await esito(r)).toEqual({
      status: 403,
      error: 'Accesso negato: classe fuori dal tuo plesso',
    })
  })

  it('sezione inesistente ⇒ 404', async () => {
    const { supabase } = client()
    expect((await esito(await assertSezioneInScope(supabase, SEGRETERIA_A, SEZ_A_GIRASOLI + 'x')))
      .status).toBe(404)
  })

  it('sectionId assente ⇒ 400', async () => {
    const { supabase, lette } = client()
    expect((await esito(await assertSezioneInScope(supabase, SEGRETERIA_A, null))).status).toBe(400)
    expect(lette).not.toContain('sections')
  })

  it('sezione del proprio plesso ⇒ consentita alla segreteria', async () => {
    const { supabase } = client()
    expect(await assertSezioneInScope(supabase, SEGRETERIA_A, SEZ_A_TULIPANI)).toBeNull()
  })

  it("all'educator la sezione NON assegnata è negata, anche nel suo plesso", async () => {
    const { supabase } = client()
    const r = await assertSezioneInScope(supabase, EDUCATOR_A, SEZ_A_TULIPANI)
    expect(await esito(r)).toEqual({ status: 403, error: 'Sezione non assegnata al docente' })
    expect(await assertSezioneInScope(supabase, EDUCATOR_A, SEZ_A_GIRASOLI)).toBeNull()
  })

  it('errore di lettura ⇒ 500 e log error, mai un 404 muto', async () => {
    // Senza il controllo di `{ error }` la sezione risultava «non trovata»: un
    // 404 indistinguibile da un id inesistente, che inquina anche i contatori.
    const { supabase } = client({ errori: { sections: { code: '42703' } } })
    const r = await assertSezioneInScope(supabase, SEGRETERIA_A, SEZ_A_GIRASOLI)
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-sezione-non-risolta')
  })
})

// =============================================================================
// assertClasseNomeInScope — l'omonimia fra sedi
// =============================================================================

describe('assertClasseNomeInScope', () => {
  it('nome esistente nel proprio plesso ⇒ consentito', async () => {
    const { supabase } = client()
    expect(await assertClasseNomeInScope(supabase, SEGRETERIA_A, 'GIRASOLI')).toBeNull()
  })

  it("nome che esiste SOLO nell'altra sede ⇒ 403 e un warn di sicurezza", async () => {
    const { supabase, dati } = client()
    dati.sections = [{ id: SEZ_B_GIRASOLI, name: 'GIRASOLI', scuola_id: SEDE_B }]
    const r = await assertClasseNomeInScope(supabase, SEGRETERIA_A, 'GIRASOLI')
    expect(await esito(r)).toEqual({ status: 403, error: 'Classe fuori dal tuo plesso' })
    expect(tipiLoggati('warn')).toContain('classe-fuori-sede')
  })

  it('nome assente ⇒ 400 senza nemmeno leggere le sezioni', async () => {
    const { supabase, lette } = client()
    expect((await esito(await assertClasseNomeInScope(supabase, SEGRETERIA_A, ''))).status).toBe(400)
    expect(lette).not.toContain('sections')
  })

  it('utente senza plessi ⇒ 403 senza leggere le sezioni', async () => {
    const { supabase, lette } = client()
    expect((await esito(await assertClasseNomeInScope(supabase, SENZA_SEDE, 'GIRASOLI'))).status).toBe(
      403,
    )
    expect(lette).not.toContain('sections')
  })

  it('errore di lettura (PostgREST non lancia) ⇒ 500 e log error, mai un 403 muto', async () => {
    const { supabase } = client({ errori: { sections: { code: '42703' } } })
    const r = await assertClasseNomeInScope(supabase, SEGRETERIA_A, 'GIRASOLI')
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-classe-non-risolta')
  })

  it('con soloSezioniAssegnate: la classe non assegnata è negata anche se è nel plesso', async () => {
    const { supabase } = client()
    const r = await assertClasseNomeInScope(supabase, EDUCATOR_A, 'TULIPANI', {
      soloSezioniAssegnate: true,
    })
    expect(await esito(r)).toEqual({ status: 403, error: 'Classe non assegnata al docente' })
    expect(tipiLoggati('warn')).toContain('classe-non-assegnata')
    expect(
      await assertClasseNomeInScope(supabase, EDUCATOR_A, 'GIRASOLI', { soloSezioniAssegnate: true }),
    ).toBeNull()
  })

  it("con soloSezioniAssegnate l'omonima di un'altra sede non vale come assegnazione", async () => {
    const { supabase, dati } = client()
    // L'educator è assegnato alla «GIRASOLI» di A; l'admin che chiede «GIRASOLI»
    // vedrebbe due righe (A e B), ma per il docente conta solo la sua.
    dati.utenti_sezioni = [{ utente_id: ID_EDUCATOR, section_id: SEZ_B_GIRASOLI }]
    const r = await assertClasseNomeInScope(supabase, EDUCATOR_A, 'GIRASOLI', {
      soloSezioniAssegnate: true,
    })
    expect((await esito(r)).status).toBe(403)
  })
})

// =============================================================================
// assertAlunniInSezione
// =============================================================================

describe('assertAlunniInSezione', () => {
  it('tutti gli alunni nella sezione ⇒ consentito', async () => {
    const { supabase } = client()
    expect(await assertAlunniInSezione(supabase, [ALU_A_ASSEGNATO], SEZ_A_GIRASOLI)).toBeNull()
  })

  it('un solo id estraneo ⇒ 403 SENZA nominare gli uuid nel corpo, e un warn che li conta', async () => {
    // W6: il corpo della risposta elencava gli uuid degli alunni estranei —
    // cioè restituiva a chi ha appena sbagliato plesso l'unico dato che non
    // avrebbe dovuto vedere (l'esistenza di quegli id). Gli identificativi
    // stanno nei log, che sono service-role; la risposta dice solo di no.
    const { supabase } = client()
    const r = await assertAlunniInSezione(supabase, [ALU_A_ASSEGNATO, ALU_B], SEZ_A_GIRASOLI)
    const e = await esito(r)
    expect(e.status).toBe(403)
    expect(e.error).toBe('Alunni non appartenenti alla sezione')
    expect(e.error).not.toContain(ALU_B)
    expect(e.error).not.toContain(ALU_A_ASSEGNATO)
    expect(tipiLoggati('warn')).toContain('alunni-fuori-sezione')
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { tipo?: string })?.tipo === 'alunni-fuori-sezione',
    )
    expect((riga?.[2] as { n?: number })?.n).toBe(1)
  })

  it('elenco vuoto (o di soli null) ⇒ consentito, senza leggere gli alunni', async () => {
    const { supabase, lette } = client()
    expect(await assertAlunniInSezione(supabase, [null, undefined], SEZ_A_GIRASOLI)).toBeNull()
    expect(lette).not.toContain('alunni')
  })

  it('errore di lettura ⇒ 500 e log error, mai un 403 che accusa tutti gli id', async () => {
    const { supabase } = client({ errori: { alunni: { code: '42703' } } })
    const r = await assertAlunniInSezione(supabase, [ALU_A_ASSEGNATO], SEZ_A_GIRASOLI)
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-alunni-non-risolti')
    expect(tipiLoggati('warn')).not.toContain('alunni-fuori-sezione')
  })
})

// =============================================================================
// assertUtenteInScope — le operazioni su un COLLEGA
// =============================================================================

describe('assertUtenteInScope', () => {
  it("collega dell'altra sede ⇒ 403 e un warn", async () => {
    const { supabase } = client()
    const r = await assertUtenteInScope(supabase, SEGRETERIA_A, ID_COLLEGA_B)
    expect(await esito(r)).toEqual({ status: 403, error: 'Utente fuori dal tuo plesso' })
    expect(tipiLoggati('warn')).toContain('utente-fuori-sede')
  })

  it('collega del proprio plesso ⇒ consentito', async () => {
    const { supabase } = client()
    expect(await assertUtenteInScope(supabase, SEGRETERIA_A, ID_COLLEGA_A)).toBeNull()
  })

  it("l'admin multi-sede raggiunge anche il collega dell'altra sede", async () => {
    const { supabase } = client()
    expect(await assertUtenteInScope(supabase, ADMIN_TRE_SEDI, ID_COLLEGA_B)).toBeNull()
  })

  it('utente inesistente ⇒ 404; id assente ⇒ 400', async () => {
    const { supabase } = client()
    expect((await esito(await assertUtenteInScope(supabase, SEGRETERIA_A, 'non-esiste'))).status).toBe(
      404,
    )
    expect((await esito(await assertUtenteInScope(supabase, SEGRETERIA_A, null))).status).toBe(400)
  })

  it('errore di lettura ⇒ 500 e log error, e NESSUN warn `utente-fuori-sede`', async () => {
    const { supabase } = client({ errori: { utenti: { code: '42703' } } })
    const r = await assertUtenteInScope(supabase, SEGRETERIA_A, ID_COLLEGA_A)
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-utente-non-risolto')
    // Il contatore `*-fuori-sede` è un segnale di SICUREZZA: un guasto di
    // lettura non deve riempirlo di falsi positivi.
    expect(tipiLoggati('warn')).not.toContain('utente-fuori-sede')
  })
})

// =============================================================================
// assertPagamentoInScope — la contabilità
// =============================================================================

describe('assertPagamentoInScope', () => {
  it("pagamento dell'altra sede ⇒ 403 e un warn", async () => {
    const { supabase } = client()
    const r = await assertPagamentoInScope(supabase, SEGRETERIA_A, PAG_B)
    expect(await esito(r)).toEqual({ status: 403, error: 'Pagamento fuori dal tuo plesso' })
    expect(tipiLoggati('warn')).toContain('pagamento-fuori-sede')
  })

  it('pagamento SENZA sede ⇒ 403: un movimento non attribuibile non è di nessuno', async () => {
    const { supabase } = client()
    expect(
      (await esito(await assertPagamentoInScope(supabase, ADMIN_TRE_SEDI, PAG_SENZA_SEDE))).status,
    ).toBe(403)
  })

  it('pagamento del proprio plesso ⇒ consentito', async () => {
    const { supabase } = client()
    expect(await assertPagamentoInScope(supabase, SEGRETERIA_A, PAG_A)).toBeNull()
  })

  it('pagamento inesistente ⇒ 404; id assente ⇒ 400', async () => {
    const { supabase } = client()
    expect((await esito(await assertPagamentoInScope(supabase, SEGRETERIA_A, 'x'))).status).toBe(404)
    expect((await esito(await assertPagamentoInScope(supabase, SEGRETERIA_A, null))).status).toBe(400)
  })

  it('errore di lettura ⇒ 500 e log error, e NESSUN warn `pagamento-fuori-sede`', async () => {
    const { supabase } = client({ errori: { pagamenti: { code: '42703' } } })
    const r = await assertPagamentoInScope(supabase, SEGRETERIA_A, PAG_A)
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-pagamento-non-risolto')
    expect(tipiLoggati('warn')).not.toContain('pagamento-fuori-sede')
  })
})

// =============================================================================
// assertParentInScope — la sede del genitore viene dai FIGLI
// =============================================================================

describe('assertParentInScope', () => {
  it("genitore con figli solo nell'altra sede ⇒ 403 e un warn", async () => {
    const { supabase } = client()
    const r = await assertParentInScope(supabase, SEGRETERIA_A, PAR_B)
    expect(await esito(r)).toEqual({ status: 403, error: 'Genitore fuori dal tuo plesso' })
    expect(tipiLoggati('warn')).toContain('genitore-fuori-sede')
  })

  it('genitore con un figlio nel proprio plesso ⇒ consentito', async () => {
    const { supabase } = client()
    expect(await assertParentInScope(supabase, SEGRETERIA_A, PAR_A)).toBeNull()
  })

  it('genitore con figli in DUE sedi ⇒ raggiungibile da entrambe le segreterie', async () => {
    const { supabase, dati } = client()
    dati.student_parents = [
      { parent_id: PAR_A, student_id: ALU_A_ASSEGNATO, alunni: { scuola_id: SEDE_A } },
      { parent_id: PAR_A, student_id: ALU_B, alunni: { scuola_id: SEDE_B } },
    ]
    expect(await assertParentInScope(supabase, SEGRETERIA_A, PAR_A)).toBeNull()
    expect(await assertParentInScope(supabase, utente(ID_SEGRETERIA, 'segreteria', SEDE_B), PAR_A))
      .toBeNull()
  })

  it('genitore senza figli collegati ⇒ 403 (non c\'è modo di attribuirlo a un plesso)', async () => {
    const { supabase } = client()
    expect((await esito(await assertParentInScope(supabase, SEGRETERIA_A, PAR_ORFANO))).status).toBe(
      403,
    )
    // …ma NON è un tentativo cross-sede: il contatore di sicurezza non si tocca.
    expect(tipiLoggati('warn')).not.toContain('genitore-fuori-sede')
    expect(tipiLoggati('warn')).toContain('genitore-senza-figli')
  })

  // ── W6: «non è tuo» e «non esiste» sono due cose diverse ───────────────────
  it('genitore INESISTENTE ⇒ 404 e nessun warn: il contatore di sicurezza resta pulito', async () => {
    // Provato dal tester con un uuid a caso: rispondeva 403 e scriveva
    // `genitore-fuori-sede`, cioè il segnale nato per contare i tentativi
    // cross-sede si riempiva di 404 banali.
    const { supabase } = client()
    const r = await assertParentInScope(supabase, SEGRETERIA_A, 'bab00000-0000-4000-8000-00000000ffff')
    expect(await esito(r)).toEqual({ status: 404, error: 'Genitore non trovato' })
    expect(tipiLoggati('warn')).toEqual([])
  })

  it('genitore ESISTENTE ma di un altro plesso ⇒ 403 e IL warn (è il segnale vero)', async () => {
    const { supabase } = client()
    const r = await assertParentInScope(supabase, SEGRETERIA_A, PAR_B)
    expect(await esito(r)).toEqual({ status: 403, error: 'Genitore fuori dal tuo plesso' })
    expect(tipiLoggati('warn')).toEqual(['genitore-fuori-sede'])
  })

  it("errore di lettura dell'anagrafica ⇒ 500, non un 404 inventato", async () => {
    // `student_parents` risponde (nessun figlio), `parents` no: senza il
    // controllo di `{ error }` l'anagrafica illeggibile diventerebbe
    // «genitore non trovato» — un 404 affermativo su un dato che non si è letto.
    const { supabase } = client({ errori: { parents: { code: '42703' } } })
    const r = await assertParentInScope(supabase, SEGRETERIA_A, 'bab00000-0000-4000-8000-00000000ffff')
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-genitore-non-risolto')
  })

  it('utente senza plessi ⇒ 403 senza leggere student_parents', async () => {
    const { supabase, lette } = client()
    expect((await esito(await assertParentInScope(supabase, SENZA_SEDE, PAR_A))).status).toBe(403)
    expect(lette).not.toContain('student_parents')
  })

  it('errore di lettura ⇒ 500 e log error, mai un 403 muto', async () => {
    const { supabase } = client({ errori: { student_parents: { code: '42703' } } })
    const r = await assertParentInScope(supabase, SEGRETERIA_A, PAR_A)
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-genitore-non-risolto')
  })

  it('parentId assente ⇒ 400', async () => {
    const { supabase } = client()
    expect((await esito(await assertParentInScope(supabase, SEGRETERIA_A, null))).status).toBe(400)
  })
})

// =============================================================================
// assertAlunnoInScope
// =============================================================================

describe('assertAlunnoInScope', () => {
  it("alunno dell'altra sede ⇒ 403", async () => {
    const { supabase } = client()
    const r = await assertAlunnoInScope(supabase, SEGRETERIA_A, ALU_B)
    expect(await esito(r)).toEqual({
      status: 403,
      error: 'Accesso negato: alunno fuori dal tuo plesso',
    })
  })

  it('alunno del proprio plesso ⇒ consentito alla segreteria', async () => {
    const { supabase } = client()
    expect(await assertAlunnoInScope(supabase, SEGRETERIA_A, ALU_A_ALTRA_CLASSE)).toBeNull()
  })

  it("all'educator è negato l'alunno di un'altra classe dello stesso plesso", async () => {
    const { supabase } = client()
    const r = await assertAlunnoInScope(supabase, EDUCATOR_A, ALU_A_ALTRA_CLASSE)
    expect(await esito(r)).toEqual({ status: 403, error: 'Alunno non nella tua classe' })
    expect(await assertAlunnoInScope(supabase, EDUCATOR_A, ALU_A_ASSEGNATO)).toBeNull()
  })

  it('alunno inesistente ⇒ 404; id assente ⇒ 400', async () => {
    const { supabase } = client()
    expect((await esito(await assertAlunnoInScope(supabase, SEGRETERIA_A, 'x'))).status).toBe(404)
    expect((await esito(await assertAlunnoInScope(supabase, SEGRETERIA_A, undefined))).status).toBe(
      400,
    )
  })

  it('errore di lettura ⇒ 500 e log error, mai un 404 muto', async () => {
    const { supabase } = client({ errori: { alunni: { code: '42703' } } })
    const r = await assertAlunnoInScope(supabase, SEGRETERIA_A, ALU_A_ASSEGNATO)
    expect(await esito(r)).toEqual({ status: 500, error: 'Verifica di scope non riuscita' })
    expect(tipiLoggati('error')).toContain('scope-alunno-non-risolto')
  })
})
