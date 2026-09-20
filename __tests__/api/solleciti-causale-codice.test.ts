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
  /** I dati passati al costruttore dell'email: da qui si legge il campo `causale` del riquadro. */
  riquadri: [] as { causale: string }[],
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
      b.select = () => b
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
        resolve({
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
import { codiceVoce } from '@/lib/pagamenti/codice-voce'

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
    expect(mail.corpo).toContain(codiceVoce(PID))
    expect(mail.corpo).toContain(COD_1)
    expect(mail.riquadro).toBe(mail.corpo)
    // E che dal riquadro sia arrivata fino all'HTML davvero spedito: il taccuino
    // da solo proverebbe soltanto che il motore l'ha passata a qualcuno.
    expect(mail.html).toContain(COD_1)
  })

  it('la causale del sollecito è quella storica, col codice in testa e mai in coda', async () => {
    const [mail] = await inviaSolleciti([PID])
    // Il campo causale dell'home banking si taglia da DESTRA: in coda il codice
    // sarebbe il primo pezzo a sparire, proprio nelle causali più lunghe.
    expect(mail.corpo).toBe(`Retta Settembre 2026 ${COD_1} - per il minore Mara Bianchi - ${CF} - GIUGLIANO`)
  })

  it('DUE voci sollecitate insieme → DUE codici diversi (contro la costante cablata)', async () => {
    // Un mock piatto — o un codice calcolato una volta sola fuori dal ciclo —
    // resta verde su un pagamento solo. Qui le righe sono due, identiche tranne
    // l'id: se il codice non dipende dall'id, i due codici coincidono.
    h.pagamenti = [pagRetta(), pagMensa()]
    const mail = await inviaSolleciti([PID, PID2])
    expect(mail).toHaveLength(2)
    expect(mail[0].corpo).toContain(COD_1)
    expect(mail[1].corpo).toContain(COD_2)
    expect(mail[0].corpo).not.toContain(COD_2)
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
    expect(app).toContain(COD_1)
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
    expect(app).toBe(`Retta settembre 2026 ${COD_1} - Mara Bianchi - ${CF} - GIUGLIANO`)
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
    expect(app).toBe(`Retta Settembre 2026 - pagamento ${COD_1} - Mara Bianchi`)
    expect(mail.corpo).toBe(app)
    expect(app.split(COD_1)).toHaveLength(2) // una sola occorrenza
    expect((mail.corpo ?? '').split(COD_1)).toHaveLength(2)
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
