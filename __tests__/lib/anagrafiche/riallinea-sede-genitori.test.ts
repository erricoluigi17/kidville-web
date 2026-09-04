import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../../fixtures/finto-supabase'
import { SEDE_A, SEDE_B, SEDE_C } from '../../fixtures/sedi'

// =============================================================================
// QUANDO UN BAMBINO CAMBIA PLESSO, L'ACCOUNT DI SUO PADRE RESTA NEL VECCHIO.
//
// `utenti.scuola_id` è NOT NULL ed è DERIVATO dai figli (vedi `sedeDelGenitore`),
// ma finora nessuno lo ricalcolava: il trasferimento sposta l'alunno e lascia
// l'account del genitore agganciato al plesso di partenza. Quella colonna non è
// cosmetica — è la sede con cui vengono registrate la richiesta GDPR di
// cancellazione e la notifica dei moduli firmati — quindi un genitore rimasto
// indietro riceve dal plesso sbagliato, e la segreteria di arrivo non lo vede.
//
// IL CASO CHE CONTA PIÙ DI TUTTI È QUELLO IN CUI NON SI FA NIENTE. Due figli in
// due plessi è la condizione che il prodotto DEVE permettere: lì non esiste una
// sede giusta, e sceglierne una a caso è peggio che lasciare quella di prima.
// `sedeDelGenitore` risponde `ambigua`, e `ambigua` NON è un errore: è la
// risposta corretta, e va scritta nei log come tale.
//
// `parents` NON ha una colonna sede e non deve averla: la sede di un genitore è
// una proprietà dei suoi figli, e i suoi figli possono stare in due posti.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import { riallineaSedeGenitori } from '@/lib/anagrafiche/riallinea-sede-genitori'

/** Un genitore (account `u1`, anagrafica `p1`) con un figlio che ORA sta in SEDE_B,
 *  mentre il suo account di login è ancora agganciato a SEDE_A. */
function dbBase(): DBFinto {
  return {
    utenti: [{ id: 'u1', ruolo: 'genitore', scuola_id: SEDE_A, nome: 'Mario', cognome: 'Rossi', email: 'mario@example.test' }],
    parents: [{ id: 'p1', auth_user_id: 'u1', first_name: 'Mario', last_name: 'Rossi' }],
    student_parents: [{ parent_id: 'p1', student_id: 'al-1', alunni: { scuola_id: SEDE_B } }],
    legame_genitori_alunni: [],
  }
}

function client(db: DBFinto, scritture: Scrittura[] = [], errori?: Record<string, { code: string; message?: string }>): SupabaseClient {
  return creaFintoSupabase(db, [], { scritture, errori }) as unknown as SupabaseClient
}

/** Le righe di log emesse da QUESTO modulo, riconosciute per `esito`. */
const logDi = (esito: string) =>
  logEvento.mock.calls.find((c) => (c[2] as { esito?: string })?.esito === esito)

/** Solo le scritture su `utenti`: il resto del fixture non ci interessa. */
const scrittureUtenti = (s: Scrittura[]) => s.filter((x) => x.tabella === 'utenti')

beforeEach(() => vi.clearAllMocks())

