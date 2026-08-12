import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { SEDE_A, NOME_SEDE_A } from '../fixtures/sedi'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'

// =============================================================================
// IL GATE DI FORMA DEL PERCORSO **GIRA DAVVERO**, dentro `iscrizione/personale:POST`.
//
// ── PERCHÉ QUESTO FILE ESISTE, E COSA È SUCCESSO SENZA ───────────────────────
//
// `percorsoDocumentoAmmesso` ha una suite tutta sua (`__tests__/lib/percorso-documento`),
// verde, dettagliata, con diciotto rifiuti misurati accanto ai loro controlli positivi.
// Il 12/08/2026 quella suite era verde su una funzione **che nessuno chiamava**.
//
// Il campo del modulo si chiamava `documento_path`; la migrazione `20260812194501` l'ha
// diviso in `documento_fronte_path` e `documento_retro_path`. La rotta continuava a
// leggere il nome vecchio, quindi `testo(normalizzati.documento_path)` valeva `null` a
// ogni richiesta e il ramo di rifiuto non entrava mai. Prova eseguita e non dedotta:
// forzando la funzione a `return true` — cioè con la porta spalancata a
// `documenti/../../etc/passwd` — i test del chiamante davano gli stessi identici numeri
// del codice buono.
//
// Diciotto test verdi su una funzione che nessuno chiama sono la forma più costosa di
// falsa sicurezza: raccontano una difesa che al primo invio reale non c'è. Questo file
// è l'unico che se ne accorgerebbe, e la sua regola è una sola:
//
//     **ogni caso qui manda un modulo PER IL RESTO VALIDO.**
//
// Se il 400 arrivasse dalla validazione dei campi obbligatori — che è ciò che accadeva
// nei cinque casi che questo file sostituisce — il test resterebbe verde anche
// cancellando il gate. Qui l'unico difetto del payload è il percorso, quindi togliendo
// la chiamata la risposta diventa 201 e ogni asserzione cade.
// =============================================================================

const OPERAZIONE = 'iscrizione/personale:POST'

const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  scritture: [] as { tabella: string; operazione: string; valori: Record<string, unknown>[] }[],
  eventi: [] as { evento: string; livello: string; campi: Record<string, unknown> }[],
  errori: [] as { campi: Record<string, unknown>; err: unknown }[],
}))

vi.mock('@/lib/security/rate-limit', () => ({
  // Un limitatore che dice sempre sì, e QUI va bene: il tetto vero (3/ora, con le sue
  // opzioni) è misurato in `anagrafica-personale-post.test.ts`, e ripeterlo qui
  // significherebbe solo far cadere il quarto caso di ogni `it.each` per una ragione
  // che non c'entra con ciò che si sta misurando.
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
  clientIp: () => '203.0.113.7',
}))

vi.mock('@/lib/logging/logger', async (originale) => {
  const reale = await originale<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (evento: string, livello: string, campi: Record<string, unknown>) => {
      h.eventi.push({ evento, livello, campi })
    },
    logErrore: (campi: Record<string, unknown>, err: unknown) => {
      h.errori.push({ campi, err })
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () =>
    creaFintoSupabase(h.db as DBFinto, [], { scritture: h.scritture as Scrittura[] }),
}))

vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: vi.fn(async () => undefined) }))
vi.mock('@/lib/notifiche/destinatari', () => ({ staffScuola: vi.fn(async () => ['segreteria']) }))

import { POST } from '@/app/api/iscrizione/personale/route'
import { COLONNE_DOCUMENTO } from '@/lib/personale/percorso-documento'
import { calcolaCodiceFiscale } from '@/lib/fiscale/calcolo'

/**
 * IL CODICE FISCALE SI CALCOLA, NON SI INCOLLA: il repository è pubblico, e un codice
 * battuto a mano somiglia a quello di una persona vera senza che nessuno sappia di chi.
 * `H501` è il codice catastale di Roma — dato aperto, non un dato personale.
 */
