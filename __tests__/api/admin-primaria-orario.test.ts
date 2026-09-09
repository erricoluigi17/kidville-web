import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { DBFinto, ErrorePostgrest, Riga, Scrittura } from '../fixtures/finto-supabase'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'

// =============================================================================
// L1 — `admin/primaria/orario`: la route che genera l'orario della primaria.
//
// Fino al 2026-09-09 questo file NON aveva un solo test, e portava cinque
// difetti che si tengono per mano:
//
//  (a) il monte ore. `Math.round(modello / giorni)` produce UN intero per tutti
//      i giorni: 27h su 5 giorni → round(5,4) = 5 → **25 ore invece di 27**.
//      Misurato in produzione il 2026-09-09: le due sole sezioni con campanelle
//      hanno 25 righe di tipo `lezione` a fronte di un modello da 27.
//  (b) il tetto delle ore firmabili. `registro_orario` ha
//      `CHECK (ora_lezione BETWEEN 1 AND 8)` e la pagina docente spedisce
//      l'`ordine` della campanella come `oraLezione`. L'`ordine` conta anche
//      intervallo e mensa, quindi a 40h×5 arriva a 10: 500 col messaggio
//      Postgres grezzo, e in offline la firma viene ritentata all'infinito.
//      Qui si difende l'INVARIANTE che rende `ora_lezione` rappresentabile —
//      mai più di 8 campanelle di tipo `lezione` in un giorno — su ogni
//      scrittura di questo file.
//  (c) il POST non aveva alcun gate di sede: sei azioni scrivibili su una
//      classe di un altro plesso, con client service-role che scavalca la RLS.
//  (d) quattro `{ error }` scartati: nel caso «delete riuscita, insert
//      respinta» la classe restava con ZERO campanelle e a schermo «salvato».
//  (e) zod lasco dove il DB è stretto (`giorni_settimana` 5-6, `giorno` 1-6).
//  (f) `update-campanella` cancellava la cella orario anche quando il tipo NON
//      cambiava — bastava correggere l'ora di una campanella già `mensa`.
//
// I casi asseriscono SEMPRE anche l'effetto sul database finto (`h.scritture`,
// `h.db`): «403» da solo non prova che la riga altrui sia rimasta intatta, e un
// 201 non prova che le campanelle siano state scritte.
// =============================================================================

const SEZ_A = '11111111-1111-4111-8111-aaaaaaaaaaaa'
const SEZ_B = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const CAMP_A_LEZ = '33333333-1111-4111-8111-aaaaaaaaaaaa'
const CAMP_A_MENSA = '33333333-1111-4111-8111-aaaaaaaaaaab'
const CAMP_B_LEZ = '33333333-2222-4222-8222-bbbbbbbbbbbb'
/** Una classe SORELLA, nello stesso plesso: il gate di sede non la ferma. */
const SEZ_A2 = '11111111-1111-4111-8111-aaaaaaaaaaab'
const CAMP_A2_LEZ = '33333333-1111-4111-8111-aaaaaaaaaaac'
const CAMP_IGNOTA = '99999999-9999-4999-8999-999999999999'
const MAT_A = '44444444-1111-4111-8111-aaaaaaaaaaaa'
const TEMPO_A = '55555555-1111-4111-8111-aaaaaaaaaaaa'
const TEMPO_B = '55555555-2222-4222-8222-bbbbbbbbbbbb'
const CELLA_LEZ = '66666666-1111-4111-8111-aaaaaaaaaaaa'
const CELLA_MENSA = '66666666-1111-4111-8111-aaaaaaaaaaab'
const ADMIN = '88888888-1111-4111-8111-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireDocente: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as unknown[],
  errori: {} as Record<string, { code: string; message?: string }>,
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireStaff: h.requireStaff,
  requireDocente: h.requireDocente,
}))
vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  const crea = () =>
    creaFintoSupabase(h.db, h.tabelle, {
      scritture: h.scritture as never,
      errori: h.errori as Record<string, ErrorePostgrest>,
    })
  return { createAdminClient: async () => crea(), createClient: async () => crea() }
})

import { GET, POST } from '@/app/api/admin/primaria/orario/route'