describe('riallineaSedeGenitori · il caso che conta è quello in cui NON si scrive', () => {
  it('DUE FIGLI IN DUE PLESSI ⇒ non tocca niente, e lo dice a livello `info`', async () => {
    // Non è un guasto e non è un caso limite: è la condizione che l'utente ci ha
    // chiesto di permettere. Scegliere una delle due sedi sarebbe inventare un
    // dato; lasciare quella di prima è l'unica cosa onesta da fare.
    const db = dbBase()
    db.student_parents = [
      { parent_id: 'p1', student_id: 'al-1', alunni: { scuola_id: SEDE_B } },
      { parent_id: 'p1', student_id: 'al-2', alunni: { scuola_id: SEDE_C } },
    ]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1', 'al-2'])

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(db.utenti[0].scuola_id).toBe(SEDE_A)
    expect(esito).toMatchObject({ aggiornati: 0, ambigui: 1 })

    const riga = logDi('sede-genitore-ambigua-non-toccata')
    expect(riga).toBeDefined()
    // `info`, non `warn`: un warn su una condizione LEGITTIMA insegna a chi
    // guarda i log a ignorare i warn.
    expect(riga?.[1]).toBe('info')
    // Il motivo viaggia su `stato`, che è in lista bianca. Su `motivo` — che è in
    // lista NERA perché di solito porta testo libero su un minore — uscirebbe
    // `[redatto:str/7]`, cioè la riga direbbe che è successo qualcosa e non cosa.
    expect(riga?.[2]).toMatchObject({ stato: 'ambigua' })
  })

  it('un figlio solo, e ha cambiato plesso ⇒ `utenti.scuola_id` viene riscritto', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1'])

    expect(db.utenti[0].scuola_id).toBe(SEDE_B)
    expect(scrittureUtenti(scritture)).toHaveLength(1)
    expect(esito).toMatchObject({ aggiornati: 1, ambigui: 0 })
    // Il SUCCESSO lascia una riga: con i soli errori, «nessun log» non distingue
    // «tutto a posto» da «non è mai partito niente».
    expect(logDi('sede-genitore-riallineata')?.[1]).toBe('info')
  })

  it('la sede è già quella giusta ⇒ NESSUNA scrittura (o ogni PATCH riscriverebbe tutto)', async () => {
    const db = dbBase()
    db.utenti = [{ id: 'u1', ruolo: 'genitore', scuola_id: SEDE_B }]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1'])

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(esito).toMatchObject({ aggiornati: 0, invariati: 1 })
  })

  it('la sede coincide ma è scritta in MAIUSCOLO ⇒ resta nessuna scrittura', async () => {
    // In Postgres `uuid` è un TIPO: 'BBBB…' e 'bbbb…' sono lo stesso valore. Un
    // confronto fra stringhe direbbe «è cambiata» e riscriverebbe la riga a ogni
    // giro — una UPDATE inutile su dati veri, e un log di successo che mente.
    const db = dbBase()
    db.utenti = [{ id: 'u1', ruolo: 'genitore', scuola_id: SEDE_B.toUpperCase() }]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1'])

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(esito).toMatchObject({ aggiornati: 0, invariati: 1 })
  })

  it('non scrive MAI `utenti.role`: è una colonna generata da `ruolo`', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    await riallineaSedeGenitori(client(db, scritture), ['al-1'])

    const payload = scrittureUtenti(scritture)[0]?.valori[0] ?? {}
    expect(Object.keys(payload)).toEqual(['scuola_id'])
  })

  it('due fratelli, un solo genitore ⇒ una sola UPDATE, non una per figlio', async () => {
    const db = dbBase()
    db.student_parents = [
      { parent_id: 'p1', student_id: 'al-1', alunni: { scuola_id: SEDE_B } },
      { parent_id: 'p1', student_id: 'al-2', alunni: { scuola_id: SEDE_B } },
    ]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1', 'al-2'])

    expect(scrittureUtenti(scritture)).toHaveLength(1)
    expect(esito).toMatchObject({ aggiornati: 1 })
  })

  it('elenco di alunni vuoto ⇒ non interroga NIENTE (nemmeno una query a vuoto)', async () => {
    const tabelle: string[] = []
    const finto = creaFintoSupabase(dbBase(), tabelle) as unknown as SupabaseClient
    const esito = await riallineaSedeGenitori(finto, [])

    expect(tabelle).toEqual([])
    expect(esito).toMatchObject({ aggiornati: 0, invariati: 0, ambigui: 0, saltati: 0 })
  })
})

