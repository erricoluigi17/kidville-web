import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SEDE_A } from '../fixtures/sedi'
import type { DBFinto } from '../fixtures/finto-supabase'

// =============================================================================
// `POST /api/admin/legami-familiari` — il ramo «CREA UN ADULTO NUOVO», e la forma
// VERA della sua risposta.
//
// ─── PERCHÉ QUESTO FILE ESISTE ──────────────────────────────────────────────
//
// La schermata legge `anagrafica` e `runtime` per decidere che cosa dire
// all'operatore. Su questo ramo la risposta NON è quella che il nome delle due
// chiavi lascerebbe supporre, e per due giri nessuno l'aveva misurata: il doppio
// della fetch nel test di interfaccia fingeva `anagrafica: 'creata', runtime:
// 'creato'`, una coppia che la rotta su questo ramo non produce mai. È la
// trappola che questo repo ha già pagato con Aruba — «il mock inventa il
// contratto del fornitore» — e si chiude in un modo solo: esercitando la rotta
// vera e fissando quello che risponde davvero.
//
// ─── CHE COSA RISPONDE, E PERCHÉ ────────────────────────────────────────────
//
//   POST { azione:'collega', alunno_id, relation_type, genitore:{…} }
//     con email    → { anagrafica: 'gia-presente', runtime: 'gia-presente' }
//     senza email  → { anagrafica: 'gia-presente', runtime: 'senza-account' }
//
// `anagrafica: 'gia-presente'` ANCHE QUANDO L'ANAGRAFICA È NATA IN QUESTA STESSA
// RICHIESTA, e la catena è questa: la rotta delega a `linkOrCreateParent`, che al
// suo punto 3 fa l'upsert su `student_parents` (`src/lib/anagrafiche/parents.ts`);
// subito dopo la rotta chiama `collegaFamiliare`, che legge la stessa riga
// (`legameAnagrafico`), la trova, e quindi non la conta come creata. Non è un
// difetto della rotta — il legame *c'è*, che è ciò che l'operatore ha chiesto —
// ma è un fatto che l'interfaccia deve conoscere: senza, «Questo legame c'era
// già: non è stato aggiunto niente di nuovo» compare esattamente dopo aver
// creato un'anagrafica e, con un'email, spedito credenziali vere a una famiglia
// vera.
//
// ─── PERCHÉ STA IN UN FILE SUO ──────────────────────────────────────────────
//
// Il posto naturale sarebbe `legami-familiari-due-tabelle.test.ts`, che collauda
// le altre azioni della stessa rotta. Non ci sta perché quel file appartiene al
// primo stadio di questo lavoro e non è nel perimetro di chi scrive qui: nove
// agenti lavorano sullo stesso albero, e scrivere fuori dal proprio perimetro
// sovrascrive il lavoro altrui. Il nome porta `legami-familiari-ui` perché è la
// forma su cui l'interfaccia poggia — quando i due file si riuniranno, questi due
// casi vanno là dentro.
//
// ⚠️ REPOSITORY PUBBLICO: uuid finti, nomi palesemente inventati, indirizzi sul
// TLD riservato `.invalid`. Da qui passano anagrafiche di minori.
// =============================================================================

