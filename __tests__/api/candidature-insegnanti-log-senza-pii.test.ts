import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'

// =============================================================================
// I LOG della candidatura non portano fuori la persona che si è candidata.
//
// `app_log` si conserva 30 giorni ed è interrogabile in SQL: è il canale meno
// sorvegliato e più letto del progetto. Qui il dato non è di un minore, ma è
// comunque quello di un adulto che sta cercando lavoro — e il fatto stesso che
// una persona si sia proposta a questa scuola può costarle il posto che ha.
//
// La difesa vera è `redact()`, che è a LISTA BIANCA per chiave. Questo file
// prova la riga PRIMA della redazione, cioè quello che la route decide di
// mettere nel contesto: una lista bianca che non deve mai entrare in funzione è
// più solida di una che salva il codice tutti i giorni. Se un domani qualcuno
// aggiungesse `email` ai campi «perché sarebbe comodo vederla», qui diventa
// rosso — e non nel giorno in cui qualcuno legge la tabella.
//
// Sono provati TUTTI i rami che loggano: felice, honeypot, campi non validi,
// consensi mancanti, duplicato, tabella assente, colonna assente, errore.
// =============================================================================

const h = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  erroreInsert: null as { code?: string; message?: string } | null,
  sedi: [] as { id: string; nome: string }[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  /**
   * Ogni chiamata a `logErrore`, con i suoi argomenti INTERI.
   *
   * Prima qui c'era `logErrore: () => {}`, e il caso «il `message` del database
   * resta fuori dai campi del log» interrogava soltanto `h.eventi`: cioè provava
   * che un messaggio con dentro l'email non finisse in una funzione che quel
   * messaggio non riceve mai. L'asserzione sarebbe rimasta verde qualunque cosa
   * `logErrore` avesse fatto dell'errore — e `logErrore` lo passa a
   * `persisti({ messaggio })`, cioè dentro `app_log`.
   */
  errori: [] as { dati: unknown; errore: unknown }[],
}))

vi.mock('@/lib/security/rate-limit', () => ({
  rateLimit: async () => ({ ok: true, remaining: 2, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.7',
}))

vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
    logErrore: (dati: unknown, errore: unknown) => {
      h.errori.push({ dati, errore })
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(tabella: string) {
      if (tabella === 'schools' || tabella === 'scuole') {
        const b: Record<string, unknown> = {}
        b.select = () => b
        b.order = () => b
        b.in = () => b
        b.then = (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: h.sedi.map((s) => ({ ...s, attiva: true })), error: null }).then(res)
        return b
      }
      const b: Record<string, unknown> = {}
      let scrittura = false
      b.insert = (row: Record<string, unknown>) => {
        scrittura = true
        h.inserts.push(row)
        return b
      }
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.limit = () => b
      b.order = () => b
      b.single = async () =>
        h.erroreInsert && h.inserts.length === 1
          ? { data: null, error: h.erroreInsert }
          : { data: { id: 'cand-nuova' }, error: null }
      b.maybeSingle = async () =>
        scrittura ? { data: { id: 'cand-nuova' }, error: null } : { data: { id: 'cand-gia-viva' }, error: null }
      return b
    },
  }),
}))

vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => []) }))

import { POST } from '@/app/api/iscrizione/insegnanti/route'
import { redact, redactInput } from '@/lib/logging/redact'
import { descriviErrore } from '@/lib/logging/serialize'
import { INSEGNANTE_FIELDS } from '@/lib/forms/insegnanti-template'

/**
 * L'uuid dentro il percorso del curriculum.
 *
 * Sta in una costante perché è la parte del percorso che va cercata nei log da
 * sola: dal 2026-08-15 il nome del file non sopravvive più al caricamento
 * (`candidature/<uuid>-cv.<est>`), quindi l'unica cosa che identifica il
 * curriculum di una persona è l'uuid — ed è anche la chiave con cui il cockpit
 * lo fa firmare.
 */
const UUID_CV = '0f5f1f2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f'

