import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// IL CODICE DELLA VOCE DENTRO IL SOLLECITO — E LA PROVA CHE LE DUE STRADE NON
// DIVERGONO.
//
// La causale che il genitore ricopia nell'home banking gli arriva da DUE posti:
// l'elenco pagamenti dell'app (`causale_suggerita`, GET /api/pagamenti) e l'email
// di sollecito. Sono due strade diverse dello stesso prodotto, e compongono la
// stessa frase per lo stesso pagamento.
//
// Finché quella frase portava solo descrizione, nome e codice fiscale, una
// divergenza fra le due era un fastidio estetico. Da quando porta il CODICE DELLA
// VOCE non lo è più: il codice è ciò che dice QUALE voce si sta pagando, e la
// riconciliazione legge quello. Se una sola delle due strade smette di appenderlo
// — per esempio perché una passa da `causaleBonifico` e l'altra è tornata a
// `renderCausale`, che il codice non lo applica — metà delle famiglie paga con una
// causale muta, e nessun test fallisce: entrambe le stringhe continuano ad avere
// l'aria di essere giuste.
//
// È esattamente la forma di guasto per cui in questo repo esiste già un lock sulla
// causale della fattura (`causale-fattura-un-motore-solo`). Qui si monta la prova
// diretta: le DUE strade vere, sullo STESSO pagamento e con lo STESSO modello, e
// le due stringhe confrontate carattere per carattere.
//
// ⚠️ LIMITE DICHIARATO — L'UGUAGLIANZA VALE PER LE VOCI `tipo: 'singolo'` VISTE
// DAL RAMO STAFF. È la forma che il sollecito tratta, ed è quella montata qui.
// Per una voce `tipo: 'split'` guardata dal GENITORE le due strade NON compongono
// la stessa stringa: il ramo `agisceComeGenitore` del GET
// (`src/app/api/pagamenti/route.ts`, riga 230) sostituisce `importo` con la quota
// del singolo genitore, mentre `solleciti-invio.ts` compone sempre l'importo pieno
// (`importo: formatEuro(pag.importo)`). Con un modello di sede che cita
// `{importo}` — caso reale: è il modello usato in
// `__tests__/api/pagamenti-solleciti-invio.test.ts` — l'app e l'email mostrano due
// cifre diverse.
//
// Lo scarto è PREESISTENTE e estraneo al codice della voce: il `{codice}` coincide
// comunque, perché `r.id` resta l'id del pagamento anche per le quote. Va trattato
// a parte, e intanto sta scritto qui: un invariante enunciato senza il suo limite
// è la forma di promessa scritta e non mantenuta che questo repo paga più cara.
// =============================================================================

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  requireUser: vi.fn(),
  sendEmail: vi.fn(async (opts: { to: string }) => Boolean(opts)),
  // Il sollecito manda testo + HTML, quindi passa da `sendEmailDetailed`. Il mock
  // DEVE esporre entrambe: `vi.mock` sostituisce il modulo INTERO, e una funzione
  // dimenticata qui diventa un 500 opaco.
  sendEmailDetailed: vi.fn(async (opts: { to: string; subject: string; text: string; html?: string }) => ({
    ok: Boolean(opts),
    error: null,
  })),
  enqueueNotifiche: vi.fn(async () => {}),
  pagamenti: [] as Record<string, unknown>[],
  utenti: [] as Record<string, unknown>[],
  settingsRow: null as Record<string, unknown> | null,
  /**
   * I dati passati al costruttore dell'email: da qui si legge il campo `causale` del riquadro.
   * `null` ⇒ la voce non ammette il bonifico (voce «solo contanti»).
   */
  riquadri: [] as { causale: string | null }[],
  /**
   * Colonne di `pagamenti` che il DB «non ha» (DB E2E della CI non migrato): una SELECT
   * che ne nomina una risponde `42703`, come fa PostgREST.
   */
  colonneAssenti: [] as string[],
  /** Le chiamate a `logEvento`, per vedere i gradini della degradazione. */
  eventi: [] as unknown[][],
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff, requireUser: h.requireUser }))
vi.mock('@/lib/auth/scope', () => ({
  resolveScuoleAttive: vi.fn(async () => ['sc-1']),
  assertAlunnoInScope: vi.fn(async () => null),
}))
// Le due rotte pescano da qui due funzioni diverse (i figli del genitore per
// l'elenco, i tutori del bambino per il sollecito): `vi.mock` sostituisce il
// modulo intero, quindi vanno dichiarate entrambe o l'import esplode.
vi.mock('@/lib/anagrafiche/legami', () => ({
  getFigliDiGenitore: vi.fn(async () => ['al-1']),
  getGenitoriDiAlunno: vi.fn(async () => ['g-1']),
}))
vi.mock('@/lib/email/send', () => ({ sendEmail: h.sendEmail, sendEmailDetailed: h.sendEmailDetailed }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.enqueueNotifiche }))
// Il logger vero resta: gli si appoggia accanto un taccuino delle chiamate a `logEvento`.
vi.mock('@/lib/logging/logger', async (importActual) => {
  const reale = await importActual<typeof import('@/lib/logging/logger')>()
  return {
    ...reale,
    logEvento: (...a: Parameters<typeof reale.logEvento>) => {
      h.eventi.push(a)
      return reale.logEvento(...a)
    },
  }
})