const PERSONA = {
  nome: 'Ines',
  cognome: 'Prova',
  sesso: 'F' as const,
  dataNascita: '1985-03-12',
  codiceBelfiore: 'H501',
}
const esitoCf = calcolaCodiceFiscale(PERSONA)
if (!esitoCf.ok) throw new Error(`anagrafica di prova non calcolabile: ${esitoCf.motivo}`)
const CF_COERENTE = esitoCf.codice

/** Un percorso nella forma che SOLO `iscrizione/personale/upload:POST` può produrre. */
const percorsoValido = (estensione = 'pdf') =>
  `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.${estensione}`

/** Lo registra nel finto registro dei caricamenti: esiste, e non è ancora di nessuno. */
const caricato = (percorso = percorsoValido()): string => {
  ;(h.db.caricamenti_personale as Record<string, unknown>[]).push({
    percorso,
    pratica_id: null,
    anagrafica_utente_id: null,
  })
  return percorso
}

/**
 * Le facce del documento, una per campo dichiarato dal template.
 *
 * ⚠️ SI DERIVANO DA `COLONNE_DOCUMENTO`, non si elencano: un file di test che scrivesse
 * `documento_fronte_path` a mano sarebbe la stessa copia che ha causato il difetto —
 * e resterebbe verde il giorno in cui il template guadagnasse una terza faccia, senza
 * che nessuno provi il gate su quella.
 */
const facce = (): Record<string, unknown> =>
  Object.fromEntries(COLONNE_DOCUMENTO.map((campo) => [campo, caricato()]))

/** Un'anagrafica valida e completa: da qui si cambia UN campo solo per volta. */
const pratica = (extra: Record<string, unknown> = {}) => ({
  nome: PERSONA.nome,
  cognome: PERSONA.cognome,
  gender: PERSONA.sesso,
  birth_date: PERSONA.dataNascita,
  codice_belfiore_nascita: PERSONA.codiceBelfiore,
  birth_place: 'Comune di Prova',
  birth_province: 'NA',
  birth_nation: 'Italia',
  fiscal_code: CF_COERENTE,
  citizenship: 'Italiana',
  address: 'Via di Prova',
  residence_street_number: '1',
  residence_city: 'Comune di Prova',
  residence_province: 'NA',
  zip_code: '80014',
  email: 'ines.prova@example.invalid',
  telefono: '+39 333 0000000',
  document_type: 'CI',
  document_number: 'AB1234567',
  document_expiry: '2030-01-01',
  titolo_studio: 'laurea_triennale',
  gradi: ['nido', 'infanzia'],
  presa_visione_informativa_personale: true,
  dichiarazione_veridicita: true,
  presa_visione_copia_documento: true,
  ...facce(),
  ...extra,
})

const invia = (dati: Record<string, unknown> = {}) =>
  POST(
    new NextRequest('http://localhost/api/iscrizione/personale', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      body: JSON.stringify({ scuola_id: SEDE_A, data: pratica(dati) }),
    }),
  )

/** Le righe che l'INSERT ha davvero provato a scrivere sulle pratiche. */
const inserite = () =>
  h.scritture.filter((s) => s.tabella === 'pratiche_personale' && s.operazione === 'insert')

beforeEach(() => {
  vi.clearAllMocks()
  h.eventi = []
  h.errori = []
  h.scritture = []
  h.db = {
    schools: [{ id: SEDE_A, nome: NOME_SEDE_A }],
    scuole: [{ id: SEDE_A, attiva: true }],
    caricamenti_personale: [],
    pratiche_personale: [],
  }
})