const ID_SEGRETERIA = 'aaaa0000-0000-4000-8000-0000000000f1'
const ALUNNO = 'aaaa1111-0000-4000-8000-0000000000a1'
/** Il secondo bambino della stessa sede: serve a dare un plesso all'adulto già in archivio. */
const ALUNNO_2 = 'aaaa1111-0000-4000-8000-0000000000a2'
/** L'account che l'identità di accesso creerebbe: qui lo scrive il doppio (vedi sotto). */
const ACCOUNT_NUOVO = 'aaaa3333-0000-4000-8000-0000000000d9'
/** L'adulto che in archivio c'è già, per il controllo positivo dell'ultimo test. */
const PARENT_IN_ARCHIVIO = 'aaaa2222-0000-4000-8000-0000000000c1'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  logEvento: vi.fn(),
  db: {} as Record<string, Record<string, unknown>[]>,
  tabelle: [] as string[],
  /**
   * Errori PostgREST iniettati per `"<tabella>:<operazione>"`. Vuoto = nessun guasto.
   *
   * `code` è OBBLIGATORIO (`ErrorePostgrest` del fixture) e non è pedanteria del
   * tipo: è il campo su cui `legami-scrittura.ts` distingue un guasto vero da un
   * `23505` («qualcun altro ha appena scritto lo stesso legame»), quindi un errore
   * iniettato senza codice collauderebbe un ramo che in produzione non esiste.
   */
  errori: {} as Record<string, { code: string; message?: string }>,
  /**
   * Il doppio dell'IDENTITÀ DI ACCESSO, e solo quando un test lo arma: a `null`
   * gira la funzione VERA.
   *
   * È l'unico collaboratore che un finto client non può servire: crea l'utente in
   * `auth.users` passando da `admin.auth.admin.createUser`, che nel finto client
   * non esiste (e che, se esistesse, sarebbe il finto client a decidere l'esito —
   * cioè il collaudo si sposterebbe sul fixture). Il caso «senza email» gira
   * quindi sulla funzione reale, che lì non tocca affatto `auth`.
   */
  identitaFinta: null as null | ((admin: SupabaseClient, parent: { id: string }) => Promise<unknown>),
}))

// Solo `logEvento` è sostituito: il resto del modulo di logging resta REALE,
// perché `withRoute` ne usa altri pezzi.
vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return { ...reale, logEvento: (...a: unknown[]) => h.logEvento(...a) }
})

vi.mock('@/lib/auth/require-staff', async (originale) => {
  const reale = await originale<typeof import('@/lib/auth/require-staff')>()
  return { ...reale, requireStaff: h.requireStaff }
})

vi.mock('@/lib/auth/parent-identity', async (originale) => {
  const reale = await originale<typeof import('@/lib/auth/parent-identity')>()
  return {
    ...reale,
    ensureParentIdentity: async (
      admin: Parameters<typeof reale.ensureParentIdentity>[0],
      parent: Parameters<typeof reale.ensureParentIdentity>[1],
      opts?: Parameters<typeof reale.ensureParentIdentity>[2],
    ) => (h.identitaFinta ? h.identitaFinta(admin, parent) : reale.ensureParentIdentity(admin, parent, opts)),
  }
})

vi.mock('@/lib/supabase/server-client', async () => {
  const { creaFintoSupabase } = await import('../fixtures/finto-supabase')
  return {
    createAdminClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
    createClient: async () => creaFintoSupabase(h.db, h.tabelle, { errori: h.errori }),
  }
})

import { POST } from '@/app/api/admin/legami-familiari/route'

const dbBase = (): DBFinto => ({
  utenti: [{ id: ID_SEGRETERIA, ruolo: 'segreteria', scuola_id: SEDE_A }],
  utenti_scuole: [],
  utenti_sezioni: [],
  alunni: [
    { id: ALUNNO, scuola_id: SEDE_A, nome: 'Bambino', cognome: 'Uno', stato: 'iscritto', section_id: null, classe_sezione: '3 ANNI A' },
    { id: ALUNNO_2, scuola_id: SEDE_A, nome: 'Bambino', cognome: 'Due', stato: 'iscritto', section_id: null, classe_sezione: '3 ANNI A' },
  ],
  // Si parte da ZERO adulti: tutto quello che finisce in queste tre tabelle lo
  // scrive la richiesta sotto collaudo, e questo è ciò che rende leggibili le
  // lunghezze asserite più avanti.
  parents: [],
  student_parents: [],
  legame_genitori_alunni: [],
  audit_scritture_docente: [],
})