/**
 * Il costruttore dell'email si INTERCETTA, non si sostituisce.
 *
 * Serve il valore del campo `causale` che il motore gli passa — è il riquadro
 * «Dati per il bonifico», cioè ciò che la famiglia copia davvero — ma serve anche
 * l'HTML VERO che ne esce: un finto che restituisse una stringa vuota lascerebbe
 * verde una regressione che toglie la causale dal messaggio. Quindi si tiene
 * l'implementazione reale e le si appoggia accanto un taccuino.
 */
vi.mock('@/lib/email/messaggi/sollecito', async (importActual) => {
  const reale = await importActual<typeof import('@/lib/email/messaggi/sollecito')>()
  return {
    ...reale,
    messaggioSollecito: (d: Parameters<typeof reale.messaggioSollecito>[0], sede: Parameters<typeof reale.messaggioSollecito>[1]) => {
      h.riquadri.push({ causale: d.causale })
      return reale.messaggioSollecito(d, sede)
    },
  }
})

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      let colonne = ''
      b.select = (c?: string) => {
        colonne = c ?? ''
        return b
      }
      b.eq = () => b
      b.in = () => b
      b.or = () => b
      b.is = () => b
      b.lt = () => b
      b.gte = () => b
      b.lte = () => b
      b.neq = () => b
      b.order = () => b
      b.limit = () => b
      // La GET dei pagamenti legge a blocchi (`range`, K1): un blocco solo qui.
      b.range = () => b
      // L'elenco pagamenti legge le sedi in blocco (`.in('id', …)` → lista), il
      // sollecito una alla volta (`.maybeSingle()`): stessa riga, due forme.
      // Il nome della sede è scritto a mano qui dentro, non preso da una costante
      // del file: la fabbrica di `vi.mock` gira all'IMPORT dei moduli, cioè prima
      // che il corpo di questo file sia stato valutato.
      b.maybeSingle = async () => ({
        data:
          table === 'admin_settings' ? h.settingsRow
          : table === 'scuole' ? { id: 'sc-1', nome: 'Kidville Giugliano' }
          : null,
        error: null,
      })
      b.insert = () => ({ then: (r: (v: unknown) => unknown) => r({ data: null, error: null }) })
      b.update = () => b
      b.then = (resolve: (v: unknown) => unknown) =>
        table === 'pagamenti' && h.colonneAssenti.some((col) => colonne.includes(col))
          ? resolve({ data: null, error: { code: '42703', message: 'column does not exist' } })
          : resolve({
          data:
            table === 'pagamenti' ? h.pagamenti
            : table === 'scuole' ? [{ id: 'sc-1', nome: 'Kidville Giugliano' }]
            : table === 'utenti' ? h.utenti
            : [],
          error: null,
        })
      return b
    },
  }),
}))

