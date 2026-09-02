import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * L'IMPORT SCRIVE IL NOME DELLA SEZIONE, NON QUELLO DEL FOGLIO.
 *
 * ─── PERCHÉ QUESTA È LA CORREZIONE CHE VALE PIÙ DI TUTTE ────────────────────
 * `alunni.classe_sezione` è TESTO. Il trigger `sync_alunno_section_id` risolve
 * `section_id` confrontando senza spazi né maiuscole, quindi il foglio può
 * scrivere «4 anni  a» e il bambino finisce lo stesso nella sezione giusta —
 * ma il TESTO resta divergente da `sections.name`, e su quel testo si reggono
 * ancora i destinatari dei broadcast e il menu per classe.
 *
 * Il 2026-09-02 le schermate dell'area 0-6 cercavano i bambini proprio per
 * testo: cinque classi di Kidville Giugliano si aprivano vuote o quasi. I dati
 * sono stati riallineati — e sarebbe servito a poco, perché l'elenco ATTIVO di
 * Giugliano porta **106 righe** col testo divergente: ogni nuova domanda
 * abbinata a una di quelle righe riscriveva la divergenza, un bambino alla
 * volta, circa sei al giorno. Senza questa correzione il riallineamento si
 * sarebbe disfatto da solo.
 *
 * ─── COSA PROVA QUESTO FILE, E COME ─────────────────────────────────────────
 * Non conta righe: guarda CHE COSA finisce nel database. `finto-supabase`
 * accumula le scritture, quindi l'asserzione è sul VALORE scritto — che è
 * l'unica forma in cui questo difetto è visibile, perché il numero di righe era
 * giusto anche prima.
 */

const SEDE = 'd53b0fbc-0000-4000-8000-00000000000a'
const ALTRA_SEDE = '429da920-0000-4000-8000-00000000000b'
const SEC_4A = 'c4a00000-0000-4000-8000-00000000004a'
const DOMANDA = 'f0000000-0000-4000-8000-000000000001'

/** Il nome com'è in anagrafica. */
const CANONICO = '4 ANNI A'
/** Il testo com'è nel foglio d'iscrizione di Giugliano. */
const DAL_FOGLIO = '4 anni  a'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({
  ...log,
  EVENTI_PERSISTITI: new Set(['iscrizione', 'anagrafica']),
}))

import { alunnoDiRiferimento } from '@/lib/iscrizioni/import/esegui'

const grezzo = {
  codice_fiscale: 'RSSMRA20A01H501X',
  data_nascita: '2020-01-01',
}

const assegnazione = (classe: string) => ({
  nome: 'Mario',
  cognome: 'Rossi',
  classe,
  retta: 150,
}) as Parameters<typeof alunnoDiRiferimento>[2]

const dbBase = (): DBFinto => ({
  sections: [
    { id: SEC_4A, scuola_id: SEDE, name: CANONICO },
    // Un'OMONIMA normalizzata in un'altra sede: se la risoluzione non filtrasse
    // per `scuola_id` potrebbe pescare questa e scrivere il nome sbagliato.
    { id: 'altra', scuola_id: ALTRA_SEDE, name: '4 Anni A' },
  ],
  alunni: [],
})

let scritture: Scrittura[]
const client = (db: DBFinto, errori?: Record<string, { code: string }>) => {
  scritture = []
  return creaFintoSupabase(db, [], {
    scritture,
    errori,
    // `iscrizioni_segna_creato` marca la riga come creata da questo giro: qui
    // basta che non lanci, perché l'oggetto del test è il testo della classe.
    rpc: { iscrizioni_segna_creato: () => ({ data: null, error: null }) },
  })
}

/** L'ultima riga scritta su `alunni`, qualunque sia stata l'operazione. */
const scrittaSuAlunni = () => {
  const s = scritture.filter((x) => x.tabella === 'alunni')
  expect(s.length, 'nessuna scrittura su `alunni`').toBeGreaterThan(0)
  // `valori` = ciò che la chiamata ha PASSATO (l'insert, o la patch
  // dell'update): è lì che si legge il testo scritto, non in `colpite`, che è
  // la riga risultante dopo l'applicazione dei filtri.
  return s[s.length - 1].valori[0] as Riga
}

