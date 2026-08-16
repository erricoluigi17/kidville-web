/**
 * Gli otto prestampati che riguardano il genitore — n. 05, 06, 07, 08, 09, 10, 26·27 e 28
 * di `docs/prestampati/`.
 *
 * Un modello qui dentro è una DEFINIZIONE, non un generatore: dichiara il proprio
 * `document_type`, il titolo, a chi è disponibile, che firma pretende, quali campi il
 * form deve chiedere (schema `zod` + descrittori per costruirlo) e come si compone
 * l'elenco dei blocchi che poi impagina `buildPrestampatoPdf()`. Niente I/O, niente
 * Supabase, niente jsPDF: un prestampato si collauda senza tirarsi dietro il PDF, e le
 * misure in millimetri stanno tutte in `impaginazione.ts`.
 *
 * ─── PERCHÉ QUESTI MODULI RICHIEDONO OGNI VOLTA GLI STESSI DATI ──────────────────
 *
 * `docs/prestampati/README.md` dice che «un campo chiesto una volta non si richiede mai
 * più»: pediatra, ASL, contatti d'emergenza, terapie e sostituzioni alimentari
 * dovrebbero entrare in anagrafica al primo modulo e dal secondo essere prefill. Oggi
 * NON è così, e non è una dimenticanza: quelle colonne (e le tabelle dei contatti
 * d'emergenza, delle dosi somministrate e delle righe alimento→sostituzione) non
 * esistono, e il titolare ha vietato migrazioni su un database che contiene dati reali
 * di minori. Finché il divieto vale, quei campi li chiede il form ogni volta e
 * finiscono SOLO nel PDF.
 *
 * Chi legge dopo lo scambierebbe per una svista e «sistemerebbe» aggiungendo colonne:
 * il punto è che la decisione è già stata presa, e va riaperta con il titolare, non con
 * una `apply_migration`. I campi da promuovere sono marcati `daPromuovereInAnagrafica`
 * — sono l'elenco esatto di ciò che quel giorno diventa prefill.
 *
 * ─── ART. 9 GDPR ────────────────────────────────────────────────────────────────
 *
 * 05, 06 e 07 portano dati sanitari di un minore: allergie, farmaci, diagnosi, diete.
 * Nessuno di questi valori entra MAI in un log — né come valore, né come «solo
 * l'allergene», né come lunghezza del testo. Questo file non logga niente di proposito:
 * è puro, e chi lo chiama logga l'operazione (uuid, esito, durata), non il contenuto.
 *
 * Testato in `__tests__/lib/prestampati-modelli-genitore.test.ts`.
 */

import { z } from 'zod'
import {
  buildCertificatoBody,
  buildIntestazioneSede,
  rigaLuogoData,
  type SedeCertificato,
} from '@/lib/certificati/self-service'
import { isoToIt } from '@/lib/format/data'
import { zDataYMD } from '@/lib/validation/common'
import type { BloccoPrestampato, CampoPrestampato } from '@/lib/prestampati/tipi'

// ─── Il descrittore del form ────────────────────────────────────────────────────

/** I `document_type` degli otto modelli di questo file. */
export type SlugPrestampatoGenitore =
  | 'scheda_sanitaria'
  | 'autorizzazione_farmaci'
  | 'dieta_speciale'
  | 'delega_ritiro'
  | 'permesso_orario'
  | 'autorizzazione_uscita'
  | 'certificato_iscrizione_frequenza'
  | 'certificato_bonus_nido'

/** Chi può far nascere il documento. */
export type DisponibileA = 'genitore' | 'segreteria' | 'genitore_e_segreteria'

/**
 * Che sottoscrizione pretende il foglio (§3 di `00-impaginazione.md`).
 *
 * `otp_genitore` vale anche per il 06, che oltre alla firma vuole l'accettazione della
 * Direzione: quella non è una firma del documento, è un visto d'ufficio e vive nel
 * riquadro «PER ACCETTAZIONE» del corpo.
 */
export type FirmaRichiesta = 'otp_genitore' | 'otp_due_genitori' | 'legale_rappresentante'

export type TipoCampoModulo =
  | 'testo'
  | 'testoLungo'
  | 'numero'
  | 'telefono'
  | 'data'
  | 'ora'
  | 'siNo'
  | 'scelta'
  | 'file'
  /** Tabella a righe ripetibili: le colonne stanno in `colonne`. */
  | 'righe'

export interface OpzioneCampo {
  valore: string
  etichetta: string
}

/**
 * Un campo che il form deve chiedere. Il nucleo comune — nome, cognome, nascita, codice
 * fiscale, sezione, sede, scuola, genitore, anno scolastico — non compare MAI qui: l'app
 * quei dati li ha già, e richiederli è il modo più rapido di far abbandonare un modulo.
 */
export interface CampoModulo {
  /** Chiave nelle risposte: coincide con quella dello schema `zod`. */
  nome: string
  etichetta: string
  tipo: TipoCampoModulo
  /**
   * Obbligatorio SEMPRE, in ogni combinazione di risposte.
   *
   * I campi obbligatori solo in certi casi — la specifica di un'allergia dichiarata, il
   * certificato di una dieta sanitaria, l'orario di un'uscita anticipata — restano
   * `false` qui e portano il loro `mostraSe`: la condizione vive nello schema `zod`, che
   * è l'unico posto in cui il rifiuto è vero. Un `obbligatorio: true` condizionale
   * segnerebbe con l'asterisco un campo che il modulo nemmeno mostra.
   */
  obbligatorio: boolean
  /** Testo di aiuto sotto il campo: spiega perché serve, non cosa è. */
  aiuto?: string
  opzioni?: readonly OpzioneCampo[]
  /** Più risposte ammesse (es. i giorni di un permesso ricorrente). */
  multipla?: boolean
  /** Colonne di una tabella `righe`. */
  colonne?: readonly CampoModulo[]
  /** Il campo si mostra solo quando un altro ha uno di questi valori. */
  mostraSe?: { campo: string; valori: readonly (string | boolean)[] }
  /** L'app riempie il campo da qui, e la persona può correggerlo. */
  precompilatoDa?: string
  /**
   * Elenco che l'app costruisce a runtime perché dipende dall'alunno: i delegati attivi
   * di `delegates`. Il form NON lascia scrivere un nome libero — sul cartaceo c'è
   * scritto «allegare delega» e nessuno la allega mai (doc. 09).
   */
  opzioniDaApp?: 'delegati_attivi'
  /** Chiesto solo a chi emette il documento allo sportello, non al genitore. */
  chiestoA?: 'segreteria'
  /**
   * Colonna/tabella in cui questo campo dovrà atterrare quando le migrazioni
   * torneranno possibili. Finché resta valorizzato, il dato vive solo nel PDF.
   */
  daPromuovereInAnagrafica?: string
}

// ─── I dati precompilati (il nucleo comune) ─────────────────────────────────────

/** Gli stessi tre gradi del resto del repo (`sections.school_type`). */
export type LivelloScolastico = 'nido' | 'infanzia' | 'primaria'

const ETICHETTE_LIVELLO: Record<LivelloScolastico, string> = {
  nido: 'Nido',
  infanzia: "Scuola dell'Infanzia",
  primaria: 'Scuola Primaria',
}

export interface DatiAlunno {
  nome: string
  cognome: string
  /** ISO `aaaa-mm-gg`, come la colonna `alunni.data_nascita`. */
  dataNascita?: string | null
  /** `alunni.birth_city` + `alunni.birth_province`, già composti. */
  luogoNascita?: string | null
  codiceFiscale?: string | null
  /** `alunni.classe_sezione`. */
  sezione?: string | null
  /**
   * `sections.school_type` della sezione dell'alunno. È l'UNICA fonte del campo Livello
   * del 26·27: senza sezione non c'è niente da cui dedurlo, e un livello indovinato su
   * un certificato che va a un ente è una dichiarazione falsa.
   *
   * Sul 28 non è una riga da stampare ma un cancello: `nido` o niente certificato.
   */
  livello?: LivelloScolastico | null
  /** `alunni.genitori_separati`: se vero la doppia firma dell'08 resta obbligatoria. */
  genitoriSeparati?: boolean | null
}

export type RuoloGenitore = 'padre' | 'madre' | 'tutore'

export interface DatiGenitore {
  /** Cognome e nome, come li scrive `parents`. */
  nomeCompleto: string
  ruolo?: RuoloGenitore | null
  telefono?: string | null
  email?: string | null
}

/**
 * La sede. Estende `SedeCertificato` — e non lo ricopia — perché è la forma che
 * `buildIntestazioneSede()` già sa leggere: l'intestazione dei prestampati è quella dei
 * certificati, non una seconda versione che fra sei mesi degrada in modo diverso.
 */
export interface DatiSede extends SedeCertificato {
  /** Estremi dell'autorizzazione al funzionamento del nido (doc. 28). */
  autorizzazioneNido?: AutorizzazioneNido | null
}

/**
 * Uno per ciascuna delle tre sedi: sono tre autorizzazioni diverse, con numeri, date ed
 * enti emittenti diversi. Vivono in `scuole.config.anagrafica`, mai in codice.
 */
export interface AutorizzazioneNido {
  numero?: string | null
  /** ISO `aaaa-mm-gg`. */
  data?: string | null
  /**
   * L'ente che ha EMESSO il provvedimento, per intero e già scritto come va stampato.
   *
   * ⚠️ Si chiamava `comune`, e il nome non era un dettaglio: sulle tre sedi vere due
   * autorizzazioni su tre le ha rilasciate un **Ambito socio-sanitario**, non un Comune
   * (spec §2.1). Finché il campo si chiamava così, tre punti diversi della catena — la
   * chiave in configurazione, l'etichetta del form, il testo stampato — affermavano che
   * l'emittente fosse un Comune, e il certificato lo dichiarava all'INPS.
   */
  ente?: string | null
}

/**
 * L'ente gestore. Tutto da `scuole.config.anagrafica`: il repository è pubblico e il CdA
 * cambia, e un nome scritto in un `.ts` è un nome che un giorno sarà sbagliato in venti
 * documenti nello stesso momento.
 */
export interface DatiScuola {
  ragioneSociale?: string | null
  /** P.IVA / codice fiscale dell'ente gestore. */
  piva?: string | null
  sedeLegale?: string | null
  legaleRappresentante?: string | null
}

/** Il visto d'ufficio: accettazione della Direzione (06), presa in carico (07), presa visione (09). */
export interface VistoUfficio {
  /** Nome di chi ha apposto il visto. */
  utente: string
  /** Istante già formattato per la stampa (es. `13/08/2026 10:24`). */
  istante: string
}

/**
 * Una firma raccolta (doc. 08, che ne vuole due).
 *
 * Solo nome e istante: email e indirizzo IP stanno nella ricevuta FEA
 * (`src/lib/fea/receipt-pdf.ts`), che è un altro documento e si scarica a parte.
 */
export interface Sottoscrizione {
  firmatario: string
  istante: string
}

export interface DatiUscita {
  /** Uno dei `TIPI_USCITA`. */
  tipo: TipoUscita
  /** Dettaglio libero quando `tipo` è `altro`. */
  tipoDettaglio?: string | null
  destinazione: string
  /** ISO `aaaa-mm-gg`. */
  data: string
  oraPartenza?: string | null
  oraRientro?: string | null
  /** Uno dei `MEZZI_TRASPORTO`. */
  mezzo?: MezzoTrasporto | null
  mezzoDettaglio?: string | null
  /** Se vero il form chiede «sa nuotare», e senza quella risposta il PDF non si compone. */
  attivitaInAcqua?: boolean | null
}