// ─── helper richiesta ────────────────────────────────────────────────────────
const azione = (action: string, body: unknown) =>
  new NextRequest(`http://localhost/api/admin/primaria/orario?action=${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const scritte = (tabella: string): Scrittura[] =>
  (h.scritture as Scrittura[]).filter((s) => s.tabella === tabella)

const campanelleDi = (sezione: string): Riga[] =>
  (h.db.campanelle ?? []).filter((c) => c.section_id === sezione)

/** Le sole campanelle firmabili: intervallo e mensa non sono ore di lezione. */
const lezioniDi = (sezione: string): Riga[] =>
  campanelleDi(sezione).filter((c) => c.tipo === 'lezione')

const dbBase = (): DBFinto => ({
  schools: [
    { id: SEDE_A, nome: 'Kidville Alfa' },
    { id: SEDE_B, nome: 'Kidville Beta' },
  ],
  sections: [
    { id: SEZ_A, scuola_id: SEDE_A, name: '1 A' },
    { id: SEZ_A2, scuola_id: SEDE_A, name: '1 B' },
    { id: SEZ_B, scuola_id: SEDE_B, name: '1 A' },
  ],
  utenti_scuole: [],
  utenti_sezioni: [],
  utenti: [{ id: ADMIN, scuola_id: SEDE_A, ruolo: 'admin', nome: 'Dir', cognome: 'Uno' }],
  materie: [{ id: MAT_A, section_id: SEZ_A, scuola_id: SEDE_A, nome: 'Italiano', codice: 'ITA' }],
  tempo_scuola: [
    { id: TEMPO_A, section_id: SEZ_A, modello: 27, giorni_settimana: 5, attivo: true },
    { id: TEMPO_B, section_id: SEZ_B, modello: 40, giorni_settimana: 5, attivo: true },
  ],
  campanelle: [
    { id: CAMP_A_LEZ, section_id: SEZ_A, giorno_settimana: 1, ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
    { id: CAMP_A_MENSA, section_id: SEZ_A, giorno_settimana: 1, ordine: 2, ora_inizio: '09:30:00', ora_fine: '10:30:00', tipo: 'mensa' },
    { id: CAMP_A2_LEZ, section_id: SEZ_A2, giorno_settimana: 1, ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
    { id: CAMP_B_LEZ, section_id: SEZ_B, giorno_settimana: 1, ordine: 1, ora_inizio: '08:30:00', ora_fine: '09:30:00', tipo: 'lezione' },
  ],
  orario_settimanale: [
    { id: CELLA_LEZ, section_id: SEZ_A, giorno_settimana: 1, campanella_id: CAMP_A_LEZ, materia_id: MAT_A, docente_id: null, note: null },
    { id: CELLA_MENSA, section_id: SEZ_A, giorno_settimana: 1, campanella_id: CAMP_A_MENSA, materia_id: null, docente_id: null, note: null },
  ],
})

/** L'admin del solo plesso A. */
const soloA = { id: ADMIN, role: 'admin', ruolo: 'admin', scuola_id: SEDE_A }

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.errori = {}
  h.requireStaff.mockResolvedValue({ user: soloA })
  h.requireDocente.mockResolvedValue({ user: soloA })
})

// =============================================================================
// (a) IL MONTE ORE — sei combinazioni, e il modello è un CONTRATTO
// =============================================================================
describe('set-tempo genera esattamente le ore del modello scelto', () => {
  // modello × giorni: le sei combinazioni che l'interfaccia sa produrre
  // (tendina 27/29/40 × tendina 5/6). Solo 40×5 era esatta.
  const combinazioni: [number, number][] = [
    [27, 5],
    [27, 6],
    [29, 5],
    [29, 6],
    [40, 5],
    [40, 6],
  ]

  for (const [modello, giorni] of combinazioni) {
    it(`${modello}h su ${giorni} giorni → ${modello} ore di lezione, non una di meno`, async () => {
      const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello, giorniSettimana: giorni }))
      expect(res.status).toBe(201)

      const lezioni = lezioniDi(SEZ_A)
      expect(lezioni).toHaveLength(modello)

      // Ogni giorno della settimana scolastica ha almeno un'ora: il resto si
      // ridistribuisce, non si arrotonda via.
      const giorniGenerati = new Set(lezioni.map((c) => c.giorno_settimana))
      expect(giorniGenerati.size).toBe(giorni)
    })

    it(`${modello}h su ${giorni} giorni → mai più di 8 lezioni in un giorno (CHECK ora_lezione 1..8)`, async () => {
      await POST(azione('set-tempo', { sectionId: SEZ_A, modello, giorniSettimana: giorni }))
      for (let g = 1; g <= giorni; g++) {
        const delGiorno = lezioniDi(SEZ_A).filter((c) => c.giorno_settimana === g)
        expect(delGiorno.length, `giorno ${g}`).toBeLessThanOrEqual(8)
        expect(delGiorno.length, `giorno ${g}`).toBeGreaterThan(0)
      }
    })
  }

  /**
   * IL RESTO VA DA QUALCHE PARTE, E SI VEDE A SCHERMO.
   *
   * 27 ore su 5 giorni non sono «5 e qualcosa»: sono 6, 6, 5, 5, 5. Il numero non
   * è un dettaglio interno — è quante righe firmabili il docente si trova davanti
   * il lunedì, ed è il numero che l'E2E dell'orario asserisce
   * (`e2e/primaria-360/journeys/85-registro-orario.spec.ts:40`, che dice ancora 5
   * perché è stato scritto quando il monte ore era sbagliato). Sta qui per essere
   * letto da chi dovrà aggiornarlo, invece di essere dedotto un'altra volta.
   */
  it('27h × 5 giorni si distribuisce 6-6-5-5-5: il resto NON evapora', async () => {
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 5 }))
    expect(res.status).toBe(201)
    const perGiorno = [1, 2, 3, 4, 5].map((g) => lezioniDi(SEZ_A).filter((c) => c.giorno_settimana === g).length)
    expect(perGiorno).toEqual([6, 6, 5, 5, 5])
  })

  it('senza giorniSettimana ricade su 5 giorni, e le ore restano quelle del modello', async () => {
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27 }))
    expect(res.status).toBe(201)
    expect(lezioniDi(SEZ_A)).toHaveLength(27)
    expect(new Set(lezioniDi(SEZ_A).map((c) => c.giorno_settimana)).size).toBe(5)
  })

  it('le campanelle rigenerate sostituiscono le precedenti e restano solo nella propria sezione', async () => {
    await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 5 }))
    // La campanella preesistente di SEZ_A è stata sostituita…
    expect(campanelleDi(SEZ_A).some((c) => c.id === CAMP_A_LEZ)).toBe(false)
    // …e quella dell'altro plesso non è stata toccata.
    expect(campanelleDi(SEZ_B).map((c) => c.id)).toEqual([CAMP_B_LEZ])
  })
})

// =============================================================================
// (c) IL GATE DI SEDE SUL POST — sei azioni, sei scritture cross-tenant
// =============================================================================
describe('POST: nessuna delle sei azioni scrive su una classe di un altro plesso', () => {
  const casi: [string, unknown][] = [
    ['set-tempo', { sectionId: SEZ_B, modello: 27, giorniSettimana: 5 }],
    ['genera-campanelle', { sectionId: SEZ_B }],
    ['set-cell', { sectionId: SEZ_B, giorno: 1, campanellaId: CAMP_B_LEZ, materiaId: null }],
    ['add-campanella', { sectionId: SEZ_B, giornoSettimana: 1, ordine: 9, oraInizio: '15:00', oraFine: '16:00', tipo: 'lezione' }],
    ['update-campanella', { sectionId: SEZ_B, campanellaId: CAMP_B_LEZ, oraFine: '10:00' }],
    ['delete-campanella', { sectionId: SEZ_B, campanellaId: CAMP_B_LEZ }],
  ]

  for (const [action, body] of casi) {
    it(`${action} su una sezione dell'altro plesso: 403 e NESSUNA scrittura`, async () => {
      const res = await POST(azione(action, body))
      expect(res.status).toBe(403)
      expect(h.scritture).toHaveLength(0)
      // La sezione altrui è rimasta esattamente com'era.
      expect(campanelleDi(SEZ_B)).toHaveLength(1)
      expect(h.db.tempo_scuola.filter((t) => t.section_id === SEZ_B && t.attivo)).toHaveLength(1)
    })
  }

  it('la stessa azione sulla PROPRIA sezione passa: il gate nega la sede, non l\'azione', async () => {
    const res = await POST(azione('delete-campanella', { sectionId: SEZ_A, campanellaId: CAMP_A_LEZ }))
    expect(res.status).toBe(200)
    expect(campanelleDi(SEZ_A).some((c) => c.id === CAMP_A_LEZ)).toBe(false)
  })

  it('GET su una sezione dell\'altro plesso: 403 (il gate del GET resta)', async () => {
    const res = await GET(new NextRequest(`http://localhost/api/admin/primaria/orario?sectionId=${SEZ_B}`))
    expect(res.status).toBe(403)
  })
})

