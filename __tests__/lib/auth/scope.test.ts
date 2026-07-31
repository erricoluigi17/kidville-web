import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { AppRole, AppUser } from '@/lib/auth/require-staff'
import { SEDE_A, SEDE_B, SEDE_C } from '../../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'

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
    pagamenti: [
      { id: PAG_A, scuola_id: SEDE_A },
      { id: PAG_B, scuola_id: SEDE_B },
      { id: PAG_SENZA_SEDE, scuola_id: null },
    ],
  }
}

/** Il finto client + i suoi accumulatori (letture e scritture). */
function client(opzioni: { errori?: Record<string, { code: string }> } = {}) {
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

  it('sede dichiarata NON accessibile ⇒ ignorata: con più sedi ⇒ 400', async () => {
    const { supabase, dati } = client()
    // L'admin ha A, B, C; gli si chiede di scrivere sulla sede E2E (non sua).
    dati.utenti_scuole = [
      { utente_id: ID_ADMIN, scuola_id: SEDE_A },
      { utente_id: ID_ADMIN, scuola_id: SEDE_B },
    ]
    const r = await resolveScuolaScrittura(richiesta(), supabase, ADMIN_TRE_SEDI, SEDE_C)
    expect(r.scuolaId).toBeUndefined()
    expect((r.response as { status: number }).status).toBe(400)
  })

  it('sede dichiarata NON accessibile ⇒ ignorata: con UNA sola sede si resta sulla propria', async () => {
    const { supabase } = client()
    // La segreteria di A chiede di scrivere su B: non si nega, ma NON si scrive
    // su B. Il dato resta nel suo plesso.
    const r = await resolveScuolaScrittura(richiesta(), supabase, SEGRETERIA_A, SEDE_B)
    expect(r.response).toBeUndefined()
    expect(r.scuolaId).toBe(SEDE_A)
  })

  it('cookie manomesso con una sede altrui ⇒ non la usa: resta la propria', async () => {
    const { supabase } = client()
    const r = await resolveScuolaScrittura(richiesta(SEDE_B), supabase, SEGRETERIA_A)
    expect(r.response).toBeUndefined()
    expect(r.scuolaId).toBe(SEDE_A)
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

  it('un solo id estraneo ⇒ 403, e il messaggio lo nomina', async () => {
    const { supabase } = client()
    const r = await assertAlunniInSezione(
      supabase,
      [ALU_A_ASSEGNATO, ALU_B],
      SEZ_A_GIRASOLI,
    )
    const e = await esito(r)
    expect(e.status).toBe(403)
    expect(e.error).toContain(ALU_B)
    expect(e.error).not.toContain(ALU_A_ASSEGNATO)
  })

  it('elenco vuoto (o di soli null) ⇒ consentito, senza leggere gli alunni', async () => {
    const { supabase, lette } = client()
    expect(await assertAlunniInSezione(supabase, [null, undefined], SEZ_A_GIRASOLI)).toBeNull()
    expect(lette).not.toContain('alunni')
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
})
