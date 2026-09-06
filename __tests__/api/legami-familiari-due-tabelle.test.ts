import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A, SEDE_B } from '../fixtures/sedi'
import type { DBFinto, Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// `/api/admin/legami-familiari` — collegare, scollegare, correggere il ruolo.
//
// ─── PERCHÉ QUESTO TEST GUARDA **DUE** TABELLE ──────────────────────────────
//
// Il legame genitore↔bambino vive in due posti, ed è la misura a dirlo (DB di
// produzione, 2026-09-05): `student_parents` 885 righe, `legame_genitori_alunni`
// 818. Non sono un doppione: `student_parents` porta l'ANAGRAFICA (`parents.id`)
// ed è quella che legge il codice applicativo; `legame_genitori_alunni` porta
// l'ACCOUNT (`utenti.id`) ed è quella che leggono le policy RLS del baseline su
// `pagamenti`, `incassi`, `note_disciplinari`.
//
// Scriverne UNA sola è il difetto che questo file esiste per impedire, e ha due
// facce entrambe silenziose:
//  · solo l'anagrafica ⇒ la segreteria vede il legame, il genitore non vede i
//    pagamenti di suo figlio (RLS chiusa) e nessuno logga niente;
//  · solo il runtime ⇒ il contrario.
// Nessuna delle due rompe una schermata: restituiscono meno righe, e basta.
//
// La PROVA NEGATIVA è la ragione della forma di questi test: si asserisce lo
// stato finale di ENTRAMBE le tabelle nel finto client (che filtra e scrive
// davvero), mai «la route ha risposto 200». Togliendo da `collegaFamiliare` la
// chiamata a `sincronizzaLegamiRuntime` il primo test diventa rosso, e diventa
// rosso sull'asserzione giusta: `legame_genitori_alunni` resta vuota.
// =============================================================================

const ID_SEGRETERIA = 'aaaa0000-0000-4000-8000-0000000000f1'
const ALUNNO_A = 'aaaa1111-0000-4000-8000-0000000000a1'
const ALUNNO_A2 = 'aaaa1111-0000-4000-8000-0000000000a2'
const ALUNNO_B = 'bbbb1111-0000-4000-8000-0000000000b1'
/** Madre già in archivio, con account: il caso principale del riuso. */
const PARENT_MADRE = 'aaaa2222-0000-4000-8000-0000000000c1'
const ACCOUNT_MADRE = 'aaaa3333-0000-4000-8000-0000000000d1'
/** Padre già in archivio e già collegato ad ALUNNO_A: è «l'ultimo genitore». */
const PARENT_PADRE = 'aaaa2222-0000-4000-8000-0000000000c2'
const ACCOUNT_PADRE = 'aaaa3333-0000-4000-8000-0000000000d2'
/** Anagrafica SENZA account (in produzione sono 64 su 747): niente riga runtime. */
const PARENT_SENZA_ACCOUNT = 'aaaa2222-0000-4000-8000-0000000000c3'
/** Genitore dell'ALTRA sede: non deve poter essere collegato da qui. */
const PARENT_ALTRA_SEDE = 'bbbb2222-0000-4000-8000-0000000000e1'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  /**
   * Il percorso «crea un adulto NUOVO» è sostituito, e solo lui: quello vero
   * crea un'identità di accesso e **manda un'email di credenziali a una famiglia
   * vera**. Qui serve poterlo far fallire a comando — è l'unico modo di guardare
   * che cosa risponde la rotta quando l'anagrafica può essere già nata.
   */
  linkOrCreateParent: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  scritture: [] as Scrittura[],
  erroriTabella: {} as Record<string, { code: string; message?: string }>,
}))

// Solo `logEvento` è sostituito: il resto del modulo di logging resta REALE,
// perché `withRoute` ne usa altri pezzi e un mock totale collauderebbe
// l'impalcatura invece della route.
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})

// `requireStaff` è l'unico gate sostituito: serve un'identità senza sessione
// Supabase. `assertAlunnoInScope` / `assertParentInScope` restano REALI e
// girano contro il finto client — altrimenti il test sull'isolamento fra sedi
// proverebbe il mock, non il presidio.
vi.mock('@/lib/auth/require-staff', async (originale) => {
  const reale = await originale<typeof import('@/lib/auth/require-staff')>()
  return { ...reale, requireStaff: h.requireStaff }
})