/**
 * I dati personali che il modulo raccoglie, ognuno con un valore RICONOSCIBILE.
 * Sono inventati: il repository è pubblico.
 */
const PII = {
  nome: 'Ines',
  cognome: 'Cognomericonoscibile',
  email: 'ines.cognomericonoscibile@example.invalid',
  telefono: '+39 333 1112223',
  residence_city: 'Comunericonoscibile',
  note: 'Ho lavorato dieci anni in un nido e vorrei tornare a insegnare.',
  // ⚠️ IL PERCORSO È NELLA FORMA CHE LA ROUTE AMMETTE, e la forma è cambiata due
  // volte in cinque giorni.
  //
  // Qui c'era `form_attachments/curriculum-cognomericonoscibile.pdf`, cioè un
  // valore che dal 2026-08-10 la route RESPINGE con 400: `cv_path` arriva da una
  // richiesta anonima ed è la chiave con cui il cockpit fa firmare un oggetto
  // dello Storage. Poi c'è stato `candidature/<uuid>-curriculum-<cognome>.pdf`,
  // respinto a sua volta dal 2026-08-15: `costruisciPercorsoCv` non conserva più
  // niente del nome mandato dal browser, e la forma ammessa è
  // `candidature/<uuid>-cv.<estensione>` e nient'altro. Ogni volta che questo
  // valore resta indietro, il file continua a «passare» misurando i log del ramo
  // di RIFIUTO invece di quelli dei rami che dice di misurare — un collaudo verde
  // su un percorso che il prodotto non esegue più.
  //
  // Il cognome adesso nel percorso non c'è (è la ragione per cui il nome è stato
  // buttato via: su questa porta il file si chiama `cv-<cognome>.pdf`), e il
  // percorso resta comunque una cosa da tenere fuori dai log — è la chiave con
  // cui si firma il curriculum di una persona, e `redact()` non la ha in lista
  // bianca.
  cv_path: `candidature/${UUID_CV}-cv.pdf`,
  titolo_dettaglio: 'Scienze dell’educazione, Istituto Riconoscibile',
  // Il campo nato il 2026-08-15, e l'unico testo LIBERO che questo modulo abbia
  // guadagnato: la casella accanto ad «Altro». Qui viaggia sempre — la
  // candidatura di prova non spunta «Altro», quindi il campo è nascosto e in
  // tabella entra `null` — ma nel CORPO GREZZO c'è, ed è da lì che `parseBody`
  // lo deposita nel contesto prima che zod l'abbia guardato.
  posizione_altro: 'Mestierericonoscibile',
}

const candidatura = (extra: Record<string, unknown> = {}) => ({
  ...PII,
  residence_province: 'NA',
  titolo_studio: 'laurea_triennale',
  anni_esperienza: 10,
  // `posizioni` e non più `gradi`: dal 2026-08-15 lo zod della rotta pretende
  // questo campo, e le fasce le deriva la route da qui.
  posizioni: ['insegnante_nido'],
  disponibilita: 'tempo_pieno',
  presa_visione_informativa: true,
  ...extra,
})

const invia = (corpo: Record<string, unknown>) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione/insegnanti', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify(corpo),
    }),
  )

beforeEach(() => {
  vi.clearAllMocks()
  h.inserts = []
  h.erroreInsert = null
  h.sedi = [{ id: SEDE_A, nome: NOME_SEDE_A }]
  h.eventi = []
  h.errori = []
})

/**
 * Tutto ciò che la route ha depositato nei log, nella forma in cui il logger lo
 * SCRIVEREBBE — non nella forma in cui lo riceve.
 *
 * La differenza è l'unica cosa che rende questo file una prova. Gli eventi
 * (`logEvento`) portano campi strutturati, e lì il presidio è `redact()`. Gli
 * errori (`logErrore`) portano l'errore VERO, il cui `message` su un `23505` di
 * Postgres contiene l'indirizzo per costruzione: asserire sull'oggetto grezzo
 * sarebbe rosso sempre e non proverebbe niente, asserire di non averlo mai
 * guardato — com'era prima, con `logErrore: () => {}` — è verde sempre e prova
 * ancora meno. La difesa sta in mezzo: `descriviErrore` → `sanificaMessaggio`,
 * che è la funzione REALE che il logger applica prima di `persisti`.
 */