// =============================================================================
// (c-bis) set-cell: la campanella deve essere DELLA sezione dichiarata
// =============================================================================
describe('set-cell: la campanella deve appartenere alla sezione dichiarata', () => {
  it('campanella di un\'altra sezione: 403 e nessuna cella scritta', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: 1, campanellaId: CAMP_B_LEZ, materiaId: MAT_A }))
    expect(res.status).toBe(403)
    expect(scritte('orario_settimanale')).toHaveLength(0)
  })

  // Il gate di sede qui NON aiuta: SEZ_A e SEZ_A2 sono due classi dello STESSO
  // plesso, quindi `assertSezioneInScope` le lascia passare entrambe. Se la
  // verifica di appartenenza della campanella non c'è, non la fa nessun altro.
  it('campanella di una classe SORELLA (stesso plesso): 403, e la classe sorella resta intatta', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: 1, campanellaId: CAMP_A2_LEZ, materiaId: MAT_A }))
    expect(res.status).toBe(403)
    expect(scritte('orario_settimanale')).toHaveLength(0)
  })

  it('update-campanella su una campanella della classe sorella: 403, e la campanella non cambia', async () => {
    const res = await POST(azione('update-campanella', { sectionId: SEZ_A, campanellaId: CAMP_A2_LEZ, tipo: 'mensa' }))
    expect(res.status).toBe(403)
    expect(scritte('campanelle')).toHaveLength(0)
    expect(h.db.campanelle.find((c) => c.id === CAMP_A2_LEZ)!.tipo).toBe('lezione')
  })

  // ⚠️ Questo caso registra il comportamento OSSERVATO, non un presidio nuovo:
  // `delete-campanella` filtra con `.eq('section_id', …)`, quindi la campanella
  // della classe sorella non viene toccata — ma la risposta è comunque
  // `success: true` su una cancellazione che non ha cancellato niente. Il dato
  // è al sicuro; il messaggio no. Segnalato nel rapporto, non corretto qui.
  it('delete-campanella su una campanella della classe sorella: non la cancella (ma dice «fatto»)', async () => {
    const res = await POST(azione('delete-campanella', { sectionId: SEZ_A, campanellaId: CAMP_A2_LEZ }))
    expect(h.db.campanelle.some((c) => c.id === CAMP_A2_LEZ)).toBe(true)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('campanella inesistente: 404 e nessuna cella scritta', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: 1, campanellaId: CAMP_IGNOTA, materiaId: MAT_A }))
    expect(res.status).toBe(404)
    expect(scritte('orario_settimanale')).toHaveLength(0)
  })

  it('giorno diverso da quello della campanella: 400 e nessuna cella scritta', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: 3, campanellaId: CAMP_A_LEZ, materiaId: MAT_A }))
    expect(res.status).toBe(400)
    expect(scritte('orario_settimanale')).toHaveLength(0)
  })

  it('campanella propria e giorno coerente: 201 e la cella viene scritta', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: 1, campanellaId: CAMP_A_LEZ, materiaId: MAT_A }))
    expect(res.status).toBe(201)
    expect(scritte('orario_settimanale')).toHaveLength(1)
  })
})

