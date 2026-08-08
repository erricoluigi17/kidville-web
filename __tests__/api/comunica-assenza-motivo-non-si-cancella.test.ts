import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { resetRateLimit } from '@/lib/security/rate-limit'

// =============================================================================
// UN CAMPO LASCIATO VUOTO NON È «CANCELLA CIÒ CHE AVEVO SCRITTO»
//
// Rilievo M21 del secondo collaudo. Comunicare due volte lo stesso giorno con il
// campo «Motivo» vuoto AZZERAVA il motivo già archiviato — che è un dato
// sanitario di un minore — e l'interfaccia diceva soltanto «Assenza comunicata»,
// senza dire che aveva sovrascritto qualcosa.
//
// La causa: `giustificazione_testo: motivoTesto || null` vive nell'oggetto `riga`
// usato da ENTRAMBE le scritture. Sull'INSERT è giusto (non c'era niente prima);
// sull'UPDATE cancella.
//
// ─── PERCHÉ IL PRESIDIO DELL'INTERFACCIA NON BASTA ──────────────────────────
//
// L'onda 2 ha reso il campo «Motivo» lo specchio di ciò che risulta archiviato:
// riaprendo il modulo sullo stesso giorno il testo torna, quindi il rinvio non
// lo perde. Ma quel presidio vale per QUESTA versione dell'interfaccia. Una
// versione vecchia dell'app installata dallo store, o qualunque altro client,
// manda ancora il campo vuoto — e cancella. La regola va dove sta il dato.
//
// ─── LA REGOLA, E IL SUO PREZZO DICHIARATO ──────────────────────────────────
//
// Il vuoto NON cancella: sull'aggiornamento la colonna non si scrive affatto.
// Il prezzo è che da qui non si può più svuotare il motivo lasciando in piedi
// l'assenza — si annulla e si ricomunica, che è un gesto che esiste già ed è
// esplicito. Fra «un dato sanitario sparisce senza che nessuno l'abbia chiesto»
// e «per toglierlo servono due tocchi», la scelta non è in equilibrio.
// =============================================================================

const STUDENT = 'a1111111-1111-4111-8111-111111111111'
const PARENT = 'b1111111-1111-4111-8111-111111111111'
const SEZIONE = 'c1111111-1111-4111-8111-111111111111'
const MAESTRA = 'd1111111-1111-4111-8111-111111111111'
const SCUOLA = 'e1111111-1111-4111-8111-111111111111'

const ADESSO = '2026-08-10T09:00:00Z'
const DOMANI = '2026-08-11'

const h = vi.hoisted(() => ({
  requireParent: vi.fn(),
  assertGenitore: vi.fn(),
}))

vi.mock('@/lib/auth/require-parent', () => ({ requireParentOfStudent: h.requireParent }))
vi.mock('@/lib/pagamenti/sospensione', () => ({ assertGenitoreNonSospeso: h.assertGenitore }))
vi.mock('@/lib/logging/logger', () => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

let db: DBFinto
let scritture: Scrittura[]
let client: ReturnType<typeof creaFintoSupabase>

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => client,
}))

import { POST } from '@/app/api/parent/presenze/comunica-assenza/route'
import { invalidateNotificheConfigCache } from '@/lib/notifiche/config'

const postReq = (body: unknown) =>
  new NextRequest('http://localhost/api/parent/presenze/comunica-assenza', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** La riga già comunicata dalla famiglia, col motivo sanitario dentro. */
function rigaGiaComunicata(motivo: string | null = 'febbre da tre giorni') {
  db.presenze = [
    {
      id: 'p-1',
      alunno_id: STUDENT,
      scuola_id: SCUOLA,
      section_id: SEZIONE,
      data: DOMANI,
      stato: 'assente',
      giustificata: true,
      giustificata_da: PARENT,
      giustificazione_testo: motivo,
      registrato_da: null,
    },
  ]
}

const motivoArchiviato = () => db.presenze[0]?.giustificazione_testo ?? null

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(ADESSO))
  invalidateNotificheConfigCache()
  resetRateLimit()
  db = {
    alunni: [{ id: STUDENT, nome: 'Sofia', cognome: 'Rossi', section_id: SEZIONE, scuola_id: SCUOLA }],
    sections: [{ id: SEZIONE, school_type: 'infanzia', scuola_id: SCUOLA }],
    utenti_sezioni: [{ utente_id: MAESTRA, section_id: SEZIONE }],
    utenti: [{ id: MAESTRA, attivo: true }],
    admin_settings: [],
    presenze: [],
    notifiche: [],
  }
  scritture = []
  client = creaFintoSupabase(db, [], { scritture })
  h.requireParent.mockResolvedValue({ user: { id: PARENT, role: 'genitore' }, response: null })
  h.assertGenitore.mockResolvedValue(null)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('POST — ricomunicare lo stesso giorno non cancella il motivo già archiviato', () => {
  it('motivo VUOTO: il testo sanitario sopravvive', async () => {
    rigaGiaComunicata()
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: '' }))
    expect(res.status).toBe(201)
    expect(motivoArchiviato()).toBe('febbre da tre giorni')
  })

  it('motivo ASSENTE dal corpo: idem — è il caso di un client vecchio', async () => {
    rigaGiaComunicata()
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI }))
    expect(res.status).toBe(201)
    expect(motivoArchiviato()).toBe('febbre da tre giorni')
  })

  it('motivo di soli spazi: non è un motivo, e non cancella', async () => {
    rigaGiaComunicata()
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: '   \n  ' }))
    expect(motivoArchiviato()).toBe('febbre da tre giorni')
  })

  it("un motivo NUOVO sostituisce quello vecchio: la correzione dev'essere ancora possibile", async () => {
    rigaGiaComunicata()
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: 'visita medica' }))
    expect(motivoArchiviato()).toBe('visita medica')
  })

  it("sull'UPDATE la colonna non compare proprio, quando il motivo è vuoto", async () => {
    rigaGiaComunicata()
    await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: '' }))
    const update = scritture.find((s) => s.operazione === 'update' && s.tabella === 'presenze')
    expect(update, 'nessun UPDATE su presenze').toBeTruthy()
    // ⚠️ `valori` è un ARRAY di righe. La prima stesura di questo test faceva
    // `Object.keys(update.valori)` e leggeva gli INDICI (`['0']`), quindi era
    // vera in ogni caso: passava anche PRIMA della correzione. Un'asserzione
    // vacua è la stessa bugia di un test mancante, con una faccia migliore —
    // ed è il difetto che questo stesso ciclo ha inseguito nei flow Maestro.
    const scritto = update!.valori[0] as Record<string, unknown>
    expect(Object.keys(scritto), 'la riga scritta non ha campi').not.toHaveLength(0)
    // Non «scritta a null»: proprio non scritta. La chiave presente con valore
    // `null` azzererebbe la colonna esattamente come prima.
    expect(Object.keys(scritto)).not.toContain('giustificazione_testo')
    // …e il resto dell'aggiornamento dev'esserci ancora.
    expect(scritto.giustificata).toBe(true)
  })

  it('sulla PRIMA comunicazione il motivo vuoto resta null: non c’è niente da proteggere', async () => {
    const res = await POST(postReq({ studentId: STUDENT, data: DOMANI, motivo: '' }))
    expect(res.status).toBe(201)
    expect(motivoArchiviato()).toBeNull()
  })
})