const testoDeiLog = () =>
  JSON.stringify({
    eventi: h.eventi,
    errori: h.errori.map((e) => ({ campi: e.dati, descritto: descriviErrore(e.errore) })),
  })

function nessunaPii(dove: string): void {
  const testo = testoDeiLog()
  // La chiocciola: nessun indirizzo email, in nessuna forma.
  expect(testo, `${dove}: un log contiene una chiocciola`).not.toContain('@')
  for (const [campo, valore] of Object.entries(PII)) {
    // I valori sono scelti apposta perché non compaiano per caso.
    expect(testo, `${dove}: il log contiene il campo «${campo}»`).not.toContain(String(valore))
  }
  // E nemmeno frammenti: il cognome, il comune, l'uuid del curriculum (che dopo
  // la rimozione del nome dal percorso è l'unica cosa che quel file identifica, e
  // basta da solo a farlo firmare) e le cifre centrali del telefono.
  for (const frammento of ['Cognomericonoscibile', 'Comunericonoscibile', UUID_CV, '333 111']) {
    expect(testo, `${dove}: il log contiene «${frammento}»`).not.toContain(frammento)
  }
}

describe('i log della candidatura non portano fuori la persona', () => {
  it('la route ha davvero loggato qualcosa (se cade, questo file non sta provando niente)', async () => {
    await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    expect(h.eventi.some((e) => e.evento === 'candidatura')).toBe(true)
  })

  it('ramo FELICE', async () => {
    await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    nessunaPii('felice')
  })

  it('ramo HONEYPOT', async () => {
    await invia({ scuole_ids: [SEDE_A], data: candidatura(), sito_web: 'http://spam.invalid' })
    nessunaPii('honeypot')
  })

  it('ramo CAMPI NON VALIDI (il campo si nomina, il valore no)', async () => {
    await invia({ scuole_ids: [SEDE_A], data: candidatura({ residence_province: 'XY' }) })
    nessunaPii('campi-non-validi')
    // Il campo va nominato: senza, il warn non dice cosa correggere.
    expect(testoDeiLog()).toContain('residence_province')
    // …ma il VALORE respinto non entra.
    expect(testoDeiLog()).not.toContain('"XY"')
  })

  it('ramo CONSENSI MANCANTI', async () => {
    await invia({ scuole_ids: [SEDE_A], data: candidatura({ presa_visione_informativa: false }) })
    nessunaPii('consensi')
  })

  it('ramo SEDE NON VALIDA', async () => {
    await invia({ scuole_ids: ['99999999-0000-4000-8000-000000000099'], data: candidatura() })
    nessunaPii('sede')
  })

  it('ramo DUPLICATO (23505): la chiave del doppione È l’email, e non deve uscire', async () => {
    h.erroreInsert = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "candidature_insegnanti_email_viva" ' +
        'Key (lower(email))=(ines.cognomericonoscibile@example.invalid) already exists.',
    }
    const res = await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    expect(res.status).toBe(201)
    // Il `message` di Postgres sul 23505 contiene l'indirizzo PER COSTRUZIONE:
    // è il caso in cui rimandarlo nel log costerebbe l'email di una maestra.
    nessunaPii('duplicato')
  })

  it('ramo CV_PATH RESPINTO: il percorso rifiutato non entra nei log', async () => {
    // Il ramo nuovo del 2026-08-10, e quello con il rischio più concentrato: il
    // valore respinto è testo libero scritto da un anonimo, e il nome del file di
    // un curriculum è quasi sempre il nome di una persona. Si registra CHE è
    // stato respinto — `cv-path-non-ammesso` — non che cosa era.
    await invia({
      scuole_ids: [SEDE_A],
      data: candidatura({ cv_path: 'iscrizioni/generico/carta-identita-cognomericonoscibile.pdf' }),
    })
    expect(h.eventi.some((e) => e.campi.esito === 'cv-path-non-ammesso')).toBe(true)
    nessunaPii('cv-path-non-ammesso')
    // E nemmeno il prefisso del bucket dei documenti dei minori: sarebbe il
    // frammento da cui si capisce quale porta qualcuno stava provando.
    expect(testoDeiLog()).not.toContain('carta-identita')
  })

  it('ramo TABELLA ASSENTE (503)', async () => {
    h.erroreInsert = { code: 'PGRST205', message: 'relation "candidature_insegnanti" does not exist' }
    await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    nessunaPii('tabella-assente')
  })

  it('ramo COLONNA ASSENTE (ritento)', async () => {
    h.erroreInsert = {
      code: 'PGRST204',
      message: "Could not find the 'consents_log' column of 'candidature_insegnanti' in the schema cache",
    }
    await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    nessunaPii('colonna-assente')
  })

  it('ramo ERRORE GENERICO: il `message` del database esce MASCHERATO, non intatto', async () => {
    h.erroreInsert = { code: '42501', message: 'permission denied: ines.cognomericonoscibile@example.invalid' }
    await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    nessunaPii('errore')

    // E la prova che la riga è arrivata a `logErrore`: senza, l'asserzione qui
    // sopra sarebbe verde perché non è successo niente — che è esattamente il
    // modo in cui questo caso passava prima.
    expect(h.errori, 'il 500 non ha loggato nessun errore').toHaveLength(1)
    const descritto = descriviErrore(h.errori[0].errore) as { messaggio: string; codice?: string }
    expect(descritto.messaggio).toContain('[email]')
    expect(descritto.messaggio).not.toContain('cognomericonoscibile@')
    // Il codice SQLSTATE resta: è ciò che serve alle tre di notte.
    expect(descritto.codice).toBe('42501')
  })

  it('il `Key (...)=(...)` del 23505 — dove l’email è la CHIAVE — esce mascherato', async () => {
    // Il `23505` non passa da `logErrore` (si risponde 201), ma il messaggio
    // resta quello che qualunque altro ramo potrebbe rimandare al logger: la
    // maschera si prova sul testo esatto che Postgres produce.
    const grezzo = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "candidature_insegnanti_email_viva" ' +
        'Key (lower(email))=(ines.cognomericonoscibile@example.invalid) already exists.',
    }
    const messaggio = (descriviErrore(grezzo) as { messaggio: string }).messaggio
    expect(messaggio).not.toContain('ines.cognomericonoscibile')
    expect(messaggio).not.toContain('@')
    // Il nome del VINCOLO resta: è l'unica cosa che dice quale unicità è saltata.
    expect(messaggio).toContain('candidature_insegnanti_email_viva')
  })

  it('il CORPO GREZZO depositato da `parseBody` prima di zod non esce in chiaro', async () => {
    // LA LACUNA PIÙ A MONTE, e la difesa che questo file non toccava.
    //
    // `parseBody` fa `impostaPayload('body', raw)` PRIMA di zod: nello slot
    // `payload` del contesto finisce il corpo INTERO della candidatura — nome,
    // cognome, email, telefono, note, percorso del curriculum — e da lì
    // `logErrore` lo porta in `app_log` insieme al 500. La difesa c'è
    // (`impostaPayload` chiama `redactInput`), ma finché nessuno la misurava era
    // una difesa creduta, non provata.
    //
    // `redactInput` e non `redact`: sotto `payload` le chiavi le sceglie chi fa
    // la richiesta, quindi nessuna chiave può aprire la lista bianca. È la
    // differenza che rende `{"esito": "<quello che ti pare>"}` un canale di
    // testo libero verso la tabella, se si sbaglia funzione.
    const corpo = { scuola_id: SEDE_A, data: candidatura(), sito_web: '' }
    const ridotto = JSON.stringify(redactInput(corpo))

    expect(ridotto, 'una chiocciola è uscita dal corpo grezzo').not.toContain('@')
    for (const [campo, valore] of Object.entries(PII)) {
      expect(ridotto, `il corpo grezzo lascia uscire «${campo}»`).not.toContain(String(valore))
    }
    // La sede resta leggibile: è un uuid, ed è ciò che rende diagnosticabile la riga.
    expect(ridotto).toContain(SEDE_A)
  })

  it('l’`esito` dei campi non validi resta LEGGIBILE dopo `redact()` reale, con 6+ campi', async () => {
    // IL TETTO DA 64 CARATTERI, misurato invece che supposto.
    //
    // `redact()` lascia in chiaro il valore di `esito` solo se rispetta
    // `FORMA_ENUMERATO`, che impone al massimo 64 caratteri. Concatenando gli id
    // dei 13 campi del modulo il caso peggiore è lungo 158 e già con sei si
    // arriva a 78: sopra il tetto l'INTERO valore diventa `[redatto:str/N]`, e
    // nel log non resta nemmeno la parola «campi-non-validi» — cioè si perde la
    // classificazione del ramo, non solo il dettaglio.
    //
    // Non è un caso di laboratorio: è il modulo spedito quasi vuoto, che è la
    // forma più comune di invio fallito.
    // Otto campi respinti: i quattro obbligatori lasciati vuoti più quattro
    // facoltativi compilati male. I soli obbligatori sarebbero quattro, cioè
    // sotto il tetto — e un test che si fermasse lì misurerebbe il caso comodo.
    //
    // ⚠️ `posizioni` NON può restare fra i vuoti: è un array e lo zod lo pretende
    // con almeno un elemento, quindi una stringa vuota farebbe uscire la
    // richiesta con un 400 di zod PRIMA di arrivare alla ri-validazione dei
    // campi — cioè questo caso misurerebbe un ramo che non è il suo.
    const vuoti = Object.fromEntries(INSEGNANTE_FIELDS.map((f) => [f.id, '']))
    await invia({
      scuole_ids: [SEDE_A],
      data: {
        ...vuoti,
        posizioni: ['insegnante_nido'],
        presa_visione_informativa: true,
        residence_province: 'XY',
        residence_city: 'x'.repeat(101),
        anni_esperienza: 999,
        disponibilita: 'quando-capita',
      },
    })

    const avviso = h.eventi.find(
      (e) => e.evento === 'candidatura' && String(e.campi.esito ?? '').startsWith('campi-non-validi'),
    )
    expect(avviso, 'il ramo dei campi non validi non ha loggato').toBeTruthy()
    expect(Number(avviso?.campi.n)).toBeGreaterThanOrEqual(6)

    // La misura che conta: dopo la redazione VERA l'esito si legge ancora.
    const dopo = redact({ esito: avviso?.campi.esito }) as { esito: string }
    expect(String(avviso?.campi.esito).length, 'l’esito supera il tetto di `FORMA_ENUMERATO`').toBeLessThanOrEqual(64)
    expect(dopo.esito, 'la classificazione del ramo è stata redatta via').toContain('campi-non-validi')
    expect(dopo.esito).not.toContain('[redatto')
  })

  it('nessuna chiamata a `logEvento` porta una chiave che nomina un dato personale', async () => {
    await invia({ scuole_ids: [SEDE_A], data: candidatura() })
    // `posizioni` e `posizione_altro` sono nell'elenco dal 2026-08-15: la prima
    // dice che lavoro sta cercando una persona, la seconda è testo libero scritto
    // da un anonimo. Il log ne porta il CONTEGGIO (`n_posizioni`) e un booleano
    // (`docente`), che è tutto ciò che serve a chi interroga `app_log`.
    const vietate = [
      'nome',
      'cognome',
      'email',
      'telefono',
      'note',
      'cv_path',
      'residence_city',
      'posizioni',
      'posizione_altro',
    ]
    for (const e of h.eventi) {
      for (const chiave of Object.keys(e.campi)) {
        expect(vietate, `chiave «${chiave}» in un log di ${e.evento}`).not.toContain(chiave)
      }
    }
  })
})