// =============================================================================
// (d) I QUATTRO `{ error }` SCARTATI — PostgREST non lancia
// =============================================================================
describe('set-tempo: una scrittura respinta non può rispondere «salvato»', () => {
  it('insert delle campanelle respinta: NON 201, e l\'esito non mente', async () => {
    h.errori = { 'campanelle:insert': { code: '23505', message: 'duplicate key' } }
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 5 }))
    expect(res.status).not.toBe(201)
    expect(res.status).toBe(500)
    // Ed è il caso vero: la delete è passata, l'insert no → zero campanelle.
    expect(campanelleDi(SEZ_A)).toHaveLength(0)
  })

  it('delete delle campanelle respinta: NON 201, e le campanelle restano quelle di prima', async () => {
    h.errori = { 'campanelle:delete': { code: '23503', message: 'foreign key' } }
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 5 }))
    expect(res.status).not.toBe(201)
    expect(res.status).toBe(500)
    expect(campanelleDi(SEZ_A)).toHaveLength(2)
  })

  it('insert del tempo scuola respinta: 500 e il modello precedente resta ATTIVO', async () => {
    h.errori = { 'tempo_scuola:insert': { code: '23503', message: 'foreign key' } }
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 40, giorniSettimana: 5 }))
    expect(res.status).toBe(500)
    // Il difetto: la disattivazione avveniva PRIMA dell'insert, quindi un
    // insert respinto lasciava la sezione senza alcun tempo scuola attivo.
    const attivi = h.db.tempo_scuola.filter((t) => t.section_id === SEZ_A && t.attivo)
    expect(attivi).toHaveLength(1)
    expect(attivi[0].id).toBe(TEMPO_A)
  })

  it('set-tempo riuscito: esattamente UN tempo scuola attivo, ed è quello nuovo', async () => {
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 40, giorniSettimana: 5 }))
    expect(res.status).toBe(201)
    const attivi = h.db.tempo_scuola.filter((t) => t.section_id === SEZ_A && t.attivo)
    expect(attivi).toHaveLength(1)
    expect(attivi[0].modello).toBe(40)
    // Il precedente è stato disattivato, non cancellato (resta lo storico).
    expect(h.db.tempo_scuola.find((t) => t.id === TEMPO_A)!.attivo).toBe(false)
  })

  it('update-campanella: la delete della cella orfana respinta non risponde «salvato», e non lascia nulla a metà', async () => {
    h.errori = { 'orario_settimanale:delete': { code: '23503', message: 'foreign key' } }
    const res = await POST(azione('update-campanella', { sectionId: SEZ_A, campanellaId: CAMP_A_LEZ, tipo: 'mensa' }))
    expect(res.status).toBe(500)
    // La delete sta PRIMA dell'update apposta: se fallisce non è cambiato
    // niente, e il ritentativo riparte da uno stato coerente.
    expect(h.db.campanelle.find((c) => c.id === CAMP_A_LEZ)!.tipo).toBe('lezione')
    expect(scritte('campanelle')).toHaveLength(0)
    expect(h.db.orario_settimanale.some((o) => o.id === CELLA_LEZ)).toBe(true)
  })
})