// Sostituito il SOLO `linkOrCreateParent` (il resto del modulo resta reale): è
// il percorso che crea l'anagrafica dell'adulto, l'identità di accesso e spedisce
// le credenziali. Un test che lo esegue davvero collauderebbe quattro sistemi
// invece della rotta, e nel farlo scriverebbe un'email.
vi.mock('@/lib/anagrafiche/parents', async (originale) => {
  const reale = await originale<typeof import('@/lib/anagrafiche/parents')>()
  return { ...reale, linkOrCreateParent: (...a: unknown[]) => h.linkOrCreateParent(...a) }
})

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.erroriTabella }),
    createClient: async () =>
      creaFintoSupabase(h.db, h.tabelle, { scritture: h.scritture, errori: h.erroriTabella }),
  }
})

import { GET, POST } from '@/app/api/admin/legami-familiari/route'

/**
 * Le anagrafiche adulte, in un posto solo: il finto client NON costruisce i join
 * dalla stringa di `select()` — l'oggetto annidato lo mette il fixture (è scritto
 * nella sua testata). Perciò ogni riga di `student_parents` porta con sé la
 * `parents` incorporata, e la porta uguale a quella della tabella `parents`,
 * costruita da qui invece che ribattuta a mano: due copie che divergono
 * renderebbero verde un test che guarda la copia sbagliata.
 */
const ANAGRAFICHE: Record<string, Record<string, unknown>> = {
  [PARENT_MADRE]: { id: PARENT_MADRE, auth_user_id: ACCOUNT_MADRE, first_name: 'Adulta', last_name: 'Verdi', fiscal_code: 'AAAAAA00A00A000A', emails: ['a@example.invalid'] },
  [PARENT_PADRE]: { id: PARENT_PADRE, auth_user_id: ACCOUNT_PADRE, first_name: 'Adulto', last_name: 'Bianchi', fiscal_code: 'BBBBBB00B00B000B', emails: ['b@example.invalid'] },
  [PARENT_SENZA_ACCOUNT]: { id: PARENT_SENZA_ACCOUNT, auth_user_id: null, first_name: 'Adulta', last_name: 'Neri', fiscal_code: 'CCCCCC00C00C000C', emails: [] },
  [PARENT_ALTRA_SEDE]: { id: PARENT_ALTRA_SEDE, auth_user_id: null, first_name: 'Adulto', last_name: 'Gialli', fiscal_code: 'DDDDDD00D00D000D', emails: [] },
}

const legame = (
  studentId: string,
  parentId: string,
  relationType: string,
  sede: string,
) => ({
  student_id: studentId,
  parent_id: parentId,
  relation_type: relationType,
  is_primary: relationType === 'mother' || relationType === 'father',
  alunni: { scuola_id: sede },
  parents: ANAGRAFICHE[parentId],
})

const dbBase = (): DBFinto => ({
  utenti: [{ id: ID_SEGRETERIA, ruolo: 'segreteria', scuola_id: SEDE_A }],
  utenti_scuole: [],
  utenti_sezioni: [],
  alunni: [
    { id: ALUNNO_A, scuola_id: SEDE_A, nome: 'Bambino', cognome: 'Uno', stato: 'iscritto', section_id: null, classe_sezione: '3 ANNI A' },
    { id: ALUNNO_A2, scuola_id: SEDE_A, nome: 'Bambino', cognome: 'Due', stato: 'iscritto', section_id: null, classe_sezione: '3 ANNI A' },
    { id: ALUNNO_B, scuola_id: SEDE_B, nome: 'Bambino', cognome: 'Tre', stato: 'iscritto', section_id: null, classe_sezione: '3 ANNI B' },
  ],
  parents: Object.values(ANAGRAFICHE).map((p) => ({ ...p })),
  // Stato di partenza: ALUNNO_A ha SOLO il padre (è il suo ultimo genitore);
  // PARENT_MADRE è già di questa sede perché collegata ad ALUNNO_A2;
  // PARENT_SENZA_ACCOUNT e PARENT_ALTRA_SEDE stanno rispettivamente in SEDE_A e
  // in SEDE_B, e la differenza è tutto il punto del test d'isolamento.
  student_parents: [
    legame(ALUNNO_A, PARENT_PADRE, 'father', SEDE_A),
    legame(ALUNNO_A2, PARENT_MADRE, 'mother', SEDE_A),
    legame(ALUNNO_A2, PARENT_SENZA_ACCOUNT, 'delegate', SEDE_A),
    legame(ALUNNO_B, PARENT_ALTRA_SEDE, 'mother', SEDE_B),
  ],
  legame_genitori_alunni: [
    { genitore_id: ACCOUNT_PADRE, alunno_id: ALUNNO_A, intestatario_fattura: true, percentuale_pagamento: 100 },
    { genitore_id: ACCOUNT_MADRE, alunno_id: ALUNNO_A2, intestatario_fattura: false, percentuale_pagamento: 0 },
  ],
  audit_scritture_docente: [],
})

