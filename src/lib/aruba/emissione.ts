/**
 * Orchestratore emissione fattura elettronica (DL-017/018/019 + quote separati).
 *
 * Carica il pagamento saldato, DETERMINA LA SERIE FISCALE del bambino, compone la
 * causale, DETERMINA LE QUOTE di fatturazione (una sola nel caso normale; N per i
 * genitori separati o gli ordini divise), e per ciascuna quota risolve
 * l'intestatario (parents, via bridge), assegna un numero sul sezionale giusto,
 * genera l'XML FatturaPA e lo invia ad Aruba. Le quote sono INDIPENDENTI: quelle
 * valide partono anche se un'altra fallisce (es. CF mancante), e ciascuna è
 * idempotente (skip se esiste già una riga `fatture_emesse` non-scartata per
 * quella quota). Nessun mock: senza credenziali Aruba ritorna `non_configurato`.
 *
 * ─── LE TRE COSE CHE NON SI INDOVINANO MAI, E PERCHÉ SI BLOCCA INVECE ────────
 *
 *  1. LA SERIE FISCALE. «Asilo» o «FPR» dipende dalla data di nascita del minore
 *     (tre anni compiuti entro il 30 aprile → FPR). Senza né codice fiscale né
 *     data di nascita l'emissione si FERMA: scegliere una serie a caso significa
 *     un numero bruciato su un registro fiscale, che si corregge solo con una
 *     nota di variazione.
 *
 *  2. IL NUMERO. Le due serie vivono su Aruba e la segreteria continua a
 *     emettervi A MANO: «Asilo» è a 2.327 documenti, «FPR» a 1.946. Il progressivo
 *     si rilegge da Aruba e la lettura è BLOCCANTE — non «best-effort col contatore
 *     interno», che su una serie nata fuori da questo database vale zero e farebbe
 *     uscire un «1». Ma si rilegge UNA VOLTA PER LOTTO, non una per fattura: Aruba
 *     limita le ricerche a 12 al minuto per IP (SLA §3) e la rilettura per-fattura
 *     spezzava a metà l'emissione delle rette del mese (vedi `TTL_ULTIMO_NUMERO_MS`).
 *
 *  3. L'ANAGRAFICA — DEL CEDENTE **E DEL CESSIONARIO**. La prima arriva da
 *     `admin_settings.fiscale_config` via `cedenteDaConfig`, la seconda da `parents`
 *     via `validaCessionario`: due gate fail-closed uguali, perché il danno è lo
 *     stesso. Una fattura con `<CAP></CAP>` non è «quasi giusta», è uno scarto SDI
 *     (00423/00200) e un numero perso — e vale sia che il CAP vuoto sia il nostro,
 *     sia che sia quello del genitore.
 *
 * ─── L'ORDINE DEI CONTROLLI È IL CONTROLLO ───────────────────────────────────
 * Tutto ciò che può far scartare il documento e si sa PRIMA — cedente, intestatario,
 * coerenza fra aliquota e natura IVA — si verifica prima di chiamare
 * `prossimo_numero_fattura_sezionale`, perché quella RPC SCRIVE il contatore. Dopo
 * di lei un fallimento non costa un errore: costa un buco nel registro fiscale.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  arubaSignin,
  arubaUpload,
  arubaUltimoNumeroFattura,
  resolveArubaCredentials,
  richiesteArubaSpese,
  PAUSA_FRA_PAGINE_MS,
  type ArubaConfig,
  type ArubaUploadResult,
} from './client'
import { buildFatturaElettronicaXml, causalePerTracciato, verificaCoerenzaIva, LIMITI, type IvaFattura } from './fatturapa-xml'
import { mapStatoAruba } from './stato'
import { determinaQuoteFatturazione, resolveParentRegistry } from '@/lib/pagamenti/intestatari'
import { bolloDovuto, type FiscaleConfig } from '@/lib/pagamenti/fiscale'
import { cedenteDaConfig, type FiscalAruba } from '@/lib/fatturazione/cedente'
import { validaCessionario, messaggioCessionarioIncompleto } from '@/lib/fatturazione/cessionario'
import {
  annoScolasticoDiCompetenza,
  formattaNumeroFattura,
  sezionalePerMinore,
  ErroreSerieAmbigua,
  type Sezionale,
} from '@/lib/fatturazione/sezionale'
import { componiCausalePagamento, type PagamentoPerCausale } from './causale-pagamento'
import { leggiModuleConfig } from '@/lib/settings/module-config'
import { annoFiscale, oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { logEvento } from '@/lib/logging/logger'

export interface AttoreEmissione {
  id: string
}

/** Esito di una singola quota (riportato al chiamante per il caso multi-quota). */
export interface EsitoQuota {
  adultId: string
  label: string
  ok: boolean
  /** Il progressivo dentro il sezionale (2328), non il numero completo. */
  numero?: number
  /** Il numero come sta scritto sul documento: «Asilo 2328/2026». */
  numeroFattura?: string
  uploadFileName?: string
  motivo?: 'intestatario_mancante' | 'scartata' | 'idempotente' | 'numerazione' | 'configurazione' | 'errore'
  messaggio?: string
  /**
   * Lo status HTTP che l'aggregato deve restituire per QUESTA quota, quando la mappa per
   * `motivo` non basta.
   *
   * Serve a un caso solo, e vale la pena nominarlo: un RIFIUTO DI TRASPORTO di Aruba (429
   * sopravvissuto al ritentativo, 401, 5xx, timeout) esce con `motivo: 'errore'`, che la mappa
   * traduce in **500 «Internal Server Error»** — una bugia, perché il guasto non è nostro, e
   * un invito a ripremere «Emetti» su un numero già consumato. `502` dice la cosa vera: il
   * gateway non ha concluso. Il ramo `'errore'` resta a 500 per ciò che 500 è davvero, cioè
   * l'XML che non si è saputo comporre.
   */
  httpStatus?: number
}

export type EsitoEmissione =
  | { ok: true; fatturaStato: 'in_attesa'; uploadFileName: string; numero: number; numeroFattura?: string; quote?: EsitoQuota[] }
  | {
      ok: false
      motivo:
        | 'non_saldato'
        | 'non_configurato'
        | 'dati_minore_mancanti'
        /** Serie ambigua: emissione in agosto senza `periodo_competenza`. Vedi `ErroreSerieAmbigua`. */
        | 'periodo_competenza_mancante'
        | 'numerazione_non_allineata'
        | 'intestatario_mancante'
        | 'scartata'
        | 'errore'
      messaggio: string
      httpStatus: number
      quote?: EsitoQuota[]
    }

interface AlunnoNested {
  id?: string
  nome?: string
  cognome?: string
  codice_fiscale?: string | null
  data_nascita?: string | null
  genitori_separati?: boolean | null
  retta_split_config?: { quote?: { adult_id: string; importo: number | string; etichetta?: string | null }[] } | null
  intestatario_fatture?: { tipo?: string; nome?: string; adult_id?: string } | null
}