/** Tutto ciò che l'app sa già, e che quindi il form non chiede. */
export interface DatiPrestampato {
  alunno: DatiAlunno
  /**
   * Tutti i genitori/tutori collegati in `student_parents`, nell'ordine in cui
   * l'anagrafica li restituisce. **Quell'ordine non dice chi firma**: è il criterio con
   * cui il database li ha ordinati, non una scelta di nessuno.
   */
  genitori: readonly DatiGenitore[]
  /**
   * Chi sta compilando e firmando — «il/la sottoscritto/a» del cartaceo (06, 09).
   *
   * Lo sa la route, che ha l'utente autenticato, e lo dichiara qui. Prima veniva dedotto
   * da `genitori[0]`, e con due tutori in anagrafica il primo dell'elenco è il padre
   * anche quando a firmare è la madre: un permesso di uscita anticipata che dichiara come
   * accompagnatore una persona diversa da chi l'ha chiesto.
   */
  richiedente?: DatiGenitore | null
  sede: DatiSede
  scuola: DatiScuola
  /** Da `annoScolasticoCorrente()`. */
  annoScolastico: string
  /** ISO `aaaa-mm-gg` del giorno di emissione. */
  dataOggi: string
  /** 06 · 07 · 09 — il visto d'ufficio, quando è già stato apposto. */
  visto?: VistoUfficio | null
  /** 08 — le firme raccolte, in ordine. */
  sottoscrizioni?: readonly Sottoscrizione[]
  /**
   * 09 — il delegato scelto, già risolto in cognome e nome dai `delegates` attivi. Per
   * «io stesso» non serve: quel ramo legge `richiedente`.
   */
  accompagnatore?: string | null
  /** 10 — l'uscita creata dalla segreteria, uguale per tutta la sezione. */
  uscita?: DatiUscita | null
}

// ─── Il modello e la sua composizione ───────────────────────────────────────────

export interface ErroreCampo {
  /** Percorso del campo nelle risposte; vuoto quando l'errore riguarda il contesto. */
  campo: string
  messaggio: string
}

/**
 * L'esito di una composizione.
 *
 * Il ramo riuscito porta anche le RISPOSTE VALIDATE, e non è un varco: sono esattamente
 * quelle che lo schema ha appena accettato, non le grezze. Senza, la route che deve
 * ricavare `expiry_date` (dall'`al` del 06 e dell'08, dalla `validita` del 07) sarebbe
 * costretta a validare due volte — una qui e una fuori — con due sorgenti di verità sullo
 * stesso dato e nessuna garanzia che restino d'accordo.
 */
export type EsitoComposizione<R = unknown> =
  | { ok: true; blocchi: BloccoPrestampato[]; risposte: R }
  | { ok: false; errori: ErroreCampo[] }

/**
 * `R` sono le risposte del modello. Con il valore predefinito `unknown` il tipo resta
 * usabile senza parametri — è la forma con cui vive nel registro, dove gli otto modelli
 * hanno otto tipi di risposte diversi — mentre chi importa un modello per nome le vede
 * tipate fin dentro l'esito.
 */
export interface ModelloPrestampato<R = unknown> {
  readonly slug: SlugPrestampatoGenitore
  readonly titolo: string
  readonly disponibileA: DisponibileA
  readonly firma: FirmaRichiesta
  readonly campi: readonly CampoModulo[]
  /** Esposto per chi vuole solo validare (o generare il form) senza comporre. */
  readonly schema: z.ZodType<R>
  /**
   * Valida le risposte e, solo se reggono, compone i blocchi. I due passi non si
   * separano di proposito: un documento composto da risposte non validate è un foglio
   * firmato che dichiara cose che nessuno ha controllato.
   */
  componi(dati: DatiPrestampato, risposteGrezze: unknown): EsitoComposizione<R>
}

/**
 * Sigilla un modello: fuori di qui il tipo delle risposte non serve a nessuno, e tenerlo
 * generico costringerebbe ogni chiamante a sapere quale modello sta usando prima di
 * poterlo usare.
 *
 * `verificaContesto` è il secondo cancello, e serve per una ragione precisa: alcune
 * regole non stanno nelle risposte. Che il 10 debba chiedere «sa nuotare» dipende
 * dall'uscita creata dalla segreteria; che l'08 pretenda due firme dipende
 * dall'anagrafica; che il 28 sia emettibile dipende dagli estremi dell'autorizzazione
 * comunale. `zod` non può vederle, e lasciarle al chiamante significa scoprirle il
 * giorno in cui manca il controllo.
 */
function definisciModello<R>(m: {
  slug: SlugPrestampatoGenitore
  titolo: string
  disponibileA: DisponibileA
  firma: FirmaRichiesta
  campi: readonly CampoModulo[]
  schema: z.ZodType<R>
  verificaContesto?: (dati: DatiPrestampato, risposte: R) => ErroreCampo[]
  componi: (dati: DatiPrestampato, risposte: R) => BloccoPrestampato[]
}): ModelloPrestampato<R> {
  return {
    slug: m.slug,
    titolo: m.titolo,
    disponibileA: m.disponibileA,
    firma: m.firma,
    campi: m.campi,
    schema: m.schema,
    componi(dati, risposteGrezze) {
      const esito = m.schema.safeParse(risposteGrezze)
      if (!esito.success) return { ok: false, errori: erroriDaZod(esito.error) }
      const contesto = m.verificaContesto?.(dati, esito.data) ?? []
      if (contesto.length > 0) return { ok: false, errori: contesto }
      return { ok: true, blocchi: m.componi(dati, esito.data), risposte: esito.data }
    },
  }
}

function erroriDaZod(errore: z.ZodError): ErroreCampo[] {
  return errore.issues.map((problema) => ({
    campo: problema.path.join('.'),
    messaggio: problema.message,
  }))
}

// ─── Elenchi chiusi (le voci del cartaceo) ──────────────────────────────────────

function opzioniDa<T extends string>(valori: readonly T[], etichette: Record<T, string>): OpzioneCampo[] {
  return valori.map((valore) => ({ valore, etichetta: etichette[valore] }))
}

export const MOTIVI_DIETA = [
  'allergia_alimentare',
  'intolleranza_alimentare',
  'etico_religiosi',
  'scelta_alimentare',
  'altro',
] as const
export type MotivoDieta = (typeof MOTIVI_DIETA)[number]
const ETICHETTE_MOTIVO_DIETA: Record<MotivoDieta, string> = {
  allergia_alimentare: 'Allergia alimentare',
  intolleranza_alimentare: 'Intolleranza alimentare',
  etico_religiosi: 'Motivi etico-religiosi',
  scelta_alimentare: 'Scelta alimentare (vegetariana/vegana)',
  altro: 'Altro',
}

/**
 * Il motivo è sanitario? Non è una sfumatura: cambia **cosa è obbligatorio** e **quale
 * base giuridica** regge il trattamento. Una dieta vegetariana non richiede un
 * certificato medico, e chiederlo sarebbe una raccolta di dati non necessaria.
 *
 * `altro` NON si presume sanitario: presumerlo significherebbe pretendere un certificato
 * medico da chi ha scritto «il bambino non digerisce il pomodoro».
 */
export function motivoSanitario(motivo: MotivoDieta): boolean {
  return motivo === 'allergia_alimentare' || motivo === 'intolleranza_alimentare'
}

export const VALIDITA_DELEGA = ['permanente', 'periodo', 'occasione'] as const
export type ValiditaDelega = (typeof VALIDITA_DELEGA)[number]
const ETICHETTE_VALIDITA_DELEGA: Record<ValiditaDelega, string> = {
  permanente: 'Permanente (fino a revoca scritta)',
  periodo: 'Periodo specifico',
  occasione: 'Occasione specifica',
}

export const TIPI_PERMESSO = ['entrata_posticipata', 'uscita_anticipata', 'entrambe'] as const
export type TipoPermesso = (typeof TIPI_PERMESSO)[number]
const ETICHETTE_TIPO_PERMESSO: Record<TipoPermesso, string> = {
  entrata_posticipata: 'Entrata posticipata',
  uscita_anticipata: 'Uscita anticipata',
  entrambe: 'Entrata posticipata e uscita anticipata',
}

/**
 * I giorni su cui può ricorrere un permesso. Le tre sedi aprono dal lunedì al venerdì:
 * il giorno in cui una aprisse il sabato, si aggiunge qui e non in tre punti diversi.
 */
export const GIORNI_SETTIMANA = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi'] as const
export type GiornoSettimana = (typeof GIORNI_SETTIMANA)[number]
const ETICHETTE_GIORNO: Record<GiornoSettimana, string> = {
  lunedi: 'lunedì',
  martedi: 'martedì',
  mercoledi: 'mercoledì',
  giovedi: 'giovedì',
  venerdi: 'venerdì',
}

/**
 * Le cinque voci del cartaceo, e le quattro del mezzo di trasporto. Non sono campi di
 * questo modello: le sceglie la segreteria quando crea l'uscita, una volta per tutta la
 * sezione, e il 10 le legge da `DatiUscita`. Stanno qui perché è qui che si stampano —
 * e perché sono un elenco chiuso, non testo libero, da tutte e due le parti.
 */
export const TIPI_USCITA = ['uscita_didattica', 'gita', 'laboratorio_esterno', 'piscina', 'altro'] as const
export type TipoUscita = (typeof TIPI_USCITA)[number]
const ETICHETTE_TIPO_USCITA: Record<TipoUscita, string> = {
  uscita_didattica: 'Uscita didattica',
  gita: 'Gita',
  laboratorio_esterno: 'Laboratorio esterno',
  piscina: 'Corso di piscina/nuoto',
  altro: 'Altro',
}

export const MEZZI_TRASPORTO = ['scuolabus', 'pullman_privato', 'a_piedi', 'altro'] as const
export type MezzoTrasporto = (typeof MEZZI_TRASPORTO)[number]
const ETICHETTE_MEZZO: Record<MezzoTrasporto, string> = {
  scuolabus: 'Scuolabus',
  pullman_privato: 'Pullman privato',
  a_piedi: 'A piedi',
  altro: 'Altro',
}

/** Valore convenzionale dell'accompagnatore quando ritira il genitore stesso (doc. 09). */
export const ACCOMPAGNATORE_GENITORE = 'io_stesso'

// ─── Mattoni comuni ─────────────────────────────────────────────────────────────

/**
 * Righe libere in coda alle tabelle ripetibili (§2 di `00-impaginazione.md`: delegati,
 * alimenti e sostituzioni, registro delle dosi). Un modulo consegnato deve poter essere
 * completato a penna.
 */
const RIGHE_LIBERE_TABELLA = 3

/**
 * Una riga-campo, ma solo se il valore c'è davvero.
 *
 * È il degrado esplicito già in uso in `buildCertificatoBody()`: un dato che manca fa
 * sparire la riga — mai «N.D.», mai un valore inventato, mai un'etichetta seguita dal
 * vuoto. Su un foglio che una famiglia porta a un ente, una riga vuota si legge come un
 * dato che la scuola non ha voluto dichiarare.
 */
function campo(etichetta: string, valore: string | null | undefined): CampoPrestampato[] {
  const v = valore?.trim()
  return v ? [{ etichetta, valore: v }] : []
}

/** Blocco di righe-campo, che sparisce del tutto quando non è rimasta nessuna riga. */
function blocchiCampi(campi: CampoPrestampato[], colonne: 1 | 2 = 1): BloccoPrestampato[] {
  return campi.length > 0 ? [{ tipo: 'campi', campi, colonne }] : []
}

/** Titolo di sezione + righe: se non è rimasta nessuna riga, sparisce anche il titolo. */
function sezioneCampi(titolo: string, campi: CampoPrestampato[], colonne: 1 | 2 = 1): BloccoPrestampato[] {
  if (campi.length === 0) return []
  return [{ tipo: 'sezione', titolo }, { tipo: 'campi', campi, colonne }]
}