function richiesta(url: string, body?: Record<string, unknown>): Request {
  return {
    url,
    method: body ? 'POST' : 'GET',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body ?? {},
  } as unknown as Request
}

const post = (body: Record<string, unknown>) =>
  POST(richiesta('http://localhost/api/admin/legami-familiari', body))
const get = (qs: string) =>
  GET(richiesta(`http://localhost/api/admin/legami-familiari?${qs}`))

const spSu = (alunno: string, parent: string) =>
  (h.db.student_parents ?? []).filter((r) => r.student_id === alunno && r.parent_id === parent)
const lgaSu = (alunno: string, account: string) =>
  (h.db.legame_genitori_alunni ?? []).filter((r) => r.alunno_id === alunno && r.genitore_id === account)
const scrittureSu = (tabella: string) => h.scritture.filter((s) => s.tabella === tabella)

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` pulisce le CHIAMATE, non l'implementazione: senza questa
  // riga il `mockRejectedValue` di un test resterebbe armato in quelli dopo, e
  // un test verde per un'implementazione lasciata accesa altrove è il modo più
  // silenzioso di non collaudare niente.
  h.linkOrCreateParent.mockReset()
  h.db = dbBase()
  h.tabelle = []
  h.scritture = []
  h.erroriTabella = {}
  h.requireStaff.mockResolvedValue({
    user: { id: ID_SEGRETERIA, role: 'segreteria', ruolo: 'segreteria', scuola_id: SEDE_A },
  })
})

describe('POST collega — le tabelle vive sono DUE, e si scrivono entrambe', () => {
  it('collega una madre già in archivio: riga in student_parents E in legame_genitori_alunni', async () => {
    const res = await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE, relation_type: 'mother' })

    expect(res.status).toBe(200)
    const corpo = await res.json()
    expect(corpo).toMatchObject({ anagrafica: 'creata', runtime: 'creato' })

    // 1ª tabella — l'anagrafica, con il ruolo e `is_primary` DERIVATO dal ruolo.
    expect(spSu(ALUNNO_A, PARENT_MADRE)).toHaveLength(1)
    expect(spSu(ALUNNO_A, PARENT_MADRE)[0]).toMatchObject({
      student_id: ALUNNO_A,
      parent_id: PARENT_MADRE,
      relation_type: 'mother',
      is_primary: true,
    })

    // 2ª tabella — il runtime, quella che leggono le policy RLS. È QUESTA
    // l'asserzione che diventa rossa togliendo la seconda scrittura.
    expect(lgaSu(ALUNNO_A, ACCOUNT_MADRE)).toHaveLength(1)
    expect(lgaSu(ALUNNO_A, ACCOUNT_MADRE)[0]).toMatchObject({
      // La quota NON si inventa: chi arriva secondo non diventa intestatario.
      intestatario_fattura: false,
      percentuale_pagamento: 0,
    })
  })

  it('un genitore SENZA account scrive solo l’anagrafica, e lo DICE', async () => {
    // 64 anagrafiche su 747 in produzione non hanno `auth_user_id`: non esiste
    // un `utenti.id` da mettere in `genitore_id`, e inventarlo scriverebbe una FK
    // rotta. La risposta deve distinguerlo da un guasto — «senza-account» non è
    // «non-scritto».
    const res = await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_SENZA_ACCOUNT, relation_type: 'delegate' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ anagrafica: 'creata', runtime: 'senza-account' })
    expect(spSu(ALUNNO_A, PARENT_SENZA_ACCOUNT)).toHaveLength(1)
    expect(h.db.legame_genitori_alunni).toHaveLength(2) // le due di partenza
  })

  it('ricollegare un legame che c’è già non duplica e non riscrive il ruolo', async () => {
    const res = await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_PADRE, relation_type: 'delegate' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ anagrafica: 'gia-presente' })
    expect(spSu(ALUNNO_A, PARENT_PADRE)).toHaveLength(1)
    // Il ruolo NON è stato degradato a `delegate` da una richiesta di collegamento:
    // per cambiarlo c'è `cambia-ruolo`, che è un gesto dichiarato.
    expect(spSu(ALUNNO_A, PARENT_PADRE)[0].relation_type).toBe('father')
  })
})

describe('POST collega — l’isolamento fra plessi', () => {
  it('la segreteria di A non può collegare un genitore di B: 403 e ZERO scritture', async () => {
    const res = await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_ALTRA_SEDE, relation_type: 'mother' })

    expect(res.status).toBe(403)
    expect(scrittureSu('student_parents')).toEqual([])
    expect(scrittureSu('legame_genitori_alunni')).toEqual([])
    expect(spSu(ALUNNO_A, PARENT_ALTRA_SEDE)).toHaveLength(0)
  })

  it('la segreteria di A non può collegare un BAMBINO di B: 403 e ZERO scritture', async () => {
    const res = await post({ azione: 'collega', alunno_id: ALUNNO_B, parent_id: PARENT_MADRE, relation_type: 'mother' })

    expect(res.status).toBe(403)
    expect(scrittureSu('student_parents')).toEqual([])
    expect(scrittureSu('legame_genitori_alunni')).toEqual([])
  })
})

describe('POST scollega — pulisce entrambe, e non lascia un bambino senza nessuno', () => {
  it('scollega: spariscono la riga anagrafica E quella runtime', async () => {
    // Prima si collega la madre, così il padre non è più l'ultimo.
    await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE, relation_type: 'mother' })
    h.scritture = []

    const res = await post({ azione: 'scollega', alunno_id: ALUNNO_A, parent_id: PARENT_PADRE })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ anagrafica: 'rimossa', runtime: 'rimosso' })
    expect(spSu(ALUNNO_A, PARENT_PADRE)).toHaveLength(0)
    expect(lgaSu(ALUNNO_A, ACCOUNT_PADRE)).toHaveLength(0)
    // L'altro legame non è stato toccato: si scollega UNA persona, non la famiglia.
    expect(spSu(ALUNNO_A, PARENT_MADRE)).toHaveLength(1)
    expect(lgaSu(ALUNNO_A, ACCOUNT_MADRE)).toHaveLength(1)
  })

  it('scollegare l’ULTIMO genitore è rifiutato: 409 e niente cancellato', async () => {
    // ALUNNO_A ha solo il padre. Senza di lui il bambino non sarebbe più
    // raggiungibile da nessun adulto — e in produzione cinque alunni sono già
    // in quello stato: il rimedio è non crearne un sesto.
    const res = await post({ azione: 'scollega', alunno_id: ALUNNO_A, parent_id: PARENT_PADRE })

    expect(res.status).toBe(409)
    const corpo = await res.json()
    expect(corpo.codice).toBe('LEGAME_ULTIMO_GENITORE')
    // Il messaggio dice il RIMEDIO, non solo il divieto.
    expect(String(corpo.error)).toMatch(/collega/i)
    expect(spSu(ALUNNO_A, PARENT_PADRE)).toHaveLength(1)
    expect(lgaSu(ALUNNO_A, ACCOUNT_PADRE)).toHaveLength(1)
    expect(scrittureSu('student_parents')).toEqual([])
    expect(scrittureSu('legame_genitori_alunni')).toEqual([])
  })

  it('un legame che non esiste risponde 404, non 200', async () => {
    const res = await post({ azione: 'scollega', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE })

    expect(res.status).toBe(404)
    expect((await res.json()).codice).toBe('LEGAME_NON_TROVATO')
  })

  it('se la lettura dei legami residui fallisce NON si cancella niente', async () => {
    // PostgREST non lancia: senza il controllo del valore di ritorno, un guasto
    // di lettura si sarebbe presentato come «zero genitori residui»… oppure,
    // peggio, come un via libera. Qui si pretende il contrario: nel dubbio non
    // si toglie a un adulto la vista su un minore.
    h.erroriTabella = { 'student_parents:select': { code: 'XX000', message: 'guasto' } }

    const res = await post({ azione: 'scollega', alunno_id: ALUNNO_A, parent_id: PARENT_PADRE })

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(spSu(ALUNNO_A, PARENT_PADRE)).toHaveLength(1)
    expect(lgaSu(ALUNNO_A, ACCOUNT_PADRE)).toHaveLength(1)
  })
})

// =============================================================================
// QUANDO A FALLIRE È LA **SECONDA** SCRITTURA — lo stato a metà, nei due versi.
//
// I test qui sopra coprono il fallimento di una LETTURA. Quello di una SCRITTURA
// — cioè esattamente il guasto che questo modulo esiste per impedire — non era
// coperto in nessuna delle due direzioni, e l'assenza aveva già prodotto la sua
// misura (revisione del 2026-09-06, errore iniettato su
// `legame_genitori_alunni:upsert`): la rotta rispondeva `200 { ok: true }` e sul
// database restavano `student_parents` = 1 e `legame_genitori_alunni` = 0 —
// gate applicativo APERTO e RLS CHIUSA — con l'intera suite verde.
//
// Perciò qui si guarda lo stato finale delle DUE tabelle, mai il solo status: è
// l'unica asserzione che sa distinguere «riuscito» da «riuscito a metà».
// =============================================================================
describe('POST — quando fallisce la SECONDA scrittura', () => {
  it('collega: resta l’anagrafica e NON la riga runtime — 200 con runtime «non-scritto», e un `error` a log', async () => {
    h.erroriTabella = { 'legame_genitori_alunni:upsert': { code: 'XX000', message: 'guasto' } }

    const res = await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE, relation_type: 'mother' })

    // Il 200 è DELIBERATO (vedi la nota accanto al `return` di
    // `collegaFamiliare`): la riga anagrafica c'è davvero, quindi «non salvato»
    // sarebbe falso, e disfarla cancellerebbe un legame che poteva esserci già.
    // Ciò che non deve perdersi è lo stato a metà, e sta tutto in `runtime`.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ anagrafica: 'creata', runtime: 'non-scritto' })

    // 1ª tabella scritta, 2ª no: il genitore vedrebbe il figlio in anagrafica e
    // NON i suoi pagamenti, perché le policy RLS leggono la seconda.
    expect(spSu(ALUNNO_A, PARENT_MADRE)).toHaveLength(1)
    expect(lgaSu(ALUNNO_A, ACCOUNT_MADRE)).toHaveLength(0)

    // Dentro un 200 il guasto non ha nessun altro segnale che questa riga: senza,
    // «è andato tutto bene» e «la RLS è rimasta chiusa» sarebbero lo stesso
    // silenzio.
    const conError = h.logEvento.mock.calls.some(
      (c: unknown[]) =>
        c[1] === 'error' && (c[2] as { esito?: unknown } | null)?.esito === 'runtime-non-creato',
    )
    expect(conError, 'nessuna riga di livello `error` per il runtime non creato').toBe(true)
  })

  it('scollega: l’accesso è già tolto e l’anagrafica resta — 500 `LEGAME_MEZZO_TOLTO`, che NON dice «niente è stato modificato»', async () => {
    // Prima si collega la madre, così il padre non è più l'ultimo genitore.
    await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE, relation_type: 'mother' })
    h.scritture = []
    h.erroriTabella = { 'student_parents:delete': { code: 'XX000', message: 'guasto' } }

    const res = await post({ azione: 'scollega', alunno_id: ALUNNO_A, parent_id: PARENT_PADRE })

    expect(res.status).toBe(500)
    const corpo = await res.json()
    // Il codice è quello dello STATO A METÀ, e non `LEGAME_NON_SALVATO`: il
    // client, appena riconosce un codice, mostra la frase di catalogo e scarta
    // la prosa del server — e la frase di `LEGAME_NON_SALVATO` dice «niente è
    // stato modificato», cioè il contrario del vero proprio qui.
    expect(corpo.codice).toBe('LEGAME_MEZZO_TOLTO')
    expect(String(corpo.error)).not.toMatch(/niente è stato modificato/i)
    expect(String(corpo.error)).toMatch(/anagrafica/i)

    // LO STATO A METÀ, misurato sulle due tabelle: l'accesso tolto…
    expect(lgaSu(ALUNNO_A, ACCOUNT_PADRE)).toHaveLength(0)
    // …e il legame anagrafico ancora lì, che è la metà da ritentare.
    expect(spSu(ALUNNO_A, PARENT_PADRE)).toHaveLength(1)
  })

  it('scollega: se è la PRIMA cancellazione a fallire non cambia niente, e il codice lo dice (`LEGAME_NON_SALVATO`)', async () => {
    // Il controllo NEGATIVO del test qui sopra: senza, «metà fatto» e «niente
    // fatto» tornerebbero a essere lo stesso codice e nessuno se ne accorgerebbe.
    await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE, relation_type: 'mother' })
    h.erroriTabella = { 'legame_genitori_alunni:delete': { code: 'XX000', message: 'guasto' } }

    const res = await post({ azione: 'scollega', alunno_id: ALUNNO_A, parent_id: PARENT_PADRE })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LEGAME_NON_SALVATO')
    expect(lgaSu(ALUNNO_A, ACCOUNT_PADRE)).toHaveLength(1)
    expect(spSu(ALUNNO_A, PARENT_PADRE)).toHaveLength(1)
  })

  it('scollega di un adulto SENZA account: se salta l’anagrafica non è uno stato a metà, perché non c’era nessun accesso da togliere', async () => {
    // Qui la «seconda» scrittura è l'unica: `PARENT_SENZA_ACCOUNT` non ha un
    // `utenti.id`, quindi non esiste nessuna riga runtime da cancellare. Il
    // motivo lo decide lo STATO — che cosa è già stato tolto — non quale delle
    // due `delete` è andata storta.
    h.erroriTabella = { 'student_parents:delete': { code: 'XX000', message: 'guasto' } }

    const res = await post({ azione: 'scollega', alunno_id: ALUNNO_A2, parent_id: PARENT_SENZA_ACCOUNT })

    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('LEGAME_NON_SALVATO')
    expect(spSu(ALUNNO_A2, PARENT_SENZA_ACCOUNT)).toHaveLength(1)
  })
})

describe('POST cambia-ruolo', () => {
  it('corregge relation_type e RIALLINEA is_primary (che non si passa a mano)', async () => {
    const res = await post({ azione: 'cambia-ruolo', alunno_id: ALUNNO_A2, parent_id: PARENT_SENZA_ACCOUNT, relation_type: 'mother' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ relation_type: 'mother', is_primary: true })
    expect(spSu(ALUNNO_A2, PARENT_SENZA_ACCOUNT)[0]).toMatchObject({
      relation_type: 'mother',
      is_primary: true,
    })
  })

  it('su un legame inesistente: 404', async () => {
    const res = await post({ azione: 'cambia-ruolo', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE, relation_type: 'mother' })
    expect(res.status).toBe(404)
  })
})

// =============================================================================
// IL RAMO «ADULTO NUOVO» — dove «niente è stato modificato» è una frase pericolosa.
//
// Su questo ramo un rifiuto arriva DOPO `linkOrCreateParent`, cioè dopo che
// l'anagrafica può essere nata e le credenziali essere partite verso una famiglia
// vera. Fino al 2026-09-06 usciva `LEGAME_NON_SALVATO`, la cui frase di catalogo
// invita a riprovare: seconda anagrafica, seconda email. Il dialogo di aggiunta
// se n'era accorto dal proprio lato e si difendeva nascondendo la prosa sui 5xx;
// la difesa giusta è che la rotta dica quale ramo ha preso.
// =============================================================================
describe('POST collega — il ramo «adulto NUOVO» dice che l’anagrafica può esserci già', () => {
  it('se la creazione dell’adulto salta: 500 `LEGAME_ADULTO_FORSE_CREATO`, e nessun invito a riprovare', async () => {
    h.linkOrCreateParent.mockRejectedValue(new Error('guasto finto'))

    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO_A,
      relation_type: 'mother',
      genitore: { first_name: 'Adulta', last_name: 'Rosa' },
    })

    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('LEGAME_ADULTO_FORSE_CREATO')
    // `linkOrCreateParent` lancia da quattro punti, e tre stanno DOPO l'insert
    // dell'anagrafica: promettere che niente è cambiato è una promessa che non si
    // può mantenere.
    expect(String(corpo.error)).not.toMatch(/niente è stato modificato/i)
  })

  it('se l’adulto è stato creato e il collegamento no, NON si risponde `LETTURA_FALLITA`', async () => {
    // L'anagrafica c'è (l'ha appena creata `linkOrCreateParent`, che scrive anche
    // il legame): qualunque cosa vada storta dopo, il rimedio non è ricompilare il
    // modulo — è cercare l'adulto in archivio. Perciò il codice segue il RAMO, non
    // il tipo di guasto.
    h.linkOrCreateParent.mockResolvedValue({ parentId: PARENT_MADRE })
    h.erroriTabella = { 'student_parents:select': { code: 'XX000', message: 'guasto' } }

    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO_A,
      relation_type: 'mother',
      genitore: { first_name: 'Adulta', last_name: 'Rosa' },
    })

    expect(res.status).toBe(500)
    expect((await res.json()).codice).toBe('LEGAME_ADULTO_FORSE_CREATO')
  })

  it('senza `parent_id` e senza `genitore` non c’è nessuno da collegare: 400 e ZERO scritture', async () => {
    const res = await post({ azione: 'collega', alunno_id: ALUNNO_A, relation_type: 'mother' })

    expect(res.status).toBe(400)
    // Non `LEGAME_NON_SALVATO`: quella frase dice «riprova fra poco», e riprovare
    // non serve a niente finché non si indica un adulto.
    expect((await res.json()).codice).toBe('LEGAME_ADULTO_NON_INDICATO')
    expect(scrittureSu('student_parents')).toEqual([])
    expect(h.linkOrCreateParent).not.toHaveBeenCalled()
  })
})

describe('POST — il corpo è validato in modo STRICT', () => {
  it('una chiave fuori schema non passa in silenzio: 400', async () => {
    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO_A,
      parent_id: PARENT_MADRE,
      relation_type: 'mother',
      is_primary: true, // non esiste nell'API: `is_primary` lo decide il ruolo
    })
    expect(res.status).toBe(400)
    expect(scrittureSu('student_parents')).toEqual([])
  })

  it('un ruolo fuori vocabolario non passa: 400', async () => {
    const res = await post({ azione: 'collega', alunno_id: ALUNNO_A, parent_id: PARENT_MADRE, relation_type: 'madre' })
    expect(res.status).toBe(400)
  })
})

describe('GET — la ricerca non esce dai plessi consentiti', () => {
  it('cerca fra i genitori della PROPRIA sede e non trova quelli dell’altra', async () => {
    const res = await get('tipo=genitori&q=Adult')

    expect(res.status).toBe(200)
    const { genitori } = await res.json()
    const ids = (genitori as { id: string }[]).map((g) => g.id)
    expect(ids).toContain(PARENT_MADRE)
    expect(ids).toContain(PARENT_SENZA_ACCOUNT)
    expect(ids).not.toContain(PARENT_ALTRA_SEDE)
  })

  it('con `alunno_id` marca chi è GIÀ collegato, così la UI non lo ripropone', async () => {
    const res = await get(`tipo=genitori&q=Adult&alunno_id=${ALUNNO_A}`)

    const { genitori } = await res.json()
    const righe = genitori as { id: string; gia_collegato: boolean }[]
    expect(righe.find((g) => g.id === PARENT_PADRE)?.gia_collegato).toBe(true)
    expect(righe.find((g) => g.id === PARENT_MADRE)?.gia_collegato).toBe(false)
  })

  it('la ricerca degli ALUNNI resta nei propri plessi', async () => {
    const res = await get('tipo=alunni&q=Bambino')

    expect(res.status).toBe(200)
    const { alunni } = await res.json()
    const ids = (alunni as { id: string }[]).map((a) => a.id)
    expect(ids).toContain(ALUNNO_A)
    expect(ids).toContain(ALUNNO_A2)
    expect(ids).not.toContain(ALUNNO_B)
  })

  it('un genitore di un ALTRO plesso non si può usare come filtro: 403', async () => {
    const res = await get(`tipo=alunni&q=Bambino&parent_id=${PARENT_ALTRA_SEDE}`)
    expect(res.status).toBe(403)
  })
})