// =============================================================================
// (e) ZOD LASCO DOVE IL DB È STRETTO
// =============================================================================
describe('zod rifiuta ciò che il database rifiuterebbe con un 500', () => {
  it('giorniSettimana = 7 (il CHECK del DB è 5-6): 400 e nessuna scrittura', async () => {
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 7 }))
    expect(res.status).toBe(400)
    expect(h.scritture).toHaveLength(0)
  })

  it('giorniSettimana = 4: 400 e nessuna scrittura', async () => {
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 4 }))
    expect(res.status).toBe(400)
    expect(h.scritture).toHaveLength(0)
  })

  it('giorniSettimana = 5.5: 400 (la colonna è INTEGER)', async () => {
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 5.5 }))
    expect(res.status).toBe(400)
    expect(h.scritture).toHaveLength(0)
  })

  it('giorno = «x» in set-cell: 400, non un NaN scritto in colonna NOT NULL', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: 'x', campanellaId: CAMP_A_LEZ, materiaId: MAT_A }))
    expect(res.status).toBe(400)
    expect(scritte('orario_settimanale')).toHaveLength(0)
  })

  it('giorno = 9 in set-cell (il CHECK del DB è 1-6): 400', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: 9, campanellaId: CAMP_A_LEZ, materiaId: MAT_A }))
    expect(res.status).toBe(400)
    expect(scritte('orario_settimanale')).toHaveLength(0)
  })

  it('giorno = «1» (stringa, come arriva da un form): resta accettato', async () => {
    const res = await POST(azione('set-cell', { sectionId: SEZ_A, giorno: '1', campanellaId: CAMP_A_LEZ, materiaId: MAT_A }))
    expect(res.status).toBe(201)
    const riga = h.db.orario_settimanale.find((o) => o.id === CELLA_LEZ)!
    expect(riga.giorno_settimana).toBe(1)
  })
})

// =============================================================================
// (f) update-campanella: la cella si cancella solo quando il tipo CAMBIA
// =============================================================================
describe('update-campanella cancella la cella orario solo alla transizione da lezione', () => {
  it('correggere l\'ora di una campanella GIÀ mensa non tocca l\'orario settimanale', async () => {
    const res = await POST(azione('update-campanella', { sectionId: SEZ_A, campanellaId: CAMP_A_MENSA, oraFine: '11:00' }))
    expect(res.status).toBe(200)
    expect(scritte('orario_settimanale')).toHaveLength(0)
    expect(h.db.orario_settimanale.some((o) => o.id === CELLA_MENSA)).toBe(true)
  })

  it('trasformare una lezione in mensa cancella la cella, che è diventata orfana', async () => {
    const res = await POST(azione('update-campanella', { sectionId: SEZ_A, campanellaId: CAMP_A_LEZ, tipo: 'mensa' }))
    expect(res.status).toBe(200)
    expect(scritte('orario_settimanale')).toHaveLength(1)
    expect(h.db.orario_settimanale.some((o) => o.id === CELLA_LEZ)).toBe(false)
  })

  it('ribadire tipo = mensa su una campanella già mensa non cancella niente', async () => {
    const res = await POST(azione('update-campanella', { sectionId: SEZ_A, campanellaId: CAMP_A_MENSA, tipo: 'mensa' }))
    expect(res.status).toBe(200)
    expect(scritte('orario_settimanale')).toHaveLength(0)
  })
})