function richiesta(body: Record<string, unknown>): Request {
  return {
    url: 'http://localhost/api/admin/legami-familiari',
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Request
}

const post = (body: Record<string, unknown>) => POST(richiesta(body))

/** L'adulto che non è in archivio, così come lo manda il dialogo «crea un adulto nuovo». */
const adultoNuovo = (email: string | null) => ({
  first_name: 'Adulta',
  last_name: 'Diprova',
  fiscal_code: '',
  emails: email ? [email] : [],
  phones: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  h.db = dbBase()
  h.tabelle = []
  h.errori = {}
  h.identitaFinta = null
  h.requireStaff.mockResolvedValue({
    user: { id: ID_SEGRETERIA, role: 'segreteria', ruolo: 'segreteria', scuola_id: SEDE_A },
  })
})

describe('POST collega — il ramo «crea un adulto nuovo» risponde SEMPRE `gia-presente`', () => {
  it('⚠️ senza email: l’anagrafica NASCE ADESSO e la risposta la chiama `gia-presente`', async () => {
    // `linkOrCreateParent` e `ensureParentIdentity` sono entrambi VERI: senza
    // email il secondo esce subito con `no_email` e non tocca `auth`, quindi
    // questa è la catena di produzione dal primo all'ultimo anello.
    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO,
      relation_type: 'mother',
      genitore: adultoNuovo(null),
    })

    expect(res.status).toBe(200)
    const corpo = await res.json()

    // 1. L'anagrafica È STATA CREATA in questa richiesta: si parte da zero righe.
    expect(h.db.parents).toHaveLength(1)
    expect(h.db.parents[0]).toMatchObject({ first_name: 'Adulta', last_name: 'Diprova' })
    // 2. E il legame pure — scritto da `linkOrCreateParent`, non da `collegaFamiliare`.
    expect(h.db.student_parents).toHaveLength(1)
    expect(h.db.student_parents[0]).toMatchObject({ student_id: ALUNNO, relation_type: 'mother' })

    // 3. …e nonostante i due punti qui sopra, la rotta dice `gia-presente`.
    //    È QUESTA l'asserzione che l'interfaccia deve conoscere: leggerla come
    //    «c'era già» annuncia che non è stato fatto niente proprio dopo aver
    //    creato un'anagrafica.
    expect(corpo).toMatchObject({ anagrafica: 'gia-presente', runtime: 'senza-account' })
    expect(corpo.anagrafica).not.toBe('creata')
  })

  it('⚠️ con email (identità creata): `gia-presente` su ENTRAMBE, e il legame runtime esiste', async () => {
    // Il doppio fa ciò che fa la funzione vera nel caso riuscito, e nient'altro:
    // scrive il ponte `parents.auth_user_id`. Tutto il resto — l'upsert su
    // `student_parents`, `sincronizzaLegamiRuntime`, `collegaFamiliare` — resta
    // codice di produzione, ed è lui a produrre la coppia asserita qui sotto.
    // I tre flag a `false` tengono spento l'invio delle credenziali: qui si
    // misura la forma di una risposta, non si spedisce una email.
    h.identitaFinta = async (admin, parent) => {
      await admin.from('parents').update({ auth_user_id: ACCOUNT_NUOVO }).eq('id', parent.id)
      return {
        ok: true,
        authUserId: ACCOUNT_NUOVO,
        email: 'adulta.diprova@example.invalid',
        createdAuth: false,
        createdUtenti: false,
        boundNow: false,
        password: null,
        scuolaId: SEDE_A,
        indirizzo: null,
      }
    }

    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO,
      relation_type: 'father',
      genitore: adultoNuovo('adulta.diprova@example.invalid'),
    })

    expect(res.status).toBe(200)
    const corpo = await res.json()

    // Il legame è stato scritto su ENTRAMBE le tabelle vive…
    expect(h.db.student_parents).toHaveLength(1)
    expect(h.db.legame_genitori_alunni).toHaveLength(1)
    expect(h.db.legame_genitori_alunni[0]).toMatchObject({ alunno_id: ALUNNO, genitore_id: ACCOUNT_NUOVO })
    // …e la risposta dice `gia-presente` su tutte e due, perché a scriverle è
    // stato `linkOrCreateParent` un istante prima che `collegaFamiliare` le
    // guardasse. È la coppia esatta che arriva all'interfaccia in produzione.
    expect(corpo).toMatchObject({ anagrafica: 'gia-presente', runtime: 'gia-presente' })
    expect(corpo.anagrafica).not.toBe('creata')
    expect(corpo.runtime).not.toBe('creato')
  })

  it('⚠️ col CF di un adulto GIÀ COLLEGATO non si scrive NIENTE — e la risposta dice CHI', async () => {
    // IL CASO CHE `anagrafica` NON PUÒ RACCONTARE, e la ragione per cui
    // l'interfaccia guarda l'uuid invece della coppia di parole.
    //
    // Qui l'operatore apre «crea un adulto nuovo» e digita il codice fiscale di
    // un adulto che a quel bambino È GIÀ COLLEGATO: `linkOrCreateParent`
    // deduplica al suo punto 1, l'upsert del punto 3 trova la riga e non ne
    // aggiunge una, `collegaFamiliare` la rilegge e la chiama `gia-presente` —
    // esattamente come quando l'anagrafica l'ha appena creata lui. Le due
    // situazioni escono dalla rotta con lo STESSO `anagrafica`, e sono opposte:
    // là è nata una famiglia in archivio, qui non è successo niente.
    //
    // A distinguerle resta `parentId`: l'adulto su cui la scrittura è finita.
    // Chi era già collegato lo sa la schermata, che l'elenco ce l'ha davanti.
    const CF_CONDIVISO = 'BBBBBB00B00B000B'
    h.db.parents = [
      { id: PARENT_IN_ARCHIVIO, auth_user_id: null, first_name: 'Adulto', last_name: 'Inarchivio', fiscal_code: CF_CONDIVISO, emails: [] },
    ]
    h.db.student_parents = [
      { student_id: ALUNNO, parent_id: PARENT_IN_ARCHIVIO, relation_type: 'father', is_primary: true, alunni: { scuola_id: SEDE_A } },
    ]

    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO,
      relation_type: 'mother',
      genitore: { ...adultoNuovo(null), fiscal_code: CF_CONDIVISO },
    })

    expect(res.status).toBe(200)
    const corpo = await res.json()

    // 1. NESSUNA anagrafica nuova: il CF ha deduplicato sull'adulto che c'era.
    expect(h.db.parents).toHaveLength(1)
    expect(h.db.parents[0]!.id).toBe(PARENT_IN_ARCHIVIO)
    // 2. NESSUN legame nuovo: la riga resta una.
    //    (Sul `relation_type` non si asserisce niente: l'upsert vero passa
    //    `ignoreDuplicates: true` e la riga esistente non la tocca, mentre il
    //    finto client ci fa sopra un `Object.assign`. Asserire in un verso o
    //    nell'altro fisserebbe un comportamento del fixture, non della rotta.)
    expect(h.db.student_parents).toHaveLength(1)
    // 3. …e la risposta è indistinguibile da quella dell'anagrafica appena creata.
    expect(corpo).toMatchObject({ anagrafica: 'gia-presente' })

    // 4. QUESTA è l'informazione che resta, ed è quella su cui poggia la
    //    schermata: l'uuid dell'adulto, in CAMMELLO come lo scrive
    //    `collegaFamiliare` (il blocco «IL CONTRATTO» della rotta lo chiama
    //    `parent_id`: la prosa e il codice divergono, e qui vince il codice).
    //    Una rinomina di questa chiave rende muta `avvisoDaEsito` e va vista qui.
    expect(corpo.parentId).toBe(PARENT_IN_ARCHIVIO)
    expect(Object.keys(corpo)).toContain('parentId')
  })

  it('il controllo positivo: scegliendo un adulto GIÀ IN ARCHIVIO `creata` esce eccome', async () => {
    // Senza questo caso i due test qui sopra sarebbero verdi anche su una rotta
    // che risponde `gia-presente` sempre e comunque, e la riserva
    // `modo === 'ricerca'` dell'interfaccia non proteggerebbe niente: è il ramo
    // della RICERCA l'unico in cui `anagrafica` distingue davvero i due casi.
    //
    // L'adulto arriva con un figlio già suo (`ALUNNO_2`): è da lì che
    // `assertParentInScope` deduce il suo plesso — `parents` una colonna di sede
    // non ce l'ha, e non deve averla.
    h.db.parents = [
      { id: PARENT_IN_ARCHIVIO, auth_user_id: null, first_name: 'Adulto', last_name: 'Inarchivio', fiscal_code: 'AAAAAA00A00A000A', emails: [] },
    ]
    h.db.student_parents = [
      {
        student_id: ALUNNO_2,
        parent_id: PARENT_IN_ARCHIVIO,
        relation_type: 'father',
        is_primary: true,
        // Il finto client NON costruisce i join dalla stringa di `select()`:
        // l'oggetto annidato lo mette il fixture (sta scritto nella sua testata).
        alunni: { scuola_id: SEDE_A },
      },
    ]

    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO,
      parent_id: PARENT_IN_ARCHIVIO,
      relation_type: 'delegate',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ anagrafica: 'creata', runtime: 'senza-account' })
    // Il legame nuovo si aggiunge a quello che c'era: non lo sostituisce.
    expect(h.db.student_parents).toHaveLength(2)
  })
})