function paragrafoSe(testo: string | null | undefined, stile?: 'normale' | 'corsivo' | 'grassetto'): BloccoPrestampato[] {
  const t = testo?.trim()
  return t ? [{ tipo: 'paragrafo', testo: t, stile }] : []
}

/**
 * La riga sotto il titolo: `{{scuola.ragione_sociale}} – Kidville (Nido · Infanzia ·
 * Primaria)`, come sui `.docx` della scuola.
 *
 * Non è un doppione dell'intestazione di sede, che porta il NOME DEL PLESSO
 * («Kidville Cesa») e il suo indirizzo: qui c'è la ragione sociale dell'ente gestore, che
 * è un altro dato e sta in configurazione. Se manca, la riga non compare.
 */
function rigaEnteGestore(dati: DatiPrestampato): BloccoPrestampato[] {
  const ragione = dati.scuola.ragioneSociale?.trim()
  if (!ragione) return []
  return [{ tipo: 'paragrafo', testo: `${ragione} – Kidville (Nido · Infanzia · Primaria)`, stile: 'corsivo' }]
}

/**
 * La casella della sede, spuntata da sé (convenzione `☐` del README).
 *
 * Sul cartaceo ci sono tre caselle con i nomi delle tre sedi. Qui ce n'è una sola, col
 * nome che arriva dal database: le sedi sono righe di `scuole`, non una costante, e tre
 * nomi cablati diventerebbero un foglio che dimentica in silenzio la quarta sede il
 * giorno in cui aprisse.
 */
function casellaSede(dati: DatiPrestampato, etichetta = 'Sede'): BloccoPrestampato[] {
  const nome = dati.sede.scuola_nome?.trim()
  return nome ? [{ tipo: 'caselle', caselle: [{ testo: `${etichetta}: ${nome}`, spuntata: true }] }] : []
}

/** Le righe-campo del blocco DATI DELL'ALUNNO/A, comuni a tutti e otto. */
function campiAlunno(dati: DatiPrestampato, conCodiceFiscale: boolean): CampoPrestampato[] {
  const a = dati.alunno
  return [
    ...campo('Cognome', a.cognome),
    ...campo('Nome', a.nome),
    ...campo('Data di nascita', isoToIt(a.dataNascita ?? '')),
    ...campo('Luogo di nascita', a.luogoNascita),
    ...(conCodiceFiscale ? campo('Codice fiscale', a.codiceFiscale) : []),
    ...campo('Sezione/Classe', a.sezione),
    ...campo('Anno scolastico', dati.annoScolastico),
  ]
}

/**
 * Il blocco DATI DELL'ALUNNO/A completo: titolo, casella della sede, righe-campo.
 *
 * Sette modelli su otto lo montano così. Il 28 no, e chiama `casellaSede()` da solo: il
 * suo `.docx` mette gli identificativi dentro la frase, e qui sopra ne stamperebbe un
 * secondo giro.
 */
function blocchiAlunno(dati: DatiPrestampato, { conCodiceFiscale = false } = {}): BloccoPrestampato[] {
  return [
    { tipo: 'sezione', titolo: "Dati dell'alunno/a" },
    ...casellaSede(dati),
    ...blocchiCampi(campiAlunno(dati, conCodiceFiscale), 2),
  ]
}

const ETICHETTE_RUOLO: Record<RuoloGenitore, string> = {
  padre: 'Padre/Tutore',
  madre: 'Madre/Tutrice',
  tutore: 'Tutore',
}

/**
 * Un blocco per genitore, non un blocco solo con tutti dentro.
 *
 * `campo()` toglie le righe senza valore, e in un blocco a due colonne un telefono
 * mancante farebbe risalire il nome del genitore successivo nella colonna di destra: due
 * persone diverse sulla stessa riga, e il telefono dell'una attribuito all'altra.
 */
function blocchiGenitori(dati: DatiPrestampato, { numerati = false } = {}): BloccoPrestampato[] {
  return dati.genitori.flatMap((g, i) => {
    const etichetta = numerati
      ? `Cognome e nome (${i + 1})`
      : `${g.ruolo ? ETICHETTE_RUOLO[g.ruolo] : 'Genitore/Tutore'} — Cognome e nome`
    return blocchiCampi([...campo(etichetta, g.nomeCompleto), ...campo('Telefono', g.telefono)], 2)
  })
}

/**
 * Il genitore che sottoscrive: quello dichiarato in `richiedente`, e nient'altro.
 *
 * L'unica deduzione ammessa è quella in cui non c'è niente da dedurre: **un solo**
 * genitore collegato in anagrafica è per forza il firmatario. Con due tutori e nessun
 * richiedente dichiarato la risposta è «non lo so», e vale più di una risposta plausibile:
 * a valle il degrado toglie la riga (06) o il cancello rifiuta la composizione (09),
 * invece di stampare il nome del padre sotto la firma della madre.
 */
export function genitoreRichiedente(dati: DatiPrestampato): DatiGenitore | undefined {
  if (dati.richiedente) return dati.richiedente
  return dati.genitori.length === 1 ? dati.genitori[0] : undefined
}

/**
 * Una domanda «☐ SÌ ☐ NO» del cartaceo, con la sua eventuale specifica.
 *
 * Esce come riga-campo e non come coppia di caselle perché su un documento GIÀ FIRMATO
 * la risposta è un fatto, non una scelta da fare: la parola sta sulla stessa riga della
 * domanda e non dipende da quanto bene il toner ha reso un quadratino da 3,5 mm. Le
 * caselle restano dove il cartaceo elenca alternative sotto un titolo di sezione (il
 * motivo del 07, il tipo di permesso del 09), che è il caso in cui aggiungono davvero
 * qualcosa.
 */
function domandaSiNo(
  domanda: string,
  risposta: boolean,
  dettaglio?: string | null,
  etichettaDettaglio = 'Se sì, specificare'
): BloccoPrestampato[] {
  return [
    ...blocchiCampi([{ etichetta: domanda, valore: risposta ? 'SÌ' : 'NO' }]),
    ...(risposta ? blocchiCampi(campo(etichettaDettaglio, dettaglio)) : []),
  ]
}

/** Caselle di un elenco chiuso, con spuntata quella scelta. */
function caselleScelta<T extends string>(
  valori: readonly T[],
  etichette: Record<T, string>,
  scelti: readonly T[]
): BloccoPrestampato[] {
  return [
    {
      tipo: 'caselle',
      caselle: valori.map((v) => ({ testo: etichette[v], spuntata: scelti.includes(v) })),
    },
  ]
}

/** «lunedì» · «lunedì e mercoledì» · «lunedì, mercoledì e venerdì»: la virgola non sostituisce la «e». */
function elencoItaliano(voci: readonly string[]): string {
  if (voci.length <= 1) return voci[0] ?? ''
  return `${voci.slice(0, -1).join(', ')} e ${voci[voci.length - 1]}`
}

/** `dal … al …`, con quello che c'è: se manca un estremo, resta l'altro; se mancano entrambi, niente. */
function periodo(dalIso?: string | null, alIso?: string | null): string {
  const dal = isoToIt(dalIso ?? '')
  const al = isoToIt(alIso ?? '')
  if (dal && al) return `dal ${dal} al ${al}`
  if (dal) return `dal ${dal}`
  return al ? `al ${al}` : ''
}

/**
 * Rete di sicurezza sui nomi che finiscono nel PDF: mai un'email, mai un indirizzo IP.
 *
 * `buildReceiptPdf()` formatta il firmatario come «Nome <email>», e un chiamante che
 * riusasse quella stringa qui infilerebbe l'email in un foglio che la famiglia stampa e
 * consegna. `impaginazione.ts` ha la stessa guardia sul riquadro di firma, ma le
 * sottoscrizioni del doc. 08 passano dal CORPO del documento e quella guardia non le
 * vede: è la porta che resta aperta se si dà per scontato che il chiamante sia gentile.
 */