// =============================================================================
// (b) IL TETTO DELLE ORE FIRMABILI — 8 lezioni al giorno, non una di più
// =============================================================================
describe('mai più di 8 campanelle di tipo lezione in un giorno', () => {
  /** Riempie il martedì di SEZ_A con 8 lezioni: il massimo rappresentabile. */
  const martediPieno = () => {
    for (let i = 1; i <= 8; i++) {
      h.db.campanelle.push({
        id: `77777777-1111-4111-8111-00000000000${i}`,
        section_id: SEZ_A,
        giorno_settimana: 2,
        ordine: i,
        ora_inizio: '08:30:00',
        ora_fine: '09:30:00',
        tipo: 'lezione',
      })
    }
  }

  it('add-campanella della 9ª lezione: rifiutata, e nessuna riga inserita', async () => {
    martediPieno()
    const res = await POST(
      azione('add-campanella', { sectionId: SEZ_A, giornoSettimana: 2, ordine: 9, oraInizio: '16:00', oraFine: '17:00', tipo: 'lezione' })
    )
    expect(res.status).toBe(422)
    expect(scritte('campanelle')).toHaveLength(0)
  })

  it('add-campanella di un intervallo sullo stesso giorno pieno: consentita', async () => {
    martediPieno()
    const res = await POST(
      azione('add-campanella', { sectionId: SEZ_A, giornoSettimana: 2, ordine: 9, oraInizio: '16:00', oraFine: '16:15', tipo: 'intervallo' })
    )
    expect(res.status).toBe(201)
  })

  it('add-campanella della 9ª lezione su un ALTRO giorno: consentita', async () => {
    martediPieno()
    const res = await POST(
      azione('add-campanella', { sectionId: SEZ_A, giornoSettimana: 3, ordine: 1, oraInizio: '08:30', oraFine: '09:30', tipo: 'lezione' })
    )
    expect(res.status).toBe(201)
  })

  it('update-campanella che promuove un intervallo a 9ª lezione: rifiutata', async () => {
    martediPieno()
    h.db.campanelle.push({
      id: CAMP_IGNOTA,
      section_id: SEZ_A,
      giorno_settimana: 2,
      ordine: 9,
      ora_inizio: '16:00:00',
      ora_fine: '16:15:00',
      tipo: 'intervallo',
    })
    const res = await POST(azione('update-campanella', { sectionId: SEZ_A, campanellaId: CAMP_IGNOTA, tipo: 'lezione' }))
    expect(res.status).toBe(422)
    expect(scritte('campanelle')).toHaveLength(0)
    expect(h.db.campanelle.find((c) => c.id === CAMP_IGNOTA)!.tipo).toBe('intervallo')
  })

  it('update-campanella su una lezione già contata (nessun nuovo posto occupato): consentita', async () => {
    martediPieno()
    const primaDelMartedi = h.db.campanelle.find((c) => c.giorno_settimana === 2)!
    const res = await POST(
      azione('update-campanella', { sectionId: SEZ_A, campanellaId: primaDelMartedi.id as string, oraFine: '09:45', tipo: 'lezione' })
    )
    expect(res.status).toBe(200)
  })
})