describe('POST /api/iscrizione/personale · il gate di forma è COLLEGATO ai campi veri', () => {
  it('il modulo per il resto valido entra: è il controllo positivo di tutto il file', async () => {
    // Senza questo, un gate che respingesse QUALUNQUE percorso — cioè un modulo
    // pubblico chiuso a chi ha compilato per davvero — passerebbe ogni riga qui sotto.
    const res = await invia()
    expect(res.status, await res.text()).toBe(201)
    expect(inserite(), 'la pratica non è stata scritta').toHaveLength(1)
    expect(
      h.eventi.find((e) => e.campi.esito === 'documento-path-non-ammesso'),
      'il gate ha respinto un percorso che la rotta di caricamento produce davvero',
    ).toBeUndefined()

    // Le due facce arrivano in tabella con i loro nomi di oggi: se ne mancasse una,
    // la Segreteria avrebbe una pratica «completa» con mezzo documento.
    const riga = inserite()[0].valori[0]
    for (const campo of COLONNE_DOCUMENTO) {
      expect(riga[campo], `la colonna «${campo}» non è stata scritta`).toEqual(expect.any(String))
    }
  })

  // ⚠️ IL CICLO È SU `COLONNE_DOCUMENTO`: ogni faccia è una porta, e una porta che
  // nessuno prova è una porta aperta. Prima esisteva un solo caso, sul campo che nel
  // frattempo era stato rinominato — cioè su nessuna porta.
  for (const campo of COLONNE_DOCUMENTO) {
    describe(`la faccia «${campo}»`, () => {
      it.each([
        ['una risalita nel percorso', 'documenti/../../etc/passwd'],
        ['un uuid inventato a mano', 'documenti/non-un-uuid/anche-questo.pdf'],
        ['un’estensione fuori elenco', `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.exe`],
        ['il nome del file al posto dell’uuid', `documenti/${crypto.randomUUID()}/carta-identita.pdf`],
        ['un percorso lunghissimo', `documenti/${'a'.repeat(300)}/x.pdf`],
        ['il bucket dei MINORI', 'iscrizioni/modulo/00000000-0000-4000-8000-000000000000-carta.pdf'],
        ['una virgola, che in `.or(…)` aggiunge una condizione', `documenti/${crypto.randomUUID()}/${crypto.randomUUID()}.pdf,x.pdf`],
      ])('%s è respinta, e la pratica NON entra', async (_caso, percorso) => {
        const res = await invia({ [campo]: percorso })

        expect(res.status).toBe(400)
        const corpo = await res.json()
        expect(corpo.codice).toBe('PRATICA_NON_INVIATA')
        // I campi segnalati sono TUTTE le facce, derivate: dire quale ha fallito
        // sarebbe una risposta diversa a seconda del motivo.
        expect(Object.keys(corpo.campi).sort()).toEqual([...COLONNE_DOCUMENTO].sort())
        expect(inserite(), 'una pratica con un percorso non valido è stata scritta').toHaveLength(0)

        // ⚠️ E IL RIFIUTO ARRIVA DAL GATE, non dai campi obbligatori: è la differenza
        // fra un test che misura questa difesa e un test che passerebbe anche
        // cancellandola.
        const rifiuto = h.eventi.find((e) => e.campi.esito === 'documento-path-non-ammesso')
        expect(rifiuto, 'il 400 non viene dal gate di forma: arriva da un altro controllo').toBeDefined()
        expect(rifiuto?.livello).toBe('warn')
        expect(rifiuto?.campi.operazione).toBe(OPERAZIONE)

        // ⚠️ NEL LOG NON VA IL PERCORSO: è la chiave che apre il documento d'identità
        // di una persona, e `redact()` non lo ha in lista bianca.
        const scritto = JSON.stringify([...h.eventi, ...h.errori])
        expect(scritto, 'il percorso respinto è finito nei log').not.toContain(percorso)
      })
    })
  }

  it('le due facce non possono essere LO STESSO oggetto', async () => {
    // La migrazione `20260812194501` lo dichiara come un fatto — «I due percorsi non
    // possono essere uguali — lo impone la route, non il database» — e questa riga è
    // ciò che rende vera quella frase. Senza, il modo più facile di «finire» il modulo
    // è allegare due volte la stessa foto: pratica completa, retro mancante, e nessuna
    // riga che lo dica.
    const stesso = caricato()
    const res = await invia(Object.fromEntries(COLONNE_DOCUMENTO.map((campo) => [campo, stesso])))

    expect(res.status).toBe(400)
    expect(inserite()).toHaveLength(0)
    const rifiuto = h.eventi.find((e) => e.campi.esito === 'documento-facce-uguali')
    expect(rifiuto, 'due facce identiche sono entrate').toBeDefined()
    expect(rifiuto?.livello).toBe('warn')
    expect(JSON.stringify([...h.eventi, ...h.errori])).not.toContain(stesso)
  })
})