import { GET } from '@/app/api/pagamenti/route'
import { POST } from '@/app/api/pagamenti/solleciti/route'
// Importato per legare l'asserzione all'ID della riga: se una delle due strade
// ricavasse il codice da un altro campo, il `toContain` qui sotto diventa rosso.
// I valori d'oro restano comunque trascritti a mano (vedi COD_1/COD_2).
import { codiceVoce, estraiCodiciVoce } from '@/lib/pagamenti/codice-voce'

// ─── La fixture: nessun dato reale (repo pubblico, dati di minori) ───────────
/** CF SINTETICO: non appartiene a nessuna persona, e la checksum non torna apposta. */
const CF = 'ABCDEF00A00A000A'
/** Gli id devono essere uuid: lo schema `zod` della rotta solleciti li valida. */
const PID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const PID2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'

/**
 * I VALORI D'ORO, trascritti e mai ricalcolati qui dentro.
 *
 * Sono `codiceVoce(PID)` e `codiceVoce(PID2)`, scritti a mano: il codice deve
 * restare lo stesso per sempre — sta nei solleciti già spediti e nei bonifici già
 * partiti — e un valore cablato è l'unica asserzione che diventa rossa il giorno in
 * cui qualcuno tocca la mescola di `codice-voce.ts`. Comporli invocando la stessa
 * funzione che il codice invoca renderebbe il test una tautologia.
 */
const COD_1 = '#P228TKC'
const COD_2 = '#C4V8626'
/**
 * Come i due codici escono nella causale del BONIFICO: senza il `#`, che Poste rifiuta
 * (2026-10-09, v. `@/lib/pagamenti/causale-banca`). I valori d'oro qui sopra restano
 * canonici: sono ciò che `codiceVoce` produce e che l'estrattore restituisce.
 */
const N_1 = COD_1.slice(1)
const N_2 = COD_2.slice(1)

const pagRetta = () => ({
  id: PID,
  alunno_id: 'al-1',
  scuola_id: 'sc-1',
  descrizione: 'Retta Settembre 2026',
  importo: 150,
  importo_pagato: 0,
  scadenza: '2026-09-30',
  stato: 'scaduto',
  tipo: 'singolo',
  periodo_competenza: '2026-09-01',
  ultimo_sollecito_il: null,
  payment_categories: { id: 'c-1', nome: 'Rette', slug: 'rette', colore: null, icona: null },
  alunni: { id: 'al-1', nome: 'Mara', cognome: 'Bianchi', codice_fiscale: CF, classe_sezione: null, sospeso: false },
})

/** La seconda voce dello stesso alunno: identica in tutto tranne l'id e la descrizione. */
const pagMensa = () => ({ ...pagRetta(), id: PID2, descrizione: 'Mensa Settembre 2026' })

const urlElenco = () => new Request('http://localhost/api/pagamenti') as unknown as import('next/server').NextRequest
const postSollecito = (ids: string[]) =>
  new Request('http://localhost/api/pagamenti/solleciti', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pagamento_ids: ids }),
  })

/** Le `causale_suggerita` dell'elenco pagamenti, nell'ordine delle righe. */
async function causaliDellApp(): Promise<string[]> {
  const res = await GET(urlElenco())
  expect(res.status).toBe(200)
  const j = await res.json()
  return (j.data as { causale_suggerita: string }[]).map((r) => r.causale_suggerita)
}

/**
 * La riga della causale dentro il corpo testuale dell'email.
 *
 * ⚠️ Si ritaglia fra le virgolette che `rigaCausaleSollecito` mette attorno alla
 * causale, non si cerca il codice nell'email intera: un `toContain` sul messaggio
 * completo resterebbe verde anche con la causale sparita dal testo e il codice
 * rimasto solo nel riquadro HTML — che è metà del guasto che questo file misura.
 * Senza la riga la fetta è `null`, e l'asserzione è rossa come dev'essere.
 */