beforeEach(() => vi.clearAllMocks())

describe("l'import scrive il nome canonico della classe", () => {
  it('un bambino NUOVO: dal foglio «4 anni  a», nel database «4 ANNI A»', async () => {
    const db = dbBase()
    const esito = await alunnoDiRiferimento(client(db), grezzo, assegnazione(DAL_FOGLIO), SEDE, DOMANDA)

    expect(esito).not.toHaveProperty('errore')
    // Il VALORE, non il conteggio: prima di questa correzione qui c'era
    // «4 anni  a», il numero di righe era identico, e nessun test se ne accorgeva.
    expect(scrittaSuAlunni().classe_sezione).toBe(CANONICO)
  })

  it('un bambino GIÀ ISCRITTO: anche l\'aggiornamento riallinea il testo', async () => {
    // Le due strade della stessa funzione — insert e update — devono fare la
    // stessa cosa. È la forma in cui questo genere di difetto sopravvive: si
    // corregge il ramo che si è guardato.
    const db = dbBase()
    db.alunni = [{
      id: 'a-esistente', scuola_id: SEDE, codice_fiscale: grezzo.codice_fiscale,
      nome: 'Mario', cognome: 'Rossi', classe_sezione: DAL_FOGLIO, section_id: SEC_4A,
    }]
    await alunnoDiRiferimento(client(db), grezzo, assegnazione(DAL_FOGLIO), SEDE, DOMANDA)

    expect(scrittaSuAlunni().classe_sezione).toBe(CANONICO)
  })

  it('il nome canonico si cerca DENTRO la sede: l\'omonima di un altro plesso non conta', async () => {
    const db = dbBase()
    // La sezione della sede giusta si chiama «4 ANNI A»; quella dell'altra sede
    // «4 Anni A». Deve uscire la prima.
    await alunnoDiRiferimento(client(db), grezzo, assegnazione(DAL_FOGLIO), SEDE, DOMANDA)
    expect(scrittaSuAlunni().classe_sezione).toBe(CANONICO)
    expect(scrittaSuAlunni().classe_sezione).not.toBe('4 Anni A')
  })

  it('classe che nella sede NON esiste: si scrive il grezzo, non si inventa niente', async () => {
    // Rifiutare qui lascerebbe la sede senza elenco — «rimedio peggiore del
    // male», come già motivato in `iscrizioni/import/sezioni.ts`. Il bambino
    // entra col testo del foglio, `section_id` resta NULL, e da oggi il trigger
    // lascia una riga `warn` in `app_log` a dirlo.
    const db = dbBase()
    await alunnoDiRiferimento(client(db), grezzo, assegnazione('CLASSE INESISTENTE'), SEDE, DOMANDA)
    expect(scrittaSuAlunni().classe_sezione).toBe('CLASSE INESISTENTE')
  })

  it('le sezioni non si riescono a leggere: si scrive il grezzo E si logga', async () => {
    // PostgREST non lancia. Senza il controllo di `{ error }` la lettura caduta
    // diventerebbe «nessuna sezione», e si tornerebbe a scrivere il testo storto
    // in silenzio: lo stesso guasto, con un passaggio in più.
    const db = dbBase()
    await alunnoDiRiferimento(
      client(db, { sections: { code: '42P01' } }),
      grezzo, assegnazione(DAL_FOGLIO), SEDE, DOMANDA,
    )
    expect(scrittaSuAlunni().classe_sezione).toBe(DAL_FOGLIO)
    const righe = log.logEvento.mock.calls.filter(
      ([, livello, campi]) => livello === 'error' && (campi as { esito?: string })?.esito === 'sezioni-non-lette',
    )
    expect(righe, 'una lettura caduta deve lasciare una riga, non passare in silenzio').toHaveLength(1)
  })
})