describe('POST collega — quando su questo ramo qualcosa va storto, la rotta DICE che l’adulto può esistere', () => {
  /**
   * ⚠️ QUESTO È IL LOCK SU CUI POGGIA `testoDelRifiuto` DEL DIALOGO.
   *
   * `DialogoAggiungiLegame` sostituisce la frase del server con la propria — «non
   * ripetere la creazione, chiudi e controlla se l'adulto è nell'elenco» — e la
   * riserva è UN CODICE: `LEGAME_ADULTO_FORSE_CREATO`. Fino al 2026-09-06 era
   * invece una deduzione della schermata (`modo === 'nuovo' && stato >= 500`), che
   * copriva anche i 500 in cui non è nato niente e diceva a chi doveva riprovare
   * di non riprovare.
   *
   * Spostare la riserva sul codice è più vero solo finché la rotta quel codice lo
   * manda: senza questa prova, il giorno in cui tornasse a rispondere
   * `LEGAME_NON_SALVATO` su questo ramo la schermata direbbe di nuovo «niente è
   * stato modificato» a un operatore che ha appena creato un'anagrafica e spedito
   * credenziali — col gate verde, perché il doppio della fetch nel test di
   * interfaccia il codice se lo sceglie da sé.
   */
  it('⚠️ 500 `LEGAME_ADULTO_FORSE_CREATO`, e non `LEGAME_NON_SALVATO`: l’anagrafica È nata', async () => {
    // Il guasto è mirato al SOLO `select` su `student_parents`, che su questo
    // percorso è la prima lettura di `collegaFamiliare` (`legameAnagrafico`):
    // `linkOrCreateParent` quella tabella la tocca in `upsert` e mai in lettura,
    // quindi arriva in fondo e l'anagrafica la scrive davvero. È l'ordine esatto
    // che rende il caso pericoloso in produzione.
    h.errori = { 'student_parents:select': { code: '42501', message: 'permission denied' } }

    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO,
      relation_type: 'mother',
      genitore: adultoNuovo(null),
    })

    expect(res.status).toBe(500)
    const corpo = await res.json()
    expect(corpo.codice).toBe('LEGAME_ADULTO_FORSE_CREATO')
    expect(corpo.codice).not.toBe('LEGAME_NON_SALVATO')
    // …e la prosa non promette il contrario di ciò che è successo.
    expect(String(corpo.error)).not.toMatch(/niente è stato modificato/i)

    // LA MISURA CHE RENDE IL CODICE VERO, e non una parola scelta bene:
    // l'anagrafica dell'adulto ESISTE, scritta da questa stessa richiesta che ha
    // risposto 500. Ripetere il modulo ne creerebbe una seconda.
    expect(h.db.parents).toHaveLength(1)
    expect(h.db.parents[0]).toMatchObject({ first_name: 'Adulta', last_name: 'Diprova' })
    // E il ramo esercitato è QUELLO: `linkOrCreateParent` è arrivato in fondo —
    // la riga di legame che scrive lui c'è — quindi il rifiuto viene da
    // `collegaFamiliare` e non dal `catch` che avvolge la creazione. I due
    // rispondono lo stesso codice, e senza questa riga la prova non saprebbe
    // dire quale dei due ha misurato.
    expect(h.db.student_parents).toHaveLength(1)
  })

  it('il controllo positivo: senza guasto lo stesso corpo esce 200 (altrimenti la prova qui sopra è vuota)', async () => {
    // Senza questo caso, un errore iniettato che facesse fallire la richiesta
    // MOLTO prima — un 403 di scope, un 400 di zod — darebbe lo stesso «non è
    // `LEGAME_NON_SALVATO`», e la prova qui sopra sarebbe verde senza aver mai
    // esercitato il ramo che dichiara di esercitare.
    const res = await post({
      azione: 'collega',
      alunno_id: ALUNNO,
      relation_type: 'mother',
      genitore: adultoNuovo(null),
    })

    expect(res.status).toBe(200)
    expect(h.db.parents).toHaveLength(1)
  })
})