function s(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * `YYYY-MM-DD` → mezzanotte LOCALE di quel giorno.
 *
 * La stringa arriva da `oggiFiscaleISO()`, che la formatta in **Europe/Rome**:
 * leggerla a pezzi e ricostruirla con `new Date(a, m-1, g)` tiene il GIORNO
 * italiano qualunque sia il fuso del processo (Vercel gira in UTC). Passare da
 * `new Date(iso)` la interpreterebbe come mezzanotte UTC, e a ovest di Greenwich
 * diventerebbe il giorno prima — il difetto già pagato in questo repo col banco
 * di prova che viveva in un altro fuso dal prodotto.
 */
function giornoDaIsoFiscale(iso: string): Date {
  const [anno, mese, giorno] = iso.split('-').map(Number)
  return new Date(anno, mese - 1, giorno)
}

/**
 * `ProgressivoInvio` (campo 1.1.2): deve essere UNICO per mittente, perché lo SdI
 * ci costruisce sopra il nome del file (`IT<piva>_<progressivo>`).
 *
 * Prima era `String(numero).padStart(5, '0')`, cioè il solo progressivo. Con DUE
 * serie attive quello è un doppione annunciato: la 2328 di «Asilo» e la 2328 di
 * «FPR» avrebbero prodotto lo stesso `00.328` e Aruba avrebbe risposto «00404
 * File già inviato con lo stesso nome» — un rifiuto per una collisione di nomi, su
 * una fattura perfettamente valida. Qui ci entrano la LETTERA della serie e le due
 * cifre dell'anno: `A26002328`, nove caratteri sui dieci ammessi da `String10Type`.
 */
export function progressivoInvioFattura(sezionale: Sezionale, numero: number, anno: number): string {
  const lettera = sezionale === 'FPR' ? 'F' : 'A'
  return `${lettera}${String(anno % 100).padStart(2, '0')}${String(numero).padStart(6, '0')}`
}

/* ────────────────────────────────────────────────────────────────────────────
 * L'ULTIMO NUMERO DELLA SERIE: UNA LETTURA PER LOTTO, NON UNA PER FATTURA.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Quanto resta valida una lettura del progressivo prima di rifarla.
 *
 * ─── IL DIFETTO CHE QUESTA CACHE CHIUDE, misurato e scritto in questo stesso repo ──
 * `docs/fatturazione/tracciato-di-riferimento.md`, ultima sezione: «Aruba strozza
 * (leaky bucket — oggi si sa: **12 ricerche al minuto per IP**, SLA §3, non «60 l'ora»,
 * che è il tier degli UPLOAD) e risponde **429 con una pagina HTML**…
 * l'ultimo numero emesso si legge **una volta per lotto**, mai una volta per fattura,
 * altrimenti un'emissione massiva si interrompe a metà.» Fino al 2026-08-10 il motore
 * faceva esattamente il contrario, e con un commento che lo rivendicava: una lettura
 * per OGNI quota di OGNI pagamento, e da quando `arubaUltimoNumeroFattura` scorre le
 * pagine quella lettura vale fino a 20 richieste (40 col ripiego sull'anno precedente).
 * Le rette del mese per 32 bambini — 32 letture + 32 upload — sfondano il secchio a
 * metà lotto: da lì in poi ogni quota fallisce con `motivo:'numerazione'`, e la
 * segreteria si ritrova metà delle fatture emesse e metà no.
 *
 * ─── PERCHÉ UN VALORE DI CINQUE MINUTI FA È ANCORA BUONO ─────────────────────
 * Il numero NON viene assegnato da Aruba: lo assegna la RPC
 * `prossimo_numero_fattura_sezionale`, che tiene un contatore in tabella ed è
 * monotona. La lettura da Aruba serve solo a dare al contatore un PAVIMENTO
 * (`p_min`), perché le due serie sono nate fuori da questo database. Un pavimento
 * letto cinque minuti fa resta un pavimento valido: nel frattempo il contatore si è
 * mosso da solo, e `p_min` più basso del contatore non produce nessun effetto.
 * L'unico caso in cui la cache perde qualcosa è la segreteria che emette A MANO su
 * Aruba proprio durante il lotto — un rischio che la rilettura per-fattura NON
 * eliminava comunque (fra la lettura e l'upload la finestra resta aperta), mentre il
 * 429 a metà lotto era una certezza. Va detto fino in fondo: contro quel caso non c'è
 * nemmeno l'indice unico del registro, perché una fattura emessa sul gestionale di
 * Aruba in `fatture_emesse` NON C'È. La migrazione `20260809235620_…` sosteneva il
 * contrario in un commento e dentro un `COMMENT ON FUNCTION`; è stata corretta il
 * 2026-08-10, e le due frasi devono restare d'accordo.
 *
 * Dopo ogni allocazione il pavimento in cache viene alzato al numero appena
 * assegnato: dentro un lotto la cache non può che salire.
 */
const TTL_ULTIMO_NUMERO_MS = 5 * 60 * 1000

const cacheUltimoNumero = new Map<string, { valore: number; scadenza: number }>()

/** Ambiente + utenza + serie + anno: due sedi con credenziali diverse non si mescolano. */
function chiaveSerieAruba(ambiente: string | undefined, username: string, sezionale: Sezionale, anno: number): string {
  return `${ambiente ?? 'demo'}|${username}|${sezionale}|${anno}`
}

/** Il pavimento in cache, se non è scaduto. `null` = va riletto da Aruba. */
function pavimentoInCache(chiave: string): number | null {
  const voce = cacheUltimoNumero.get(chiave)
  if (!voce) return null
  if (voce.scadenza <= Date.now()) {
    cacheUltimoNumero.delete(chiave)
    return null
  }
  return voce.valore
}

/** Scrive il pavimento, o lo ALZA se quello nuovo è più alto (non torna mai indietro). */
function memorizzaPavimento(chiave: string, valore: number): void {
  const voce = cacheUltimoNumero.get(chiave)
  const scaduta = !voce || voce.scadenza <= Date.now()
  if (scaduta) {
    cacheUltimoNumero.set(chiave, { valore, scadenza: Date.now() + TTL_ULTIMO_NUMERO_MS })
    return
  }
  if (valore > voce.valore) voce.valore = valore
}

/**
 * Svuota la cache dei progressivi. Serve ai TEST, che altrimenti si passerebbero il
 * pavimento da un caso all'altro e misurerebbero un comportamento inventato. In
 * produzione non la chiama nessuno: il tempo fa il suo mestiere.
 */
export function svuotaCacheUltimoNumeroAruba(): void {
  cacheUltimoNumero.clear()
}

const attendi = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ────────────────────────────────────────────────────────────────────────────
 * RIFIUTO DI TRASPORTO ≠ SCARTO DI MERITO.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * L'etichetta di stato di una riga scritta a registro quando **non si sa** se il documento
 * sia arrivato allo SdI.
 *
 * Non è «Errore upload» e non porta `sdi_stato: 2`: quei due dicono «Aruba ha guardato il
 * documento e l'ha respinto», che di fronte a un `429`, a un `401` o a un timeout è
 * un'affermazione FALSA — e `fatture_emesse` è WORM, quindi una falsità scritta lì non si
 * corregge più. La riga c'è lo stesso, e deve esserci: il numero È stato consumato, e senza
 * riga quel progressivo sparirebbe dai radar di chiunque.
 */
const LABEL_TRASPORTO = 'Trasporto fallito'

/** Quanto può essere lungo `sdi_scarto_motivo` per un rifiuto di trasporto. */
const MOTIVO_TRASPORTO_MAX = 200

/**
 * Il motivo che la segreteria legge in tabella. Corto, e **mai** il corpo del provider:
 * il `429` di Aruba è una pagina HTML intera, e fino al 2026-09-03 finiva dentro questa
 * colonna. Il corpo non si perde — `externalFetch` lo mette in `app_log` con lo status —
 * ma non è quello che serve a chi deve decidere se ripremere «Emetti».
 */
function motivoTrasporto(quale: string): string {
  return `TRASPORTO ${quale}: esito ignoto, verificare sul pannello Aruba prima di ripremere`.slice(
    0,
    MOTIVO_TRASPORTO_MAX,
  )
}

/**
 * Il messaggio per chi ha appena premuto «Emetti».
 *
 * Dice l'unica cosa che conta e che nessun altro messaggio di questo file dice: **non
 * ripremere**. Ogni altro fallimento dell'emissione si chiude con «nessun numero è stato
 * consumato», e ripremere è la risposta giusta; qui no. Il numero c'è, il documento
 * potrebbe essere partito, e un secondo tentativo produrrebbe una seconda fattura per la
 * stessa retta — che si corregge solo con una nota di variazione.
 */
function messaggioTrasporto(numeroFattura: string, quale: string): string {
  return (
    `Aruba non ha concluso l’invio della fattura ${numeroFattura} (${quale}) e non sappiamo se il ` +
    'documento sia partito. Il numero è comunque stato consumato. NON ripremere «Emetti»: ' +
    'controlla prima sul pannello Aruba se la fattura risulta trasmessa.'
  )
}

/**
 * La riga di trasporto NON è stata scritta a registro: due fatti, DUE righe.
 *
 * ⚠️ Perché non una sola con `erroreConCausa`, come altrove in questo file. Negli altri
 * punti il motivo del provider viaggia già nel campo `msg`, quindi mettere l'errore di
 * PostgREST come errore principale non perde niente. Qui no: nel ramo dell'ECCEZIONE il
 * corpo della risposta di Aruba esiste solo dentro l'errore catturato, e `logEvento` fa
 * vincere l'errore sui campi — passare l'errore del database al suo posto BUTTEREBBE VIA
 * il motivo del provider, che è precisamente ciò che AGENTS.md regola 3 vieta.
 *
 * Con due righe nessuno dei due sparisce: la prima dice cosa ha risposto Aruba, la seconda
 * che quel fatto non è finito a registro — e ognuna porta il proprio `code` nella colonna
 * `codice`, dove si interroga.
 */
function segnalaTrasportoNonRegistrato(
  scuolaId: string,
  numero: number,
  anno: number,
  numeroFattura: string,
  quale: string,
  errore: unknown,
): void {
  const detto =
    `fattura ${numeroFattura}: invio ad Aruba dall'esito IGNOTO (${quale}) e la riga di trasporto ` +
    'NON è stata scritta a registro — il numero risulta consumato e non lo documenta niente'
  logEvento('fattura', 'error', {
    operazione: 'emettiFatturaPagamento:upload',
    esito: 'trasporto-non-registrato',
    provider: 'aruba',
    scuola_id: scuolaId,
    numero,
    anno,
    msg: detto,
  }, erroreConCausa(detto, errore))
}

/**
 * Un errore che dice PRIMA cosa è successo al dominio, e sotto il guasto tecnico.
 *
 * Serve perché `logEvento(evento, livello, campi, err)` fa vincere l'ERRORE sui campi: il
 * `messaggio` della riga diventa quello dell'errore passato. Con l'errore di PostgREST nudo, in
 * `app_log.messaggio` finirebbe «duplicate key value violates unique constraint» — vero, e
 * inutile: non dice QUALE fattura è rimasta senza registro. Messo come `cause`, `descriviErrore`
 * lo tiene (messaggio nella `causa`, `code` promosso alla colonna `codice`) e il messaggio
 * principale resta il fatto di dominio. Il `name` è proprio perché `get_runtime_errors` di
 * Vercel raggruppa per *error name*.
 */
function erroreConCausa(messaggio: string, causa: unknown): Error {
  const err = new Error(messaggio, { cause: causa })
  err.name = 'FatturaRegistroError'
  return err
}

/**
 * L'aggregato sul PAGAMENTO non si è aggiornato — e nessuno se ne accorgerebbe.
 *
 * PostgREST non lancia: qui c'era `await supabase.from('pagamenti').update(…)` con l'esito
 * scartato dalla destrutturazione (AGENTS.md, regola 7). Le due tabelle restano divergenti:
 * `fatture_emesse` ha la sua riga, `pagamenti.fattura_stato` è rimasto indietro. In segreteria
 * la conseguenza è visibile e muta insieme — il bottone «Invia fattura» resta lì su un
 * pagamento che la fattura ce l'ha già. (L'idempotenza per-quota impedisce il doppio invio
 * allo SDI; quello che manca è solo la spiegazione, ed è questa riga.)
 *
 * Non cambia l'esito restituito: il documento è partito davvero, e dichiarare fallita
 * un'emissione riuscita sposterebbe il danno invece di raccontarlo.
 */
function segnalaStatoNonAggiornato(
  pagamentoId: string,
  scuolaId: string,
  statoVoluto: 'in_attesa' | 'scartata',
  errore: unknown,
): void {
  const detto = `stato fattura del pagamento non aggiornato a «${statoVoluto}»: tabelle divergenti`
  logEvento('fattura', 'error', {
    operazione: 'emettiFatturaPagamento',
    esito: 'pagamento-non-aggiornato',
    provider: 'aruba',
    scuola_id: scuolaId,
    // uuid: `redact` lo lascia in chiaro, quindi la riga dice QUALE pagamento riallineare.
    // Nessun campo `stato`: lì `logEvento` ci legge uno status HTTP e lo promuove a colonna
    // (`statoHttp`), e «in_attesa» non è uno status. Lo stato voluto sta nel messaggio.
    pagamento_id: pagamentoId,
    msg: detto,
  }, erroreConCausa(detto, errore))
}

export async function emettiFatturaPagamento(
  supabase: SupabaseClient,
  pagamentoId: string,
  attore: AttoreEmissione
): Promise<EsitoEmissione> {
  // 1. pagamento + alunno (con i campi split, il CF e la data di nascita del minore)
  //    + slug della categoria, che decide il MODELLO di causale.
  const { data: pag, error: errPag } = await supabase
    .from('pagamenti')
    // Una stringa SOLA, per quanto lunga: spezzata con `+` il client Supabase
    // perde il tipo letterale del select e ogni campo di `pag` diventa un errore
    // di compilazione. Non è uno stile, è un vincolo dell'inferenza.
    .select(
      'id, descrizione, importo, stato, scadenza, periodo_competenza, scuola_id, fattura_causale, categoria_id, alunno_id, payment_categories:categoria_id ( slug ), alunni:alunno_id ( id, nome, cognome, codice_fiscale, data_nascita, genitori_separati, retta_split_config, intestatario_fatture )'
    )
    .eq('id', pagamentoId)
    .single()
  // PostgREST NON LANCIA (AGENTS.md, regola 7): fino al 2026-08-10 l'errore era
  // scartato dalla destrutturazione e QUALUNQUE guasto di lettura — permesso
  // negato, colonna assente (42703) sul DB E2E non migrato, rete — usciva come
  // «Pagamento non trovato», 404. Un messaggio che MENTE sulla causa costa più
  // del silenzio: manda chi indaga a cercare un pagamento che invece esiste.
  // `.single()` segnala «zero righe» con `PGRST116`, ed è l'unico caso in cui
  // «non trovato» è la verità; tutto il resto è un guasto e si dice guasto.
  if (errPag && (errPag as { code?: string }).code !== 'PGRST116') {
    logEvento('fattura', 'error', {
      operazione: 'emettiFatturaPagamento:pagamento',
      esito: 'pagamento-non-letto',
      pagamento_id: pagamentoId,
    }, errPag)
    return {
      ok: false,
      motivo: 'errore',
      messaggio:
        'Impossibile leggere il pagamento dal database: la fattura non è stata emessa. ' +
        'Non è un pagamento inesistente, è una lettura fallita — riprova fra poco.',
      httpStatus: 503,
    }
  }
  if (!pag) return { ok: false, motivo: 'errore', messaggio: 'Pagamento non trovato', httpStatus: 404 }
  if (pag.stato !== 'pagato')
    return {
      ok: false,
      motivo: 'non_saldato',
      messaggio: 'La fattura può essere emessa solo per pagamenti saldati',
      httpStatus: 400,
    }

  // 2. config Aruba + credenziali (lato server)
  const { data: settings, error: errSettings } = await supabase
    .from('admin_settings')
    .select('aruba_config')
    .eq('scuola_id', pag.scuola_id)
    .maybeSingle()
  // Stessa famiglia della riga qui sopra, e stessa bugia: con l'errore scartato,
  // una lettura fallita diventava `settings = null` → `cfg = {}` → «Fatturazione
  // Aruba non configurata», 503. Chi legge quel messaggio va a controllare le
  // CREDENZIALI, che sono a posto, mentre il guasto è nel database. `maybeSingle()`
  // non produce errore per «zero righe» (torna `data: null`): se qui c'è un
  // `error`, è un guasto vero e va detto per quello che è.
  if (errSettings) {
    logEvento('fattura', 'error', {
      operazione: 'emettiFatturaPagamento:configurazione',
      esito: 'configurazione-non-letta',
      scuola_id: pag.scuola_id,
      pagamento_id: pagamentoId,
    }, errSettings)
    return {
      ok: false,
      motivo: 'errore',
      messaggio:
        'Impossibile leggere la configurazione di fatturazione della sede: la fattura non è stata ' +
        'emessa. Le credenziali Aruba non c’entrano — è la lettura dal database ad essere fallita.',
      httpStatus: 503,
    }
  }
  const cfg = (settings?.aruba_config ?? {}) as ArubaConfig
  const creds = resolveArubaCredentials(cfg)
  if (!cfg.abilitato || !creds) {
    // Livello `error`, non `warn`: AGENTS.md — configurazione mancante è un
    // incidente, non una nota a piè di pagina. Qui significa che una fattura
    // dovuta NON parte. `scuola_id` va nel contesto strutturato (uuid), non
    // interpolato nel messaggio.
    logEvento('fattura', 'error', {
      operazione: 'emettiFatturaPagamento',
      esito: 'credenziali-non-configurate',
      scuola_id: pag.scuola_id,
      abilitato: Boolean(cfg.abilitato),
    })
    return {
      ok: false,
      motivo: 'non_configurato',
      messaggio: 'Fatturazione Aruba non configurata o credenziali mancanti',
      httpStatus: 503,
    }
  }

  // Anagrafica del cedente + bollo virtuale (A8), dalla FONTE UNICA
  // `admin_settings.fiscale_config`.
  //
  // ⚠️ LA LETTURA È FAIL-CLOSED, e fino al 2026-08-10 un commento qui sopra
  // sosteneva che lo fosse già. Non lo era, su nessuno dei due pezzi:
  // `getModuleConfig` restituisce `{}` anche quando la SELECT FALLISCE (PostgREST
  // non lancia), e `cedenteDaConfig({}, cfg.fiscal)` non rifiuta affatto — ripiega
  // sul vecchio `aruba_config.fiscal`, che è un ramo vivo e collaudato. Messe
  // insieme, le due cose significano che un permesso negato o una colonna assente
  // cambiavano IN SILENZIO l'anagrafica di CHI EMETTE il documento: la fattura
  // partiva verso lo SDI intestata alla configurazione di ripiego, e nessuno
  // poteva accorgersene. Ora la lettura dice se è riuscita, e se non è riuscita
  // non si emette: il ripiego resta per le sedi che non hanno mai compilato
  // `fiscale_config`, non per i guasti.
  const letturaFiscale = await leggiModuleConfig(supabase, 'fiscale_config', pag.scuola_id)
  if (!letturaFiscale.ok) {
    logEvento('fattura', 'error', {
      operazione: 'emettiFatturaPagamento:cedente',
      esito: 'fiscale-config-non-letta',
      scuola_id: pag.scuola_id,
      pagamento_id: pagamentoId,
      msg:
        "impossibile leggere l'anagrafica fiscale della sede: emissione fermata per non " +
        'intestare la fattura alla configurazione di ripiego senza che nessuno lo sappia',
    })
    return {
      ok: false,
      motivo: 'errore',
      messaggio:
        'Impossibile leggere i dati fiscali della sede: la fattura non è stata emessa. ' +
        'Non è un’anagrafica incompleta — è la lettura dal database ad essere fallita, e ' +
        'proseguire avrebbe intestato il documento ai dati di ripiego. Riprova fra poco.',
      httpStatus: 503,
    }
  }
  const fiscaleCfg = letturaFiscale.config as FiscaleConfig
  const esitoCedente = cedenteDaConfig(fiscaleCfg, cfg.fiscal as FiscalAruba | undefined)
  if (!esitoCedente.ok) {
    // Configurazione mancante = incidente (AGENTS.md §4). Nei campi solo NUMERI e
    // l'uuid della sede: `redact` tratta la P.IVA da segreto e hasha la
    // denominazione, quindi lì non servirebbero a nessuno. Il `msg` — che diventa
    // la colonna `app_log.messaggio` — nomina i campi da compilare e dove.
    logEvento('fattura', 'error', {
      operazione: 'emettiFatturaPagamento',
      esito: 'cedente-incompleto',
      scuola_id: pag.scuola_id,
      campi_mancanti: esitoCedente.mancanti.length,
      msg: esitoCedente.messaggio,
    })
    return { ok: false, motivo: 'non_configurato', messaggio: esitoCedente.messaggio, httpStatus: 503 }
  }
  const cedente = esitoCedente.cedente
  if (!cedente.email) {
    // LA DIFFERENZA DICHIARATA. `<Contatti><Email>` c'è su tutte le fatture che la
    // segreteria scrive a mano (misurato il 2026-08-10 sui campioni veri): senza,
    // il documento resta valido per lo SDI ma esce DIVERSO dai suoi vicini nella
    // stessa serie fiscale, e il genitore non ha una casella a cui rispondere.
    // `warn` e non `error` perché l'elemento è facoltativo e la fattura parte; ma
    // non in silenzio — una differenza che nessuno ha scelto è il difetto.
    // L'indirizzo NON entra nei campi: `redact` hasha la chiave `email`.
    logEvento('fattura', 'warn', {
      operazione: 'emettiFatturaPagamento',
      esito: 'cedente-senza-email',
      scuola_id: pag.scuola_id,
      pagamento_id: pagamentoId,
      msg: 'la sede non ha un indirizzo email nei dati fiscali: la fattura uscirà senza '
        + '<Contatti><Email>, a differenza di quelle emesse a mano. Compilalo in '
        + 'Impostazioni → Dati fiscali.',
    })
  }

  // 3. LA SERIE FISCALE del bambino. Prima di qualunque chiamata ad Aruba e prima
  //    di toccare un contatore: se non si sa su quale serie va il documento, non
  //    c'è niente da numerare.
  const alunno = (Array.isArray(pag.alunni) ? pag.alunni[0] : pag.alunni) as AlunnoNested | null
  const dataDocumento = oggiFiscaleISO()
  const anno = annoFiscale()
  // L'anno scolastico viene dal PERIODO CHE SI FATTURA, non da oggi: una retta di maggio
  // saldata a settembre appartiene all'anno scolastico vecchio, e il confine dei tre anni
  // si sposterebbe di dodici mesi (cioè cambierebbe la SERIE) se si guardasse il
  // calendario invece del documento. Vedi `annoScolasticoDiCompetenza`.
  const competenza = annoScolasticoDiCompetenza(
    pag.periodo_competenza as string | null,
    giornoDaIsoFiscale(dataDocumento),
  )
  const annoScolastico = competenza.anno
  if (competenza.fonte === 'data_documento') {
    // `warn` e non `error`: il ripiego è la MAGGIORANZA dei pagamenti (71 su 98 in
    // produzione al 2026-08-10 non hanno `periodo_competenza`) e nella quasi totalità
    // dei casi coincide col periodo fatturato. Ma non è muto, perché quando NON coincide
    // — fattura emessa in un anno scolastico diverso da quello della retta — sposta la
    // serie fiscale, e questa riga è l'unico modo per ricostruirlo dopo. Solo uuid e
    // numeri nei campi; il fatto sta nel `msg`.
    logEvento('fattura', 'warn', {
      operazione: 'emettiFatturaPagamento',
      esito: 'anno-scolastico-da-data-documento',
      scuola_id: pag.scuola_id,
      pagamento_id: pagamentoId,
      anno_scolastico: annoScolastico,
      msg: 'il pagamento non ha un periodo di competenza: la serie fiscale è stata decisa '
        + "sull'anno scolastico della data di emissione. Compila «periodo di competenza» "
        + 'sul pagamento se la retta appartiene a un altro anno scolastico.',
    })
  }
  let sezionale: Sezionale
  try {
    const esitoSezionale = sezionalePerMinore({
      codiceFiscale: alunno?.codice_fiscale,
      dataNascita: alunno?.data_nascita,
      annoScolastico,
      // In agosto, e solo senza «periodo di competenza», l'anno scolastico è dedotto in un
      // mese in cui le due regole del prodotto rispondono anni diversi: `sezionalePerMinore`
      // rifiuta di scegliere se i due anni candidati portano il bambino su serie diverse.
      annoScolasticoAmbiguo: competenza.ambiguo,
    })
    sezionale = esitoSezionale.sezionale
    if (esitoSezionale.codiceFiscaleImplausibile || esitoSezionale.dataNascitaImplausibile) {
      // IL CAMPO CHE SI LEGGE BENISSIMO E DESCRIVE UN'ALTRA PERSONA: il codice fiscale del
      // GENITORE incollato in quello del bambino. Non è illeggibile — la forma è perfetta —
      // e fino al 2026-08-10 non alzava niente: la fattura partiva muta con una data di
      // nascita del 1985. La serie è stata decisa sull'altra fonte, ma quel codice finisce
      // verbatim nella descrizione della riga, cioè nell'unico punto in cui il documento
      // identifica il minore. Nei campi solo uuid: il valore sbagliato non entra nei log.
      const quale = esitoSezionale.codiceFiscaleImplausibile && esitoSezionale.dataNascitaImplausibile
        ? 'il codice fiscale e la data di nascita del minore indicano entrambi una data che un alunno non può avere'
        : esitoSezionale.codiceFiscaleImplausibile
          ? 'il codice fiscale del minore si legge ma indica una data che un alunno non può avere'
          : 'la data di nascita del minore indica una data che un alunno non può avere'
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento',
        esito: 'anagrafica-minore-implausibile',
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        alunno_id: alunno?.id ?? pag.alunno_id,
        anno_scolastico: annoScolastico,
        msg: `${quale} (probabile dato di un adulto nel campo del bambino): la serie ${sezionale} è stata `
          + "decisa sull'altra fonte. Correggi l'anagrafica del bambino.",
      })
    }
    if (esitoSezionale.codiceFiscaleIlleggibile || esitoSezionale.dataNascitaIlleggibile) {
      // IL CASO CHE FINO AL 2026-08-10 PASSAVA MUTO, ed era il più frequente. Un campo
      // valorizzato ma illeggibile non è un'anagrafica incompleta: è un dato SBAGLIATO,
      // e il codice fiscale del minore finisce verbatim nella descrizione della riga di
      // fattura (segnaposto `{codice_fiscale}`) — l'unico posto del documento dove il
      // bambino viene identificato, e ciò da cui dipende la detrazione del genitore.
      // Un documento verso lo SDI è irreversibile, quindi `error`: la fattura parte
      // comunque (l'altra fonte basta a scegliere la serie), ma qualcuno deve correggere.
      // Nei campi solo uuid: né il codice fiscale né la data di nascita, sono di un minore.
      const cosa = esitoSezionale.codiceFiscaleIlleggibile && esitoSezionale.dataNascitaIlleggibile
        ? 'il codice fiscale e la data di nascita del minore sono entrambi valorizzati ma illeggibili'
        : esitoSezionale.codiceFiscaleIlleggibile
          ? 'il codice fiscale del minore è valorizzato ma NON è leggibile'
          : 'la data di nascita del minore è valorizzata ma NON è leggibile'
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento',
        esito: 'anagrafica-minore-illeggibile',
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        alunno_id: alunno?.id ?? pag.alunno_id,
        msg: `${cosa}: la serie ${sezionale} è stata decisa sull'altra fonte, ma il dato sbagliato `
          + "finisce sul documento. Correggi l'anagrafica del bambino.",
      })
    }
    if (esitoSezionale.discordanza) {
      // `error` e non `warn`: due fonti anagrafiche che si contraddicono su un
      // minore sono un dato da correggere, e qui decidono la SERIE FISCALE di un
      // documento. Vince l'anagrafica (l'ha verificata una persona sul documento),
      // ma la contraddizione non può restare muta. Nei campi entra solo l'uuid
      // dell'alunno: né il codice fiscale né la data di nascita — sono dati di un
      // minore, e `redact` li chiuderebbe comunque.
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento',
        esito: 'sezionale-discordanza',
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        alunno_id: alunno?.id ?? pag.alunno_id,
        msg: `codice fiscale e data di nascita del minore indicano date diverse: vale l'anagrafica, serie ${sezionale}`,
      })
    }
  } catch (e) {
    // Nessun campo `msg` qui, ed è una regola del logger che vale la pena
    // ricordare: quando si passa un ERRORE, il suo messaggio vince e diventa la
    // colonna `app_log.messaggio`, mentre un `msg` fra i campi resta una stringa
    // qualunque e `redact` la chiude (`[redatto:str/99]`). Il messaggio di
    // `sezionalePerMinore` dice già cosa correggere e dove: aggiungerne un altro
    // significherebbe scrivere una riga illeggibile accanto a una leggibile.
    // Nei campi solo `esito` (in lista bianca) e gli uuid: la data di nascita di
    // un minore nei log non entra mai.
    //
    // DUE BLOCCHI DIVERSI, DUE RIPARAZIONI DIVERSE. L'anagrafica incompleta si
    // completa sulla scheda del bambino; la serie ambigua d'agosto si scioglie
    // compilando «periodo di competenza» SUL PAGAMENTO — e non c'è niente da
    // correggere sul bambino. Rispondere all'una col messaggio dell'altra manderebbe
    // la segreteria a cercare un campo che è già a posto.
    const ambigua = e instanceof ErroreSerieAmbigua
    logEvento('fattura', 'error', {
      operazione: 'emettiFatturaPagamento',
      esito: ambigua ? 'anno-scolastico-ambiguo' : 'sezionale-non-determinabile',
      scuola_id: pag.scuola_id,
      pagamento_id: pagamentoId,
      alunno_id: alunno?.id ?? pag.alunno_id,
      anno_scolastico: annoScolastico,
    }, e)
    if (ambigua) {
      return {
        ok: false,
        motivo: 'periodo_competenza_mancante',
        messaggio:
          'Impossibile determinare la serie fiscale (Asilo/FPR): il pagamento non ha un «periodo di competenza» ' +
          'e la fattura si emette in agosto, il mese in cui cambia l’anno scolastico. Per questo bambino i due ' +
          'anni possibili danno serie diverse. Indica il periodo di competenza sul pagamento e riprova.',
        httpStatus: 422,
      }
    }
    return {
      ok: false,
      motivo: 'dati_minore_mancanti',
      messaggio:
        'Impossibile determinare la serie fiscale (Asilo/FPR): completa codice fiscale o data di nascita ' +
        'del bambino nell’anagrafica. La serie non si può indovinare.',
      httpStatus: 422,
    }
  }

  // 4. LA CAUSALE. La compone `@/lib/aruba/causale-pagamento`, che è lo STESSO
  //    codice chiamato da `/api/pagamenti/fattura/anteprima`: la segreteria deve
  //    approvare esattamente il testo che parte. Cascata invariata (correzione
  //    manuale → modello della CATEGORIA → «Predefinito» → modello di fabbrica) e
  //    fail-closed invariato: se la configurazione non si legge, non si emette.
  //    Nessun numero è ancora stato consumato.
  const esitoCausale = await componiCausalePagamento(supabase, pag as PagamentoPerCausale, alunno)
  if (!esitoCausale.ok) {
    return {
      ok: false,
      motivo: esitoCausale.motivo,
      messaggio: esitoCausale.messaggio,
      httpStatus: esitoCausale.httpStatus,
    }
  }
  const causaleBase = esitoCausale.causale

  // 5. determina le quote di fatturazione
  const quote = await determinaQuoteFatturazione(
    supabase,
    { id: pag.id, importo: pag.importo },
    {
      id: alunno?.id ?? pag.alunno_id,
      genitori_separati: alunno?.genitori_separati,
      retta_split_config: alunno?.retta_split_config,
      intestatario_fatture: alunno?.intestatario_fatture,
    }
  )
  if (quote.length === 0)
    return {
      ok: false,
      motivo: 'intestatario_mancante',
      messaggio: 'Intestatario fattura non impostato sull’anagrafica',
      httpStatus: 422,
    }
  const multi = quote.length > 1

  // 6. righe fatture_emesse già presenti (per l'idempotenza per-quota)
  //
  // ─── QUESTA LETTURA È L'UNICA COSA FRA UN CLIC E UNA SECONDA FATTURA ALLO SDI ─
  // L'idempotenza per-quota vive in due posti, e nessuno dei due è facoltativo:
  // qui (che evita di allocare un numero e caricare un secondo XML) e sul
  // database, con l'indice unico parziale `fatture_emesse_pagamento_quota_uidx`
  // introdotto da `20260809235620_fatture_numerazione_sezionale.sql`. L'indice è
  // l'ultima difesa e arriva TARDI — scatta sull'INSERT, cioè dopo che il
  // documento è già partito — quindi la difesa vera è questa riga.
  //
  // PostgREST NON LANCIA (AGENTS.md, regola 7). Con l'errore scartato dalla
  // destrutturazione, `esistenti` valeva `null`, `righeEsistenti` diventava `[]`,
  // `gia` restava `undefined` e si emetteva di nuovo — IN SILENZIO, senza una
  // riga di log. E non è un caso di scuola: questa `select` chiede `sezionale`,
  // colonna che esiste solo DOPO la migrazione qui sopra; se il codice arriva in
  // produzione prima di lei (o gira sul DB E2E della CI, che non è migrato) la
  // risposta è `42703` — cioè esattamente `esistenti = null`, su ogni chiamata.
  // Prima emissione: numero nuovo, XML caricato, INSERT in `PGRST204`, la riga a
  // registro non c'è. La segreteria ripreme perché il pagamento risulta ancora
  // senza fattura: numero nuovo un'altra volta, e allo SDI parte un SECONDO
  // documento fiscale per la stessa retta — che si corregge solo con una nota di
  // variazione.
  //
  // Quindi FAIL-CLOSED, come il cedente e come il cessionario: se l'idempotenza
  // non è VERIFICABILE, non si emette. Un'emissione mancata si rifà con un clic;
  // una fattura doppia no.
  //
  // ⚠️ E NON TUTTE LE RIGHE VIVE RACCONTANO LA STESSA COSA. Una riga «Trasporto
  // fallito» (`sdi_stato` nullo, nessun nome file) blocca il secondo documento
  // come le altre — ed è per questo che nasce con `sdi_stato: null` — ma NON è una
  // fattura inviata: nessuno sa se sia partita. Va riconosciuta qui sotto e
  // raccontata per quello che è, altrimenti la seconda pressione riceve un «già
  // fatto» e il pagamento finisce in un «in attesa» che nessun `sync` chiuderà.
  const { data: esistenti, error: errEsistenti } = await supabase
    .from('fatture_emesse')
    .select('id, numero, sezionale, aruba_filename, sdi_stato, quota_adult_id')
    .eq('pagamento_id', pagamentoId)
  if (errEsistenti) {
    logEvento('fattura', 'error', {
      operazione: 'emettiFatturaPagamento:idempotenza',
      esito: 'idempotenza-non-verificabile',
      scuola_id: pag.scuola_id,
      pagamento_id: pagamentoId,
    }, errEsistenti)
    return {
      ok: false,
      motivo: 'errore',
      messaggio:
        'Impossibile verificare se questo pagamento è già stato fatturato: l’emissione è stata ' +
        'fermata per non rischiare una SECONDA fattura allo SDI per la stessa retta. ' +
        'Nessun numero è stato consumato.',
      httpStatus: 503,
    }
  }
  const righeEsistenti = (esistenti ?? []) as {
    id: string
    numero: number
    sezionale: string | null
    aruba_filename: string | null
    sdi_stato: number | null
    quota_adult_id: string | null
  }[]

  // 7. emissione indipendente per quota
  let tokenCache: string | null = null
  const ensureToken = async () => {
    if (!tokenCache) tokenCache = (await arubaSignin(cfg.ambiente, creds)).accessToken
    return tokenCache
  }

  // La serie e l'anno sono gli stessi per tutte le quote di questo pagamento (li
  // decide il MINORE, non chi paga): una chiave sola, e una lettura sola.
  const chiaveSerie = chiaveSerieAruba(cfg.ambiente, creds.username, sezionale, anno)

  /**
   * ─── IL RITMO PRIMA DELL'UPLOAD ─────────────────────────────────────────────
   * L'upload partiva SUBITO dopo l'ultima pagina di `findByUsername`: dentro la
   * stessa finestra del leaky bucket che aveva appena risposto a sette GET. Un
   * `429` lì costa un numero già allocato dalla RPC — un buco nel registro
   * fiscale — e lascia il pagamento «scartata».
   *
   * Il predicato non è «la cache era vuota», è «sono partite davvero delle
   * richieste»: le due cose coincidono in produzione, ma solo la seconda è una
   * misura, e la misura ce l'ha il client (`richiesteArubaSpese`). Se il
   * pavimento arriva dalla cache non si è speso niente, e i cinque secondi
   * sarebbero solo cinque secondi passati da qualcuno a guardare una rotellina.
   *
   * Una sola pausa per invocazione: il flag si spegne quando la si paga.
   */
  let ritmoDaPagare = false
  const leggiPavimentoSerie = async (): Promise<number> => {
    const inCache = pavimentoInCache(chiaveSerie)
    if (inCache !== null) return inCache
    const spesePrima = richiesteArubaSpese()
    const token = await ensureToken()
    const letto = await arubaUltimoNumeroFattura(cfg.ambiente, token, {
      username: creds.username,
      anno,
      sezionale,
      vatcodeSender: cedente.piva || undefined,
    })
    if (richiesteArubaSpese() > spesePrima) ritmoDaPagare = true
    memorizzaPavimento(chiaveSerie, letto)
    return letto
  }

  const esiti: EsitoQuota[] = []
  for (const q of quote) {
    // idempotenza: esiste già una riga non-scartata per questa quota?
    const gia = righeEsistenti.find((r) => {
      const scartata = r.sdi_stato != null && mapStatoAruba(r.sdi_stato).isScarto
      if (scartata) return false
      return r.quota_adult_id === q.adultId || (!multi && r.quota_adult_id == null)
    })
    if (gia) {
      // ── UNA RIGA «TRASPORTO FALLITO» NON È UNA FATTURA INVIATA ───────────────
      // Si riconosce da due colonne insieme: `sdi_stato` nullo E nessun nome file.
      // Basta, e vale la pena scrivere perché: dentro questo file `sdi_stato` lo
      // scrivono quattro INSERT e nessun'altra — `1` quando Aruba ha risposto
      // `0000`, `2` sullo scarto di merito, `null` soltanto nei due rami del rifiuto
      // di trasporto; e `fattura/sync`, l'unico altro scrittore, ci mette sempre un
      // numero (e non guarda nemmeno queste righe: filtra `sdi_stato in (1,3,5)` con
      // `aruba_filename not null`). In produzione, poi, `fatture_emesse` è vuota:
      // non c'è uno storico di righe di altra forma da interpretare.
      //
      // ⚠️ PERCHÉ NON BASTAVA NON RIEMETTERE. Lo `sdi_stato: null` tiene la riga viva
      // e blocca il secondo documento — quella parte funzionava, ed è giusta. Ma la
      // riga cadeva nel ramo `idempotente` con `ok: true`, e l'aggregato di fondo
      // scriveva `fattura_stato = 'in_attesa'` con `fattura_aruba_id = null`: uno
      // stato senza uscita, perché `fattura/sync` non ripesca una riga senza nome
      // file e `aggregaFatturaStato` la terrebbe «in attesa» per sempre. Chi ripreme
      // «Emetti» — e ripreme, perché la UI mostra «Riprova» proprio sullo stato
      // `scartata` in cui il primo tentativo lascia il pagamento — si sentiva
      // rispondere «fatto» su una fattura di cui nessuno sa se sia partita.
      if (gia.sdi_stato == null && gia.aruba_filename == null) {
        // `esito` è in lista bianca e resta in chiaro in tabella: «quante volte si è
        // ripremuto su una fattura dall'esito ignoto» diventa una query. Numeri e
        // uuid passano in chiaro; niente altro serve, e niente altro ci va.
        logEvento('fattura', 'warn', {
          operazione: 'emettiFatturaPagamento:idempotenza',
          esito: 'trasporto-in-sospeso',
          provider: 'aruba',
          scuola_id: pag.scuola_id,
          pagamento_id: pagamentoId,
          numero: gia.numero,
          msg:
            'ripremuto «Emetti» su una fattura con esito di trasporto ignoto: nessun secondo ' +
            'documento è stato inviato; il pagamento resta da verificare sul pannello Aruba',
        })
        const numeroFattura = gia.sezionale ? `${gia.sezionale} ${gia.numero}` : String(gia.numero)
        esiti.push({
          adultId: q.adultId,
          label: q.label,
          // `ok: false` è la parte che conta: l'aggregato lascia il pagamento
          // `scartata` (dov'era) invece di inventargli un «in attesa», e la route
          // risponde 409 invece di 200.
          ok: false,
          numero: gia.numero,
          numeroFattura,
          motivo: 'errore',
          // 409 e non 502: il gateway non c'entra, il conflitto è con una riga che è
          // già a registro e che qualcuno deve chiudere prima di riprovare.
          httpStatus: 409,
          messaggio:
            messaggioTrasporto(numeroFattura, 'esito ignoto') +
            ' Se sul pannello Aruba la fattura NON risulta, la riga «Trasporto fallito» a registro ' +
            'va chiusa a mano (sdi_stato = 2) prima di riemettere; se risulta, va completata con il ' +
            'nome file (aruba_filename) e sdi_stato = 1, così la sincronizzazione la riprende.',
        })
        continue
      }
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: true,
        numero: gia.numero,
        numeroFattura: gia.sezionale ? `${gia.sezionale} ${gia.numero}` : undefined,
        uploadFileName: gia.aruba_filename ?? undefined,
        motivo: 'idempotente',
      })
      continue
    }

    // ── L'INTESTATARIO, con lo STESSO gate fail-closed del cedente ────────────
    // Fino al 2026-08-10 qui si controllava una cosa sola: che il codice fiscale
    // ci fosse. Indirizzo, CAP e comune del genitore entravano nell'XML come
    // stavano, anche vuoti, e l'invio partiva DOPO che il numero era già stato
    // allocato (la RPC scrive il contatore): numero bruciato più scarto SDI, che
    // si corregge solo con una nota di variazione. Misurato con il validatore XSD
    // di questo repo: residenza vuota = tre violazioni di `pattern` su
    // `Indirizzo`, `CAP` e `Comune`. E non è un'ipotesi sul futuro — misura del
    // 2026-08-10 su `parents`: 22 righe con un `fiscal_code` valorizzato, 21 delle
    // quali NON hanno la forma di un codice fiscale (venti a 14 caratteri, una a
    // due). Quattordici caratteri alfanumerici passano lo XSD e li scarta lo SDI.
    const reg = await resolveParentRegistry(supabase, q.adultId)
    if (!reg) {
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        motivo: 'intestatario_mancante',
        messaggio:
          `Intestatario «${q.label || 'genitore'}» non trovato in anagrafica: ` +
          'nessun numero è stato consumato.',
      })
      continue
    }
    const erroriCessionario = validaCessionario({
      codice_fiscale: reg.fiscal_code,
      nome: reg.first_name,
      cognome: reg.last_name,
      indirizzo: reg.residence_address,
      cap: reg.zip_code,
      comune: reg.residence_city,
    })
    if (Object.keys(erroriCessionario).length > 0) {
      const nome = [reg.first_name, reg.last_name].filter(Boolean).join(' ') || q.label || 'intestatario'
      // Nei campi del log entrano solo uuid e NUMERI: il nome e il codice fiscale
      // del genitore sono dati personali e non ci vanno mai (`redact` li chiuderebbe
      // comunque). Il `msg` dice QUALI campi, non di CHI: chi opera ha già il nome
      // sotto gli occhi, nella riga del pagamento su cui ha appena cliccato.
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento:cessionario',
        esito: 'cessionario-incompleto',
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        campi_mancanti: Object.keys(erroriCessionario).length,
        msg:
          `anagrafica dell'intestatario incompleta o non valida (${Object.keys(erroriCessionario).join(', ')}): ` +
          'la fattura NON è stata emessa e nessun numero è stato consumato',
      })
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        motivo: 'intestatario_mancante',
        messaggio: messaggioCessionarioIncompleto(erroriCessionario, nome),
      })
      continue
    }
    const residenza = await leggiResidenzaEstesa(supabase, reg.id, pag.scuola_id)

    // ── LA CAUSALE DI QUESTA QUOTA ───────────────────────────────────────────
    // Il separatore è « - » e non un trattino lungo: «—» (U+2014) sta fuori da
    // `[\p{IsBasicLatin}\p{IsLatin-1Supplement}]`, cioè fuori dal tracciato, e
    // ogni fattura del ramo multi-quota nasceva formalmente invalida. Il
    // generatore ora translittera comunque, ma un carattere che il tracciato non
    // ammette non si scrive di proposito nel sorgente.
    const causale = multi ? `${causaleBase} - quota ${q.label || reg.first_name || 'genitore'}` : causaleBase
    // IL TAGLIO SI MISURA DOVE IL TESTO VA A FINIRE DAVVERO — e da oggi va in un
    // posto solo: `<Descrizione>` della riga (2.2.1.4, 1.000 caratteri). Il gate
    // guardava i 200 di `<Causale>` (2.1.1.11), che questo motore NON scrive più:
    // avrebbe annunciato un troncamento che non avviene, e taciuto quello vero.
    // La misura è la stringa RIDOTTA AL TRACCIATO, non quella in mano: `€`→`EUR`
    // allunga, ciò che il tracciato non sa scrivere sparisce.
    if (causalePerTracciato(causale).length > LIMITI.descrizione) {
      // Troncare è una decisione sul CONTENUTO di un documento fiscale: la prende
      // il generatore come ultima difesa (il documento parte valido), ma chi
      // configura il modello deve sapere che sta perdendo del testo.
      logEvento('fattura', 'warn', {
        operazione: 'emettiFatturaPagamento',
        esito: 'causale-troncata',
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        msg: `la causale composta supera i ${LIMITI.descrizione} caratteri della descrizione di riga (campo 2.2.1.4) e verrà troncata: accorcia il modello in Contabilità → Causali`,
      })
    }
    const importoQuota = Number(q.importo)

    // ── L'IVA, VERIFICATA PRIMA CHE UN NUMERO VENGA CONSUMATO ────────────────
    // IVA per causale da `aruba_config.iva[]` (match per inclusione,
    // case-insensitive); nessun match → default esente art. 10 del generatore.
    //
    // `verificaCoerenzaIva` sta QUI e non più solo dentro il generatore perché
    // l'ordine è il punto: `aliquota 0` senza `Natura` e `aliquota > 0` CON
    // `Natura` sono due scarti SDI (00401 / 00400) che lo XSD non vede, e fino al
    // 2026-08-10 una riga IVA scritta male si scopriva soltanto dopo aver
    // allocato il numero e caricato il file. Una configurazione sbagliata deve
    // costare un messaggio d'errore, non un buco nel registro fiscale.
    const ivaEntry = (cfg.iva || []).find(
      (v) => v.causale && causale.toLowerCase().includes(String(v.causale).toLowerCase())
    )
    const ivaFattura: IvaFattura | undefined = ivaEntry
      ? {
          aliquota: Number(ivaEntry.aliquota),
          natura: ivaEntry.natura || undefined,
          // Il riferimento normativo delle righe configurate a mano non veniva MAI
          // passato: `<RiferimentoNormativo>` spariva proprio sulle esenti
          // configurate dalla sede, cioè dove serve.
          riferimentoNormativo: ivaEntry.riferimento_normativo || undefined,
        }
      : undefined
    if (ivaFattura) {
      try {
        verificaCoerenzaIva(ivaFattura)
      } catch (e) {
        // Configurazione mancante o incoerente = incidente (AGENTS.md §4). Nei campi
        // solo uuid e numeri; il messaggio dell'errore dice già quale regola è saltata
        // e con quale codice lo SDI scarterebbe.
        logEvento('fattura', 'error', {
          operazione: 'emettiFatturaPagamento:iva',
          esito: 'iva-incoerente',
          scuola_id: pag.scuola_id,
          pagamento_id: pagamentoId,
          aliquota: Number(ivaEntry?.aliquota),
        }, e)
        esiti.push({
          adultId: q.adultId,
          label: q.label,
          ok: false,
          motivo: 'configurazione',
          messaggio:
            `${e instanceof Error ? e.message : 'Configurazione IVA non valida'} ` +
            'Correggi la riga IVA nella configurazione Aruba della sede. Nessun numero è stato consumato.',
        })
        continue
      }
    }
    const aliquota = ivaFattura ? ivaFattura.aliquota : 0
    const esente = aliquota === 0
    const bolloImporto = esente ? bolloDovuto(importoQuota, fiscaleCfg) : 0
    // importoQuota è il LORDO incassato: con IVA>0 va scorporato l'imponibile,
    // così ImportoTotaleDocumento (imponibile+imposta) torna pari all'incassato.
    const imponibile = aliquota > 0 ? Math.round((importoQuota / (1 + aliquota / 100)) * 100) / 100 : importoQuota

    // ── IL NUMERO ─────────────────────────────────────────────────────────────
    // Il pavimento della serie si legge UNA VOLTA PER LOTTO (vedi
    // `TTL_ULTIMO_NUMERO_MS`), non una volta per fattura: Aruba strozza a ~60
    // richieste l'ora e la rilettura per-fattura interrompeva un'emissione massiva
    // a metà, lasciando la segreteria con metà delle rette fatturate.
    // Se la lettura fallisce, questa quota NON parte: un progressivo che non si è
    // potuto allineare è un progressivo che non si conosce.
    let ultimoAruba: number
    try {
      ultimoAruba = await leggiPavimentoSerie()
    } catch (e) {
      // `error` e non più `warn`: fino al 2026-08-09 qui si proseguiva «col
      // contatore interno», che per una serie nata sul gestionale di Aruba vale
      // ZERO — cioè si emetteva il numero 1 su una serie di 2.327 documenti. Il
      // corpo dell'errore del provider viaggia dentro `e` (il client passa da
      // `externalFetch` e lo conserva) e DEVE restare il messaggio della riga: è
      // l'unica cosa che distingue un token scaduto da un 5xx di Aruba. Per
      // questo non c'è un `msg` fra i campi — lo sovrascriverebbe? no: verrebbe
      // redatto, e affiancherebbe una stringa illeggibile a una leggibile. Il
      // fatto di dominio sta in `esito`, che è in lista bianca e si interroga.
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento:ultimoNumeroAruba',
        provider: 'aruba',
        esito: `numerazione-non-allineabile-${sezionale.toLowerCase()}`,
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        anno,
      }, e)
      // ── PERCHÉ QUI CI SONO CINQUE MESSAGGI E NON UNO ────────────────────────
      // Fino al 2026-09-02 ce n'erano due: il 429 e «tutto il resto». Quel «tutto
      // il resto» copriva SEI guasti diversi — login fallito, utenza non abilitata
      // ai Web Service, ambiente sbagliato, rete lenta, formato non riconosciuto,
      // parsing — e chi leggeva la schermata non poteva sapere quale. Misurato sul
      // campo: il 2026-09-02 la segreteria ha letto «Riprova più tardi» per un
      // guasto che sarebbe stato lì anche fra un mese, perché era il nostro parser.
      //
      // `e.code` era già in mano e bastava guardarlo. La chiusura resta identica in
      // ogni ramo — nessun numero consumato, nessuna fattura emessa — perché quella
      // è l'unica cosa che la persona davanti allo schermo deve poter dare per
      // certa; a cambiare è solo COSA FARE dopo, che è l'informazione utile.
      const codiceProvider = String((e as { code?: unknown } | null)?.code ?? '')
      const nienteEmesso =
        'La fattura non è stata emessa e nessun numero è stato consumato.'
      const messaggioNumerazione = (() => {
        switch (codiceProvider) {
          case '429':
            // Non è un guasto: è il secchio pieno (12 ricerche al minuto per IP e un
            // login al minuto, SLA §3 di Aruba; il 429 arriva come pagina HTML). Il
            // codice ha già aspettato 90 s e ritentato una volta: la risposta giusta,
            // adesso, è aspettare di più — e non insistere, perché ogni tentativo
            // azzera la finestra di un'ora.
            return (
              'Aruba ha risposto «troppe richieste» (limite di 12 ricerche e 1 accesso al minuto). ' +
              `${nienteEmesso} Aspetta almeno un’ora senza ripremere, poi riprova.`
            )
          case '401':
          case '403':
            // Riprovare non serve: finché la configurazione è quella, l'esito è
            // quello. Le due cose che possono essere: credenziali e ambiente.
            return (
              'Aruba ha rifiutato le credenziali della sede (utenza, password o ambiente). ' +
              `${nienteEmesso} Riprovare non basta: controlla la configurazione Aruba nelle impostazioni della sede.`
            )
          case 'rete':
            return (
              'Aruba non ha risposto entro 30 secondi. ' +
              `${nienteEmesso} Riprova fra qualche minuto.`
            )
          case 'etichette-illeggibili':
            // Il caso del 2026-09-02. Va detto che NON è un problema di Aruba né
            // della sede, altrimenti si va a cercare nel posto sbagliato.
            return (
              `Aruba ha risposto, ma il formato dei numeri della serie «${sezionale}» non è riconosciuto: ` +
              `non è stato possibile sapere da quale numero ripartire. ${nienteEmesso} ` +
              'Non è un problema della sede né delle credenziali: va corretta l’app. Segnalalo.'
            )
          default:
            return (
              `Impossibile leggere l’ultimo numero della serie «${sezionale}» da Aruba. ` +
              `${nienteEmesso} Riprova più tardi.`
            )
        }
      })()
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        motivo: 'numerazione',
        messaggio: messaggioNumerazione,
      })
      continue
    }

    const numRes = await supabase.rpc('prossimo_numero_fattura_sezionale', {
      p_sezionale: sezionale,
      p_anno: anno,
      p_min: ultimoAruba,
    })
    if (numRes.error || typeof numRes.data !== 'number') {
      // PostgREST non lancia (AGENTS.md, regola 7): senza questa riga il difetto è
      // muto e in segreteria si legge solo «Numerazione fattura non disponibile».
      // Il fatto di dominio va come messaggio principale e l'errore del database
      // come `cause`, così `messaggio` dice QUALE serie non ha saputo numerare e
      // il `code` di PostgREST finisce comunque nella colonna `codice`.
      const dettoNumero = `allocazione del numero sulla serie ${sezionale} non riuscita: nessuna fattura emessa`
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento:prossimoNumero',
        esito: 'numerazione-rpc-fallita',
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        anno,
      }, erroreConCausa(dettoNumero, numRes.error))
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        motivo: 'numerazione',
        messaggio: 'Numerazione fattura non disponibile',
      })
      continue
    }
    const numero = numRes.data
    // Il pavimento in cache sale al numero appena assegnato: dentro un lotto la
    // lettura successiva parte da qui e non può proporre un numero già usato.
    memorizzaPavimento(chiaveSerie, numero)
    const numeroFattura = formattaNumeroFattura(sezionale, numero, anno)
    const progressivoInvio = progressivoInvioFattura(sezionale, numero, anno)

    let xml: string
    try {
      xml = buildFatturaElettronicaXml({
        progressivoInvio,
        numero: numeroFattura,
        data: dataDocumento,
        cedente,
        cessionario: {
          codiceFiscale: s(reg.fiscal_code),
          nome: s(reg.first_name),
          cognome: s(reg.last_name),
          sede: {
            indirizzo: s(reg.residence_address),
            numeroCivico: residenza.numeroCivico,
            cap: s(reg.zip_code),
            comune: s(reg.residence_city),
            provincia: residenza.provincia,
            nazione: 'IT',
          },
        },
        // LA DESCRIZIONE STA IN UN POSTO SOLO, ed è la riga. Fino al 2026-08-10 lo
        // stesso testo veniva passato anche come `causale`, cioè scritto DUE VOLTE
        // sullo stesso documento con due limiti diversi (1.000 qui, 200 in
        // `<Causale>`): una causale di 230 caratteri — facilissima col modello di
        // fabbrica più il suffisso « - quota Papà» — usciva intera nella riga e
        // tagliata a metà parola nell'intestazione. Sulle fatture vere della
        // cooperativa `<Causale>` è ASSENTE (misurato il 2026-08-10 su due
        // campioni scaricati da Aruba): la descrizione sta solo nella riga.
        righe: [{ descrizione: causale, prezzoUnitario: imponibile }],
        iva: ivaFattura,
        bollo: bolloImporto > 0 ? { importo: bolloImporto } : undefined,
        // Le fatture vere della cooperativa portano tutte il blocco pagamento, e
        // portano SOLO queste quattro cose: condizioni (TP02), modalità (MP05),
        // scadenza e importo. NIENTE `<IBAN>` e niente `<Beneficiario>` — misurato
        // sui campioni veri il 2026-08-10, e scritto in
        // `docs/fatturazione/tracciato-di-riferimento.md`. Aggiungerli «per
        // completezza» sarebbe una differenza dentro la stessa serie fiscale: il
        // PRD sosteneva il contrario e i due documenti erano stati scritti insieme;
        // ha ragione la misura. L'IBAN resta dov'è utile — sulle ricevute e nelle
        // comunicazioni — e resta fuori dal tracciato.
        pagamento: {
          dataScadenza: s(pag.scadenza) || dataDocumento,
        },
      })
    } catch (e) {
      // Il generatore LANCIA su un input che produrrebbe uno scarto certo. Tutto
      // ciò che si può verificare prima è già stato verificato sopra — cedente,
      // intestatario, coerenza IVA — proprio perché a QUESTO punto il numero è già
      // stato allocato: se si finisce qui, resta un buco nel sezionale, ed è il
      // motivo per cui questa riga è un `error` e non un ritorno silenzioso.
      const dettoXml = `composizione dell'XML fallita DOPO l'allocazione del numero ${numeroFattura}: il progressivo resta consumato`
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento:xml',
        esito: 'xml-non-componibile',
        scuola_id: pag.scuola_id,
        pagamento_id: pagamentoId,
        numero,
        anno,
        msg: dettoXml,
      }, e)
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        numero,
        numeroFattura,
        motivo: 'errore',
        messaggio: e instanceof Error ? e.message : 'Impossibile comporre la fattura elettronica',
      })
      continue
    }

    const baseRow = {
      pagamento_id: pagamentoId,
      scuola_id: pag.scuola_id,
      numero,
      sezionale,
      anno,
      progressivo_invio: progressivoInvio,
      causale,
      importo: importoQuota,
      intestatario: { nome: reg.first_name, cognome: reg.last_name, codice_fiscale: reg.fiscal_code },
      xml_inviato: xml,
      creato_da: attore.id,
      quota_adult_id: q.adultId,
      quota_label: q.label || null,
      parent_registry_id: reg.id,
      bollo_virtuale: bolloImporto > 0,
    }

    // ── IL RITMO, PRIMA DI SPENDERE L'ULTIMA RICHIESTA ───────────────────────
    // Se il pavimento è appena stato letto da Aruba, il secchio è stato toccato
    // adesso: l'upload si tiene a distanza. Una volta per invocazione, non una
    // per quota — le quote successive usano il token e il pavimento già in mano.
    if (ritmoDaPagare) {
      ritmoDaPagare = false
      await attendi(PAUSA_FRA_PAGINE_MS)
    }

    // ── L'INVIO, E LA RETE CHE FINALMENTE C'È SOTTO ──────────────────────────
    // `ensureToken()` e `arubaUpload()` stavano FUORI da ogni `try`, con il numero
    // già allocato. Un `429` sul `signin`, il tetto di 30 s del provider o una rete
    // caduta risalivano fino al `catch` della route: **500 «Internal Server Error»**,
    // nessuna riga a registro, e — la parte peggiore — nessuno in grado di dire se la
    // fattura fosse partita. Un timeout a trenta secondi non significa che Aruba non
    // abbia ricevuto il file.
    let up: ArubaUploadResult
    try {
      const token = await ensureToken()
      // NIENTE `senderPIVA`: il documento è un TD01 e il mittente è il cedente dell'XML, che
      // è l'utenza stessa. Passarlo — e a 11 cifre nude — è ciò che il 2026-09-03 ha fatto
      // respingere la prima fattura vera con `0093` «deleghe non valide» (vedi `arubaUpload`).
      up = await arubaUpload(cfg.ambiente, token, {
        dataFileBase64: Buffer.from(xml, 'utf-8').toString('base64'),
      })
    } catch (e) {
      // `code` viene da `erroreAruba` (`'rete'`, o lo status quando una risposta
      // c'era). Finisce nel motivo a registro perché «rete» e «429» mandano a
      // guardare in due posti diversi, e la colonna è l'unica cosa che resta.
      const quale = String((e as { code?: unknown } | null)?.code ?? 'ignoto')
      const motivo = motivoTrasporto(quale)
      const { error: errTrasporto } = await supabase
        .from('fatture_emesse')
        .insert({ ...baseRow, sdi_stato: null, sdi_stato_label: LABEL_TRASPORTO, sdi_scarto_motivo: motivo })
      // `withRoute` NON vede le eccezioni catturate: senza questa riga il caso più
      // velenoso del file resterebbe muto. Il corpo del provider viaggia dentro `e`
      // (il client lo conserva) e DEVE restare il messaggio della riga — è l'unica
      // cosa che distingue un token scaduto da una rete caduta. Per questo `e` va
      // passato SEMPRE: se anche l'INSERT è fallito, quel fatto ha una riga sua.
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento:upload',
        esito: 'upload-esito-ignoto',
        provider: 'aruba',
        scuola_id: pag.scuola_id,
        numero,
        anno,
      }, e)
      if (errTrasporto) {
        segnalaTrasportoNonRegistrato(pag.scuola_id, numero, anno, numeroFattura, quale, errTrasporto)
      }
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        numero,
        numeroFattura,
        motivo: 'errore',
        httpStatus: 502,
        messaggio: messaggioTrasporto(numeroFattura, quale),
      })
      continue
    }

    if (up.trasporto) {
      // RIFIUTO DI TRASPORTO: Aruba ha risposto, ma non sul MERITO del documento
      // (429 sopravvissuto al ritentativo, 401/403, 5xx, o un 2xx illeggibile).
      // A registro sì — il numero è consumato — ma senza `sdi_stato: 2`, che
      // significa «scartata» e qui sarebbe falso.
      // ── COME SI CHIAMA IL GUASTO, NELLA COLONNA CHE LEGGE LA SEGRETERIA ────
      // `sdi_scarto_motivo` è l'unica cosa davanti a chi deve decidere se ripremere:
      // deve nominare il guasto, non stampare un numero che dice il contrario.
      //  · un `0034` arrivato in risposta al NOSTRO ritentativo porta uno status `2xx`, ma
      //    la notizia non è lo status: è che il primo invio era stato ricevuto. «TRASPORTO
      //    200» lo nasconderebbe. A dirlo è `up.dopoRitentativo`, un campo del contratto del
      //    client, e NON `up.errorCode === '0034'`: il ramo `!esito.ok` di `client.ts` copia
      //    nell'esito l'`errorCode` dell'envelope del rifiuto, quindi un HTTP non-2xx col
      //    corpo `{"errorCode":"0034",…}` e nessun `429` di mezzo arriva qui identico — ed è
      //    un rifiuto di trasporto ordinario, da raccontare col suo status. Guardare il solo
      //    `errorCode` scriverebbe «TRASPORTO 0034 dopo un 429» su un `429` mai arrivato:
      //    una frase falsa, in una colonna dove il trigger WORM vieta il `DELETE`;
      //  · un `2xx` con il corpo illeggibile è il caso peggiore da raccontare con un
      //    numero solo — «TRASPORTO 200: esito ignoto» mette un 200 dentro un motivo di
      //    fallimento, e chi legge lo associa a un successo.
      // Tutto il resto (429, 401/403, 5xx) è già parlante con il suo numero.
      const quale = up.dopoRitentativo
        ? '0034 dopo un 429'
        : up.statoHttp !== undefined && up.statoHttp >= 200 && up.statoHttp < 300
          ? `${up.statoHttp} illeggibile`
          : String(up.statoHttp ?? 'ignoto')
      // Il prefisso «HTTP» ha senso solo quando `quale` È uno status: «HTTP 0034 dopo un
      // 429» sarebbe la stessa specie di frase falsa che le righe qui sopra evitano.
      const detto = up.dopoRitentativo ? quale : `HTTP ${quale}`
      const motivo = motivoTrasporto(quale)
      const { error: errTrasporto } = await supabase
        .from('fatture_emesse')
        .insert({ ...baseRow, sdi_stato: null, sdi_stato_label: LABEL_TRASPORTO, sdi_scarto_motivo: motivo })
      // LA CHIAVE È `stato`, E IL NOME NON È INTERCAMBIABILE. `logger.ts` promuove alla
      // colonna `app_log.stato_http` una sola chiave — `numeroDi(campi, 'stato')` — e solo
      // se il valore è un numero. Chiamandola `status` il 429 restava dentro il JSONB
      // `contesto.campi`: leggibile, ma non filtrabile, e «quanti 429 sull'upload questo
      // mese» smetteva di essere una query. Niente `?? 0`, poi: qui `statoHttp` è sempre
      // valorizzato (il ramo `!esito.ok` e quello del 2xx illeggibile in `client.ts` lo
      // riempiono entrambi; senza risposta si LANCIA e si finisce nel `catch` sopra), e
      // uno zero in quella colonna sarebbe uno status HTTP che non esiste.
      //
      // Il CORPO della risposta (per il 429 una pagina HTML intera) è già in `app_log` per
      // mano di `externalFetch`: non si ricopia qui, e non entra mai nella colonna che la
      // segreteria legge.
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento:upload',
        esito: 'upload-trasporto',
        provider: 'aruba',
        scuola_id: pag.scuola_id,
        stato: up.statoHttp,
        numero,
        anno,
        msg: `fattura ${numeroFattura}: Aruba non ha concluso l'invio (${detto}); esito ignoto, numero consumato`,
      })
      if (errTrasporto) {
        segnalaTrasportoNonRegistrato(pag.scuola_id, numero, anno, numeroFattura, detto, errTrasporto)
      }
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        numero,
        numeroFattura,
        motivo: 'errore',
        httpStatus: 502,
        messaggio: messaggioTrasporto(numeroFattura, detto),
      })
      continue
    }

    if (!up.ok) {
      const { error: errScarto } = await supabase
        .from('fatture_emesse')
        .insert({ ...baseRow, sdi_stato: 2, sdi_stato_label: 'Errore upload', sdi_scarto_motivo: up.errorDescription ?? up.errorCode })
      // IL MOTIVO DEL RIFIUTO ESCE DAL DATABASE. Prima finiva solo in
      // `fatture_emesse.sdi_scarto_motivo` e nel corpo HTTP della risposta: nei log restava
      // `KV_ERR evt=route stato=502`, cioè un numero. `error_code` è in lista bianca di
      // `redact` (si legge in chiaro anche in tabella), la descrizione va nel `msg` — che
      // diventa la colonna `app_log.messaggio`, sanificata: se Aruba echeggia un codice
      // fiscale nel motivo dello scarto, `sanificaMessaggio` lo maschera.
      //
      // L'eventuale errore dell'INSERT viaggia come `cause`, non come errore principale: chi
      // legge deve trovare per primo il motivo di Aruba (che è la notizia), col guasto del
      // registro attaccato sotto. Passato come errore principale, il suo messaggio SOSTITUIREBBE
      // il nostro nella colonna `messaggio` — `logEvento` dà ragione all'errore, non ai campi.
      const dettoScarto = `fattura ${numeroFattura} scartata da Aruba (${up.errorCode}): ${up.errorDescription ?? 'nessun motivo dal provider'}`
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento',
        esito: 'scartata',
        provider: 'aruba',
        scuola_id: pag.scuola_id,
        numero,
        anno,
        error_code: up.errorCode,
        msg: dettoScarto,
      }, errScarto ? erroreConCausa(`${dettoScarto} — e la riga di scarto NON è stata scritta a registro`, errScarto) : undefined)
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        numero,
        numeroFattura,
        motivo: 'scartata',
        messaggio: up.errorDescription || `Emissione scartata (${up.errorCode})`,
      })
      continue
    }

    const { error: errRegistro } = await supabase
      .from('fatture_emesse')
      .insert({ ...baseRow, aruba_filename: up.uploadFileName, sdi_stato: 1, sdi_stato_label: 'Presa in carico', inviata_il: new Date().toISOString() })

    if (errRegistro) {
      // IL CASO PIÙ VELENOSO DEL FILE. La fattura È PARTITA (Aruba ha risposto `0000` e ha
      // dato il suo `uploadFileName`), ma la riga a registro non c'è: nessun giro di
      // `fattura/sync` la ripescherà mai, e lo scarto SDI che arrivasse fra un'ora non lo
      // saprebbe nessuno. PostgREST NON LANCIA — ritorna `{ error }` (AGENTS.md, regola 7) —
      // quindi il `try/catch` della route non scatta e senza questa riga il difetto è muto.
      //
      // L'esito resta `ok`, ed è deliberato: dichiararlo fallito inviterebbe la segreteria a
      // rifare l'emissione, cioè a mandare allo SDI una SECONDA fattura per lo stesso
      // pagamento. Il documento c'è, il registro no: è un disallineamento da riparare a mano,
      // e il `uploadFileName` nel messaggio è l'unico appiglio per ritrovarla su Aruba.
      //
      // L'errore di PostgREST è la `cause`: il messaggio principale deve dire QUALE fattura è
      // rimasta orfana (col nome file), non «duplicate key value violates unique constraint».
      // Il `code` del DB non si perde — `logEvento` lo pesca dalla causa per la colonna `codice`.
      //
      // IL 23505 È UN CASO A PARTE, e va nominato. I due indici unici di
      // `fatture_emesse` sono `(sezionale, anno, numero)` e
      // `(pagamento_id, quota_adult_id)` sulle righe non scartate: se uno dei due
      // rifiuta QUI, il database sta dicendo che per questa quota (o per questo
      // numero) un documento esisteva già — cioè che allo SDI è appena partita una
      // seconda fattura, ed è l'unico momento in cui qualcuno può accorgersene.
      // «duplicate key value violates unique constraint» da solo non lo racconta.
      const doppione = (errRegistro as { code?: string } | null)?.code === '23505'
      const dettoOrfana = doppione
        ? `DOPPIA EMISSIONE: la fattura ${numeroFattura} è partita verso Aruba (${up.uploadFileName ?? 'senza nome file'}) ma il registro l'ha RIFIUTATA perché per questa quota (o per questo numero) esisteva già un documento. Verifica su Aruba e prepara la nota di variazione`
        : `fattura ${numeroFattura} inviata ad Aruba (${up.uploadFileName ?? 'senza nome file'}) ma NON scritta a registro: resterà fuori dal sync SDI`
      logEvento('fattura', 'error', {
        operazione: 'emettiFatturaPagamento',
        // `esito` è in lista bianca e resta in chiaro in tabella: due valori diversi
        // rendono interrogabile la differenza fra «riga persa» e «doppione emesso».
        esito: doppione ? 'registro-doppione-rifiutato' : 'registro-non-scritto',
        provider: 'aruba',
        scuola_id: pag.scuola_id,
        numero,
        anno,
        msg: dettoOrfana,
      }, erroreConCausa(dettoOrfana, errRegistro))
    } else {
      // IL BATTITO (AGENTS.md, regola 5). `fattura` è in `EVENTI_PERSISTITI` proprio perché
      // questa riga arrivi in tabella: con i soli errori, «nessun log evento=fattura» non
      // distingue «nessuno ha emesso fatture» da «l'emissione non parte più». Misurato in
      // produzione il 2026-08-02: 1 sola riga in 30 giorni, livello error, ZERO info.
      //
      // `numero`/`anno` sono numeri e `scuola_id` un uuid: `redact` li lascia in chiaro anche
      // in tabella. Il nome file e il SEZIONALE non sono in lista bianca (uscirebbero
      // `[redatto:str/N]`), perciò stanno nel `msg`, che diventa la colonna `messaggio` — in
      // chiaro e sanificata. È la chiave con cui si ritrova la fattura sul portale Aruba e
      // nella tabella del sync.
      logEvento('fattura', 'info', {
        operazione: 'emettiFatturaPagamento',
        esito: 'inviata',
        provider: 'aruba',
        scuola_id: pag.scuola_id,
        numero,
        anno,
        msg: `fattura ${numeroFattura} inviata ad Aruba: ${up.uploadFileName ?? 'senza nome file'}`,
      })
    }

    esiti.push({ adultId: q.adultId, label: q.label, ok: true, numero, numeroFattura, uploadFileName: up.uploadFileName ?? undefined })
  }

  // 8. aggregato lato pagamento
  //
  // ⚠️ `fattura_causale` NON viene più riscritto qui. Era la causale COMPOSTA, e
  // dal giro successivo l'emissione la rileggeva come se fosse una correzione
  // umana: il modello della categoria smetteva di avere effetto e nessuno poteva
  // capire perché. Quel campo torna a significare una cosa sola — ciò che la
  // segreteria ha scritto a mano — e la causale davvero emessa resta a registro,
  // in `fatture_emesse.causale`.
  const okEsiti = esiti.filter((e) => e.ok)
  const nowIso = new Date().toISOString()
  if (okEsiti.length === 0) {
    const { error: errAggScarto } = await supabase
      .from('pagamenti')
      .update({ fattura_stato: 'scartata' })
      .eq('id', pagamentoId)
    if (errAggScarto) segnalaStatoNonAggiornato(pagamentoId, pag.scuola_id, 'scartata', errAggScarto)
    const first = esiti[0]
    const motivoAgg =
      first?.motivo === 'intestatario_mancante' ? 'intestatario_mancante'
      : first?.motivo === 'numerazione' ? 'numerazione_non_allineata'
      // Una riga IVA incoerente è una CONFIGURAZIONE da correggere, non uno scarto
      // del provider: 503 come il cedente incompleto, e lo stesso invito a
      // sistemare le impostazioni invece di riprovare.
      : first?.motivo === 'configurazione' ? 'non_configurato'
      : first?.motivo === 'errore' ? 'errore'
      : 'scartata'
    return {
      ok: false,
      motivo: motivoAgg,
      messaggio: first?.messaggio ?? 'Emissione non riuscita',
      // `first.httpStatus` vince sulla mappa quando la quota lo dichiara: serve al
      // RIFIUTO DI TRASPORTO, che esce con `motivo: 'errore'` ma non è un guasto
      // nostro — 500 direbbe «Internal Server Error» su un 429 di Aruba, e
      // inviterebbe a ripremere «Emetti» su un numero già consumato.
      httpStatus:
        first?.httpStatus
        ?? (motivoAgg === 'intestatario_mancante' ? 422
        : motivoAgg === 'numerazione_non_allineata' ? 503
        : motivoAgg === 'non_configurato' ? 503
        : motivoAgg === 'errore' ? 500
        : 502),
      quote: multi ? esiti : undefined,
    }
  }

  // Almeno una quota emessa → il pagamento va in attesa (lo SDI conferma via sync).
  const { error: errAggAttesa } = await supabase
    .from('pagamenti')
    .update({
      fattura_stato: 'in_attesa',
      fattura_aruba_id: okEsiti[0].uploadFileName ?? null,
      fattura_emessa_il: nowIso,
    })
    .eq('id', pagamentoId)
  if (errAggAttesa) segnalaStatoNonAggiornato(pagamentoId, pag.scuola_id, 'in_attesa', errAggAttesa)

  return {
    ok: true,
    fatturaStato: 'in_attesa',
    uploadFileName: okEsiti[0].uploadFileName ?? '',
    numero: okEsiti[0].numero ?? 0,
    numeroFattura: okEsiti[0].numeroFattura,
    quote: multi ? esiti : undefined,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Letture accessorie: degradano da sole, e lo dicono.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Provincia e numero civico del cessionario: due elementi FACOLTATIVI del tracciato. */
interface ResidenzaEstesa {
  provincia?: string
  numeroCivico?: string
}

/**
 * `parents.residence_province` e `parents.residence_street_number` — due colonne
 * che oggi non entravano nell'XML, e che il tracciato tiene separate
 * dall'indirizzo perché non le sa ricavare da una stringa unica.
 *
 * Query a parte, e non due colonne in più dentro `resolveParentRegistry`: quella
 * funzione la usano anche ricevute, attestazioni, incassi ed export, e sul
 * database E2E della CI (non migrato) una colonna assente fa fallire l'INTERA
 * SELECT con `42703` — cioè trasformerebbe un dettaglio d'indirizzo in
 * «intestatario non risolvibile» su quattro strade che oggi funzionano. Qui, se
 * la lettura non riesce, si omettono due elementi facoltativi e la fattura parte
 * lo stesso.
 */
async function leggiResidenzaEstesa(
  supabase: SupabaseClient,
  parentId: string,
  scuolaId: string | null | undefined,
): Promise<ResidenzaEstesa> {
  const { data, error } = await supabase
    .from('parents')
    .select('residence_province, residence_street_number')
    .eq('id', parentId)
    .maybeSingle()
  if (error) {
    // `warn` e non `error`: i due elementi sono FACOLTATIVI per il tracciato, la
    // fattura parte lo stesso. Ma non in silenzio — sul database E2E della CI
    // (non migrato) qui arriva un `42703`, e questa riga è ciò che lo distingue
    // da «quel genitore non ha compilato l'indirizzo».
    logEvento('fattura', 'warn', {
      operazione: 'emettiFatturaPagamento:residenzaCessionario',
      esito: 'residenza-estesa-non-letta',
      scuola_id: scuolaId ?? '',
    }, error)
    return {}
  }
  const riga = (data ?? {}) as { residence_province?: string | null; residence_street_number?: string | null }
  return {
    provincia: s(riga.residence_province).trim() || undefined,
    numeroCivico: s(riga.residence_street_number).trim() || undefined,
  }
}

/* ─── L'IBAN NON ENTRA NELLA FATTURA ELETTRONICA, e qui c'era la funzione che ce
 * lo metteva ────────────────────────────────────────────────────────────────
 *
 * `leggiIban(fiscaleCfg)` leggeva `admin_settings.fiscale_config.iban` e lo
 * passava a `<DatiPagamento>`. Il PRD lo prescriveva («IBAN da `fiscale_config`»)
 * mentre `docs/fatturazione/tracciato-di-riferimento.md`, scritto nello stesso
 * lavoro, elencava «aggiungere IBAN per completezza» fra gli errori: due
 * documenti committati insieme che dicevano il contrario su un documento
 * irreversibile. Ha deciso la MISURA, non l'argomento: il 2026-08-10 due fatture
 * vere scaricate da Aruba (`Asilo 2327/2026`, `FPR 1946/26`) hanno in
 * `<DettaglioPagamento>` soltanto `ModalitaPagamento`, `DataScadenzaPagamento` e
 * `ImportoPagamento`.
 *
 * La funzione è stata tolta invece di lasciata senza chiamanti: un helper che
 * nessuno chiama è un invito a richiamarlo. Il campo `fiscale_config.iban` resta
 * dov'è e continua a servire alle ricevute e ai solleciti.
 */