function causaleNelCorpo(text: string): string | null {
  return /indicate come causale: "([^"]*)"/.exec(text)?.[1] ?? null
}

/** Invia davvero (niente `anteprima`): solo così esiste anche il riquadro HTML. */
async function inviaSolleciti(ids: string[]) {
  const res = await POST(postSollecito(ids))
  expect(res.status).toBe(200)
  const j = await res.json()
  expect((j.data as { ok: boolean }[]).every((e) => e.ok)).toBe(true)
  return h.sendEmailDetailed.mock.calls.map((c, i) => ({
    text: c[0].text,
    html: c[0].html ?? '',
    corpo: causaleNelCorpo(c[0].text),
    riquadro: h.riquadri[i]?.causale ?? null,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  h.riquadri = []
  h.colonneAssenti = []
  h.eventi = []
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.requireUser.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
  h.pagamenti = [pagRetta()]
  h.utenti = [{ id: 'g-1', email: 'destinatario@example.invalid' }]
  // Nessuna riga impostazioni → modello di FABBRICA su entrambe le strade.
  h.settingsRow = null
})

describe('Sollecito — il codice della voce arriva al genitore', () => {
  it('corpo dell’email e riquadro «Dati per il bonifico» portano lo STESSO codice, quello della voce', async () => {
    const [mail] = await inviaSolleciti([PID])
    // Le tre asserzioni dicono cose diverse e servono tutte: la prima lega il
    // codice all'id della riga sollecitata, la seconda inchioda il valore
    // letterale (rosso se cambia la mescola), la terza prova che la stessa
    // stringa esce dalle DUE stampe della stessa email.
    expect(estraiCodiciVoce(mail.corpo ?? '')).toEqual([codiceVoce(PID)])
    expect(mail.corpo).toContain(N_1)
    expect(mail.riquadro).toBe(mail.corpo)
    // E che dal riquadro sia arrivata fino all'HTML davvero spedito: il taccuino
    // da solo proverebbe soltanto che il motore l'ha passata a qualcuno.
    expect(mail.html).toContain(N_1)
    // Il `#` non arriva più in nessuna delle due stampe: Poste lo rifiuta.
    expect(mail.corpo).not.toContain('#')
  })

  it('la causale del sollecito è quella di fabbrica, codice e CF in testa e mai in coda', async () => {
    const [mail] = await inviaSolleciti([PID])
    // Il campo causale dell'home banking si taglia da DESTRA (alcune banche a 50
    // caratteri): in coda il codice sarebbe il primo pezzo a sparire.
    expect(mail.corpo).toBe(`Retta Settembre 2026 ${N_1} ${CF} Mara Bianchi GIUGLIANO`)
  })

  it('DUE voci sollecitate insieme → DUE codici diversi (contro la costante cablata)', async () => {
    // Un mock piatto — o un codice calcolato una volta sola fuori dal ciclo —
    // resta verde su un pagamento solo. Qui le righe sono due, identiche tranne
    // l'id: se il codice non dipende dall'id, i due codici coincidono.
    h.pagamenti = [pagRetta(), pagMensa()]
    const mail = await inviaSolleciti([PID, PID2])
    expect(mail).toHaveLength(2)
    expect(mail[0].corpo).toContain(N_1)
    expect(mail[1].corpo).toContain(N_2)
    expect(mail[0].corpo).not.toContain(N_2)
    expect(COD_1).not.toBe(COD_2)
  })
})

// =============================================================================
// L'ANTI-DIVERGENZA: la stessa voce, lo stesso modello, DUE strade, UNA stringa.
//
// È la prova che conta. Diventa rossa se una sola delle due smette di passare da
// `causaleBonifico` — l'unica porta che applica `conCodiceVoce` — o se una delle
// due comincia a calcolare il codice da un campo diverso dall'id della riga.
// =============================================================================
describe('Sollecito ed elenco pagamenti compongono la STESSA causale', () => {
  it('modello di FABBRICA (nessuna configurazione di sede): stringa contro stringa', async () => {
    h.settingsRow = null
    const [app] = await causaliDellApp()
    const [mail] = await inviaSolleciti([PID])
    expect(mail.corpo).toBe(app)
    expect(mail.riquadro).toBe(app)
    expect(app).toContain(N_1)
  })

  it('modello di sede SENZA {codice}: il codice ci finisce lo stesso, e nello stesso punto', async () => {
    // È il caso vero delle tre sedi: modelli propri in `causali_config`, scritti
    // quando il codice non esisteva. La garanzia sta in lettura, e deve valere
    // identica sulle due strade — se valesse solo su una, la famiglia riceverebbe
    // in app una causale col codice e via email la stessa causale senza.
    h.settingsRow = {
      causali_config: { rette: 'Retta {mese} {anno} - {nome_completo} - {codice_fiscale} - {sede}' },
      fiscale_config: { denominazione: 'Kidville' },
      aruba_config: {},
    }
    const [app] = await causaliDellApp()
    const [mail] = await inviaSolleciti([PID])
    expect(app).toBe(`Retta settembre 2026 ${N_1} Mara Bianchi ${CF} GIUGLIANO`)
    expect(mail.corpo).toBe(app)
    expect(mail.riquadro).toBe(app)
  })

  it('modello che cita {codice} IN MEZZO: stessa posizione e una sola occorrenza su entrambe', async () => {
    // La garanzia non è un'imposizione: chi scrive `{codice}` decide dove sta, e
    // non riceve un secondo codice appiccicato alla descrizione.
    h.settingsRow = {
      causali_config: { rette: '{descrizione} - pagamento {codice} - {nome_completo}' },
      fiscale_config: { denominazione: 'Kidville' },
      aruba_config: {},
    }
    const [app] = await causaliDellApp()
    const [mail] = await inviaSolleciti([PID])
    expect(app).toBe(`Retta Settembre 2026 pagamento ${N_1} Mara Bianchi`)
    expect(mail.corpo).toBe(app)
    expect(app.split(N_1)).toHaveLength(2) // una sola occorrenza
    expect((mail.corpo ?? '').split(N_1)).toHaveLength(2)
  })

  it('DUE voci: ogni riga dell’app coincide col proprio sollecito, e le due non si scambiano', async () => {
    // L'uguaglianza su una riga sola sarebbe verde anche se entrambe le strade
    // prendessero sempre il primo pagamento del lotto. Con due righe l'accoppiamento
    // deve reggere per entrambe, e i due codici devono restare distinti.
    h.pagamenti = [pagRetta(), pagMensa()]
    const app = await causaliDellApp()
    const mail = await inviaSolleciti([PID, PID2])
    expect(app).toHaveLength(2)
    expect(mail[0].corpo).toBe(app[0])
    expect(mail[1].corpo).toBe(app[1])
    expect(mail[0].riquadro).toBe(app[0])
    expect(mail[1].riquadro).toBe(app[1])
    expect(app[0]).not.toBe(app[1])
  })
})

// =============================================================================
// LA VOCE «SOLO CONTANTI» (2026-10-05): il sollecito non chiede un bonifico che
// la voce non ammette.
//
// Una causale col codice della voce, mandata per una voce che si paga solo in
// segreteria, è un invito a fare un bonifico che la scuola poi non sa dove
// mettere. La voce che ammette il bonifico, invece, deve restare IDENTICA a prima:
// lo provano i test qui sopra, che non sono stati toccati.
// =============================================================================
describe('Voce «solo contanti» — nel sollecito niente causale, niente IBAN', () => {
  // IBAN SINTETICO: l'esempio pubblico della Banca d'Italia, non è il conto di nessuno.
  const IBAN_OK = 'IT60X0542811101000000123456'
  const IBAN_LEGGIBILE = 'IT60 X054 2811 1010 0000 0123 456'
  const FRASE = 'in contanti presso la segreteria'
  const soloContanti = () => ({ ...pagRetta(), metodi_ammessi: ['contanti'] })
  const soloBonifico = () => ({ ...pagMensa(), metodi_ammessi: ['bonifico'] })
  const anteprima = (ids: string[]) =>
    new Request('http://localhost/api/pagamenti/solleciti', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pagamento_ids: ids, anteprima: true }),
    })
  const gradini = () =>
    h.eventi.filter((a) =>
      a[0] === 'pagamento' && a[1] === 'warn' && (a[2] as { esito?: string }).esito === 'select-in-degradazione')

  beforeEach(() => {
    // La sede HA l'IBAN compilato: se il motore decidesse dall'IBAN invece che dalla
    // voce, la riga ricomparirebbe nell'email della voce in contanti.
    h.settingsRow = { fiscale_config: { denominazione: 'Kidville', iban: IBAN_OK }, aruba_config: {} }
  })

  it('anteprima: il corpo non porta il codice della voce e dice di pagare in contanti', async () => {
    h.pagamenti = [soloContanti()]
    const res = await POST(anteprima([PID]))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.data[0].ok).toBe(true)
    const corpo = j.data[0].corpo as string
    // Nessun codice di nessuna voce, in nessuna forma: dal 2026-10-09 il codice esce
    // senza `#`, quindi «niente `#`» sarebbe vero per costruzione e non proverebbe nulla.
    expect(estraiCodiciVoce(corpo)).toEqual([])
    expect(corpo).not.toContain(N_1)
    expect(corpo).not.toContain(CF)
    expect(corpo).toContain(FRASE)
    expect(h.sendEmailDetailed).not.toHaveBeenCalled()
  })

  it('invio: riquadro senza causale, HTML senza IBAN né «Dati per il bonifico»', async () => {
    h.pagamenti = [soloContanti()]
    const [mail] = await inviaSolleciti([PID])
    expect(mail.riquadro).toBeNull()
    expect(mail.corpo).toBeNull()
    expect(mail.text).toContain(FRASE)
    expect(mail.text).not.toContain(N_1)
    expect(mail.html).not.toContain(N_1)
    expect(mail.html).not.toContain('IBAN')
    expect(mail.html).not.toContain('Dati per il bonifico')
    expect(mail.html).toContain(FRASE)
  })

  it('due voci, una in contanti e una col bonifico: ciascuna email segue la PROPRIA voce', async () => {
    // Un `bonificoAmmesso` calcolato una volta sola fuori dal ciclo sarebbe verde su
    // una voce sola: qui le due email devono uscire diverse.
    h.pagamenti = [soloContanti(), soloBonifico()]
    const mail = await inviaSolleciti([PID, PID2])
    expect(mail).toHaveLength(2)
    expect(mail[0].corpo).toBeNull()
    expect(mail[0].html).not.toContain('IBAN')
    expect(mail[1].corpo).toContain(N_2)
    expect(mail[1].riquadro).toBe(mail[1].corpo)
    // Il controllo che l'IBAN della sede arriva davvero: senza, l'assenza qui sopra
    // non proverebbe niente.
    expect(mail[1].html).toContain(IBAN_LEGGIBILE)
    expect(mail[1].html).toContain('Dati per il bonifico')
  })

  it('colonna `metodi_ammessi` assente (DB E2E non migrato): un gradino giù, un warn, il bonifico resta', async () => {
    h.colonneAssenti = ['metodi_ammessi']
    const [mail] = await inviaSolleciti([PID])
    expect(mail.corpo).toContain(N_1)
    expect(mail.riquadro).toBe(mail.corpo)
    expect(gradini()).toHaveLength(1)
  })

  it('assenti anche `sconto`: due gradini, due warn, e il sollecito parte lo stesso', async () => {
    h.colonneAssenti = ['metodi_ammessi', 'sconto']
    const [mail] = await inviaSolleciti([PID])
    expect(mail.corpo).toContain(N_1)
    expect(gradini()).toHaveLength(2)
  })
})