function nomeSenzaRecapiti(riga: string): string {
  return riga
    .replace(/<[^<>]*@[^<>]*>/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Etichetta di un'opzione, col dettaglio libero al posto di «Altro» quando c'è. */
function etichettaOpzione<T extends string>(
  etichette: Record<T, string>,
  valore: T | null | undefined,
  dettaglio?: string | null
): string {
  if (!valore) return ''
  const d = dettaglio?.trim()
  return d ? `${etichette[valore]} — ${d}` : etichette[valore]
}

/** Riquadro «RISERVATO A…»: resta nel PDF anche vuoto, è il pezzo che si compila dopo. */
function riquadroVisto(titolo: string, etichette: [string, string], visto?: VistoUfficio | null): BloccoPrestampato[] {
  return [
    {
      tipo: 'riquadro',
      titolo,
      campi: [
        { etichetta: etichette[0], valore: visto?.istante?.trim() || null },
        { etichetta: etichette[1], valore: visto?.utente?.trim() || null },
      ],
    },
  ]
}

// ─── Schemi riusati ─────────────────────────────────────────────────────────────

const zTesto = (max: number, errore: string) => z.string().trim().min(1, errore).max(max)

const zTelefono = z
  .string()
  .trim()
  .min(6, 'Numero di telefono non valido')
  .max(30, 'Numero di telefono non valido')
  .regex(/^[0-9+().\s-]+$/, 'Numero di telefono non valido')

/** `hh:mm` sulle 24 ore: un orario di ingresso a scuola non ha bisogno dei secondi. */
const zOra = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Orario non valido (atteso hh:mm)')

const zTestoLungo = z.string().trim().max(1500)

/** Il percorso nello storage del file caricato: l'upload lo fa la route, qui arriva la chiave. */
const zAllegato = z.string().trim().min(1, 'Allegato obbligatorio').max(400)

/** Aggiunge un problema su un campo, con lo stesso messaggio in tutti i modelli. */
function mancante(ctx: z.RefinementCtx, campoNome: string, messaggio: string): void {
  ctx.addIssue({ code: 'custom', path: [campoNome], message: messaggio })
}

// ─── 05 — Scheda sanitaria dell'alunno/a ────────────────────────────────────────

/**
 * Le cinque domande «☐ SÌ ☐ NO — se sì, specificare» del cartaceo. In coppia perché la
 * regola è una sola: la specifica è obbligatoria esattamente quando la risposta è sì, e
 * scritta cinque volte a mano sarebbe cinque occasioni di scriverla diversa.
 */
const COPPIE_SI_NO_SANITARIE = [
  ['allergie', 'allergieDettaglio'],
  ['intolleranze', 'intolleranzeDettaglio'],
  ['patologie', 'patologieDettaglio'],
  ['terapie', 'terapieDettaglio'],
  ['ausili', 'ausiliDettaglio'],
] as const

const zContattoEmergenza = z.object({
  ordine: z.coerce.number().int().min(1, 'Ordine di chiamata non valido').max(9, 'Ordine di chiamata non valido'),
  nomeCompleto: zTesto(120, 'Cognome e nome del contatto obbligatori'),
  relazione: zTesto(80, 'Indicare la relazione con il bambino/a'),
  telefono: zTelefono,
})

const zSchedaSanitaria = z
  .object({
    pediatraNome: zTesto(120, 'Nome e cognome del pediatra obbligatori'),
    pediatraTelefono: zTelefono,
    asl: z.string().trim().max(160).optional(),
    allergie: z.boolean({ error: 'Rispondere sì o no' }),
    allergieDettaglio: zTestoLungo.optional(),
    intolleranze: z.boolean({ error: 'Rispondere sì o no' }),
    intolleranzeDettaglio: zTestoLungo.optional(),
    patologie: z.boolean({ error: 'Rispondere sì o no' }),
    patologieDettaglio: zTestoLungo.optional(),
    terapie: z.boolean({ error: 'Rispondere sì o no' }),
    terapieDettaglio: zTestoLungo.optional(),
    vaccinazioni: z.boolean({ error: 'Rispondere sì o no' }),
    ausili: z.boolean({ error: 'Rispondere sì o no' }),
    ausiliDettaglio: zTestoLungo.optional(),
    notePersonale: zTestoLungo.optional(),
    contattiEmergenza: z
      .array(zContattoEmergenza)
      .min(1, "Indicare almeno un contatto d'emergenza")
      .max(6, "Al massimo sei contatti d'emergenza"),
  })
  .superRefine((v, ctx) => {
    for (const [domanda, dettaglio] of COPPIE_SI_NO_SANITARIE) {
      if (v[domanda] && !(v[dettaglio] ?? '').trim()) {
        mancante(ctx, dettaglio, 'Indicazione obbligatoria quando la risposta è «sì»')
      }
    }
  })

export type RisposteSchedaSanitaria = z.infer<typeof zSchedaSanitaria>

const CAMPI_SCHEDA_SANITARIA: readonly CampoModulo[] = [
  {
    nome: 'pediatraNome',
    etichetta: 'Pediatra — nome e cognome',
    tipo: 'testo',
    obbligatorio: true,
    daPromuovereInAnagrafica: 'alunni.pediatra_nome',
  },
  {
    nome: 'pediatraTelefono',
    etichetta: 'Pediatra — telefono',
    tipo: 'telefono',
    obbligatorio: true,
    daPromuovereInAnagrafica: 'alunni.pediatra_telefono',
  },
  {
    nome: 'asl',
    etichetta: 'ASL / studio medico',
    tipo: 'testo',
    obbligatorio: false,
    daPromuovereInAnagrafica: 'alunni.asl',
  },
  {
    nome: 'allergie',
    etichetta: 'Allergie (alimentari, farmacologiche, da contatto, respiratorie)',
    tipo: 'siNo',
    obbligatorio: true,
  },
  {
    nome: 'allergieDettaglio',
    etichetta: 'Se sì, specificare',
    tipo: 'testoLungo',
    obbligatorio: false,
    mostraSe: { campo: 'allergie', valori: [true] },
    precompilatoDa: 'alunni.allergies',
    daPromuovereInAnagrafica: 'alunni.allergies',
  },
  { nome: 'intolleranze', etichetta: 'Intolleranze alimentari', tipo: 'siNo', obbligatorio: true },
  {
    nome: 'intolleranzeDettaglio',
    etichetta: 'Se sì, specificare',
    tipo: 'testoLungo',
    obbligatorio: false,
    mostraSe: { campo: 'intolleranze', valori: [true] },
    daPromuovereInAnagrafica: 'alunni.intolleranze',
  },
  {
    nome: 'patologie',
    etichetta: 'Patologie croniche o condizioni particolari (asma, epilessia, diabete, cardiopatie, ecc.)',
    tipo: 'siNo',
    obbligatorio: true,
  },
  {
    nome: 'patologieDettaglio',
    etichetta: 'Se sì, specificare',
    tipo: 'testoLungo',
    obbligatorio: false,
    mostraSe: { campo: 'patologie', valori: [true] },
    daPromuovereInAnagrafica: 'alunni.patologie',
  },
  {
    nome: 'terapie',
    etichetta: 'Terapie farmacologiche attualmente in corso',
    tipo: 'siNo',
    obbligatorio: true,
    aiuto: 'Se la terapia va somministrata a scuola serve anche l’autorizzazione alla somministrazione di farmaci.',
  },
  {
    nome: 'terapieDettaglio',
    etichetta: 'Se sì, farmaco / dosaggio / orario',
    tipo: 'testoLungo',
    obbligatorio: false,
    mostraSe: { campo: 'terapie', valori: [true] },
    daPromuovereInAnagrafica: 'alunni.terapie_in_corso',
  },
  {
    nome: 'vaccinazioni',
    etichetta: 'Vaccinazioni aggiornate come da normativa vigente (L. 119/2017)',
    tipo: 'siNo',
    obbligatorio: true,
    daPromuovereInAnagrafica: 'alunni.vaccinazioni_aggiornate',
  },
  {
    nome: 'ausili',
    etichetta: 'Difficoltà motorie, sensoriali o utilizzo di ausili/dispositivi medici',
    tipo: 'siNo',
    obbligatorio: true,
  },
  {
    nome: 'ausiliDettaglio',
    etichetta: 'Se sì, specificare',
    tipo: 'testoLungo',
    obbligatorio: false,
    mostraSe: { campo: 'ausili', valori: [true] },
    daPromuovereInAnagrafica: 'alunni.ausili',
  },
  {
    nome: 'notePersonale',
    etichetta: 'Altre informazioni utili per il personale educativo',
    tipo: 'testoLungo',
    obbligatorio: false,
  },
  {
    nome: 'contattiEmergenza',
    etichetta: "Contatti d'emergenza",
    tipo: 'righe',
    obbligatorio: true,
    aiuto:
      'Chi chiamare, e in che ordine, quando non si riesce a raggiungere i genitori. È il motivo per cui questa scheda esiste.',
    colonne: [
      { nome: 'ordine', etichetta: 'Ordine di chiamata', tipo: 'numero', obbligatorio: true },
      { nome: 'nomeCompleto', etichetta: 'Cognome e nome', tipo: 'testo', obbligatorio: true },
      { nome: 'relazione', etichetta: 'Relazione con il bambino/a', tipo: 'testo', obbligatorio: true },
      { nome: 'telefono', etichetta: 'Telefono', tipo: 'telefono', obbligatorio: true },
    ],
    daPromuovereInAnagrafica: 'tabella nuova — contatti d’emergenza',
  },
]

export const modelloSchedaSanitaria = definisciModello({
  slug: 'scheda_sanitaria',
  titolo: "SCHEDA SANITARIA DELL'ALUNNO/A",
  disponibileA: 'genitore',
  firma: 'otp_genitore',
  campi: CAMPI_SCHEDA_SANITARIA,
  schema: zSchedaSanitaria,
  componi: (dati, r) => {
    const genitori = [
      ...blocchiGenitori(dati),
      ...blocchiCampi(campo('Email di riferimento', dati.genitori.find((g) => g.email)?.email)),
    ]
    return [
      ...rigaEnteGestore(dati),
      ...blocchiAlunno(dati),

      // Il titolo esiste solo se sotto c'è qualcuno: un alunno senza genitori collegati in
      // anagrafica è un guasto da vedere, non un titoletto seguito dal vuoto.
      ...(genitori.length > 0
        ? ([{ tipo: 'sezione', titolo: 'Dati dei genitori/tutori' }] satisfies BloccoPrestampato[])
        : []),
      ...genitori,

      // Non è sul cartaceo, ed è il pezzo che trasforma la scheda da archivio a strumento:
      // sta subito sotto i genitori perché è la stessa domanda — chi chiamare — con la
      // risposta che serve quando i primi due numeri non rispondono.
      { tipo: 'sezione', titolo: "Contatti d'emergenza" },
      {
        tipo: 'tabella',
        intestazioni: ['Ordine di chiamata', 'Cognome e nome', 'Relazione con il bambino/a', 'Telefono'],
        righe: [...r.contattiEmergenza]
          .sort((a, b) => a.ordine - b.ordine)
          .map((c) => [String(c.ordine), c.nomeCompleto, c.relazione, c.telefono]),
        larghezze: [1, 2.2, 1.6, 1.4],
        // Nessuna riga libera, a differenza delle tabelle del §2: un nome aggiunto a penna
        // qui sotto è un numero che l'app non conosce e che nessuno chiamerà mai.
        righeVuote: 0,
      },

      ...sezioneCampi(
        'Pediatra di riferimento',
        [...campo('Nome e cognome', r.pediatraNome), ...campo('Telefono', r.pediatraTelefono)],
        2
      ),
      ...blocchiCampi(campo('ASL / Studio medico', r.asl)),

      { tipo: 'sezione', titolo: 'Informazioni sanitarie' },
      ...domandaSiNo('Allergie (alimentari, farmacologiche, da contatto, respiratorie)', r.allergie, r.allergieDettaglio),
      ...domandaSiNo('Intolleranze alimentari', r.intolleranze, r.intolleranzeDettaglio),
      ...domandaSiNo(
        'Patologie croniche o condizioni particolari (asma, epilessia, diabete, cardiopatie, ecc.)',
        r.patologie,
        r.patologieDettaglio
      ),
      ...domandaSiNo(
        'Terapie farmacologiche attualmente in corso',
        r.terapie,
        r.terapieDettaglio,
        'Se sì, farmaco / dosaggio / orario'
      ),
      ...blocchiCampi([
        {
          etichetta: 'Vaccinazioni aggiornate come da normativa vigente (L. 119/2017)',
          valore: r.vaccinazioni ? 'SÌ' : 'NO',
        },
      ]),
      ...domandaSiNo(
        'Difficoltà motorie, sensoriali o utilizzo di ausili/dispositivi medici',
        r.ausili,
        r.ausiliDettaglio
      ),

      ...(r.notePersonale?.trim()
        ? ([
            { tipo: 'sezione', titolo: 'Altre informazioni utili per il personale educativo' },
            { tipo: 'paragrafo', testo: r.notePersonale.trim() },
          ] satisfies BloccoPrestampato[])
        : []),

      { tipo: 'spazio', mm: 4 },
      {
        tipo: 'paragrafo',
        testo:
          'Il/La sottoscritto/a dichiara che le informazioni sopra riportate corrispondono al vero e si impegna a comunicare tempestivamente alla scuola qualsiasi variazione dello stato di salute del/la proprio/a figlio/a.',
      },
      {
        tipo: 'paragrafo',
        testo:
          'I dati sopra riportati saranno trattati dalla scuola nel rispetto del Regolamento UE 2016/679 (GDPR) esclusivamente per le finalità connesse alla tutela della salute, della sicurezza e della vita scolastica del minore.',
      },
    ]
  },
})

// ─── 06 — Autorizzazione alla somministrazione di farmaci ───────────────────────

const zAutorizzazioneFarmaci = z
  .object({
    farmaco: zTesto(160, 'Nome del farmaco obbligatorio'),
    dosaggio: zTesto(160, 'Dosaggio obbligatorio'),
    modalita: zTesto(160, 'Modalità di somministrazione obbligatoria'),
    orario: zTesto(160, 'Orario o frequenza obbligatori'),
    dal: zDataYMD,
    al: zDataYMD,
    prescrizionePath: zAllegato,
  })
  .superRefine((v, ctx) => {
    // Una durata che finisce prima di cominciare non è un refuso da correggere dopo:
    // `expiry_date` nasce da `al`, e l'autorizzazione scadrebbe prima della prima dose.
    if (v.al < v.dal) mancante(ctx, 'al', 'La fine del trattamento precede l’inizio')
  })

export type RisposteAutorizzazioneFarmaci = z.infer<typeof zAutorizzazioneFarmaci>

const CAMPI_AUTORIZZAZIONE_FARMACI: readonly CampoModulo[] = [
  { nome: 'farmaco', etichetta: 'Nome del farmaco', tipo: 'testo', obbligatorio: true },
  { nome: 'dosaggio', etichetta: 'Dosaggio', tipo: 'testo', obbligatorio: true },
  { nome: 'modalita', etichetta: 'Modalità di somministrazione', tipo: 'testo', obbligatorio: true },
  { nome: 'orario', etichetta: 'Orario / frequenza', tipo: 'testo', obbligatorio: true },
  { nome: 'dal', etichetta: 'Durata del trattamento — dal', tipo: 'data', obbligatorio: true },
  {
    nome: 'al',
    etichetta: 'Durata del trattamento — al',
    tipo: 'data',
    obbligatorio: true,
    aiuto: 'Alla scadenza l’autorizzazione decade da sola e sparisce dalla sezione.',
  },
  {
    nome: 'prescrizionePath',
    etichetta: 'Prescrizione medica / piano terapeutico del pediatra',
    tipo: 'file',
    obbligatorio: true,
    aiuto: 'Senza la prescrizione nessuno può somministrare nulla: l’allegato è bloccante.',
  },
]

export const modelloAutorizzazioneFarmaci = definisciModello({
  slug: 'autorizzazione_farmaci',
  titolo: 'AUTORIZZAZIONE ALLA SOMMINISTRAZIONE DI FARMACI',
  disponibileA: 'genitore',
  firma: 'otp_genitore',
  campi: CAMPI_AUTORIZZAZIONE_FARMACI,
  schema: zAutorizzazioneFarmaci,
  componi: (dati, r) => {
    // Il richiedente è chi firma, non il primo dell'anagrafica: su un'autorizzazione a
    // somministrare un farmaco, il nome sotto «GENITORE/TUTORE RICHIEDENTE» è quello di
    // chi si assume la responsabilità. Se la route non l'ha dichiarato e i tutori sono
    // due, il blocco sparisce — sezione compresa — invece di attribuirla a caso.
    const richiedente = genitoreRichiedente(dati)
    return [
      ...rigaEnteGestore(dati),
      ...blocchiAlunno(dati),

      ...sezioneCampi(
        'Genitore/tutore richiedente',
        [...campo('Cognome e nome', richiedente?.nomeCompleto), ...campo('Telefono', richiedente?.telefono)],
        2
      ),

      { tipo: 'sezione', titolo: 'Dati della terapia farmacologica' },
      ...blocchiCampi(campo('Nome del farmaco', r.farmaco)),
      ...blocchiCampi([...campo('Dosaggio', r.dosaggio), ...campo('Modalità di somministrazione', r.modalita)], 2),
      ...blocchiCampi(
        [...campo('Orario/frequenza', r.orario), ...campo('Durata del trattamento', periodo(r.dal, r.al))],
        2
      ),
      {
        tipo: 'caselle',
        caselle: [
          {
            testo: 'Si allega prescrizione medica / piano terapeutico del pediatra',
            // Lo schema pretende l'allegato, quindi qui la casella è sempre spuntata: se un
            // giorno l'allegato diventasse facoltativo, è questa riga a dover cambiare
            // insieme allo schema, e non a mentire da sola.
            spuntata: r.prescrizionePath.trim().length > 0,
          },
        ],
      },

      { tipo: 'spazio', mm: 3 },
      {
        tipo: 'paragrafo',
        testo:
          "Il/La sottoscritto/a, genitore/tutore dell'alunno/a sopra indicato/a, autorizza il personale della scuola a somministrare il farmaco sopra descritto secondo le indicazioni fornite dal pediatra, sollevando la scuola e il personale incaricato da ogni responsabilità per le conseguenze derivanti da una corretta somministrazione conforme alla prescrizione medica allegata.",
      },

      // Il cartaceo ha venti righe da riempire a penna; in app il registro delle dosi
      // sarebbe una tabella collegata, e il PDF si rigenererebbe con le righe già
      // compilate. Quella tabella non esiste (nessuna migrazione: vedi la testa del file),
      // quindi qui restano le righe libere della specifica §2 — la forma del blocco è già
      // quella giusta, e il giorno in cui la tabella arriva sono le sue righe a entrare
      // dentro `righe`, senza toccare nient'altro.
      { tipo: 'sezione', titolo: 'Registro di somministrazione' },
      {
        tipo: 'tabella',
        intestazioni: ['Data', 'Ora', 'Dose somministrata', 'Firma operatore'],
        righe: [],
        larghezze: [1, 0.8, 2, 1.6],
        righeVuote: RIGHE_LIBERE_TABELLA,
      },

      // Finché la Direzione non accetta, l'autorizzazione non abilita nessuno a
      // somministrare niente: il riquadro resta e si vede che è vuoto.
      ...riquadroVisto('Per accettazione — La Direzione', ['Data e firma', 'Nome'], dati.visto),
    ]
  },
})

// ─── 07 — Richiesta dieta speciale / intolleranze alimentari ────────────────────

const zRigaAlimento = z.object({
  alimento: zTesto(120, 'Indicare l’alimento da escludere'),
  sostituzione: z.string().trim().max(120).optional(),
})

const zDietaSpeciale = z
  .object({
    motivo: z.enum(MOTIVI_DIETA, { error: 'Indicare il motivo della richiesta' }),
    altroMotivo: z.string().trim().max(300).optional(),
    alimenti: z
      .array(zRigaAlimento)
      .min(1, 'Indicare almeno un alimento da escludere')
      .max(12, 'Al massimo dodici alimenti'),
    certificatoPath: z.string().trim().max(400).optional(),
    medico: z.string().trim().max(160).optional(),
    dataCertificato: zDataYMD.optional(),
    validita: z.string().trim().max(120).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.motivo === 'altro' && !(v.altroMotivo ?? '').trim()) {
      mancante(ctx, 'altroMotivo', 'Specificare il motivo della richiesta')
    }
    // Il certificato si pretende SOLO quando il motivo è sanitario: chiederlo a chi
    // chiede una dieta vegetariana sarebbe una raccolta di dati non necessaria.
    if (!motivoSanitario(v.motivo)) return
    if (!(v.certificatoPath ?? '').trim()) {
      mancante(ctx, 'certificatoPath', 'Il certificato medico è obbligatorio per una dieta di natura sanitaria')
    }
    if (!(v.medico ?? '').trim()) mancante(ctx, 'medico', 'Indicare il medico che ha redatto il certificato')
    if (!v.dataCertificato) mancante(ctx, 'dataCertificato', 'Indicare la data del certificato')
  })

export type RisposteDietaSpeciale = z.infer<typeof zDietaSpeciale>

const CAMPI_DIETA_SPECIALE: readonly CampoModulo[] = [
  {
    nome: 'motivo',
    etichetta: 'Motivo della richiesta',
    tipo: 'scelta',
    obbligatorio: true,
    opzioni: opzioniDa(MOTIVI_DIETA, ETICHETTE_MOTIVO_DIETA),
    aiuto: 'Governa il resto del modulo: solo un motivo sanitario richiede il certificato medico.',
  },
  {
    nome: 'altroMotivo',
    etichetta: 'Se altro, specificare',
    tipo: 'testo',
    obbligatorio: false,
    mostraSe: { campo: 'motivo', valori: ['altro'] },
  },
  {
    nome: 'alimenti',
    etichetta: 'Alimenti da escludere e sostituzioni proposte',
    tipo: 'righe',
    obbligatorio: true,
    precompilatoDa: 'alunni.allergeni',
    colonne: [
      { nome: 'alimento', etichetta: 'Alimento da escludere', tipo: 'testo', obbligatorio: true },
      { nome: 'sostituzione', etichetta: 'Sostituzione proposta', tipo: 'testo', obbligatorio: false },
    ],
    daPromuovereInAnagrafica: 'tabella nuova — alimento → sostituzione',
  },
  {
    nome: 'certificatoPath',
    etichetta: 'Certificato medico',
    tipo: 'file',
    obbligatorio: false,
    mostraSe: { campo: 'motivo', valori: ['allergia_alimentare', 'intolleranza_alimentare'] },
    aiuto: 'Obbligatorio quando la dieta ha natura sanitaria.',
  },
  {
    nome: 'medico',
    etichetta: 'Redatto dal Dott./Dott.ssa',
    tipo: 'testo',
    obbligatorio: false,
    mostraSe: { campo: 'motivo', valori: ['allergia_alimentare', 'intolleranza_alimentare'] },
  },
  {
    nome: 'dataCertificato',
    etichetta: 'In data',
    tipo: 'data',
    obbligatorio: false,
    mostraSe: { campo: 'motivo', valori: ['allergia_alimentare', 'intolleranza_alimentare'] },
  },
  {
    nome: 'validita',
    etichetta: 'Validità del certificato',
    tipo: 'testo',
    obbligatorio: false,
    aiuto: 'Una data di scadenza, oppure la dicitura riportata sul certificato. Diventa la scadenza del documento.',
  },
]

export const modelloDietaSpeciale = definisciModello({
  slug: 'dieta_speciale',
  titolo: 'RICHIESTA DIETA SPECIALE / INTOLLERANZE ALIMENTARI',
  disponibileA: 'genitore',
  firma: 'otp_genitore',
  campi: CAMPI_DIETA_SPECIALE,
  schema: zDietaSpeciale,
  componi: (dati, r) => {
    const certificato = (r.certificatoPath ?? '').trim()
    const campiCertificato = [
      ...campo('Redatto dal Dott./Dott.ssa', r.medico),
      ...campo('In data', isoToIt(r.dataCertificato ?? '')),
      ...campo('Validità del certificato', r.validita),
    ]
    return [
      ...rigaEnteGestore(dati),
      ...blocchiAlunno(dati),

      { tipo: 'sezione', titolo: 'Motivo della richiesta' },
      ...caselleScelta(MOTIVI_DIETA, ETICHETTE_MOTIVO_DIETA, [r.motivo]),
      ...(r.motivo === 'altro' ? blocchiCampi(campo('Se altro, specificare', r.altroMotivo)) : []),

      { tipo: 'sezione', titolo: 'Alimenti da escludere e sostituzioni proposte' },
      {
        tipo: 'tabella',
        intestazioni: ['Alimento da escludere', 'Sostituzione proposta'],
        righe: r.alimenti.map((riga) => [riga.alimento, riga.sostituzione?.trim() ?? '']),
        righeVuote: RIGHE_LIBERE_TABELLA,
      },

      // La sezione compare solo se ha qualcosa da dire: su una dieta etico-religiosa un
      // riquadro «CERTIFICAZIONE MEDICA» vuoto suggerirebbe un allegato mancante che
      // invece non doveva essere chiesto.
      ...(certificato || campiCertificato.length > 0
        ? ([{ tipo: 'sezione', titolo: 'Certificazione medica' }] satisfies BloccoPrestampato[])
        : []),
      ...(certificato
        ? ([
            { tipo: 'caselle', caselle: [{ testo: 'Si allega certificato medico', spuntata: true }] },
          ] satisfies BloccoPrestampato[])
        : []),
      ...blocchiCampi(campiCertificato),

      { tipo: 'spazio', mm: 3 },
      {
        tipo: 'paragrafo',
        testo:
          "Il/La sottoscritto/a chiede che al/alla proprio/a figlio/a venga garantita la dieta sopra indicata e dichiara che le informazioni fornite corrispondono al vero.",
      },

      ...riquadroVisto('Riservato a segreteria/cucina', ['Preso in carico il', 'Da'], dati.visto),
    ]
  },
})

// ─── 08 — Delega al ritiro dell'alunno/a ────────────────────────────────────────

const zDelegato = z.object({
  nomeCompleto: zTesto(120, 'Cognome e nome del delegato obbligatori'),
  relazione: zTesto(80, 'Indicare la relazione con il bambino/a'),
  documento: zTesto(80, "Indicare tipo e numero del documento d'identità"),
  documentoPath: zAllegato,
})

const zDelegaRitiro = z
  .object({
    delegati: z
      .array(zDelegato)
      .min(1, 'Indicare almeno una persona delegata')
      .max(5, 'Al massimo cinque persone delegate'),
    validita: z.enum(VALIDITA_DELEGA, { error: 'Indicare la validità della delega' }),
    dal: zDataYMD.optional(),
    al: zDataYMD.optional(),
  })
  .superRefine((v, ctx) => {
    // Una delega «permanente, fino a revoca scritta» che porta una data è un atto che
    // dichiara due cose incompatibili — e non resterebbe un'incoerenza di stampa: la
    // route ricava `expiry_date` da `al`, e alla scadenza i delegati a termine si
    // disattivano da soli. Sarebbe una delega permanente che smette di valere in
    // silenzio, cioè un nonno che un mattino non può più prendere il bambino senza che
    // nessuno abbia revocato niente.
    if (v.validita === 'permanente') {
      if (v.dal) {
        mancante(ctx, 'dal', 'Una delega permanente non ha un periodo: togliere la data o scegliere «Periodo specifico»')
      }
      if (v.al) {
        mancante(ctx, 'al', 'Una delega permanente non ha scadenza: togliere la data o scegliere «Periodo specifico»')
      }
    }
    if (v.validita === 'periodo') {
      if (!v.dal) mancante(ctx, 'dal', 'Indicare la data di inizio del periodo')
      if (!v.al) mancante(ctx, 'al', 'Indicare la data di fine del periodo')
      if (v.dal && v.al && v.al < v.dal) mancante(ctx, 'al', 'La fine del periodo precede l’inizio')
    }
    if (v.validita === 'occasione' && !v.al) {
      mancante(ctx, 'al', "Indicare la data dell'occasione")
    }
  })

export type RisposteDelegaRitiro = z.infer<typeof zDelegaRitiro>

/**
 * Due firme o una?
 *
 * Delegare un terzo al ritiro di un minore non è un atto che un solo genitore compie da
 * solo: se in anagrafica ci sono due tutori, firmano entrambi. Con `genitori_separati`
 * la doppia firma resta obbligatoria **anche se in anagrafica ne risulta uno solo** — è
 * proprio il caso in cui il consenso di chi manca conta di più, e il rimedio è
 * completare l'anagrafica, non emettere il foglio a metà.
 */
export function richiedeDueFirme(dati: DatiPrestampato): boolean {
  return dati.genitori.length >= 2 || dati.alunno.genitoriSeparati === true
}

/** Le righe «Dal»/«Al» della delega: quali compaiono lo decide la validità, non ciò che è arrivato. */
function datePerValidita(r: RisposteDelegaRitiro): CampoPrestampato[] {
  if (r.validita === 'permanente') return []
  return [
    ...(r.validita === 'periodo' ? campo('Dal', isoToIt(r.dal ?? '')) : []),
    ...campo(r.validita === 'occasione' ? 'In data' : 'Al', isoToIt(r.al ?? '')),
  ]
}

const CAMPI_DELEGA_RITIRO: readonly CampoModulo[] = [
  {
    nome: 'delegati',
    etichetta: 'Persone delegate al ritiro',
    tipo: 'righe',
    obbligatorio: true,
    precompilatoDa: 'delegates',
    aiuto: 'I delegati diventano attivi solo dopo la firma di questo modulo, non prima.',
    colonne: [
      { nome: 'nomeCompleto', etichetta: 'Cognome e nome', tipo: 'testo', obbligatorio: true },
      { nome: 'relazione', etichetta: 'Relazione con il bambino/a', tipo: 'testo', obbligatorio: true },
      { nome: 'documento', etichetta: "Documento d'identità (tipo e n.)", tipo: 'testo', obbligatorio: true },
      { nome: 'documentoPath', etichetta: "Foto o scansione del documento", tipo: 'file', obbligatorio: true },
    ],
  },
  {
    nome: 'validita',
    etichetta: 'Validità della delega',
    tipo: 'scelta',
    obbligatorio: true,
    opzioni: opzioniDa(VALIDITA_DELEGA, ETICHETTE_VALIDITA_DELEGA),
  },
  {
    nome: 'dal',
    etichetta: 'Dal',
    tipo: 'data',
    obbligatorio: false,
    mostraSe: { campo: 'validita', valori: ['periodo'] },
  },
  {
    nome: 'al',
    etichetta: 'Al / In data',
    tipo: 'data',
    obbligatorio: false,
    mostraSe: { campo: 'validita', valori: ['periodo', 'occasione'] },
    aiuto: 'Diventa la scadenza della delega: passata quella data i delegati a termine si disattivano da soli.',
  },
]

export const modelloDelegaRitiro = definisciModello({
  slug: 'delega_ritiro',
  titolo: "DELEGA AL RITIRO DELL'ALUNNO/A",
  disponibileA: 'genitore',
  firma: 'otp_due_genitori',
  campi: CAMPI_DELEGA_RITIRO,
  schema: zDelegaRitiro,
  verificaContesto: (dati) => {
    // Il PDF si genera SOLO dopo la seconda firma (doc. 08). Comporlo prima
    // produrrebbe un atto che autorizza un terzo a portare via un bambino con il
    // consenso di un genitore solo — e lo produrrebbe in silenzio.
    if (richiedeDueFirme(dati) && (dati.sottoscrizioni?.length ?? 0) < 2) {
      return [
        {
          campo: '',
          messaggio:
            'La delega richiede la firma di entrambi i genitori/tutori: manca la seconda sottoscrizione.',
        },
      ]
    }
    return []
  },
  componi: (dati, r) => {
    const sottoscrizioni = dati.sottoscrizioni ?? []
    return [
      ...rigaEnteGestore(dati),
      ...blocchiAlunno(dati),

      { tipo: 'sezione', titolo: 'Genitori/tutori deleganti' },
      ...blocchiGenitori(dati, { numerati: true }),

      { tipo: 'spazio', mm: 2 },
      {
        tipo: 'paragrafo',
        testo:
          "I sottoscritti, genitori/tutori dell'alunno/a sopra indicato/a, dichiarano di delegare al ritiro del/la proprio/a figlio/a da scuola le seguenti persone, assumendosene piena responsabilità:",
      },

      { tipo: 'sezione', titolo: 'Persone delegate' },
      {
        tipo: 'tabella',
        intestazioni: ['Cognome e nome', 'Relazione con il bambino/a', "Documento d'identità (tipo e n.)"],
        righe: r.delegati.map((d) => [d.nomeCompleto, d.relazione, d.documento]),
        larghezze: [2, 1.5, 1.8],
        // Le righe libere sono quelle che la specifica §2 chiede su questa tabella. Un
        // nome scritto lì a penna NON diventa un delegato: `delegates` si alimenta dalle
        // risposte firmate, e il foglio stampato non ha modo di rientrare nell'app.
        righeVuote: RIGHE_LIBERE_TABELLA,
      },

      { tipo: 'sezione', titolo: 'Validità della delega' },
      ...caselleScelta(VALIDITA_DELEGA, ETICHETTE_VALIDITA_DELEGA, [r.validita]),
      // Sulla delega permanente le date non si stampano affatto, ed è il secondo giro di
      // chiave dopo lo schema: la casella «fino a revoca scritta» e una riga «Al» sullo
      // stesso foglio si contraddicono, e a leggerle è chi ha in mano il bambino.
      ...blocchiCampi(datePerValidita(r), 2),

      { tipo: 'spazio', mm: 2 },
      {
        tipo: 'paragrafo',
        testo:
          'I sottoscritti si assumono ogni responsabilità civile e penale derivante dal ritiro del minore da parte delle persone sopra delegate ed esonerano la scuola da ogni responsabilità al riguardo.',
      },

      // Il blocco firma dell'impaginatore attesta UNA sottoscrizione sola: la seconda —
      // che è il punto di questo modulo — va detta qui, nel corpo, o non comparirebbe da
      // nessuna parte sul foglio che la famiglia consegna.
      ...sezioneCampi(
        'Firme dei genitori/tutori',
        sottoscrizioni.map((s, i) => ({
          etichetta: `${i + 1})`,
          valore: `${nomeSenzaRecapiti(s.firmatario)} — firmato con OTP il ${s.istante}`,
        }))
      ),
      ...(richiedeDueFirme(dati)
        ? []
        : paragrafoSe(
            `In anagrafica risulta un solo genitore/tutore per l'alunno/a: la presente delega è sottoscritta dal solo firmatario ed è valida senza la seconda firma.`,
            'corsivo'
          )),
    ]
  },
})

// ─── 09 — Richiesta di permesso: entrata posticipata / uscita anticipata ────────

const zPermessoOrario = z
  .object({
    giorno: zDataYMD,
    tipo: z.enum(TIPI_PERMESSO, { error: 'Indicare il tipo di permesso' }),
    oraArrivo: zOra.optional(),
    oraUscita: zOra.optional(),
    motivo: z.string().trim().max(300).optional(),
    accompagnatore: z.string().trim().max(120).optional(),
    ricorrenzaGiorni: z.array(z.enum(GIORNI_SETTIMANA)).max(GIORNI_SETTIMANA.length).optional(),
    ricorrenzaFino: zDataYMD.optional(),
  })
  .superRefine((v, ctx) => {
    const conEntrata = v.tipo === 'entrata_posticipata' || v.tipo === 'entrambe'
    const conUscita = v.tipo === 'uscita_anticipata' || v.tipo === 'entrambe'
    if (conEntrata && !v.oraArrivo) mancante(ctx, 'oraArrivo', 'Indicare l’orario previsto di arrivo')
    if (conUscita && !v.oraUscita) mancante(ctx, 'oraUscita', 'Indicare l’orario previsto di uscita')
    // Chi ritira un bambino si dichiara PRIMA. Sul cartaceo c'è scritto «allegare
    // delega» e nessuno la allega mai: qui senza questa risposta il modulo non parte.
    if (conUscita && !(v.accompagnatore ?? '').trim()) {
      mancante(ctx, 'accompagnatore', 'Indicare chi ritira il bambino/a')
    }
    const giorni = v.ricorrenzaGiorni ?? []
    if (giorni.length > 0 && !v.ricorrenzaFino) {
      mancante(ctx, 'ricorrenzaFino', 'Indicare fino a quando vale il permesso ricorrente')
    }
    if (giorni.length === 0 && v.ricorrenzaFino) {
      mancante(ctx, 'ricorrenzaGiorni', 'Indicare i giorni del permesso ricorrente')
    }
  })

export type RispostePermessoOrario = z.infer<typeof zPermessoOrario>

const CAMPI_PERMESSO_ORARIO: readonly CampoModulo[] = [
  {
    nome: 'giorno',
    etichetta: 'Giorno del permesso',
    tipo: 'data',
    obbligatorio: true,
    aiuto: 'Sul cartaceo si dava per scontato «oggi»: in app va detto, perché il permesso si compila anche la sera prima.',
  },
  {
    nome: 'tipo',
    etichetta: 'Tipo di permesso',
    tipo: 'scelta',
    obbligatorio: true,
    opzioni: opzioniDa(TIPI_PERMESSO, ETICHETTE_TIPO_PERMESSO),
  },
  {
    nome: 'oraArrivo',
    etichetta: 'Orario previsto di arrivo',
    tipo: 'ora',
    obbligatorio: false,
    mostraSe: { campo: 'tipo', valori: ['entrata_posticipata', 'entrambe'] },
  },
  {
    nome: 'oraUscita',
    etichetta: 'Orario previsto di uscita',
    tipo: 'ora',
    obbligatorio: false,
    mostraSe: { campo: 'tipo', valori: ['uscita_anticipata', 'entrambe'] },
  },
  { nome: 'motivo', etichetta: 'Motivo (facoltativo)', tipo: 'testo', obbligatorio: false },
  {
    nome: 'accompagnatore',
    etichetta: 'Chi accompagna o ritira il bambino/a',
    tipo: 'scelta',
    obbligatorio: false,
    mostraSe: { campo: 'tipo', valori: ['uscita_anticipata', 'entrambe'] },
    opzioniDaApp: 'delegati_attivi',
    aiuto: 'Solo il genitore o un delegato attivo. Se la persona non è fra i delegati, va prima firmata la delega al ritiro.',
  },
  {
    nome: 'ricorrenzaGiorni',
    etichetta: 'Permesso ricorrente — giorni',
    tipo: 'scelta',
    obbligatorio: false,
    multipla: true,
    opzioni: opzioniDa(GIORNI_SETTIMANA, ETICHETTE_GIORNO),
    aiuto: 'La terapia settimanale, il fratello da prendere a scuola, l’orario ridotto dell’inserimento durano mesi.',
  },
  { nome: 'ricorrenzaFino', etichetta: 'Permesso ricorrente — fino al', tipo: 'data', obbligatorio: false },
]

/**
 * Chi ritira il bambino, risolto in un NOME.
 *
 * Due rami e una regola sola: «io stesso» è il genitore che ha chiesto il permesso — non
 * il primo dell'anagrafica — e ogni altro valore è l'id di un delegato che la route ha
 * già risolto in `dati.accompagnatore`. Quando la risoluzione non riesce la funzione
 * restituisce stringa vuota, e chi la chiama la tratta come un rifiuto: sul foglio il
 * degrado toglierebbe la riga, e resterebbe un permesso di uscita anticipata FIRMATO che
 * non dice chi porta via il bambino.
 */
function nomeAccompagnatore(dati: DatiPrestampato, scelta: string | null | undefined): string {
  const s = (scelta ?? '').trim()
  if (!s) return ''
  if (s === ACCOMPAGNATORE_GENITORE) return genitoreRichiedente(dati)?.nomeCompleto?.trim() ?? ''
  return dati.accompagnatore?.trim() ?? ''
}

export const modelloPermessoOrario = definisciModello({
  slug: 'permesso_orario',
  titolo: 'RICHIESTA DI PERMESSO — ENTRATA POSTICIPATA / USCITA ANTICIPATA',
  disponibileA: 'genitore',
  firma: 'otp_genitore',
  campi: CAMPI_PERMESSO_ORARIO,
  schema: zPermessoOrario,
  verificaContesto: (dati, r) => {
    const conUscita = r.tipo === 'uscita_anticipata' || r.tipo === 'entrambe'
    if (!conUscita) return []
    // Il cancello vale per TUTTI E DUE i rami. Coprire il solo delegato non risolto
    // lasciava passare «io stesso» senza richiedente dichiarato: stesso foglio, stesso
    // buco, riga sparita per degrado — e nessuno se ne accorgeva perché il modulo era
    // valido secondo `zod`.
    if (nomeAccompagnatore(dati, r.accompagnatore)) return []
    return [
      {
        campo: 'accompagnatore',
        messaggio:
          (r.accompagnatore ?? '').trim() === ACCOMPAGNATORE_GENITORE
            ? 'Il genitore/tutore richiedente non è indicato: il permesso non direbbe chi ritira il bambino/a'
            : 'Il delegato indicato non risulta fra i delegati attivi',
      },
    ]
  },
  componi: (dati, r) => {
    const conEntrata = r.tipo === 'entrata_posticipata' || r.tipo === 'entrambe'
    const conUscita = r.tipo === 'uscita_anticipata' || r.tipo === 'entrambe'
    const accompagnatore = nomeAccompagnatore(dati, r.accompagnatore)
    const giorni = (r.ricorrenzaGiorni ?? []).map((g) => ETICHETTE_GIORNO[g])
    const ricorrenza =
      giorni.length > 0 && r.ricorrenzaFino
        ? `tutti i ${elencoItaliano(giorni)} fino al ${isoToIt(r.ricorrenzaFino)}`
        : ''

    return [
      ...rigaEnteGestore(dati),
      ...blocchiAlunno(dati),

      ...blocchiCampi(
        [
          ...campo('Data della richiesta', isoToIt(dati.dataOggi)),
          ...campo('Giorno del permesso', isoToIt(r.giorno)),
        ],
        2
      ),

      { tipo: 'sezione', titolo: 'Tipo di permesso' },
      ...caselleScelta(
        ['entrata_posticipata', 'uscita_anticipata'] as const,
        ETICHETTE_TIPO_PERMESSO,
        [
          ...(conEntrata ? (['entrata_posticipata'] as const) : []),
          ...(conUscita ? (['uscita_anticipata'] as const) : []),
        ]
      ),
      ...blocchiCampi(
        [
          ...(conEntrata ? campo('Orario previsto di arrivo', r.oraArrivo) : []),
          ...(conUscita ? campo('Orario previsto di uscita', r.oraUscita) : []),
        ],
        2
      ),
      ...blocchiCampi(campo('Motivo (facoltativo)', r.motivo)),
      ...blocchiCampi(
        campo('Persona che accompagna/ritira il bambino, se diversa dal genitore', accompagnatore)
      ),
      ...blocchiCampi(campo('Permesso ricorrente', ricorrenza)),

      ...riquadroVisto('Presa visione — Educatrice/Segreteria', ['Data e firma', 'Nome'], dati.visto),
    ]
  },
})

// ─── 10 — Autorizzazione a uscite didattiche / gite / attività esterne ──────────

const zAutorizzazioneUscita = z.object({
  autorizzo: z.boolean({ error: 'Indicare se si autorizza la partecipazione' }),
  recapito: zTelefono,
  saNuotare: z.boolean().optional(),
})

export type RisposteAutorizzazioneUscita = z.infer<typeof zAutorizzazioneUscita>

const CAMPI_AUTORIZZAZIONE_USCITA: readonly CampoModulo[] = [
  {
    nome: 'autorizzo',
    etichetta: 'Autorizzo la partecipazione',
    tipo: 'siNo',
    obbligatorio: true,
    aiuto: 'Chi non risponde entro il termine non è nell’elenco dei partecipanti: non esistono autorizzazioni verbali.',
  },
  {
    nome: 'recapito',
    etichetta: "Recapito telefonico reperibile durante l'uscita",
    tipo: 'telefono',
    obbligatorio: true,
    precompilatoDa: 'parents.phones',
  },
  {
    nome: 'saNuotare',
    etichetta: 'Il/La bambino/a sa nuotare',
    tipo: 'siNo',
    obbligatorio: false,
    aiuto: 'Chiesto solo per le attività in acqua; la condizione sta sull’uscita creata dalla segreteria, non sulle risposte.',
  },
]

export const modelloAutorizzazioneUscita = definisciModello({
  slug: 'autorizzazione_uscita',
  titolo: 'AUTORIZZAZIONE A USCITE DIDATTICHE / GITE / ATTIVITÀ ESTERNE',
  disponibileA: 'genitore',
  firma: 'otp_genitore',
  campi: CAMPI_AUTORIZZAZIONE_USCITA,
  schema: zAutorizzazioneUscita,
  verificaContesto: (dati, r) => {
    // Tutta la descrizione dell'attività è prefill dell'evento: senza, il foglio
    // autorizzerebbe la partecipazione a un'uscita che non dice dove va né quando.
    if (!dati.uscita) {
      return [{ campo: '', messaggio: "I dati dell'uscita non sono disponibili: l'autorizzazione non si può comporre." }]
    }
    // «Sa nuotare» dipende dall'evento, non dalle risposte: `zod` non lo può sapere, e
    // lasciarlo al chiamante significherebbe scoprire il buco il giorno della piscina.
    if (dati.uscita.attivitaInAcqua === true && r.saNuotare === undefined) {
      return [{ campo: 'saNuotare', messaggio: "Per un'attività in acqua va indicato se il bambino/a sa nuotare" }]
    }
    return []
  },
  componi: (dati, r) => {
    const u = dati.uscita
    return [
      ...rigaEnteGestore(dati),
      ...blocchiAlunno(dati),

      { tipo: 'sezione', titolo: "Descrizione dell'attività" },
      ...blocchiCampi(
        campo('Tipo di attività', etichettaOpzione(ETICHETTE_TIPO_USCITA, u?.tipo, u?.tipoDettaglio))
      ),
      ...blocchiCampi(campo('Destinazione', u?.destinazione)),
      ...blocchiCampi(
        [
          ...campo('Data', isoToIt(u?.data ?? '')),
          ...campo('Mezzo di trasporto', etichettaOpzione(ETICHETTE_MEZZO, u?.mezzo, u?.mezzoDettaglio)),
        ],
        2
      ),
      ...blocchiCampi(
        [
          ...campo('Orario partenza', u?.oraPartenza),
          ...campo('Orario rientro previsto', u?.oraRientro),
        ],
        2
      ),
      ...(u?.attivitaInAcqua === true && r.saNuotare !== undefined
        ? blocchiCampi([{ etichetta: 'Il/La bambino/a sa nuotare', valore: r.saNuotare ? 'SÌ' : 'NO' }])
        : []),

      { tipo: 'spazio', mm: 3 },
      {
        tipo: 'paragrafo',
        testo:
          "Si ricorda di segnalare eventuali informazioni sanitarie rilevanti già indicate nella scheda sanitaria dell'alunno/a.",
      },
      {
        tipo: 'paragrafo',
        // Il cartaceo conosce solo la formula che autorizza, perché su carta chi non
        // autorizzava non riconsegnava il foglio. In app il diniego è una risposta come
        // un'altra e va scritta per esteso: un documento che dice il contrario di ciò che
        // il genitore ha risposto è peggio di nessun documento.
        testo: r.autorizzo
          ? "Il/La sottoscritto/a autorizza il/la proprio/a figlio/a a partecipare all'attività sopra descritta, sollevando la scuola da responsabilità per fatti non imputabili a negligenza del personale."
          : "Il/La sottoscritto/a NON autorizza il/la proprio/a figlio/a a partecipare all'attività sopra descritta.",
        stile: r.autorizzo ? 'normale' : 'grassetto',
      },
      ...blocchiCampi(campo("Recapito telefonico reperibile durante l'uscita", r.recapito)),
    ]
  },
})

// ─── 26·27 — Certificato di iscrizione e frequenza ──────────────────────────────

const zCertificatoIscrizioneFrequenza = z.object({
  uso: z.string().trim().max(200).optional(),
  copie: z.coerce.number().int().min(1).max(10).optional(),
  consegna: z.enum(['mano', 'email']).optional(),
})

export type RisposteCertificatoIscrizioneFrequenza = z.infer<typeof zCertificatoIscrizioneFrequenza>

const CAMPI_CERTIFICATO_ISCRIZIONE_FREQUENZA: readonly CampoModulo[] = [
  {
    nome: 'uso',
    etichetta: 'Uso dichiarato',
    tipo: 'testo',
    obbligatorio: false,
    chiestoA: 'segreteria',
    aiuto: 'Se valorizzato compare in calce al certificato.',
  },
  {
    nome: 'copie',
    etichetta: 'Numero di copie',
    tipo: 'numero',
    obbligatorio: false,
    chiestoA: 'segreteria',
    aiuto: 'Governa il rilascio allo sportello, non il testo del certificato.',
  },
  {
    nome: 'consegna',
    etichetta: 'Consegna',
    tipo: 'scelta',
    obbligatorio: false,
    chiestoA: 'segreteria',
    opzioni: [
      { valore: 'mano', etichetta: 'A mano' },
      { valore: 'email', etichetta: 'Per email' },
    ],
  },
]

/** Le righe DATI IDENTIFICATIVI DELLA SCUOLA: è ciò che rende il certificato spendibile davanti a un ente. */
function campiEnteGestore(dati: DatiPrestampato): CampoPrestampato[] {
  return [
    ...campo('Denominazione', dati.scuola.ragioneSociale),
    ...campo('P.IVA/C.F.', dati.scuola.piva),
    ...campo('Sede legale', dati.scuola.sedeLegale),
  ]
}

export const modelloCertificatoIscrizioneFrequenza = definisciModello({
  slug: 'certificato_iscrizione_frequenza',
  titolo: 'CERTIFICATO DI ISCRIZIONE E FREQUENZA',
  disponibileA: 'genitore_e_segreteria',
  firma: 'legale_rappresentante',
  campi: CAMPI_CERTIFICATO_ISCRIZIONE_FREQUENZA,
  schema: zCertificatoIscrizioneFrequenza,
  componi: (dati, r) => {
    const alunno = {
      nome: dati.alunno.nome,
      cognome: dati.alunno.cognome,
      classe_sezione: dati.alunno.sezione,
    }
    // Il livello si DEDUCE dalla sezione: senza sezione non c'è da cosa dedurlo, e la
    // riga sparisce invece di indovinare. Stessa disciplina della clausola «nella
    // sezione X» dentro `buildCertificatoBody()`.
    const livello = dati.alunno.sezione?.trim() && dati.alunno.livello ? ETICHETTE_LIVELLO[dati.alunno.livello] : ''

    return [
      ...rigaEnteGestore(dati),
      ...blocchiAlunno(dati, { conCodiceFiscale: true }),

      { tipo: 'spazio', mm: 4 },
      // Il corpo NON si riscrive: è quello dei certificati self-service già in
      // produzione, che degrada già bene quando la sezione manca. Il cartaceo unisce le
      // due frasi in una sola («è regolarmente iscritto/a *e* frequenta»); qui restano
      // due capoversi, che dicono le stesse due cose senza duplicare il testo in un
      // secondo posto dove un domani divergerebbe.
      { tipo: 'paragrafo', testo: buildCertificatoBody('iscrizione', alunno, dati.annoScolastico) },
      { tipo: 'paragrafo', testo: buildCertificatoBody('frequenza', alunno, dati.annoScolastico) },
      ...blocchiCampi(campo('Livello', livello)),

      { tipo: 'spazio', mm: 2 },
      {
        tipo: 'paragrafo',
        testo: 'Il presente certificato viene rilasciato, in carta libera, per gli usi consentiti dalla legge.',
      },
      ...paragrafoSe(r.uso?.trim() ? `Si rilascia per il seguente uso: ${r.uso.trim()}.` : ''),

      ...sezioneCampi('Dati identificativi della scuola', campiEnteGestore(dati)),
    ]
  },
})

// ─── 28 — Certificato di iscrizione e frequenza — Nido (Bonus Asilo Nido INPS) ──

/**
 * Gli estremi dell'autorizzazione al funzionamento, in una riga sola e con lo stesso
 * degrado del resto del file: ogni pezzo compare solo se il dato c'è, e senza nessun pezzo
 * la riga non nasce affatto.
 *
 * Interpolarli in una stringa unica — `N. ${numero} del ${data} rilasciata da ${ente}` —
 * sembra la stessa cosa e non lo è: con una data che `isoToIt()` non sa leggere ne esce
 * «N. 77/2024 del  rilasciata da …», cioè esattamente il «N. ______ del ______» che la
 * specifica vieta di mandare all'INPS, e ne esce **senza che nessuna guardia se ne
 * accorga**, perché una stringa montata a mano non è mai vuota.
 *
 * ⚠️ «rilasciata **da**», e mai «rilasciata dal Comune di»: il prefisso cablato che stava
 * qui è finito su tre PDF veri il 2026-08-16. Su Giugliano stampava «rilasciata dal Comune
 * di Comune di Giugliano in Campania» (il dato porta già l'ente per intero); su Aversa e
 * Cesa stampava «dal Comune di Ambito Socio-Sanitario …», che oltre a non essere italiano
 * dichiara a un ente pubblico che un Ambito è un Comune. È lo stesso difetto dell'indirizzo
 * stampato due volte (spec §2.2) spostato in un altro campo: **dato già completo più
 * decorazione aggiunta dal codice**. Ciò che si stampa è il valore, e basta.
 */
function estremiAutorizzazioneNido(sede: DatiSede): string {
  const a = sede.autorizzazioneNido
  const data = isoToIt(a?.data ?? '')
  return [
    a?.numero?.trim() ? `N. ${a.numero.trim()}` : '',
    data ? `del ${data}` : '',
    a?.ente?.trim() ? `rilasciata da ${a.ente.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Gli estremi dell'autorizzazione al funzionamento ci sono tutti e tre, e sono leggibili?
 *
 * Sono tre autorizzazioni diverse, una per sede, e sono l'unico dato che questo
 * certificato porta e che nessun altro documento ha. Se mancano, **il pulsante non
 * compare**: un certificato con «N. ______ del ______» consegnato all'INPS è un
 * documento che l'ente rifiuta e che la famiglia scopre di non avere quando le serve.
 *
 * La data si pretende LEGGIBILE, non solo presente: `autorizzazione_nido` vive in
 * `scuole.config.anagrafica`, cioè in un JSONB che nessun vincolo del database sorveglia.
 * Dal 2026-08-15 `zAnagraficaSede` conosce la chiave e il form usa un `input type="date"`
 * (quindi ISO), ma questa guardia resta: le righe scritte prima di quel giorno, e
 * qualunque scrittura che non passi dal form, possono ancora portare «01/09/2024» in
 * formato italiano — che supererebbe qualsiasi `trim()` e poi si stamperebbe come vuoto.
 */
export function autorizzazioneNidoCompleta(sede: DatiSede): boolean {
  const a = sede.autorizzazioneNido
  return Boolean(a?.numero?.trim() && isoToIt(a?.data ?? '') && a?.ente?.trim())
}

const zCertificatoBonusNido = z.object({})

export type RisposteCertificatoBonusNido = z.infer<typeof zCertificatoBonusNido>

/**
 * L'indirizzo operativo del nido, in una riga.
 *
 * Le stesse parti che `buildIntestazioneSede()` mette nella seconda riga della testata,
 * ma qui servono come VALORE di un campo e non come riga di intestazione: chiamare
 * quella funzione e pescarne la riga per posizione sarebbe un legame che si rompe in
 * silenzio il giorno in cui una sede non ha il nome.
 */
function indirizzoOperativo(sede: DatiSede): string {
  const capCitta = [sede.scuola_cap?.trim(), sede.scuola_citta?.trim()].filter(Boolean).join(' ')
  const provincia = sede.scuola_provincia?.trim()
  return [
    sede.scuola_indirizzo?.trim(),
    [capCitta, provincia ? `(${provincia})` : ''].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(' — ')
}

export const modelloCertificatoBonusNido = definisciModello({
  slug: 'certificato_bonus_nido',
  titolo: 'CERTIFICATO DI ISCRIZIONE E FREQUENZA — NIDO',
  disponibileA: 'genitore_e_segreteria',
  firma: 'legale_rappresentante',
  campi: [],
  schema: zCertificatoBonusNido,
  verificaContesto: (dati) => {
    // Condizione 1 della specifica, ed è la più grave delle tre: il Bonus Asilo Nido
    // spetta a un servizio 0-3, e «un certificato emesso per un bambino della primavera è
    // una dichiarazione falsa a un ente pubblico». Il livello è già nei dati e il 26·27 lo
    // usa: lasciare fuori proprio questa condizione voleva dire attestare il nido a un
    // bambino dell'infanzia con un `ok: true`.
    //
    // ⚠️ Il livello arriva da `sections.school_type`, che NON distingue la sezione
    // primavera dal nido: quel filtro (24-36 mesi) resta alla route, che conosce la
    // sezione e l'età. Qui si ferma ciò che il modello può vedere — infanzia, primaria e
    // il livello sconosciuto — e non si finge di aver fermato il resto.
    if (dati.alunno.livello !== 'nido') {
      return [
        {
          campo: '',
          messaggio:
            'Il certificato per il Bonus Asilo Nido si rilascia solo a un bambino/a iscritto/a al nido: per gli altri livelli si usa il certificato di iscrizione e frequenza.',
        },
      ]
    }
    if (!autorizzazioneNidoCompleta(dati.sede)) {
      return [
        {
          campo: '',
          messaggio:
            'Gli estremi dell’autorizzazione al funzionamento del nido non sono configurati per questa sede: il certificato non si emette.',
        },
      ]
    }
    return []
  },
  componi: (dati) => {
    const a = dati.alunno
    // La frase del cartaceo, composta pezzo per pezzo: ogni inciso c'è solo se il dato
    // c'è. Su un certificato che va all'INPS, «nato/a a ______» non è un modulo da
    // completare, è una dichiarazione incompleta della scuola.
    const luogo = a.luogoNascita?.trim()
    const nascita = isoToIt(a.dataNascita ?? '')
    const cf = a.codiceFiscale?.trim()
    // «nato/a» regge sia il luogo sia la data, e togliere un pezzo non è togliere una
    // parola: senza luogo l'inciso diventa «nato/a il …», senza data «nato/a a …», senza
    // entrambi sparisce. Incollando i frammenti uno dietro l'altro verrebbe fuori
    // «bambino/a Cognome Nome il 17/04/2022», che non è italiano e che qualcuno leggerà
    // allo sportello dell'INPS.
    const nato =
      luogo && nascita
        ? `, nato/a a ${luogo} il ${nascita}`
        : luogo
          ? `, nato/a a ${luogo}`
          : nascita
            ? `, nato/a il ${nascita}`
            : ''
    const corpo = [
      `Visti gli atti d'ufficio, si certifica che il/la bambino/a ${a.cognome} ${a.nome}`,
      nato,
      cf ? `, codice fiscale ${cf}` : '',
      `, è regolarmente iscritto/a e frequenta con assiduità, per l'anno scolastico ${dati.annoScolastico}, il Nido d'Infanzia gestito da questa scuola.`,
    ].join('')

    return [
      ...rigaEnteGestore(dati),
      { tipo: 'paragrafo', testo: '(per la richiesta del Bonus Asilo Nido INPS)', stile: 'corsivo' },
      // Nessun blocco DATI DELL'ALUNNO/A, e non è una dimenticanza: il modello trascritto
      // dal `.docx` ha la casella della sede e poi la frase, e gli identificativi stanno
      // DENTRO la frase. Ristamparli due centimetri sopra in righe-campo li avrebbe
      // duplicati sullo stesso foglio — sul 26·27 il blocco serve perché il corpo riusato
      // non porta né nascita né codice fiscale, qui li porta tutti e tre.
      ...casellaSede(dati, 'Sede del Nido'),

      { tipo: 'spazio', mm: 4 },
      { tipo: 'paragrafo', testo: corpo },
      {
        tipo: 'paragrafo',
        testo:
          'Il presente certificato viene rilasciato per gli usi consentiti dalla legge, ivi compresa la richiesta del Bonus Asilo Nido INPS.',
      },

      { tipo: 'sezione', titolo: 'Dati identificativi della struttura' },
      {
        tipo: 'campi',
        campi: [
          ...campiEnteGestore(dati),
          ...campo('Sede operativa del Nido', indirizzoOperativo(dati.sede)),
          ...campo('Autorizzazione al funzionamento', estremiAutorizzazioneNido(dati.sede)),
        ],
        colonne: 1,
      },
    ]
  },
})