// =============================================================================
// (g) `uq_tempo_scuola_section_attivo` — L'INDICE CHE IL FINTO SUPABASE NON HA
//
// Questo lotto è già stato bocciato una volta ESATTAMENTE qui. La correzione
// precedente aveva spostato l'`update({attivo:false})` DOPO l'insert, così che un
// insert respinto non lasciasse la sezione senza modello — ragionevole a leggerlo,
// impossibile in produzione: `tempo_scuola` porta
//
//   CREATE UNIQUE INDEX uq_tempo_scuola_section_attivo
//     ON public.tempo_scuola USING btree (section_id) WHERE attivo;
//
// (`supabase/migrations/20260704120000_baseline.sql:4877`, riletto su `pg_indexes`
// il 2026-09-09: c'è, ed è l'unico indice della tabella oltre alla chiave primaria).
// Inserire il modello nuovo GIÀ ACCESO mentre il vecchio lo è ancora è un 23505:
// `set-tempo` risponde 500, e siccome `set-tempo` è l'unica azione che
// l'interfaccia usa per rigenerare (`OrarioManager.tsx:268`), l'orario non si
// rigenera più. I 48 test restavano verdi perché il finto Supabase non modella
// nessun indice unico: era verde il percorso che in produzione non può eseguire.
//
// ⚠️ NON si «misura» un indice parziale con `pg_constraint` né con
// `information_schema`: nasce da un `CREATE UNIQUE INDEX` e lì dentro non compare.
// Si legge da `pg_indexes`. Il metodo di misura sbagliato è ciò che ha reso
// invisibile il difetto a chi lo stava introducendo.
//
// I test qui sotto armano l'indice a mano, in due modi diversi e complementari.
// =============================================================================
describe('set-tempo e l’indice unico parziale: mai due modelli accesi insieme', () => {
  type StatoTempo = { id: string; section_id: string; attivo: boolean }

  const istantanea = (): StatoTempo[] =>
    (h.db.tempo_scuola ?? []).map((t) => ({
      id: t.id as string,
      section_id: t.section_id as string,
      attivo: Boolean(t.attivo),
    }))

  /**
   * L'INDICE PARZIALE, RIFATTO A MANO SUL DIARIO DELLE SCRITTURE.
   *
   * `h.scritture` registra ogni insert/update/delete con le righe COLPITE già
   * mutate (`finto-supabase.ts`, `registra()`), quindi la sequenza si può
   * rigiocare: si parte dallo stato iniziale e si applica una scrittura per
   * volta, contando dopo OGNI passo quanti modelli risultano accesi sulla
   * sezione. Due, anche per un solo istante fra due chiamate PostgREST, in
   * produzione sono un 23505 — e il passo che li accende è quello che fallisce.
   *
   * Ritorna la descrizione del passo colpevole, oppure `null` se la sequenza è
   * eseguibile. Non è legata a UNA sequenza: passa sia «spegni poi inserisci»
   * sia «inserisci spento, spegni, accendi», e boccia solo ciò che l'indice
   * boccerebbe davvero.
   */
  const passoCheViolaLIndice = (iniziale: StatoTempo[], sezione: string): string | null => {
    const stato = new Map<string, { section_id: string; attivo: boolean }>(
      iniziale.map((t) => [t.id, { section_id: t.section_id, attivo: t.attivo }]),
    )
    const accesi = () =>
      [...stato.values()].filter((t) => t.section_id === sezione && t.attivo).length
    if (accesi() > 1) return 'lo stato INIZIALE ha già due modelli accesi: il test è mal costruito'

    let passo = 0
    for (const s of h.scritture as Scrittura[]) {
      if (s.tabella !== 'tempo_scuola') continue
      passo += 1
      for (const r of s.colpite) {
        const id = r.id as string
        if (s.operazione === 'delete') stato.delete(id)
        else stato.set(id, { section_id: r.section_id as string, attivo: Boolean(r.attivo) })
      }
      if (accesi() > 1) {
        return `dopo la ${passo}ª scrittura su tempo_scuola (${s.operazione}) i modelli accesi sulla sezione sono ${accesi()}: in produzione questo passo è un 23505 su uq_tempo_scuola_section_attivo`
      }
    }
    return null
  }

  it('il rigiocatore SA vedere la violazione (controllo positivo: senza, tutto sarebbe verde)', () => {
    // Un lock che non si è mai visto suonare non è un lock. Qui la sequenza
    // bocciata — inserisci ACCESO mentre il precedente è acceso — si scrive a
    // mano nel diario, e il rigiocatore deve segnalarla.
    const iniziale = istantanea()
    ;(h.scritture as Scrittura[]).push({
      tabella: 'tempo_scuola',
      operazione: 'insert',
      valori: [{ section_id: SEZ_A, modello: 40, attivo: true }],
      colpite: [{ id: 'nuovo', section_id: SEZ_A, modello: 40, attivo: true }],
    })
    expect(passoCheViolaLIndice(iniziale, SEZ_A)).toMatch(/23505/)
  })

  it('set-tempo su una sezione che HA già un modello attivo: nessun passo accende due modelli', async () => {
    const iniziale = istantanea()
    expect(iniziale.filter((t) => t.section_id === SEZ_A && t.attivo)).toHaveLength(1)

    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 40, giorniSettimana: 5 }))
    expect(res.status).toBe(201)
    expect(passoCheViolaLIndice(iniziale, SEZ_A)).toBeNull()
  })

  it('e alla fine ne resta acceso UNO SOLO, che è quello nuovo', async () => {
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 29, giorniSettimana: 6 }))
    expect(res.status).toBe(201)
    const attivi = h.db.tempo_scuola.filter((t) => t.section_id === SEZ_A && t.attivo)
    expect(attivi).toHaveLength(1)
    expect(attivi[0].modello).toBe(29)
    expect(h.db.tempo_scuola.find((t) => t.id === TEMPO_A)!.attivo).toBe(false)
  })

  it('la risposta 201 dichiara il modello ACCESO, non la riga inerte con cui è nato', async () => {
    // Il modello nuovo può nascere spento (è il modo di non violare l'indice
    // senza una transazione): ciò che torna al client dev'essere lo stato in cui
    // la riga è rimasta, non quello con cui è passata.
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 27, giorniSettimana: 5 }))
    expect(res.status).toBe(201)
    const corpo = (await res.json()) as { data: { attivo: boolean; modello: number } }
    expect(corpo.data.attivo).toBe(true)
    expect(corpo.data.modello).toBe(27)
  })

  it('23505 sull’insert: 500 leggibile, il modello precedente resta ACCESO, e l’orario non viene toccato', async () => {
    // Il 23505 che l'indice produce davvero. Due cose contano: che la sezione
    // resti utilizzabile, e che a schermo non finisca la prosa di Postgres —
    // «duplicate key value violates unique constraint "uq_…"» non dice niente a
    // una segretaria e racconta a chiunque com'è fatto lo schema.
    h.errori = {
      'tempo_scuola:insert': {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_tempo_scuola_section_attivo"',
      },
    }
    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 40, giorniSettimana: 5 }))
    expect(res.status).toBe(500)

    const corpo = (await res.json()) as { error: string }
    expect(corpo.error).not.toMatch(/uq_tempo_scuola_section_attivo|duplicate key|unique constraint/)

    const attivi = h.db.tempo_scuola.filter((t) => t.section_id === SEZ_A && t.attivo)
    expect(attivi).toHaveLength(1)
    expect(attivi[0].id).toBe(TEMPO_A)
    // E le campanelle NON sono state rigenerate: la classe tiene il suo orario.
    expect(campanelleDi(SEZ_A)).toHaveLength(2)
  })

  const CONFLITTO: ErrorePostgrest = { code: '40001', message: 'could not serialize access' }

  /**
   * Fa fallire ALCUNE delle update su `tempo_scuola`, scelte per numero d'ordine.
   *
   * La chiave iniettabile è una sola per tabella e operazione
   * (`tempo_scuola:update`), quindi un errore statico le colpirebbe tutte e la
   * sequenza si fermerebbe al primo passo — che è il passo sbagliato da provare.
   * Il finto client consulta `opzioni.errori[chiave]` una volta per query, un
   * istante prima di applicare la scrittura: una proprietà CALCOLATA può quindi
   * contare i passaggi e rispondere solo a quelli che interessano.
   */
  const guastaLeUpdate = (colpita: (n: number) => boolean, errore: ErrorePostgrest) => {
    let viste = 0
    Object.defineProperty(h.errori, 'tempo_scuola:update', {
      configurable: true,
      get: () => (colpita((viste += 1)) ? errore : undefined),
    })
  }

  it('se l’accensione del nuovo modello fallisce, il precedente viene RIACCESO', async () => {
    // La finestra a zero modelli attivi è inevitabile senza una transazione. Ciò
    // che non è inevitabile è lasciarcela: una sezione senza modello acceso il
    // GET la legge come «non configurata» (`maybeSingle()` su `attivo = true`),
    // e la segreteria si ritrova la tendina vuota sopra un orario che c'è.
    guastaLeUpdate((n) => n === 2, CONFLITTO)

    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 40, giorniSettimana: 5 }))
    expect(res.status).toBe(500)

    const attivi = h.db.tempo_scuola.filter((t) => t.section_id === SEZ_A && t.attivo)
    expect(attivi, 'la sezione è rimasta senza alcun modello attivo').toHaveLength(1)
    expect(attivi[0].id).toBe(TEMPO_A)
    // Nulla è stato rigenerato: l'orario di prima è ancora al suo posto.
    expect(campanelleDi(SEZ_A)).toHaveLength(2)
  })

  it('se anche il ripristino fallisce, la risposta resta un 500 e non un «salvato»', async () => {
    // Il caso peggiore: si spegne, non si accende, e non si riesce nemmeno a
    // rimettere le cose com'erano. Non c'è niente da salvare — c'è da DIRLO.
    // (La 1ª update è lo spegnimento e deve passare, altrimenti si proverebbe un
    // altro ramo credendo di provare questo.)
    guastaLeUpdate((n) => n >= 2, CONFLITTO)

    const res = await POST(azione('set-tempo', { sectionId: SEZ_A, modello: 40, giorniSettimana: 5 }))
    expect(res.status).toBe(500)
    expect(h.db.tempo_scuola.filter((t) => t.section_id === SEZ_A && t.attivo)).toHaveLength(0)
    expect(campanelleDi(SEZ_A)).toHaveLength(2)
  })
})