describe('riallineaSedeGenitori · i guasti non fanno cadere il chiamante, ma si vedono', () => {
  it('genitore senza anagrafica `parents` ⇒ salta e AVVISA, non tira a indovinare', async () => {
    // Legame solo runtime (`legame_genitori_alunni`): l'account esiste, la riga
    // `parents` no. Senza `parents.id` non c'è niente da chiedere a
    // `sedeDelGenitore`, e dedurre la sede dall'alunno scavalcherebbe proprio il
    // controllo dell'ambiguità.
    const db = dbBase()
    db.parents = []
    db.student_parents = []
    db.legame_genitori_alunni = [{ alunno_id: 'al-1', genitore_id: 'u1' }]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1'])

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(esito).toMatchObject({ aggiornati: 0, saltati: 1 })
    expect(logDi('sede-genitore-senza-anagrafica')?.[1]).toBe('warn')
  })

  it('ZERO figli in anagrafica NON è «figli in due plessi»: sono due righe di log diverse', async () => {
    // Il caso reale, e misurato in produzione il 2026-09-03: 19 account con riga
    // `parents` ma almeno un figlio agganciato SOLO per via runtime, e 12 righe
    // `parents` con account e nessun figlio in `student_parents`.
    //
    // I genitori li trova l'UNIONE delle due tabelle ponte; la loro sede la legge
    // `sedeDelGenitore`, che guarda SOLO `student_parents`. Per questo genitore
    // risponde quindi `ambigua` con `sediFigli: []` — cioè con lo stesso `motivo`
    // di chi ha davvero due figli in due plessi, ma per la ragione opposta.
    //
    // Confonderli fa scrivere «figli in più plessi, lasciato di proposito · n: 0»
    // su un genitore che di figli in anagrafica non ne ha NESSUNO: una riga che
    // dice il contrario di quel che è successo, ed è peggio di nessuna riga.
    const db = dbBase()
    db.student_parents = []
    db.legame_genitori_alunni = [{ alunno_id: 'al-1', genitore_id: 'u1' }]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1'])

    // Si continua a NON scrivere: dedurre la sede dal legame runtime è una scelta
    // di prodotto, non una correzione di diagnosi (vedi il commento nel modulo).
    expect(scrittureUtenti(scritture)).toEqual([])
    expect(db.utenti[0].scuola_id).toBe(SEDE_A)

    // Contato fra i SALTATI, non fra gli ambigui: «non ho potuto decidere» non è
    // «ho deciso di non toccare».
    expect(esito).toMatchObject({ aggiornati: 0, ambigui: 0, saltati: 1 })

    // `warn`, non `info`: è una condizione da guardare, non una condizione normale.
    const riga = logDi('sede-genitore-senza-figli-anagrafica')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ stato: 'ambigua', n: 0 })

    // E soprattutto: la riga che direbbe il falso NON esiste.
    expect(logDi('sede-genitore-ambigua-non-toccata')).toBeUndefined()
  })

  it('`sedeDelGenitore` in errore ⇒ nessuna scrittura, e un `warn` con il motivo', async () => {
    // Il genitore lo trova il ramo runtime; è la lettura dei FIGLI a fallire.
    // «Non ho potuto leggere» non è «non ha figli»: sono due cose diverse e la
    // seconda porterebbe a scrivere una sede scelta da qualcun altro.
    const db = dbBase()
    db.legame_genitori_alunni = [{ alunno_id: 'al-1', genitore_id: 'u1' }]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(
      client(db, scritture, { student_parents: { code: 'PGRST301', message: 'jwt expired' } }),
      ['al-1'],
    )

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(db.utenti[0].scuola_id).toBe(SEDE_A)
    expect(esito).toMatchObject({ aggiornati: 0, saltati: 1 })
    const riga = logDi('sede-genitore-non-riallineata')
    expect(riga?.[1]).toBe('warn')
    expect(riga?.[2]).toMatchObject({ stato: 'errore' })
  })

  it('`parents` illeggibile ⇒ non lancia, non scrive, e logga a livello `error`', async () => {
    // PostgREST non lancia: ritorna `{ error }`. Senza controllare il valore di
    // ritorno questo ramo sarebbe un elenco vuoto scambiato per «nessun genitore».
    const db = dbBase()
    db.legame_genitori_alunni = [{ alunno_id: 'al-1', genitore_id: 'u1' }]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(
      client(db, scritture, { parents: { code: '42501', message: 'permission denied' } }),
      ['al-1'],
    )

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(esito).toMatchObject({ aggiornati: 0 })
    expect(logDi('riallineo-anagrafiche-non-lette')?.[1]).toBe('error')
  })

  it('`utenti` illeggibile ⇒ NESSUNA scrittura: senza la sede attuale si riscriverebbe tutto', async () => {
    // Il ramo che protegge dall'UPDATE inutile su dati veri. Senza il controllo
    // del valore di ritorno, `sedeAttuale` resterebbe VUOTA e ogni account
    // verrebbe riscritto anche quando la sede è già quella giusta — e il
    // riepilogo dichiarerebbe `aggiornati: N` su un giro che non ha cambiato
    // niente. PostgREST non lancia: ritorna `{ error }`.
    const db = dbBase()
    db.utenti = [{ id: 'u1', ruolo: 'genitore', scuola_id: SEDE_B }]
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(
      client(db, scritture, { 'utenti:select': { code: '42501', message: 'permission denied' } }),
      ['al-1'],
    )

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(esito).toMatchObject({ aggiornati: 0, invariati: 0, ambigui: 0, saltati: 0 })
    expect(logDi('riallineo-utenti-non-letti')?.[1]).toBe('error')
    // Nessun successo dichiarato su un giro che non è nemmeno cominciato.
    expect(logDi('sede-genitore-riallineata')).toBeUndefined()
  })

  it('l\'UPDATE viene respinta ⇒ `error` nei log, e il chiamante non cade', async () => {
    const db = dbBase()
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(
      client(db, scritture, { 'utenti:update': { code: '23503', message: 'foreign key violation' } }),
      ['al-1'],
    )

    expect(esito).toMatchObject({ aggiornati: 0, saltati: 1 })
    expect(logDi('sede-genitore-non-scritta')?.[1]).toBe('error')
    // E il successo NON è stato dichiarato: un log di riuscita su una scrittura
    // respinta è peggio di nessun log.
    expect(logDi('sede-genitore-riallineata')).toBeUndefined()
  })

  it('nei log non finisce nessun dato personale: uuid, ruoli e conteggi, mai nomi', async () => {
    const db = dbBase()
    await riallineaSedeGenitori(client(db), ['al-1'])

    for (const [, , campi] of logEvento.mock.calls) {
      const testo = JSON.stringify(campi)
      expect(testo).not.toContain('Mario')
      expect(testo).not.toContain('Rossi')
      expect(testo).not.toContain('mario@example.test')
    }
  })

  it('il giro lascia un riepilogo: quanti letti, quanti scritti, quanti lasciati stare', async () => {
    const db = dbBase()
    const riepilogo = await riallineaSedeGenitori(client(db), ['al-1'])
    expect(riepilogo).toMatchObject({ aggiornati: 1 })

    const riga = logDi('riallineo-sedi-genitori')
    expect(riga?.[1]).toBe('info')
    expect(riga?.[2]).toMatchObject({ n: 1, aggiornati: 1 })
  })

  it('nessun genitore collegato ⇒ il riepilogo esce LO STESSO, con `n: 0`', async () => {
    // Uscire in silenzio rende «nessuna riga `riallineo-sedi-genitori`»
    // indistinguibile fra «quell'alunno non ha genitori collegati» e «il riallineo
    // non è mai partito» — che è esattamente l'ambiguità che la regola 5 di
    // AGENTS.md esiste per impedire: con i soli errori, «nessun log» non
    // distingue «tutto ok» da «non è partito niente».
    const db = dbBase()
    db.student_parents = []
    db.legame_genitori_alunni = []
    const scritture: Scrittura[] = []
    const esito = await riallineaSedeGenitori(client(db, scritture), ['al-1'])

    expect(scrittureUtenti(scritture)).toEqual([])
    expect(esito).toMatchObject({ aggiornati: 0, invariati: 0, ambigui: 0, saltati: 0 })

    const riga = logDi('riallineo-sedi-genitori')
    expect(riga).toBeDefined()
    expect(riga?.[1]).toBe('info')
    expect(riga?.[2]).toMatchObject({ n: 0, aggiornati: 0, invariati: 0, ambigui: 0, saltati: 0 })
  })
})