// ─── Il registro degli otto ─────────────────────────────────────────────────────

export const MODELLI_GENITORE: readonly ModelloPrestampato[] = [
  modelloSchedaSanitaria,
  modelloAutorizzazioneFarmaci,
  modelloDietaSpeciale,
  modelloDelegaRitiro,
  modelloPermessoOrario,
  modelloAutorizzazioneUscita,
  modelloCertificatoIscrizioneFrequenza,
  modelloCertificatoBonusNido,
]

/** Il modello di uno slug, o `null`: uno slug sconosciuto non è un'eccezione, è un 404. */
export function modelloGenitore(slug: string): ModelloPrestampato | null {
  return MODELLI_GENITORE.find((m) => m.slug === slug) ?? null
}

/**
 * Le righe di intestazione del foglio, dalle stesse funzioni dei certificati già in
 * produzione: righe omesse quando il dato manca, mai una riga vuota.
 */
export function intestazionePrestampato(dati: DatiPrestampato): string[] {
  return buildIntestazioneSede(dati.sede)
}

/** «Cesa, lì 13/08/2026», oppure «Lì 13/08/2026» se la città non è in archivio. */
export function luogoDataPrestampato(dati: DatiPrestampato): string {
  return rigaLuogoData(dati.sede.scuola_citta, isoToIt(dati.dataOggi))
}
