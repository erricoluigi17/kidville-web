/**
 * I NOVE PRESTAMPATI DELLA SEGRETERIA E DELLE INSEGNANTI
 * (specifiche: `docs/prestampati/30`, `31`, `39`, `42`, `45`, `46`, `47`, `49`, `50`).
 *
 * Definizioni PURE: qui non entrano né Supabase né `fetch` né il logger. Un modello
 * dichiara *cosa* è (slug, soggetto, chi lo genera, che firma vuole, se esce dalla
 * scuola), *cosa chiede* al form (descrittori + schema `zod`) e *come si compone*
 * (dai dati precompilati + le risposte → i blocchi di `impaginazione.ts`). Il PDF, il
 * protocollo e l'archiviazione li fa la route: qui si può collaudare il testo di un
 * certificato senza un database e senza un byte di jsPDF.
 *
 * ── LE TRE REGOLE CHE VALGONO PER TUTTI E NOVE ──────────────────────────────────
 *
 * 1. **Il nucleo comune non si chiede mai.** Nome, cognome, nascita, codice fiscale,
 *    sezione, sede, scuola, genitore e anno scolastico l'app li ha già
 *    (`docs/prestampati/README.md`, tabella «Il nucleo comune»): arrivano nel prefill.
 *    Un campo chiesto una volta non si richiede più — è la differenza fra digitalizzare
 *    un modulo e digitalizzare la segreteria.
 *
 * 2. **Degrado esplicito.** Un dato che manca fa OMETTERE la riga; non produce «N.D.»,
 *    non produce una riga vuota che sembri un valore. È la disciplina già in uso in
 *    `src/lib/certificati/self-service.ts` (`buildIntestazioneSede`, `clausolaSezione`),
 *    e vale anche per una COLONNA intera (n. 47). ⚠️ Attenzione al confine: nei blocchi
 *    `campi` un valore assente NON è neutro — il motore ci stampa il filetto da compilare
 *    a penna. Sui documenti che escono dalla scuola quel filetto sarebbe un buco da
 *    riempire a mano su un atto firmato, quindi lì la riga si toglie del tutto
 *    (`campiSeValorizzati`); il filetto resta solo dove il modulo È fatto per essere
 *    completato a penna (il tagliando del n. 31, le firme del n. 50). Le righe vuote in coda
 *    a una TABELLA sono un'altra cosa e non le decide questa regola: le governa §2 di
 *    `00-impaginazione.md`, che le pretende sulle tabelle ripetibili — n. 47 compreso, con
 *    l'obiezione annotata sul posto.
 *
 * 3. **Niente dati sanitari nei log — e qui il modo di garantirlo è non avere log.**
 *    Il n. 42 (verbale di infortunio) e il n. 49.b/c (allergie, note sanitarie) trattano
 *    dati dell'art. 9 GDPR di minori. Questo file non importa `@/lib/logging/logger` di
 *    proposito: chi userà questi modelli in una route logghi id, sede, sezione e numero
 *    di righe, mai il contenuto.
 *
 * ── PERCHÉ I TIPI DEL MODELLO STANNO QUI E NON IN UN FILE CONDIVISO ─────────────
 *
 * Perché i prestampati della famiglia (05…10, 26-27, 28) li sta scrivendo un'altra mano
 * nello stesso momento, e un file condiviso scritto da due parti insieme si perde a
 * vicenda.
 *
 * ⚠️ Il prezzo di quella scelta è un DEBITO APERTO, e va elencato invece che scoperto:
 * `modelli/genitore.ts` dichiara un PROPRIO `ModelloPrestampato`, con lo stesso nome e
 * una forma incompatibile. Le differenze, una per una, così chi unisce non debba
 * cercarle:
 *
 *   · la chiave del campo — `CampoModulo.id` qui, `CampoModulo.nome` di là;
 *   · `TipoCampoModulo` — qui `mese`/`griglia`/`conferma`, di là
 *     `numero`/`telefono`/`siNo`/`file`/`righe`;
 *   · la firma — qui i tre tipi del motore (`FirmaPrestampato['tipo']`), di là
 *     `FirmaRichiesta` (`otp_genitore`/`otp_due_genitori`/`legale_rappresentante`);
 *   · `OpzioneCampo` è dichiarata in tutti e due i file;
 *   · il titolo — qui è una FUNZIONE delle risposte (il n. 39 e il n. 49 lo ricavano da
 *     lì), di là una costante;
 *   · chi può generare — `disponibileA` di là, i ruoli dell'app (`disponibilePer`) qui;
 *   · `componi` — di là valida e compone in un colpo solo restituendo un esito: è il
 *     cancello che impedisce di comporre risposte non validate, e va tenuto.
 *
 * La prima route che importa tutti e due i file non compila — o, peggio, compila e
 * disegna due form con regole diverse. L'unione va fatta in `modelli/tipi.ts` PRIMA del
 * pannello: si tengono il cancello di `genitore.ts` e soggetto, protocollo,
 * archiviazione, `piePagina`, `blocchiDopoFirma` e titolo dinamico di questo file. Da
 * unire, non da scegliere: servono tutte e due.
 *
 * ── UNA NOTA MINUTA CHE SI PAGA CARA: L'APOSTROFO È QUELLO DRITTO ──────────────
 *
 * Nei file `messages/*.json` vale quello tipografico e c'è un lock a pretenderlo. Qui
 * no, e per due ragioni misurabili: il testo di questi modelli si mescola sullo stesso
 * foglio con quello riusato dalla produzione (`buildDocumentoRichiesta`,
 * `buildCertificatoBody`, la dicitura del D.Lgs 39/93), che lo usa dritto — due forme
 * diverse nella stessa frase si vedono a stampa; e le euristiche che RILEGGONO i PDF
 * protocollati cercano la forma dritta (`src/lib/protocolli/estrai.ts` riconosce `all'`,
 * non quella tipografica). Un apostrofo elegante che rompe la precompilazione del
 * protocollo è un difetto che nessuno attribuirebbe mai a un apostrofo.
 */

import { z } from 'zod'
import { zDataYMD, zAnnoMese } from '@/lib/validation/common'
import { isoToIt } from '@/lib/format/data'
import { formatEuro } from '@/lib/format/valuta'
import { formattaDecimale } from '@/lib/i18n/numero'
import { dataCivile, formattaIstante, intlDateTime } from '@/i18n/config'
import { buildDocumentoRichiesta } from '@/lib/protocolli/documenti'
import {
  DEFAULT_LIVELLI,
  livelliEffettivi,
  renderTemplate,
  type SollecitiConfig,
} from '@/lib/pagamenti/solleciti'
import { COMPETENZE_CHIAVE, LIVELLI, livelloEtichetta } from '@/lib/competenze/modello'
import type { BloccoPrestampato, CampoPrestampato, FirmaPrestampato } from '../tipi'

// ─── Il contratto di un modello ─────────────────────────────────────────────────

/**
 * Di CHI parla il foglio. Non è una descrizione: decide che cosa chiede il pannello
 * della segreteria prima di generare — un alunno, una sezione intera, un dipendente —
 * e quindi anche quale gate di scope deve superare la route.
 */
export type SoggettoPrestampato = 'alunno' | 'sezione' | 'dipendente'

/**
 * Chi può generare il prestampato. I valori sono quelli di `AppRole`
 * (`src/lib/auth/require-staff.ts`) ma NON si importano da lì: quel modulo tira dentro
 * `next/server` e il client Supabase service-role, e un modello puro che finisce in un
 * pannello `'use client'` se li porterebbe appresso — è il modo in cui in questo repo
 * `vitest` resta verde e `npm run build` cade.
 */
export type RuoloPrestampato = 'admin' | 'coordinator' | 'segreteria' | 'educator'

/** Dove finisce il PDF dopo la firma. La scrittura la fa la route, la scelta è qui. */
export type ArchiviazionePrestampato =
  | 'student_documents'
  | 'fascicolo_personale'
  | 'protocolli'
  | 'nessuna'

/** Ciò che esce dalla scuola consuma un numero di protocollo (README, regola 4). */
export type ProtocolloPrestampato = 'uscita' | 'nessuno'

export type TipoCampoModulo =
  | 'testo'
  | 'testoLungo'
  | 'data'
  | 'ora'
  | 'mese'
  | 'email'
  | 'scelta'
  | 'sceltaMultipla'
  /**
   * Una voce PER OGNI opzione, ognuna col proprio valore: i cinque campi di esperienza
   * del n. 45, le otto competenze chiave del n. 46. Non è una scelta multipla — e la
   * differenza non è di lessico: un pannello che leggesse `sceltaMultipla` disegnerebbe
   * otto caselle da spuntare al posto di otto righe con un livello ciascuna.
   */
  | 'griglia'
  | 'conferma'

/**
 * Una voce di un elenco chiuso. `zOpzioni()` ne ricava lo schema `zod`, così le voci
 * che il form mostra e i valori che il form accetta non possono divergere.
 */
export interface OpzioneCampo {
  valore: string
  etichetta: string
}

/**
 * Il descrittore con cui il pannello costruisce il campo.
 *
 * Non è `FormField` di `@/types/database.types`, e la ragione è una sola: quel tipo —
 * che è il modello dei moduli PUBBLICI, costruiti dal builder — non ha il tipo `ora`,
 * e il n. 42 di ore ne chiede quattro. Allargare `FormFieldType` significherebbe
 * toccare un file condiviso per un campo che il builder pubblico non userà mai.
 */
export interface CampoModulo {
  /** Chiave nelle risposte: coincide con la chiave dello schema `zod`. */
  id: string
  etichetta: string
  tipo: TipoCampoModulo
  obbligatorio: boolean
  /** Riga di aiuto sotto il campo: dice PERCHÉ si chiede, non che cos'è. */
  aiuto?: string
  /**
   * Le voci fra cui si sceglie: le alternative di `scelta`/`sceltaMultipla`, le RIGHE di
   * una `griglia` (i cinque campi di esperienza, le otto competenze chiave).
   */
  opzioni?: readonly OpzioneCampo[]
  /**
   * I valori ammessi su OGNI riga di una `griglia`: i tre livelli dell'infanzia, i
   * quattro del D.M. 14/2024.
   *
   * Senza, il descrittore non basta a costruire il campo — che è l'unica ragione per cui
   * esiste — e un pannello dovrebbe cablare la scala campo per campo: la prossima volta
   * che cambia si scoprirebbe lì, invece che qui dove è dichiarata.
   *
   * Si chiama `valoriAmmessi` e non `valori` perché in `modelli/genitore.ts` — il file
   * con cui questi tipi vanno uniti — `valori` è già la lista di un `mostraSe`, cioè i
   * valori di un ALTRO campo: due `valori` con due significati nella stessa interfaccia
   * unita sarebbero un errore che compila.
   */
  valoriAmmessi?: readonly OpzioneCampo[]
}

/**
 * La vista del modello che serve al pannello: metadati e descrittori, senza i tipi di
 * prefill e risposte — che sono diversi per ognuno dei nove e non stanno in un elenco
 * solo. `MODELLI_SEGRETERIA` è un elenco di queste.
 */
export interface VoceRegistroPrestampati {
  /** `student_documents.document_type` dove il documento si archivia lì; chiave altrove. */
  slug: string
  /** Nome nel pannello della segreteria (il titolo sul foglio è un'altra cosa). */
  etichetta: string
  soggetto: SoggettoPrestampato
  disponibilePer: readonly RuoloPrestampato[]
  firma: FirmaPrestampato['tipo']
  protocollo: ProtocolloPrestampato
  archiviazione: ArchiviazionePrestampato
  campi: readonly CampoModulo[]
}

/** Un modello completo: la vista di registro più lo schema e la composizione. */
export interface ModelloPrestampato<P, R> extends VoceRegistroPrestampati {
  schema: z.ZodType<R>
  /** Il titolo sul foglio, in maiuscolo. Dipende dalle risposte nel n. 39 e nel n. 49. */
  titolo(prefill: P, risposte: R): string
  componi(prefill: P, risposte: R): BloccoPrestampato[]
  /**
   * I blocchi che sul foglio vanno SOTTO il blocco di firma. Oggi il solo n. 31: la sua
   * linea di taglio e il tagliando di risposta, che la specifica mette dopo la firma
   * (`docs/prestampati/31-richiesta-disponibilita.md`).
   *
   * ⚠️ ESISTE PERCHÉ IL MOTORE NON SA FARLO, e finché non lo saprà questa funzione è il
   * modo di non produrre un foglio sbagliato invece di annotare che lo è.
   * `impaginazione.ts` disegna `disegnaFirma` DOPO tutti i blocchi, sempre: mettere il
   * tagliando fra i blocchi di `componi` stampava la firma del legale rappresentante SOTTO
   * la linea di taglio — chi ritagliava il tagliando per rispedirlo si portava via la firma,
   * e all'istituto destinatario restava la metà non firmata di una lettera fra scuole.
   *
   * Il contratto per chi userà il modello, in due righe:
   *   · una route che non sa renderli li IGNORA, e ottiene una lettera firmata e completa in
   *     tutto tranne il tagliando — incompleta, non sbagliata;
   *   · quando `DocumentoPrestampato` avrà il campo gemello, la route glieli passa e il
   *     foglio torna a essere quello della specifica.
   *
   * La riparazione vera è quel campo in `tipi.ts` + `impaginazione.ts`: segnalata e non
   * fatta, perché quei due file non sono di questa mano.
   */
  blocchiDopoFirma?(prefill: P, risposte: R): BloccoPrestampato[]
  /**
   * Piede di pagina alternativo, su OGNI pagina (`DocumentoPrestampato.piePagina`).
   * Lo usa il solo n. 49, dove la specifica chiede che un elenco con nomi, allergie e
   * telefoni porti sempre addosso chi l'ha stampato e quando.
   */
  piePagina?(prefill: P, risposte: R): string | undefined
}

// ─── Il nucleo comune, così come arriva dal prefill ──────────────────────────────

/**
 * Le date del prefill viaggiano come stanno in tabella: la conversione a `gg/mm/aaaa` la fa
 * `dataIt()` qui dentro. Passare date già formattate significherebbe avere due formattatori
 * — quello del chiamante e questo — e i due divergono al primo modulo scritto di fretta.
 *
 * «Come stanno in tabella» sono DUE forme, non una: `YYYY-MM-DD` per le colonne `date` e
 * l'istante completo per le `timestamptz`. Ogni campo qui sotto dice quale delle due è —
 * «ISO» da solo è vero per tutte e due e non aiuta nessuno.
 */
export interface NucleoAlunno {
  cognome: string
  nome: string
  /** `YYYY-MM-DD`: `alunni.data_nascita` è una colonna `date`, non un istante. */
  dataNascita?: string | null
  luogoNascita?: string | null
  codiceFiscale?: string | null
  sezione?: string | null
}

/**
 * Dati della cooperativa. ⚠️ Mai cablati nel codice: il repository è pubblico e il CdA
 * cambia — vengono da `scuole.config.anagrafica`.
 *
 * ⚠️ Li chiedono SOLO i due modelli che li stampano nel CORPO: il n. 39, che firma la
 * lettera con la ragione sociale quando la denominazione non c'è, e il n. 47, che porta i
 * dati identificativi della scuola in coda al certificato. Sugli altri sette la ragione
 * sociale e il legale rappresentante finiscono nell'INTESTAZIONE e nel BLOCCO FIRMA, che il
 * motore riceve dalla route (`DocumentoPrestampato.intestazione`, `FirmaPrestampato`) e non
 * da `componi`: pretenderli anche qui significherebbe far leggere alla segreteria cinque
 * tabelle di `scuole.config.anagrafica` per buttarle via, in un file che comincia dicendo
 * che un campo chiesto una volta non si richiede più. Ciò che tiene la linea non è una
 * raccomandazione: i sette prefill che non stampano la cooperativa non hanno affatto un
 * campo `scuola`, e `tsc` rifiuta di passarglielo.
 *
 * ⚠️ IL LEGALE RAPPRESENTANTE NON STA QUI, ed è la stessa regola applicata a questa
 * interfaccia: nessuno dei nove lo legge, perché il suo nome arriva dal blocco di firma
 * (`FirmaPrestampato['legaleRappresentante']`). Dichiararlo lo renderebbe un campo che una
 * route legge da `scuole.config.anagrafica` per buttarlo via — cioè esattamente ciò che il
 * capoverso qui sopra vieta, scritto due righe sotto.
 */
export interface NucleoScuola {
  ragioneSociale?: string | null
  piva?: string | null
  sedeLegale?: string | null
  /** Tutti i codici della cooperativa (n. 47): le sedi ne hanno più d'uno. */
  codiciMeccanografici?: string | null
}

/** La singola sede. Le tre di produzione hanno indirizzi e codici diversi. */
export interface NucleoSede {
  nome?: string | null
  telefono?: string | null
  codiceMeccanografico?: string | null
}

// ─── Aiuti di composizione ──────────────────────────────────────────────────────

/** La lingua dei prestampati è una sola: sono atti italiani, non schermate tradotte. */
const LINGUA = 'it'

/** Stringa non vuota, oppure `null`. È il primo gradino del degrado esplicito. */
function testo(valore: string | null | undefined): string | null {
  const t = valore?.trim()
  return t ? t : null
}

/**
 * Riconosce un ISO che porta dentro anche l'ora — la forma con cui PostgREST restituisce
 * una colonna `timestamp with time zone`: `2026-10-12T09:24:31.123456+00:00`.
 *
 * Il controllo è una REGEX e non un `new Date` a occhi chiusi perché `new Date('12/10/2026')`
 * in JavaScript è il 10 dicembre (mese/giorno all'americana): una data già in forma italiana
 * entrata qui per sbaglio uscirebbe cambiata di giorno invece che rifiutata.
 */
const ISTANTE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/

/**
 * Data → `gg/mm/aaaa`; `null` se manca o non è una data (mai un valore inventato).
 *
 * ⚠️ LE FORME SONO DUE, E UNA SOLA SI VEDE. `isoToIt` è ANCORATA a `^\d{4}-\d{2}-\d{2}$`
 * (`src/lib/format/data.ts`): su un istante torna stringa vuota, e la riga sparisce in
 * silenzio. Su questi nove fogli l'assenza di una data non è un buco, SIGNIFICA qualcosa —
 * il n. 42 senza «— firmato il …» dichiara un verbale che nessuno ha firmato, il n. 50 senza
 * «Chiuso il» dichiara un mese ancora aperto, il n. 49 senza «Aggiornato al …» consegna alla
 * cucina un foglio che non dice quanto è vecchio. Perdere la data qui non toglie un dato: ne
 * afferma uno falso. E `firmato_il` è `timestamptz` in cinque tabelle del baseline, quindi
 * non è un caso di scuola: è la forma NORMALE in cui quei valori arrivano.
 *
 * Perciò si accettano tutte e due: la data di calendario per riordino di stringa, l'istante
 * ridotto prima alla sua data CIVILE italiana (`dataCivile`, `Europe/Rome`) e poi passato allo
 * stesso `isoToIt`. Le due strade escono con le stesse cifre zero-riempite, e una firma
 * apposta alle 23:30 UTC del 12 si stampa 13 — che è il giorno in cui è stata apposta qui.
 */
function dataIt(iso: string | null | undefined): string | null {
  const grezzo = testo(iso)
  if (!grezzo) return null
  const secca = testo(isoToIt(grezzo))
  if (secca) return secca
  if (!ISTANTE_ISO.test(grezzo)) return null
  const istante = new Date(grezzo)
  return Number.isNaN(istante.getTime()) ? null : testo(isoToIt(dataCivile(istante)))
}

function nomeCompleto(persona: { cognome?: string | null; nome?: string | null }): string | null {
  return testo([persona.cognome, persona.nome].map((p) => testo(p)).filter(Boolean).join(' '))
}

/**
 * Un CONTEGGIO che c'è; `null` per assente o non finito — «0» resta «0», che è un dato.
 *
 * ⚠️ Solo numeri interi: è `String(valore)`, cioè il punto decimale inglese. Tutto ciò che
 * può venire frazionario (ore settimanali, medie) passa da `formattaDecimale(…, LINGUA, n)`
 * — due discipline di formattazione per lo stesso tipo di dato, sullo stesso foglio, sono il
 * modo in cui su un atto italiano compare «12.5». La precisione a quella funzione si passa
 * SEMPRE: il suo valore predefinito è una cifra sola (nato per i megabyte dentro una frase)
 * e su un certificato di servizio arrotonda 12,75 ore a «12,8».
 */
function numero(valore: number | null | undefined): string | null {
  return typeof valore === 'number' && Number.isFinite(valore) ? String(valore) : null
}

interface CampoEventuale {
  etichetta: string
  valore: string | null | undefined
}

/**
 * Blocco `campi` con le sole righe che hanno un valore. Nessuna riga = nessun blocco:
 * `...campiSeValorizzati(...)` sparisce dalla sequenza invece di lasciare un titolo di
 * sezione seguito dal vuoto.
 */
function campiSeValorizzati(elenco: CampoEventuale[], colonne: 1 | 2 = 1): BloccoPrestampato[] {
  const presenti: CampoPrestampato[] = []
  for (const campo of elenco) {
    const valore = testo(campo.valore)
    if (valore) presenti.push({ etichetta: campo.etichetta, valore })
  }
  return presenti.length > 0 ? [{ tipo: 'campi', campi: presenti, colonne }] : []
}

/** Righe da compilare a penna: l'etichetta c'è, il valore no, e il motore stampa il filetto. */
function campiDaCompilare(etichette: string[], colonne: 1 | 2 = 1): BloccoPrestampato[] {
  return [{ tipo: 'campi', campi: etichette.map((etichetta) => ({ etichetta })), colonne }]
}

/** Le due colonne della nascita: possono mancare l'una senza l'altra, e succede. */
interface DatiNascita {
  luogoNascita?: string | null
  dataNascita?: string | null
}

/**
 * LA NASCITA È UNA LOCUZIONE SOLA, mai due righe affiancate — e vale per tutti e tre i punti
 * in cui compare (n. 30, n. 46, n. 47).
 *
 * Con «Nato/a a» e «il» come CAMPI distinti, `campiSeValorizzati` compatta: un bambino di cui
 * l'archivio ha la data di nascita ma non il luogo — combinazione tutt'altro che rara in questo
 * progetto — usciva con una riga «il: 14/03/2021» senza antecedente, per giunta ripaginata
 * nell'altra colonna del blocco a due colonne. Componendola qui, ciò che manca sparisce senza
 * lasciare in piedi la preposizione di ciò che c'è.
 *
 * `locuzioneNascita` è la forma per la PROSA («nato/a a Cittàfinta (XX) il 14/03/2021», dentro
 * la frase che certifica del n. 47); `campoNascita` la stessa cosa come RIGA di un blocco
 * `campi`, dove l'etichetta si prende la preposizione — «Nato/a a: Cittàfinta (XX) il
 * 14/03/2021», «Nato/a il: 14/03/2021» — così il valore comincia sempre con un dato e non con
 * una parola sospesa. Niente nascita in archivio = nessuna riga: è il degrado della regola 2.
 */
function locuzioneNascita(persona: DatiNascita): string | null {
  const luogo = testo(persona.luogoNascita)
  const data = dataIt(persona.dataNascita)
  return testo([luogo ? `a ${luogo}` : null, data ? `il ${data}` : null].filter(Boolean).join(' '))
}

function campoNascita(persona: DatiNascita): CampoEventuale[] {
  const luogo = testo(persona.luogoNascita)
  const data = dataIt(persona.dataNascita)
  if (luogo && data) return [{ etichetta: 'Nato/a a', valore: `${luogo} il ${data}` }]
  if (luogo) return [{ etichetta: 'Nato/a a', valore: luogo }]
  if (data) return [{ etichetta: 'Nato/a il', valore: data }]
  return []
}

/**
 * Tronca a `max` caratteri e chiude con i puntini di sospensione; sotto la soglia, il testo
 * com'è. Serve al piede del n. 49, dove la lunghezza non è estetica ma un ingombro: vedi il
 * commento di `piePagina`.
 *
 * `…` (U+2026) e non tre punti: sta in WinAnsi, cioè nella codifica dell'Helvetica di serie di
 * jsPDF — verificato generando il PDF e rileggendolo con PDF.js, dove esce tale e quale. Non è
 * scontato su questo motore: `✂` (U+2702), nella stessa posizione, diventa un apostrofo (n. 31).
 */
function accorcia(valore: string | null, max: number): string | null {
  if (!valore) return null
  return valore.length <= max ? valore : `${valore.slice(0, max - 1).trimEnd()}…`
}

function paragrafoSePresente(
  valore: string | null | undefined,
  stile?: 'normale' | 'corsivo' | 'grassetto'
): BloccoPrestampato[] {
  const t = testo(valore)
  return t ? [{ tipo: 'paragrafo', testo: t, ...(stile ? { stile } : {}) }] : []
}

/**
 * Un testo con righe bianche dentro diventa PIÙ blocchi, non uno solo con dei ritorni a
 * capo: così ogni capoverso può andare a pagina nuova per conto suo, che è ciò che il
 * motore sa fare con i blocchi e non con le righe.
 */
function paragrafiDa(valore: string | null | undefined): BloccoPrestampato[] {
  return (testo(valore) ?? '')
    .split(/\n{2,}/)
    .flatMap((capoverso) => paragrafoSePresente(capoverso.replace(/\n/g, ' ')))
}

function sezione(titolo: string): BloccoPrestampato {
  return { tipo: 'sezione', titolo }
}

/** Caselle da un elenco chiuso: spuntata quella (o quelle) che l'app già conosce. */
function caselleDa(
  opzioni: readonly OpzioneCampo[],
  scelte: readonly string[]
): BloccoPrestampato {
  return {
    tipo: 'caselle',
    caselle: opzioni.map((o) => ({ testo: o.etichetta, spuntata: scelte.includes(o.valore) })),
  }
}

function etichettaDi(opzioni: readonly OpzioneCampo[], valore: string | null | undefined): string | null {
  return opzioni.find((o) => o.valore === valore)?.etichetta ?? null
}

/**
 * Lo schema `zod` di un elenco chiuso, ricavato dalle sue opzioni.
 *
 * L'elenco che il form mostra e i valori che il form accetta sono la stessa cosa detta
 * una volta: aggiungere un luogo di infortunio senza aggiornare la validazione non è
 * possibile, perché non ci sono due posti dove scriverlo.
 */
function zOpzioni<T extends readonly OpzioneCampo[]>(opzioni: T) {
  const valori = opzioni.map((o) => o.valore) as [T[number]['valore'], ...T[number]['valore'][]]
  return z.enum(valori)
}

const zTesto = (max: number) => z.string().trim().min(1, 'Campo obbligatorio').max(max)
const zTestoFacoltativo = (max: number) => z.string().trim().max(max).optional()
/** Ora del giorno `HH:MM` in 24 ore: un infortunio alle «7» non dice se di mattina. */
const zOra = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Ora non valida (atteso HH:MM)')

// ════════════════════════════════════════════════════════════════════════════════
// 30 — NULLA OSTA AL TRASFERIMENTO
// ════════════════════════════════════════════════════════════════════════════════

export interface PrefillNullaOsta {
  alunno: NucleoAlunno
  annoScolastico: string
}

const schemaNullaOsta = z.object({
  istituto: zTesto(200),
  sede_istituto: zTesto(200),
  decorrenza: zDataYMD,
  /**
   * Conferma consapevole, non una spunta di rito: la schermata mostra il saldo prima
   * di generare, e questa riga è la dichiarazione che il legale rappresentante firma.
   * `literal(true)` significa che senza conferma il documento non nasce — e che il
   * rifiuto arriva dallo schema, non dalla buona volontà della schermata.
   */
  regolarita_confermata: z.literal(true, {
    error: 'Confermare la regolarità della posizione amministrativa prima di generare',
  }),
})

export type RisposteNullaOsta = z.infer<typeof schemaNullaOsta>

/**
 * La coda con cui il testo in produzione chiude il capoverso «alla cieca».
 *
 * `buildDocumentoRichiesta` non sa dove va il bambino e finisce la frase con «presso
 * altro istituto»: è esattamente il difetto che la specifica n. 30 mette nella colonna
 * «In app ✗» e che questo modello esiste per sanare. Riusare quel capoverso E aggiungere
 * sotto il nome dell'istituto darebbe un atto che si contraddice da sé — «presso altro
 * istituto», e due righe dopo quale — su un foglio che legge un'altra scuola. Quindi la
 * coda si toglie e al suo posto entra la destinazione vera, dentro la stessa frase, come
 * nel modello cartaceo: «si rilascia NULLA OSTA … presso l'Istituto X, con sede in Y, a
 * decorrere dal Z».
 *
 * La riparazione pulita sarebbe una destinazione opzionale fra i parametri di
 * `buildDocumentoRichiesta` — segnalata, non fatta: `src/lib/protocolli/documenti.ts`
 * non è di questa mano.
 */
const CODA_SENZA_DESTINAZIONE = ', presso altro istituto.'

export const modelloNullaOsta: ModelloPrestampato<PrefillNullaOsta, RisposteNullaOsta> = {
  slug: 'nulla_osta',
  etichetta: 'Nulla osta al trasferimento',
  soggetto: 'alunno',
  disponibilePer: ['admin', 'segreteria', 'coordinator'],
  firma: 'legaleRappresentante',
  protocollo: 'uscita',
  archiviazione: 'student_documents',
  campi: [
    {
      id: 'istituto',
      etichetta: 'Istituto di destinazione',
      tipo: 'testo',
      obbligatorio: true,
      // La parola «Istituto» la mette già il testo del modello («…presso l'Istituto
      // X…»): senza questa riga si scrive «Istituto Comprensivo di …» e sull'atto esce
      // «presso l'Istituto Istituto Comprensivo di …».
      aiuto: "Precompilato dalla richiesta della famiglia, quando c'è. Solo la denominazione: la parola «Istituto» è già nel testo.",
    },
    { id: 'sede_istituto', etichetta: "Sede dell'istituto", tipo: 'testo', obbligatorio: true },
    { id: 'decorrenza', etichetta: 'Decorrenza del trasferimento', tipo: 'data', obbligatorio: true },
    {
      id: 'regolarita_confermata',
      etichetta: 'La posizione amministrativa risulta regolare a tutti gli effetti',
      tipo: 'conferma',
      obbligatorio: true,
      aiuto:
        'Il nulla osta non si nega per morosità, ma la dichiarazione è del legale rappresentante: prima di confermare, guardare il saldo che la schermata mostra.',
    },
  ],
  schema: schemaNullaOsta,
  // Il titolo si CHIEDE alla stessa funzione che lo dà alla route esistente, invece di
  // ricopiarlo: due fogli intitolati diversamente sarebbero due documenti diversi per
  // chi li riceve, e il registro protocolli conosce quel titolo lì. Gli argomenti non
  // contano — nel ramo `nulla_osta` il titolo è una costante — ed è proprio il punto:
  // finché lo si legge da lì, non può divergere.
  titolo: () => buildDocumentoRichiesta('nulla_osta', { nome: '', cognome: '' }, '').titolo,
  componi(prefill, risposte) {
    const { alunno, annoScolastico } = prefill
    // Stesso riuso per il CORPO, che in app è più povero del modello cartaceo: gli
    // mancano codice fiscale, luogo e data di nascita, l'istituto di destinazione con la
    // sua sede, la decorrenza e — quella che conta — la dichiarazione di regolarità
    // amministrativa, che è la riga per cui la scuola che riceve il bambino chiede
    // questo documento. Si riusa il testo e gli si aggiunge il resto, invece di
    // riscriverlo: la chiusura («per gli usi consentiti dalla legge») è l'ultimo
    // capoverso di quel corpo, quindi si spezza in capoversi e le si fa posto in mezzo.
    const [apertura, ...chiusura] = buildDocumentoRichiesta(
      'nulla_osta',
      { nome: alunno.nome, cognome: alunno.cognome, classe_sezione: alunno.sezione },
      annoScolastico
    ).corpo.split(/\n{2,}/)

    // NIENTE RIPIEGO, MA NEMMENO LA PAROLA «NULL». `decorrenza` passa da `zDataYMD`, che
    // pretende `YYYY-MM-DD` E una data che esiste nel calendario: dallo schema, qui, un
    // valore illeggibile non arriva. Ma `componi(prefill, risposte)` è pubblica e non ha
    // cancelli — a differenza di `modelli/genitore.ts`, che valida e compone in un colpo
    // solo — e TypeScript vede in `decorrenza` una `string` qualunque. `dataIt` su una
    // stringa che non è una data torna `null`, e `null` dentro un template literal DIVENTA
    // la parola «null»: «a decorrere dal null», su un atto firmato dal legale
    // rappresentante e protocollato in uscita. Un `?? risposte.decorrenza` stamperebbe
    // «2026-09-01», che è meno grave ma è comunque un formato che non è quello del foglio.
    // Perciò: la data che non si sa leggere non si stampa, e la frase si chiude senza la
    // coda. Il documento resta incompleto — l'istituto e la sua sede ci sono — invece di
    // dichiarare una decorrenza che nessuno ha scritto.
    const decorrenza = dataIt(risposte.decorrenza)
    const destinazione =
      `presso l'Istituto ${risposte.istituto}, con sede in ${risposte.sede_istituto}` +
      (decorrenza ? `, a decorrere dal ${decorrenza}` : '')
    // Se un giorno la coda non fosse più quella, la destinazione NON si perde: torna a
    // essere una frase per conto suo. Un capoverso in più è un difetto di stile; una
    // destinazione che sparisce da un nulla osta è un documento sbagliato.
    const rilascio = apertura.endsWith(CODA_SENZA_DESTINAZIONE)
      ? `${apertura.slice(0, -CODA_SENZA_DESTINAZIONE.length)}, ${destinazione}.`
      : `${apertura}\n\nIl trasferimento è disposto ${destinazione}.`

    return [
      sezione("Dati dell'alunno/a"),
      ...campiSeValorizzati(
        [
          { etichetta: 'Cognome e nome', valore: nomeCompleto(alunno) },
          { etichetta: 'Codice fiscale', valore: alunno.codiceFiscale },
          ...campoNascita(alunno),
          { etichetta: 'Classe/sezione', valore: alunno.sezione },
          { etichetta: 'Anno scolastico', valore: annoScolastico },
        ],
        2
      ),
      ...paragrafiDa(rilascio),
      ...paragrafoSePresente(
        "Si dichiara altresì che la posizione amministrativa dell'alunno/a risulta regolare a tutti gli effetti."
      ),
      ...chiusura.flatMap((capoverso) => paragrafiDa(capoverso)),
    ]
  },
}

// ════════════════════════════════════════════════════════════════════════════════
// 31 — RICHIESTA DI DISPONIBILITÀ AD ACCOGLIERE L'ALUNNO/A
// ════════════════════════════════════════════════════════════════════════════════

export interface PrefillRichiestaDisponibilita {
  alunno: NucleoAlunno
  annoScolastico: string
}

const schemaRichiestaDisponibilita = z.object({
  istituto: zTesto(200),
  indirizzo_istituto: zTesto(200),
  // Se c'è, la lettera parte da sola; se non c'è, si stampa e si imbuca. Nessuna
  // delle due strade è un errore, quindi il campo è facoltativo.
  email_istituto: z.email('Indirizzo email non valido').max(200).optional().or(z.literal('')),
  decorrenza: zDataYMD,
})

export type RisposteRichiestaDisponibilita = z.infer<typeof schemaRichiestaDisponibilita>

/**
 * La linea lungo cui si taglia il tagliando.
 *
 * ⚠️ IL SEGNO DELLE FORBICI NON C'È, ed è una misura e non un timore: la specifica disegna
 * la riga come «✂ - - - - -» (`31-richiesta-disponibilita.md`), ma il motore stampa con
 * l'Helvetica di serie di jsPDF, che codifica in WinAnsi — e `✂` (U+2702) in WinAnsi non
 * esiste. Scritto tale e quale non sparisce: DIVENTA UN APOSTROFO. Misurato generando il PDF
 * e rileggendolo con PDF.js — dove il sorgente dice `✂ - - - - - X`, il testo estratto dice
 * `' - - - - - X`. Un apostrofo in testa alla linea non dice a chi riceve la lettera ciò che
 * le forbici dicono, quindi al posto del disegno va la sua didascalia — che è il significato
 * del segno, non un suo surrogato. Se un giorno il motore incorporerà un font Unicode, qui
 * torna il glifo e la dicitura se ne va.
 *
 * La lunghezza è misurata anche lei: 154 mm sui 166 utili, cioè una riga sola. Una linea di
 * taglio che va a capo sono due linee di taglio, e chi ritaglia sceglie quella sbagliata.
 */
const LINEA_DI_TAGLIO = `Tagliare lungo la linea ${Array(21).fill('—').join(' ')}`

export const modelloRichiestaDisponibilita: ModelloPrestampato<
  PrefillRichiestaDisponibilita,
  RisposteRichiestaDisponibilita
> = {
  slug: 'richiesta_disponibilita',
  etichetta: 'Richiesta di disponibilità a istituto terzo',
  soggetto: 'alunno',
  disponibilePer: ['admin', 'segreteria', 'coordinator'],
  firma: 'legaleRappresentante',
  protocollo: 'uscita',
  // Corrispondenza fra istituti: sta nel registro protocolli, non nel fascicolo del
  // bambino (specifica n. 31, «Dopo la generazione», punto 3).
  archiviazione: 'protocolli',
  campi: [
    {
      id: 'istituto',
      etichetta: 'Istituto destinatario',
      tipo: 'testo',
      obbligatorio: true,
      // Come nel n. 30: l'intestazione stampa già «Spett.le Istituto».
      aiuto: 'Solo la denominazione: la riga di destinazione porta già «Spett.le Istituto».',
    },
    { id: 'indirizzo_istituto', etichetta: 'Indirizzo', tipo: 'testo', obbligatorio: true },
    {
      id: 'email_istituto',
      etichetta: 'Email o PEC',
      tipo: 'email',
      obbligatorio: false,
      aiuto: "Se c'è, la lettera parte da sola; altrimenti resta un PDF da stampare.",
    },
    { id: 'decorrenza', etichetta: 'Decorrenza prevista', tipo: 'data', obbligatorio: true },
  ],
  schema: schemaRichiestaDisponibilita,
  titolo: () => "RICHIESTA DI DISPONIBILITÀ AD ACCOGLIERE L'ALUNNO/A",
  componi(prefill, risposte) {
    const { alunno, annoScolastico } = prefill
    const nome = nomeCompleto(alunno)
    return [
      ...campiSeValorizzati([
        { etichetta: 'Spett.le Istituto', valore: risposte.istituto },
        { etichetta: 'Indirizzo', valore: risposte.indirizzo_istituto },
        { etichetta: 'Email/PEC', valore: risposte.email_istituto },
      ]),
      {
        tipo: 'paragrafo',
        stile: 'grassetto',
        testo: "Oggetto: Richiesta di disponibilità ad accogliere l'alunno/a ai fini del trasferimento",
      },
      {
        tipo: 'paragrafo',
        testo:
          "Con la presente si comunica che l'alunno/a sotto indicato/a, attualmente iscritto/a presso questa scuola, " +
          'ha manifestato — tramite la propria famiglia — la volontà di trasferirsi presso codesto Istituto.',
      },
      ...campiSeValorizzati(
        [
          { etichetta: 'Cognome e nome', valore: nome },
          { etichetta: 'Data di nascita', valore: dataIt(alunno.dataNascita) },
          { etichetta: 'Classe/Sezione di provenienza', valore: alunno.sezione },
          { etichetta: 'Anno scolastico', valore: annoScolastico },
        ],
        2
      ),
      ...campiSeValorizzati([
        {
          etichetta: 'Decorrenza prevista del trasferimento',
          // Nessun ripiego, per la stessa ragione del n. 30: `zDataYMD` garantisce la forma.
          valore: dataIt(risposte.decorrenza),
        },
      ]),
      {
        tipo: 'paragrafo',
        testo:
          "Si richiede pertanto cortese conferma della disponibilità di un posto per l'alunno/a sopra indicato/a, " +
          'al fine di procedere con il rilascio del nulla osta al trasferimento.',
      },
      {
        tipo: 'paragrafo',
        testo:
          'Si resta in attesa di un cortese riscontro scritto, anche a mezzo email/PEC, e si ringrazia per la collaborazione.',
      },
    ]
  },
  /**
   * Il tagliando sta QUI e non in `componi` perché sul foglio va sotto la firma, e il motore
   * la firma la disegna sempre per ultima: fra i blocchi, la riga di taglio finiva SOPRA
   * «IL LEGALE RAPPRESENTANTE» e chi ritagliava il tagliando si portava via la firma della
   * Scuola. Vedi il contratto di `blocchiDopoFirma` in `ModelloPrestampato`: una route che
   * non sa renderli produce una lettera firmata senza tagliando — incompleta, non sbagliata.
   */
  blocchiDopoFirma(prefill) {
    return [
      { tipo: 'spazio', mm: 6 },
      { tipo: 'paragrafo', stile: 'corsivo', testo: LINEA_DI_TAGLIO },
      sezione('Tagliando di risposta — da restituire a Kidville'),
      ...campiSeValorizzati([{ etichetta: 'Alunno/a', valore: nomeCompleto(prefill.alunno) }]),
      {
        tipo: 'caselle',
        caselle: [
          { testo: "Si conferma la disponibilità di un posto per l'alunno/a sopra indicato/a" },
          { testo: 'Non si conferma la disponibilità' },
        ],
      },
      // Qui il filetto ci vuole: è la parte che l'istituto dall'altra parte compila a
      // penna, ci mette il timbro e rimanda indietro.
      ...campiDaCompilare(['Note']),
      ...campiDaCompilare(['Istituto', 'Data'], 2),
      ...campiDaCompilare(['Timbro e firma']),
    ]
  },
}

// ════════════════════════════════════════════════════════════════════════════════
// 39 — SOLLECITO DI PAGAMENTO (tre livelli)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * La versione STAMPABILE della lettera che oggi esiste solo come email.
 *
 * I testi non si riscrivono: sono quelli di `DEFAULT_LIVELLI`, con la configurazione
 * per sede che vince per indice (`livelliEffettivi`) e gli stessi segnaposto
 * (`renderTemplate`). Se un giorno la segreteria cambia il testo del secondo sollecito
 * dal pannello, cambia anche il foglio che si stampa — che è il punto: un genitore non
 * deve ricevere per posta parole diverse da quelle che ha letto nella mail.
 *
 * ⚠️ La riga della causale contiene il codice fiscale del bambino. È lecita qui — il
 * destinatario è il tutore — ed è la stessa che `solleciti-invio.ts` mette in fondo
 * all'email. Non finisce nei log là e non deve finirci qui: `componi()` restituisce
 * blocchi, e i blocchi non si loggano.
 */
export interface PrefillSollecito {
  alunno: NucleoAlunno
  scuola: NucleoScuola
  /** Come la scuola si firma nei solleciti (`datiStruttura().denominazione`). */
  denominazione?: string | null
  pagamento: {
    descrizione?: string | null
    /**
     * Data secca o istante — `formattaIstante` legge tutte e due. Assente = nessuna scadenza
     * registrata: nel testo resta il trattino, come nell'email.
     */
    scadenza?: string | null
    /**
     * L'importo pieno accanto al residuo. Non lo usa nessuno dei tre testi predefiniti —
     * ma `{importo}` è uno dei segnaposto che una sede può scrivere nella propria
     * configurazione, e nel contesto dell'email c'è: se qui mancasse, la lettera
     * stampata direbbe «{importo}» dove l'email dice una cifra.
     */
    importo: number
    residuo: number
    giorniRitardo: number
  }
  /** `solleciti_config` della sede: sovrascrive i default per indice. */
  config?: SollecitiConfig | null
  /** Riga di causale già composta a monte da `rigaCausaleSollecito`. */
  rigaCausale?: string | null
}

const schemaSollecito = z.object({
  livello: z.coerce
    .number({ error: 'Livello mancante' })
    .int()
    .min(1)
    .max(DEFAULT_LIVELLI.length, `Il sollecito ha ${DEFAULT_LIVELLI.length} livelli`),
})

export type RisposteSollecito = z.infer<typeof schemaSollecito>

/**
 * Il contesto dei segnaposto — LO STESSO di `src/lib/pagamenti/solleciti-invio.ts`
 * (l'oggetto `ctx`), campo per campo e formattatore per formattatore.
 *
 * ⚠️ È una COPIA, e finché resta una copia è un difetto sospeso. Alla nascita divergeva
 * già su due segnaposto:
 *
 *   · `{alunno}` — «Verdi Anna» sul foglio, «Anna Verdi» nella mail. Qui si è tenuto
 *     l'ordine dell'invio (`nome cognome`) e non `nomeCompleto()`, che ovunque altro in
 *     questo file scrive `cognome nome`;
 *   · `{scadenza}` — qui `isoToIt`, cioè un riordino di stringa, là `formattaIstante` in
 *     `Europe/Rome`. Su una data secca le due forme coincidono (misurato: `05/10/2026`),
 *     ma su una scadenza che porti dentro anche l'ora `isoToIt` non la riconosce e torna
 *     vuota: la lettera stampava «—» dove la mail stampa una data.
 *
 * Un genitore non deve leggere per posta parole diverse da quelle della mail, e la
 * differenza più visibile di tutte è il nome del figlio.
 *
 * La riparazione vera è una `contestoSollecito()` esportata da
 * `src/lib/pagamenti/solleciti.ts` e chiamata da tutti e due — segnalata, non fatta:
 * quei due file non sono di questa mano. Nel frattempo il lock «il contesto della lettera
 * è quello dell'email» (nel test di questo file) ESEGUE l'oggetto letterale dell'invio e
 * confronta i due risultati: se là qualcuno tocca un campo, qui diventa rosso.
 */
export function contestoSollecito(prefill: PrefillSollecito): Record<string, string | number> {
  const { alunno, pagamento } = prefill
  return {
    alunno: [alunno.nome, alunno.cognome].filter(Boolean).join(' ') || 'vostro figlio/a',
    descrizione: pagamento.descrizione ?? '—',
    importo: formatEuro(pagamento.importo),
    residuo: formatEuro(pagamento.residuo),
    scadenza: pagamento.scadenza ? formattaIstante(new Date(pagamento.scadenza), LINGUA) : '—',
    giorni_ritardo: pagamento.giorniRitardo,
    // `denominazione` è lo STESSO valore che calcola l'invio (`datiStruttura().
    // denominazione`) e la route lo passa da lì: quando c'è, mail e lettera si firmano
    // uguale. La ragione sociale è il ripiego di questo foglio — che il nome della
    // cooperativa ce l'ha già in testata — e l'ultimo gradino è quello dell'email, così
    // una lettera non resta mai senza chi la manda.
    scuola: testo(prefill.denominazione) ?? testo(prefill.scuola.ragioneSociale) ?? 'La Segreteria',
  }
}

export const modelloSollecito: ModelloPrestampato<PrefillSollecito, RisposteSollecito> = {
  slug: 'sollecito_pagamento',
  etichetta: 'Sollecito di pagamento',
  soggetto: 'alunno',
  disponibilePer: ['admin', 'segreteria'],
  // NESSUNA firma, come dice la tabella del README (colonna «Firma»: «—») e come conferma
  // §3.b di `00-impaginazione.md`, che elenca i documenti col blocco del legale
  // rappresentante — 26·27, 28, 30, 31, 47 — dove il 39 non c'è. Non è una svista della
  // specifica: il corpo del sollecito si chiude GIÀ da sé con `{scuola}`, e il blocco del
  // motore stamperebbe sotto una seconda chiusura, per giunta con la dicitura del D.Lgs
  // 39/93 su una lettera che non esce verso un ente. Restano il luogo e la data, che
  // `disegnaFirma` scrive comunque.
  firma: 'nessuna',
  protocollo: 'nessuno',
  // Il registro di questo documento è la tabella `solleciti`, che conserva già oggetto
  // e corpo di ogni invio: una seconda copia nel fascicolo del bambino sarebbe un
  // doppione con due verità possibili.
  archiviazione: 'nessuna',
  campi: [
    {
      id: 'livello',
      etichetta: 'Livello del sollecito',
      tipo: 'scelta',
      obbligatorio: true,
      aiuto:
        'Le soglie sono quelle predefinite: una sede può averle cambiate dalla propria configurazione.',
      opzioni: DEFAULT_LIVELLI.map((livello, i) => ({
        valore: String(i + 1),
        etichetta: `${i + 1}° livello — dal ${livello.giorni_da_scadenza}° giorno di ritardo`,
      })),
    },
  ],
  schema: schemaSollecito,
  titolo(prefill, risposte) {
    const livello = livelliEffettivi(prefill.config)[risposte.livello - 1]
    // Il segnaposto della descrizione chiude l'oggetto in tutti e tre i livelli
    // predefiniti: senza descrizione resterebbe un trattino appeso — «PROMEMORIA
    // PAGAMENTO — —» — che in cima a un foglio si vede molto più che nell'oggetto di
    // un'email. Si tronca la CODA, non il testo: la lettera sotto resta parola per parola
    // quella che la famiglia legge nella mail.
    return renderTemplate(livello.oggetto, contestoSollecito(prefill))
      .toUpperCase()
      .replace(/[\s—–-]+$/u, '')
  },
  componi(prefill, risposte) {
    const livello = livelliEffettivi(prefill.config)[risposte.livello - 1]
    // Niente riquadro di dati in testa: alunno, voce, scadenza e importo residuo il testo
    // li dice già, in prosa e nell'ordine in cui li dice l'email. Ripeterli sopra
    // trasformerebbe in modulo una cosa che è una lettera — e obbligherebbe a scrivere
    // due volte la stessa data, con due formattatori che possono divergere.
    return [
      ...paragrafiDa(renderTemplate(livello.testo, contestoSollecito(prefill))),
      ...paragrafiDa(prefill.rigaCausale),
    ]
  },
}

// ════════════════════════════════════════════════════════════════════════════════
// 42 — VERBALE DI INFORTUNIO
// ════════════════════════════════════════════════════════════════════════════════

export const LUOGHI_INFORTUNIO = [
  { valore: 'aula', etichetta: 'Aula/sezione' },
  { valore: 'giardino', etichetta: 'Giardino' },
  { valore: 'palestra', etichetta: 'Palestra' },
  { valore: 'refettorio', etichetta: 'Refettorio' },
  { valore: 'bagno', etichetta: 'Bagno' },
  { valore: 'corridoio', etichetta: 'Corridoio/scale' },
  { valore: 'ingresso', etichetta: 'Ingresso/uscita' },
  { valore: 'fuori', etichetta: 'Fuori dalla struttura' },
] as const satisfies readonly OpzioneCampo[]

export const PARTI_CORPO = [
  { valore: 'testa', etichetta: 'Testa/viso' },
  { valore: 'bocca', etichetta: 'Bocca/denti' },
  { valore: 'occhi', etichetta: 'Occhi' },
  { valore: 'arti_superiori', etichetta: 'Arti superiori' },
  { valore: 'arti_inferiori', etichetta: 'Arti inferiori' },
  { valore: 'tronco', etichetta: 'Tronco' },
  { valore: 'altro', etichetta: 'Altro' },
] as const satisfies readonly OpzioneCampo[]

export const TIPI_LESIONE = [
  { valore: 'contusione', etichetta: 'Contusione' },
  { valore: 'escoriazione', etichetta: 'Escoriazione' },
  { valore: 'ferita', etichetta: 'Ferita' },
  { valore: 'distorsione', etichetta: 'Distorsione' },
  { valore: 'sospetta_frattura', etichetta: 'Sospetta frattura' },
  { valore: 'trauma_cranico', etichetta: 'Trauma cranico' },
  { valore: 'reazione_allergica', etichetta: 'Reazione allergica' },
  { valore: 'altro', etichetta: 'Altro' },
] as const satisfies readonly OpzioneCampo[]

export const PRIMO_SOCCORSO = [
  { valore: 'disinfezione', etichetta: 'Disinfezione' },
  { valore: 'ghiaccio', etichetta: 'Ghiaccio' },
  { valore: 'medicazione', etichetta: 'Medicazione' },
  { valore: 'riposo', etichetta: 'Riposo e osservazione' },
  { valore: 'nessuno', etichetta: 'Nessuno necessario' },
  { valore: 'altro', etichetta: 'Altro' },
] as const satisfies readonly OpzioneCampo[]

export const PROVVEDIMENTI_INFORTUNIO = [
  { valore: 'rientro', etichetta: 'Rientro in sezione' },
  { valore: 'osservazione', etichetta: 'Osservazione prolungata' },
  { valore: 'ritiro', etichetta: 'Ritiro anticipato da parte della famiglia' },
  { valore: 'pronto_soccorso', etichetta: 'Accompagnamento al pronto soccorso' },
  { valore: 'centodiciotto', etichetta: 'Chiamata al 118' },
] as const satisfies readonly OpzioneCampo[]

/** I due provvedimenti che rendono obbligatoria l'ora della chiamata. */
const PROVVEDIMENTI_URGENTI: readonly string[] = ['pronto_soccorso', 'centodiciotto']

export const MODALITA_AVVISO = [
  { valore: 'telefono', etichetta: 'Telefono' },
  { valore: 'app', etichetta: 'App' },
  { valore: 'uscita', etichetta: "Di persona all'uscita" },
] as const satisfies readonly OpzioneCampo[]

/** Una persona in servizio, per le scelte «chi era presente» e «chi ha soccorso». */
export interface PersonaleInServizio {
  id: string
  nomeCompleto?: string | null
  /**
   * Addetto al primo soccorso. Sta QUI, sulla persona, e non sull'operatore che redige
   * il verbale — che è dove il modello della specifica lo colloca
   * (`addetto al primo soccorso: {{operatore.abilitato}}`, scritto sotto il campo
   * SOCCORRITORE). I due non sono la stessa persona: l'educatrice che scrive il verbale
   * può non essere quella che ha medicato, e attribuire a chi ha soccorso un'abilitazione
   * che risulta a un'altra è una dichiarazione falsa, per giunta su un foglio che una
   * famiglia può portare al pronto soccorso.
   *
   * `null`/assente = l'archivio non lo sa, e allora la riga non si stampa: «non risulta»
   * e «risulta di no» non si dicono con la stessa frase.
   */
  abilitatoPrimoSoccorso?: boolean | null
}

export interface PrefillVerbaleInfortunio {
  alunno: NucleoAlunno
  sede: NucleoSede
  annoScolastico: string
  numeroVerbale?: string | null
  /**
   * Quando il verbale è stato REDATTO, distinta dalla data dell'evento. Data secca o
   * istante: se la route la prende dalla riga di archivio arriva come `timestamptz`.
   */
  dataVerbale?: string | null
  operatore: {
    nomeCompleto?: string | null
    /** Istante della firma dell'operatore (`firmato_il` è `timestamptz`), quando c'è. */
    firmatoIl?: string | null
  }
  direzione?: {
    nome?: string | null
    /** Istante della controfirma. Assente = non ancora controfirmato, ed è ciò che il foglio dice. */
    controfirmatoIl?: string | null
  }
  genitore?: {
    nomeCompleto?: string | null
    telefono?: string | null
  }
  /**
   * Ciò che chi soccorre deve sapere PRIMA, non dopo (specifica, «Dopo la firma» 4):
   * allergie e patologie note della scheda sanitaria, già ridotte a una riga dal
   * chiamante. Assente = niente riquadro, mai un «nessuna allergia» dedotto dal vuoto.
   */
  noteSanitarie?: string | null
  /** L'organico della sede, per risolvere gli id scelti nel form. */
  personale?: readonly PersonaleInServizio[]
}

const schemaVerbaleInfortunio = z
  .object({
    data: zDataYMD,
    ora: zOra,
    luogo: zOpzioni(LUOGHI_INFORTUNIO),
    luogo_altro: zTestoFacoltativo(200),
    attivita: zTesto(300),
    dinamica: zTesto(4000),
    altro_personale: z.array(z.string().trim().min(1)).max(20).optional(),
    /**
     * Il FATTO si registra, i NOMI no: consegnare a una famiglia un documento con il
     * nome del figlio di un'altra, insieme alla dinamica di un incidente, è una
     * comunicazione di dati personali di un minore a un terzo non autorizzato. Non
     * esiste un campo per quei nomi, ed è il modo più solido di non stamparli mai.
     */
    altri_bambini_coinvolti: z.boolean().default(false),
    parte_corpo: zOpzioni(PARTI_CORPO),
    parte_corpo_altro: zTestoFacoltativo(200),
    tipo_lesione: zOpzioni(TIPI_LESIONE),
    tipo_lesione_altro: zTestoFacoltativo(200),
    descrizione_lesione: zTesto(2000),
    primo_soccorso: z.array(zOpzioni(PRIMO_SOCCORSO)).min(1, 'Indicare almeno una voce'),
    primo_soccorso_altro: zTestoFacoltativo(200),
    soccorritore: z.string().trim().min(1).optional(),
    ora_soccorso: zOra.optional(),
    provvedimenti: z.array(zOpzioni(PROVVEDIMENTI_INFORTUNIO)).min(1, 'Indicare almeno un provvedimento'),
    ora_118: zOra.optional(),
    ora_avviso: zOra,
    modalita_avviso: zOpzioni(MODALITA_AVVISO),
    note_famiglia: zTestoFacoltativo(4000),
  })
  .superRefine((valori, ctx) => {
    const pretendi = (quando: boolean, campo: string, messaggio: string) => {
      if (quando) ctx.addIssue({ code: 'custom', path: [campo], message: messaggio })
    }

    // «Se 118 o pronto soccorso — ora della chiamata». È il dato che l'assicurazione
    // chiede per primo, e l'unico che nessuno ricostruisce a memoria il giorno dopo.
    pretendi(
      valori.provvedimenti.some((p) => PROVVEDIMENTI_URGENTI.includes(p)) && !valori.ora_118,
      'ora_118',
      "Indicare l'ora della chiamata al 118 o dell'accompagnamento al pronto soccorso"
    )

    // LE QUATTRO CASELLE CON LA FRECCIA. Nel modello della specifica si leggono
    // «☐ Fuori dalla struttura → [LUOGO]», «☐ Altro → [PARTE_CORPO]», e la freccia non è
    // decorazione: senza il testo accanto, il verbale di un infortunio di un minore dice
    // «Fuori dalla struttura», «Altro», «Altro», «Altro» e non documenta niente — proprio
    // il foglio che serve alla famiglia e all'assicurazione. Il rifiuto sta qui e non nel
    // descrittore perché `obbligatorio` è una proprietà del campo, non della risposta:
    // «Quale, se altro» è obbligatorio soltanto quando la scelta è «altro».
    pretendi(
      valori.luogo === 'fuori' && !valori.luogo_altro,
      'luogo_altro',
      "Indicare dove: «Fuori dalla struttura» da sola non dice il luogo dell'infortunio"
    )
    pretendi(
      valori.parte_corpo === 'altro' && !valori.parte_corpo_altro,
      'parte_corpo_altro',
      'Indicare quale parte del corpo: «Altro» da solo non dice dove è la lesione'
    )
    pretendi(
      valori.tipo_lesione === 'altro' && !valori.tipo_lesione_altro,
      'tipo_lesione_altro',
      'Indicare il tipo di lesione: «Altro» da solo non descrive che cosa si è visto'
    )
    pretendi(
      valori.primo_soccorso.includes('altro') && !valori.primo_soccorso_altro,
      'primo_soccorso_altro',
      'Indicare quale soccorso è stato prestato: «Altro» da solo non dice che cosa si è fatto'
    )

    // «Nessuno necessario» insieme a una medicazione è una contraddizione, e su un
    // verbale la contraddizione la eredita chi lo legge un anno dopo.
    pretendi(
      valori.primo_soccorso.includes('nessuno') && valori.primo_soccorso.length > 1,
      'primo_soccorso',
      '«Nessuno necessario» non sta insieme a un soccorso prestato'
    )
  })

export type RisposteVerbaleInfortunio = z.infer<typeof schemaVerbaleInfortunio>

/** Nome di chi è in servizio, dall'id. Id sconosciuto → niente: mai un nome dedotto. */
function nomiPersonale(
  organico: readonly PersonaleInServizio[] | undefined,
  ids: readonly string[] | undefined
): string | null {
  if (!ids?.length) return null
  const nomi = ids
    .map((id) => testo(organico?.find((p) => p.id === id)?.nomeCompleto))
    .filter((n): n is string => n !== null)
  return nomi.length > 0 ? nomi.join(', ') : null
}

export const modelloVerbaleInfortunio: ModelloPrestampato<
  PrefillVerbaleInfortunio,
  RisposteVerbaleInfortunio
> = {
  slug: 'verbale_infortunio',
  etichetta: 'Verbale di infortunio',
  soggetto: 'alunno',
  // Lo compila chi ha assistito, dal telefono, mentre succede: l'educatrice è la prima
  // della lista, non un ripiego.
  disponibilePer: ['educator', 'coordinator', 'admin', 'segreteria'],
  // La colonna «Firma» del README dice «direzione», che fra i tre tipi del motore non
  // esiste — e non è quella che chiude il foglio: la specifica del 42 finisce con «PRESA
  // VISIONE DELLA FAMIGLIA — firmato con OTP», ed è ciò che il blocco attesta. La
  // controfirma della Direzione è una RIGA del corpo, come nel n. 50, perché un verbale
  // controfirmato e uno ancora in attesa devono distinguersi guardandoli.
  firma: 'genitore',
  // ⚠️ Le due fonti si contraddicono, e la scelta va dichiarata invece che lasciata
  // scoprire: il testo del modello (`42-verbale-infortunio.md`, riga 19) porta in testata
  // «· Prot. n. {{protocollo.numero}}», ma la regola 4 del README elenca ciò che si
  // protocolla — certificati, nulla osta, richiesta di disponibilità, certificato di
  // servizio — e il 42 non c'è. Si è seguita la REGOLA: il protocollo in uscita numera la
  // corrispondenza verso enti terzi, e un verbale interno consegnato alla famiglia non
  // esce verso nessuno; consumarne uno per ogni caduta in giardino riempirebbe il
  // registro di sede di righe che nessuno cercherà mai. Ciò che serve all'assicurazione è
  // il progressivo del verbale, che la testata porta comunque («Verbale n.» / «del»).
  protocollo: 'nessuno',
  archiviazione: 'student_documents',
  campi: [
    { id: 'data', etichetta: "Data dell'infortunio", tipo: 'data', obbligatorio: true },
    { id: 'ora', etichetta: 'Ora', tipo: 'ora', obbligatorio: true },
    { id: 'luogo', etichetta: 'Luogo', tipo: 'scelta', obbligatorio: true, opzioni: LUOGHI_INFORTUNIO },
    {
      id: 'luogo_altro',
      etichetta: 'Dove, se fuori dalla struttura',
      tipo: 'testo',
      obbligatorio: false,
      aiuto: 'Obbligatorio quando il luogo è «Fuori dalla struttura».',
    },
    { id: 'attivita', etichetta: 'Attività in corso', tipo: 'testo', obbligatorio: true },
    {
      id: 'dinamica',
      etichetta: 'Dinamica',
      tipo: 'testoLungo',
      obbligatorio: true,
      aiuto: 'Che cosa è successo, come e in che ordine. È la parte che nessuno ricorda fra un mese.',
    },
    {
      id: 'altro_personale',
      etichetta: 'Altro personale presente',
      tipo: 'sceltaMultipla',
      obbligatorio: false,
      aiuto: 'Si sceglie fra chi è in servizio nella sede: nel verbale finiscono i nomi, non gli identificativi.',
    },
    {
      id: 'altri_bambini_coinvolti',
      etichetta: 'Altri bambini coinvolti',
      tipo: 'conferma',
      obbligatorio: false,
      aiuto:
        'Il fatto si registra, i nomi no: non compaiono nel verbale che va alla famiglia.',
    },
    { id: 'parte_corpo', etichetta: 'Parte del corpo', tipo: 'scelta', obbligatorio: true, opzioni: PARTI_CORPO },
    {
      id: 'parte_corpo_altro',
      etichetta: 'Quale, se altro',
      tipo: 'testo',
      obbligatorio: false,
      aiuto: 'Obbligatorio quando la parte del corpo è «Altro».',
    },
    { id: 'tipo_lesione', etichetta: 'Tipo di lesione', tipo: 'scelta', obbligatorio: true, opzioni: TIPI_LESIONE },
    {
      id: 'tipo_lesione_altro',
      etichetta: 'Quale, se altro',
      tipo: 'testo',
      obbligatorio: false,
      aiuto: 'Obbligatorio quando il tipo di lesione è «Altro».',
    },
    { id: 'descrizione_lesione', etichetta: 'Descrizione della lesione', tipo: 'testoLungo', obbligatorio: true },
    {
      id: 'primo_soccorso',
      etichetta: 'Primo soccorso prestato',
      tipo: 'sceltaMultipla',
      obbligatorio: true,
      opzioni: PRIMO_SOCCORSO,
    },
    {
      id: 'primo_soccorso_altro',
      etichetta: 'Quale, se altro',
      tipo: 'testo',
      obbligatorio: false,
      aiuto: 'Obbligatorio quando fra le voci di primo soccorso c\'è «Altro».',
    },
    {
      id: 'soccorritore',
      etichetta: 'Prestato da',
      tipo: 'scelta',
      obbligatorio: false,
      aiuto: "Anche qui l'elenco è il personale in servizio, non un campo libero.",
    },
    { id: 'ora_soccorso', etichetta: 'Ora del soccorso', tipo: 'ora', obbligatorio: false },
    {
      id: 'provvedimenti',
      etichetta: 'Provvedimenti',
      tipo: 'sceltaMultipla',
      obbligatorio: true,
      opzioni: PROVVEDIMENTI_INFORTUNIO,
    },
    {
      id: 'ora_118',
      etichetta: 'Ora della chiamata al 118 o al pronto soccorso',
      tipo: 'ora',
      obbligatorio: false,
      aiuto: 'Obbligatoria quando il provvedimento è il 118 o il pronto soccorso.',
    },
    { id: 'ora_avviso', etichetta: 'Famiglia avvisata alle ore', tipo: 'ora', obbligatorio: true },
    {
      id: 'modalita_avviso',
      etichetta: 'Modalità di avviso',
      tipo: 'scelta',
      obbligatorio: true,
      opzioni: MODALITA_AVVISO,
    },
    { id: 'note_famiglia', etichetta: 'Note per la famiglia', tipo: 'testoLungo', obbligatorio: false },
  ],
  schema: schemaVerbaleInfortunio,
  titolo: () => 'VERBALE DI INFORTUNIO',
  componi(prefill, risposte) {
    const { alunno, sede, operatore, direzione, genitore } = prefill
    const chiHaSoccorso = prefill.personale?.find((p) => p.id === risposte.soccorritore)
    const soccorritore = testo(chiHaSoccorso?.nomeCompleto)
    const abilitatoPrimoSoccorso = soccorritore ? chiHaSoccorso?.abilitatoPrimoSoccorso : null
    const urgente = risposte.provvedimenti.some((p) => PROVVEDIMENTI_URGENTI.includes(p))
    return [
      ...campiSeValorizzati(
        [
          { etichetta: 'Verbale n.', valore: prefill.numeroVerbale },
          { etichetta: 'del', valore: dataIt(prefill.dataVerbale) },
        ],
        2
      ),
      sezione("Dati dell'alunno/a"),
      ...campiSeValorizzati(
        [
          { etichetta: 'Sede', valore: sede.nome },
          { etichetta: 'Cognome e nome', valore: nomeCompleto(alunno) },
          { etichetta: 'Data di nascita', valore: dataIt(alunno.dataNascita) },
          { etichetta: 'Luogo di nascita', valore: alunno.luogoNascita },
          { etichetta: 'Sezione/Classe', valore: alunno.sezione },
          { etichetta: 'Anno scolastico', valore: prefill.annoScolastico },
        ],
        2
      ),
      // In TESTA, non in coda: chi legge il verbale per soccorrere deve saperlo prima.
      ...(testo(prefill.noteSanitarie)
        ? [
            {
              tipo: 'riquadro' as const,
              titolo: 'Da sapere prima di intervenire',
              campi: [{ etichetta: 'Dalla scheda sanitaria', valore: testo(prefill.noteSanitarie) }],
            },
          ]
        : []),

      sezione('Quando e dove'),
      ...campiSeValorizzati(
        [
          // Nessun ripiego: `data` passa da `zDataYMD` (vedi il n. 30).
          { etichetta: 'Data', valore: dataIt(risposte.data) },
          { etichetta: 'Ora', valore: risposte.ora },
        ],
        2
      ),
      // L'attività sale PRIMA del gruppo di caselle, invertendo di due righe l'ordine della
      // specifica, per una ragione di impaginazione: `sezione('Luogo')` è il titoletto del
      // gruppo qui sotto, e un campo che gli restasse appeso in coda («Attività in corso:
      // Gioco libero» stampato dentro il riquadro LUOGO) attribuirebbe il dato al titolo
      // sbagliato. Sopra, sotto «QUANDO E DOVE», sta con la data e l'ora, che è dove
      // appartiene.
      ...campiSeValorizzati([{ etichetta: 'Attività in corso', valore: risposte.attivita }]),
      // OGNI GRUPPO DI CASELLE PORTA IL PROPRIO TITOLETTO, e non è ornamento: la specifica
      // le etichetta una per una («Luogo: ☐ Aula/sezione …», «Parte del corpo: ☐ Testa/viso
      // …», «Tipo: ☐ Contusione …»), e `disegnaCaselle` fra un blocco e il successivo non
      // lascia né spazio né titolo — due `caselleDa` di fila escono come quattro righe di
      // quadratini indistinguibili, e chi legge il verbale non sa dove finisce la parte del
      // corpo e dove comincia il tipo di lesione. Su un foglio che va alla famiglia e
      // all'assicurazione.
      sezione('Luogo'),
      caselleDa(LUOGHI_INFORTUNIO, [risposte.luogo]),
      // «Dove» e non «Luogo»: il titoletto sopra lo dice già, e la riga risponde alla freccia
      // della specifica («☐ Fuori dalla struttura → [LUOGO]»). Stessa regola per i due
      // «Quale» più sotto — sul foglio l'etichetta è quella del descrittore del form senza la
      // sua condizione («Dove, se fuori dalla struttura» → «Dove»).
      ...campiSeValorizzati([
        { etichetta: 'Dove', valore: risposte.luogo === 'fuori' ? risposte.luogo_altro : null },
      ]),

      sezione('Dinamica'),
      ...paragrafiDa(risposte.dinamica),

      sezione('Personale presente'),
      ...campiSeValorizzati([
        { etichetta: 'Chi ha assistito', valore: operatore.nomeCompleto },
        {
          etichetta: 'Altro personale presente',
          valore: nomiPersonale(prefill.personale, risposte.altro_personale),
        },
      ]),
      {
        tipo: 'caselle',
        caselle: [
          { testo: 'Nessun altro bambino coinvolto', spuntata: !risposte.altri_bambini_coinvolti },
          { testo: 'Altri bambini coinvolti', spuntata: risposte.altri_bambini_coinvolti },
        ],
      },
      ...(risposte.altri_bambini_coinvolti
        ? paragrafoSePresente(
            'I nomi degli altri bambini coinvolti non compaiono in questo verbale: restano agli atti interni, ' +
              'accessibili alla sola Direzione.',
            'corsivo'
          )
        : []),

      // «LESIONE RILEVATA» è sparito e al suo posto ci sono i tre titoletti che la specifica
      // scrive dentro quel gruppo. Il motore ha un solo livello di titolo: tenere anche
      // l'ombrello avrebbe stampato «LESIONE RILEVATA» con il suo filetto e, dieci millimetri
      // sotto e senza una riga in mezzo, «PARTE DEL CORPO» — cioè una sezione vuota. I tre
      // nomi veri dicono da soli ciò che l'ombrello diceva.
      sezione('Parte del corpo'),
      caselleDa(PARTI_CORPO, [risposte.parte_corpo]),
      ...campiSeValorizzati([
        {
          etichetta: 'Quale',
          valore: risposte.parte_corpo === 'altro' ? risposte.parte_corpo_altro : null,
        },
      ]),
      sezione('Tipo di lesione'),
      caselleDa(TIPI_LESIONE, [risposte.tipo_lesione]),
      ...campiSeValorizzati([
        {
          etichetta: 'Quale',
          valore: risposte.tipo_lesione === 'altro' ? risposte.tipo_lesione_altro : null,
        },
      ]),
      // Il titoletto ci vuole: la specifica etichetta la riga («Descrizione: …») e senza,
      // subito sotto le caselle del tipo di lesione, il capoverso si legge come il seguito
      // delle caselle invece che come il campo che è. La dinamica ha già il suo.
      sezione('Descrizione della lesione'),
      ...paragrafiDa(risposte.descrizione_lesione),

      sezione('Primo soccorso prestato'),
      caselleDa(PRIMO_SOCCORSO, risposte.primo_soccorso),
      ...campiSeValorizzati([
        {
          etichetta: 'Quale',
          valore: risposte.primo_soccorso.includes('altro') ? risposte.primo_soccorso_altro : null,
        },
      ]),
      ...campiSeValorizzati(
        [
          { etichetta: 'Prestato da', valore: soccorritore },
          { etichetta: 'Ora del soccorso', valore: risposte.ora_soccorso },
        ],
        2
      ),
      // L'abilitazione è quella di CHI HA SOCCORSO, non di chi scrive (vedi il commento
      // su `PersonaleInServizio.abilitatoPrimoSoccorso`), e si stampa solo quando risulta.
      ...(abilitatoPrimoSoccorso === true
        ? paragrafoSePresente(
            'Chi ha prestato il soccorso risulta addetto al primo soccorso.',
            'corsivo'
          )
        : []),

      sezione('Provvedimenti'),
      caselleDa(PROVVEDIMENTI_INFORTUNIO, risposte.provvedimenti),
      ...campiSeValorizzati([
        { etichetta: 'Ora della chiamata', valore: urgente ? risposte.ora_118 : null },
      ]),

      sezione('Comunicazione alla famiglia'),
      ...campiSeValorizzati(
        [
          { etichetta: 'Avvisata alle ore', valore: risposte.ora_avviso },
          { etichetta: 'Modalità', valore: etichettaDi(MODALITA_AVVISO, risposte.modalita_avviso) },
          { etichetta: 'Genitore contattato', valore: genitore?.nomeCompleto },
          { etichetta: 'Telefono', valore: genitore?.telefono },
        ],
        2
      ),
      ...(testo(risposte.note_famiglia)
        ? [sezione('Note per la famiglia'), ...paragrafiDa(risposte.note_famiglia)]
        : []),

      {
        tipo: 'paragrafo',
        stile: 'corsivo',
        testo:
          "Il presente verbale è redatto dal personale presente al momento dell'evento e non costituisce " +
          'diagnosi medica. In caso di persistenza o peggioramento dei sintomi si invita a rivolgersi al pediatra ' +
          'o alla struttura sanitaria competente.',
      },
      // NIENTE FILETTO SU QUESTE DUE RIGHE, ed è la scelta opposta a quella del n. 50 —
      // stessa situazione, disciplina diversa, quindi va detto perché e non lasciato scoprire.
      //
      // Nel registro presenze il filetto ci sta: quel foglio resta in sede e si stampa
      // APPOSTA per essere firmato a penna e messo nel raccoglitore. Qui no, per due ragioni.
      // La controfirma della Direzione è un atto DIGITALE: il flusso della specifica (punto 3)
      // dice «la Direzione controfirma entro la giornata» e «un verbale non controfirmato
      // resta in evidenza» — ciò che la garantisce è il cruscotto della Direzione, non una
      // riga bianca su una copia stampata. E questo foglio ESCE: va alla famiglia (app +
      // email), e la regola 2 in testa a questo file vale qui come sui certificati — un
      // filetto vuoto accanto a «La Direzione», su un verbale di infortunio di un minore già
      // uscito dalla scuola, è lo spazio in cui chiunque può scrivere a penna.
      //
      // Perciò: nome assente = riga assente. Il verbale non ancora controfirmato lo dice
      // tacendo — la stessa regola con cui `rigaFirmata` omette la data finché la firma non
      // c'è — invece di offrire il posto dove aggiungerla dopo.
      ...campiSeValorizzati([
        {
          etichetta: "L'operatore che ha redatto",
          valore: rigaFirmata(operatore.nomeCompleto, operatore.firmatoIl, 'firmato'),
        },
        {
          etichetta: 'La Direzione',
          valore: rigaFirmata(direzione?.nome, direzione?.controfirmatoIl, 'controfirmato'),
        },
      ]),
    ]
  },
}

/**
 * «Nome — firmato il gg/mm/aaaa», e senza data il solo nome.
 *
 * Un verbale non ancora controfirmato deve dirlo tacendo — cioè stampando il nome senza
 * la data — invece di dichiarare una firma che non c'è. Nome assente = riga omessa a
 * monte, da `campiSeValorizzati`.
 *
 * ⚠️ È il punto in cui la data NON è un ornamento: qui il silenzio ha un significato
 * dichiarato, e una data persa in formattazione afferma il contrario di ciò che è vero.
 * L'istante arriva da colonne `timestamptz` e lo scioglie `dataIt`, che le legge tutte e due
 * le forme — prima che lo facesse, un verbale firmato e controfirmato si stampava identico a
 * uno che nessuno aveva mai firmato.
 */
function rigaFirmata(
  nome: string | null | undefined,
  istante: string | null | undefined,
  verbo: 'firmato' | 'controfirmato'
): string | null {
  const chi = testo(nome)
  if (!chi) return null
  const quando = dataIt(istante)
  return quando ? `${chi} — ${verbo} il ${quando}` : chi
}

// ════════════════════════════════════════════════════════════════════════════════
// 45 — DOCUMENTO DI OSSERVAZIONE E VALUTAZIONE (infanzia)
// ════════════════════════════════════════════════════════════════════════════════

/** I cinque campi di esperienza delle Indicazioni Nazionali (impianto del PTOF). */
export const CAMPI_ESPERIENZA = [
  { valore: 'se_e_altro', etichetta: "Il sé e l'altro" },
  { valore: 'corpo_movimento', etichetta: 'Il corpo e il movimento' },
  { valore: 'immagini_suoni_colori', etichetta: 'Immagini, suoni, colori' },
  { valore: 'discorsi_parole', etichetta: 'I discorsi e le parole' },
  { valore: 'conoscenza_mondo', etichetta: 'La conoscenza del mondo' },
] as const satisfies readonly OpzioneCampo[]

/**
 * Tre livelli, non quattro. La primaria ne usa quattro perché deve mappare i voti
 * ministeriali (`LIVELLI` in `@/lib/competenze/modello`); qui a quattro anni la
 * differenza fra «base» e «in via di prima acquisizione» descrive il giorno in cui si è
 * osservato il bambino, non il bambino.
 */
export const LIVELLI_INFANZIA = [
  { valore: 'in_acquisizione', etichetta: 'In fase di acquisizione' },
  { valore: 'in_consolidamento', etichetta: 'In via di consolidamento' },
  { valore: 'consolidato', etichetta: 'Consolidato' },
] as const satisfies readonly OpzioneCampo[]

export const VOCI_AUTONOMIA = [
  { valore: 'autonomia_personale', etichetta: 'Autonomia personale' },
  { valore: 'relazione_pari', etichetta: 'Relazione con i pari' },
  { valore: 'relazione_adulto', etichetta: "Relazione con l'adulto" },
  { valore: 'partecipazione', etichetta: 'Partecipazione alle attività' },
  { valore: 'rispetto_regole', etichetta: 'Rispetto delle regole' },
] as const satisfies readonly OpzioneCampo[]

export const PERIODI_VALUTAZIONE = [
  { valore: 'primo', etichetta: 'Primo periodo' },
  { valore: 'fine_anno', etichetta: 'Fine anno scolastico' },
] as const satisfies readonly OpzioneCampo[]

export const ANNI_FREQUENZA = [
  { valore: '1', etichetta: '1° anno (3 anni)' },
  { valore: '2', etichetta: '2° anno (4 anni)' },
  { valore: '3', etichetta: '3° anno (5 anni)' },
] as const satisfies readonly OpzioneCampo[]

export interface PrefillValutazioneInfanzia {
  alunno: NucleoAlunno
  annoScolastico: string
  /** 1, 2 o 3. Dall'anagrafica: non lo si chiede all'insegnante che lo ha in sezione. */
  annoFrequenza?: 1 | 2 | 3 | null
  insegnanti?: readonly string[]
  coordinatrice?: string | null
}

const zLivelloInfanzia = zOpzioni(LIVELLI_INFANZIA)
const zVoceOsservata = z.object({
  livello: zLivelloInfanzia,
  osservazioni: zTestoFacoltativo(4000),
})

/**
 * La forma dello schema si costruisce DALLE costanti: un sesto campo di esperienza
 * aggiunto sopra entra da solo nella validazione, e non c'è modo di dimenticarsene.
 */
function formaDa<T extends readonly OpzioneCampo[], S extends z.ZodTypeAny>(opzioni: T, schema: S) {
  return Object.fromEntries(opzioni.map((o) => [o.valore, schema])) as Record<T[number]['valore'], S>
}

const schemaValutazioneInfanzia = z.object({
  periodo: zOpzioni(PERIODI_VALUTAZIONE),
  esperienze: z.object(formaDa(CAMPI_ESPERIENZA, zVoceOsservata)),
  autonomia: z.object(formaDa(VOCI_AUTONOMIA, zLivelloInfanzia)),
  /**
   * Qui il testo libero È il documento: i livelli servono all'insegnante per orientarsi,
   * ma ciò che la famiglia legge — e che vale — sono le osservazioni.
   */
  osservazione_globale: zTesto(8000),
  proposte: zTestoFacoltativo(8000),
})

export type RisposteValutazioneInfanzia = z.infer<typeof schemaValutazioneInfanzia>

export const modelloValutazioneInfanzia: ModelloPrestampato<
  PrefillValutazioneInfanzia,
  RisposteValutazioneInfanzia
> = {
  slug: 'valutazione_infanzia',
  etichetta: 'Documento di valutazione — infanzia',
  soggetto: 'alunno',
  disponibilePer: ['educator', 'coordinator', 'admin'],
  // Presa visione della famiglia con OTP, sullo stesso flusso della pagella della
  // primaria: non è un'approvazione del giudizio, è la prova che è arrivato.
  firma: 'genitore',
  protocollo: 'nessuno',
  archiviazione: 'student_documents',
  campi: [
    { id: 'periodo', etichetta: 'Periodo', tipo: 'scelta', obbligatorio: true, opzioni: PERIODI_VALUTAZIONE },
    {
      id: 'esperienze',
      etichetta: 'Campi di esperienza',
      tipo: 'griglia',
      obbligatorio: true,
      aiuto: 'Per ciascuno dei cinque campi: il livello e le osservazioni. Il campo delle osservazioni non ha limiti stretti.',
      opzioni: CAMPI_ESPERIENZA,
      valoriAmmessi: LIVELLI_INFANZIA,
    },
    {
      id: 'autonomia',
      etichetta: 'Autonomia e relazione',
      tipo: 'griglia',
      obbligatorio: true,
      opzioni: VOCI_AUTONOMIA,
      valoriAmmessi: LIVELLI_INFANZIA,
    },
    {
      id: 'osservazione_globale',
      etichetta: 'Osservazione complessiva',
      tipo: 'testoLungo',
      obbligatorio: true,
    },
    {
      id: 'proposte',
      etichetta: 'Proposte per il periodo successivo',
      tipo: 'testoLungo',
      obbligatorio: false,
    },
  ],
  schema: schemaValutazioneInfanzia,
  titolo: () => "DOCUMENTO DI OSSERVAZIONE E VALUTAZIONE — SCUOLA DELL'INFANZIA",
  componi(prefill, risposte) {
    const { alunno } = prefill
    const insegnanti = testo(prefill.insegnanti?.map((i) => testo(i)).filter(Boolean).join(', '))
    return [
      sezione("Dati dell'alunno/a"),
      ...campiSeValorizzati(
        [
          { etichetta: 'Cognome e nome', valore: nomeCompleto(alunno) },
          { etichetta: 'Data di nascita', valore: dataIt(alunno.dataNascita) },
          { etichetta: 'Sezione', valore: alunno.sezione },
          { etichetta: 'Anno scolastico', valore: prefill.annoScolastico },
        ],
        2
      ),
      // Le insegnanti salgono qui, sopra i due gruppi di caselle, per la stessa ragione per
      // cui nel n. 42 sale l'attività in corso: sotto, sarebbero finite dentro il titoletto
      // «PERIODO» pur non avendoci nulla a che fare. Restano fra i dati della sezione, che è
      // dove la specifica le mette.
      ...campiSeValorizzati([{ etichetta: 'Insegnanti di sezione', valore: insegnanti }]),
      // Un titoletto per gruppo, come nel n. 42 e per la stessa misura: `disegnaCaselle` non
      // separa un blocco dal successivo, e la specifica etichetta tutti e due («Anno di
      // frequenza: ☐ 1° …», «Periodo: ☐ Primo periodo …»). Senza, sotto i dati anagrafici
      // uscivano due righe di quadratini di fila e «1° anno (3 anni)» e «Primo periodo»
      // sembravano lo stesso elenco.
      sezione('Anno di frequenza'),
      caselleDa(ANNI_FREQUENZA, prefill.annoFrequenza ? [String(prefill.annoFrequenza)] : []),
      sezione('Periodo'),
      caselleDa(PERIODI_VALUTAZIONE, [risposte.periodo]),

      sezione('Campi di esperienza'),
      {
        tipo: 'tabella',
        intestazioni: ['Campo di esperienza', 'Livello', 'Osservazioni'],
        larghezze: [3, 2, 6],
        righe: CAMPI_ESPERIENZA.map((campo) => {
          const voce = risposte.esperienze[campo.valore]
          return [
            campo.etichetta,
            etichettaDi(LIVELLI_INFANZIA, voce.livello) ?? '',
            testo(voce.osservazioni) ?? '',
          ]
        }),
      },

      sezione('Autonomia e relazione'),
      ...campiSeValorizzati(
        VOCI_AUTONOMIA.map((voce) => ({
          etichetta: voce.etichetta,
          valore: etichettaDi(LIVELLI_INFANZIA, risposte.autonomia[voce.valore]),
        })),
        2
      ),

      sezione('Osservazione complessiva'),
      ...paragrafiDa(risposte.osservazione_globale),
      ...(testo(risposte.proposte)
        ? [sezione('Proposte per il periodo successivo'), ...paragrafiDa(risposte.proposte)]
        : []),

      ...campiSeValorizzati([
        { etichetta: 'Le insegnanti di sezione', valore: insegnanti },
        { etichetta: 'La Coordinatrice Didattica', valore: prefill.coordinatrice },
      ]),
    ]
  },
}

// ════════════════════════════════════════════════════════════════════════════════
// 46 — CERTIFICATO DELLE COMPETENZE
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Il modello è quello del **D.M. 14/2024** e in questo repo esiste già:
 * `COMPETENZE_CHIAVE`, `LIVELLI` e `livelloEtichetta` di `@/lib/competenze/modello`
 * sono la fonte, qui non se ne ribatte nemmeno una riga. Ciò che il prestampato
 * aggiunge è quanto la specifica n. 46 elenca come mancante: il protocollo in uscita e
 * la firma del legale rappresentante, che arrivano dal motore comune.
 *
 * E ciò che il prestampato NON deve togliere è quanto il generatore in produzione ha già:
 * il capoverso che certifica (`PREMESSA_COMPETENZE`) e le note per singola competenza
 * (`noteCompetenze`). Un certificato rigenerato di qui deve valere almeno quanto quello di
 * prima — un documento «rifatto meglio» che perde per strada il commento dell'insegnante e
 * la frase che attesta esce completo, e più povero, senza che nessuno se ne accorga.
 *
 * ⚠️ Un punto che questo file NON decide, e che va deciso da una persona: la specifica
 * n. 45 dice che il bambino esce dall'infanzia con questo certificato, mentre in app
 * `validaScrutinioFinaleClasseQuinta` lo consente solo alla quinta primaria. Qui il
 * titolo non nomina nessun ordine di scuola — la classe la porta il prefill — proprio
 * per non fissare in un `.ts` una scelta che le due fonti fanno in modo opposto.
 */
export interface PrefillCertificatoCompetenze {
  alunno: NucleoAlunno
  sede: NucleoSede
  annoScolastico: string
  classe?: string | null
  /**
   * Le note per singola competenza che l'insegnante ha GIÀ scritto in archivio
   * (`certificato_competenza_livelli.note`, per codice di competenza): le legge
   * `certificato-store.ts` e le stampa `certificato-pdf.ts` sotto ogni riga.
   *
   * Stanno nel prefill e non fra i campi del form perché sono un dato in banca dati, non
   * una domanda in più: senza, un certificato rigenerato con questo motore butterebbe via
   * il commento dell'insegnante e nessuno se ne accorgerebbe — il foglio uscirebbe
   * completo, solo più povero di prima.
   */
  noteCompetenze?: Readonly<Record<string, string | null | undefined>> | null
}

/**
 * IL CAPOVERSO CHE CERTIFICA. Senza, la tabella dei livelli è un prospetto e il certificato
 * non contiene nessuna proposizione certificante — cioè non certifica niente.
 *
 * È quello del generatore in produzione (`certificato-pdf.ts`), ricopiato e non importato:
 * quel file tira dentro jsPDF, e importarlo da un modulo puro è il modo in cui in questo repo
 * `vitest` resta verde e `npm run build` cade. Cambia il solo soggetto — là «Il Dirigente
 * Scolastico», che in una cooperativa non esiste e soprattutto non è chi firma: in calce a
 * questo foglio c'è il legale rappresentante (§3.b), e un atto non può essere attestato da
 * qualcuno diverso da chi lo firma.
 */
const PREMESSA_COMPETENZE =
  "Visti gli atti d'ufficio relativi alle valutazioni espresse in sede di scrutinio finale, si " +
  "certifica che l'alunno/a ha raggiunto i livelli di competenza di seguito riportati."

/**
 * Le righe e i valori della griglia, ricavati una volta sola dal modello nazionale: lo
 * schema `zod`, l'elenco che il pannello disegna e la tabella che si stampa leggono tutti
 * di qui. Erano tre `map` identiche in tre punti, cioè tre occasioni di divergere dal
 * D.M. una alla volta.
 */
const RIGHE_COMPETENZE = COMPETENZE_CHIAVE.map((c) => ({
  valore: c.codice,
  etichetta: c.etichetta,
})) satisfies readonly OpzioneCampo[]
// Niente annotazione `readonly OpzioneCampo[]`: allargherebbe `valore` a `string` e
// `zOpzioni` perderebbe l'unione A|B|C|D che rende la risposta un livello e non un testo.
const LIVELLI_COMPETENZE = LIVELLI.map((l) => ({
  valore: l.codice,
  etichetta: l.etichetta,
})) satisfies readonly OpzioneCampo[]

const zLivelloCompetenza = zOpzioni(LIVELLI_COMPETENZE)

const schemaCertificatoCompetenze = z.object({
  /**
   * Tutte e otto obbligatorie. La scala del D.M. non prevede la riga vuota, e la
   * disciplina del degrado — «un dato che manca fa omettere la riga» — su un modello
   * nazionale non è applicabile: una competenza in meno non è un certificato con una
   * riga in meno, è un certificato non valido. Quindi si rifiuta a monte invece di
   * stampare il trattino che il generatore in app usa per il vuoto.
   */
  livelli: z.object(formaDa(RIGHE_COMPETENZE, zLivelloCompetenza)),
  competenze_significative: zTestoFacoltativo(4000),
})

export type RisposteCertificatoCompetenze = z.infer<typeof schemaCertificatoCompetenze>

export const modelloCertificatoCompetenze: ModelloPrestampato<
  PrefillCertificatoCompetenze,
  RisposteCertificatoCompetenze
> = {
  slug: 'certificato_competenze',
  etichetta: 'Certificato delle competenze',
  soggetto: 'alunno',
  disponibilePer: ['educator', 'coordinator', 'admin'],
  firma: 'legaleRappresentante',
  protocollo: 'uscita',
  archiviazione: 'student_documents',
  campi: [
    {
      id: 'livelli',
      etichetta: 'Livello raggiunto per ciascuna competenza chiave',
      tipo: 'griglia',
      obbligatorio: true,
      aiuto: "Le osservazioni dei tre anni sono un punto di partenza, non una compilazione automatica: il giudizio resta dell'insegnante.",
      opzioni: RIGHE_COMPETENZE,
      valoriAmmessi: LIVELLI_COMPETENZE,
    },
    {
      id: 'competenze_significative',
      etichetta: 'Competenze significative',
      tipo: 'testoLungo',
      obbligatorio: false,
      aiuto: 'Le competenze non comprese fra le otto, quando ci sono.',
    },
  ],
  schema: schemaCertificatoCompetenze,
  titolo: () => 'CERTIFICATO DELLE COMPETENZE',
  componi(prefill, risposte) {
    const { alunno } = prefill
    const nota = (codice: string) => testo(prefill.noteCompetenze?.[codice])
    // La colonna delle osservazioni compare solo se almeno una competenza ne ha una: è la
    // stessa disciplina di degrado per colonna del n. 47 — otto celle vuote in fila su un
    // certificato non sono uno spazio, sembrano otto giudizi negati. Nel generatore in
    // produzione la nota sta in corsivo sotto la riga; qui una tabella non ha stili di
    // cella, e una colonna è il modo di non perderla.
    const conNote = COMPETENZE_CHIAVE.some((c) => nota(c.codice) !== null)
    return [
      {
        tipo: 'paragrafo',
        stile: 'corsivo',
        testo:
          'Rilasciato sul modello nazionale delle competenze chiave europee di cui al D.M. 14 del 30 gennaio 2024.',
      },
      sezione("Dati dell'alunno/a"),
      ...campiSeValorizzati(
        [
          { etichetta: 'Cognome e nome', valore: nomeCompleto(alunno) },
          { etichetta: 'Codice fiscale', valore: alunno.codiceFiscale },
          ...campoNascita(alunno),
          { etichetta: 'Classe/sezione', valore: testo(prefill.classe) ?? alunno.sezione },
          { etichetta: 'Anno scolastico', valore: prefill.annoScolastico },
          { etichetta: 'Codice meccanografico', valore: prefill.sede.codiceMeccanografico },
        ],
        2
      ),
      // Prima della tabella, come nel generatore in produzione: è la frase che rende
      // certificato un prospetto di livelli.
      { tipo: 'paragrafo', testo: PREMESSA_COMPETENZE },
      sezione('Competenze chiave europee'),
      {
        tipo: 'tabella',
        intestazioni: [
          'Competenza chiave',
          'Discipline che concorrono',
          'Livello',
          ...(conNote ? ['Osservazioni'] : []),
        ],
        larghezze: conNote ? [5, 4, 2, 4] : [5, 4, 2],
        righe: COMPETENZE_CHIAVE.map((competenza) => [
          competenza.etichetta,
          competenza.descrizione,
          livelloEtichetta(risposte.livelli[competenza.codice]),
          ...(conNote ? [nota(competenza.codice) ?? ''] : []),
        ]),
      },
      sezione('Legenda dei livelli'),
      { tipo: 'elenco', voci: LIVELLI.map((l) => `${l.codice} — ${l.etichetta}: ${l.descrittore}`) },
      ...(testo(risposte.competenze_significative)
        ? [sezione('Competenze significative'), ...paragrafiDa(risposte.competenze_significative)]
        : []),
    ]
  },
}

// ════════════════════════════════════════════════════════════════════════════════
// 47 — CERTIFICATO DI SERVIZIO (personale)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * L'unico dei nove che non riguarda un bambino: il soggetto è un DIPENDENTE, e il
 * prefill viene dall'anagrafica del personale (PR #82), non da `alunni`. Il pannello lo
 * sa da `soggetto: 'dipendente'` e chiede la persona invece della sezione o dell'alunno.
 */
export interface PeriodoServizio {
  id: string
  /**
   * Data secca o istante: l'anagrafica del personale non ha una tabella di periodi, e la
   * route li compone da colonne che possono essere `date` (`cessato_il`) o `timestamptz`
   * (`creata_il`). `dataIt` legge tutte e due — e non è un dettaglio: se questa data si
   * perdesse in formattazione la colonna «Dal» non resterebbe vuota, SPARIREBBE (le colonne
   * senza dati si tolgono, poche righe più sotto), e resterebbe un certificato protocollato
   * che certifica un servizio senza data d'inizio.
   */
  dal?: string | null
  /** Come `dal`. Assente e rapporto non in corso = la cella resta vuota, mai una data dedotta. */
  al?: string | null
  /** Rapporto ancora in corso: il periodo si chiude con la formula, non con una data. */
  inCorso?: boolean | null
  qualifica?: string | null
  ordine?: string | null
  sede?: string | null
  tipoRapporto?: string | null
  /**
   * Numero (12,75 = dodici ore e tre quarti) oppure testo, perché l'anagrafica può portare
   * «25 (part-time)», che non è una quantità. ⚠️ Il testo si stampa COM'È: chi lo passa lo
   * passi già in forma italiana — la virgola, non il punto — perché qui non c'è modo di
   * distinguere un separatore decimale sbagliato da una nota fra parentesi. L'unica forma
   * corretta d'ufficio è il numero puro col punto («12.75»), che `oreSettimanali()` riporta
   * alla virgola: vedi il commento lì.
   */
  oreSettimanali?: number | string | null
}

export interface PrefillCertificatoServizio {
  dipendente: {
    cognome: string
    nome: string
    dataNascita?: string | null
    luogoNascita?: string | null
    codiceFiscale?: string | null
  }
  scuola: NucleoScuola
  /** La sede di servizio: il suo codice meccanografico è ciò che dà il punteggio. */
  sede: NucleoSede
  periodi: readonly PeriodoServizio[]
}

const schemaCertificatoServizio = z.object({
  periodi_inclusi: z
    .array(z.string().trim().min(1))
    .min(1, 'Selezionare almeno un periodo di servizio da certificare'),
  uso: zTestoFacoltativo(200),
  /**
   * Spenta di proposito. «Nulla osta sotto il profilo disciplinare» è una dichiarazione
   * che il legale rappresentante fa sotto la propria responsabilità: chi la accende sta
   * dichiarando qualcosa e deve accorgersene. Molte domande non la richiedono affatto.
   */
  riga_disciplinare: z.boolean().default(false),
})

export type RisposteCertificatoServizio = z.infer<typeof schemaCertificatoServizio>

/** La formula di chiusura di un rapporto ancora aperto: mai una data di fine inventata. */
const SERVIZIO_IN_CORSO = 'in servizio alla data odierna'

/**
 * DUE CIFRE DECIMALI, e non è una preferenza: è la misura di un difetto.
 *
 * `formattaDecimale` senza precisione ne tiene UNA (`cifreMax = 1` in
 * `src/lib/i18n/numero.ts`, un valore nato per scrivere i megabyte dentro una frase), e
 * misurato in node `new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(12.75)`
 * dà «12,8» — così come 18,25 → «18,3» e 21,75 → «21,8». Un part-time da 12,75 ore si
 * stampava 12,8 su un CERTIFICATO DI SERVIZIO firmato dal legale rappresentante,
 * protocollato in uscita e che vale punteggio in graduatoria: non è un arrotondamento di
 * stile, è un dato che non viene dall'archivio — proprio ciò che la regola 2 in testa a
 * questo file vieta. Due decimali coprono i quarti d'ora dei part-time (,25 ,50 ,75) e non
 * aggiungono niente a un intero, perché `maximumFractionDigits` non riempie di zeri.
 */
const CIFRE_ORE_SETTIMANALI = 2

/** Un numero puro col punto inglese: «12.75». Una nota come «25 (part-time)» non lo è. */
const DECIMALE_COL_PUNTO = /^\d+\.\d+$/

/**
 * Le ore settimanali come vanno su un atto italiano.
 *
 * Il ramo STRINGA esiste perché l'anagrafica del personale può portare «25 (part-time)», che
 * non è un numero e si stampa come sta. L'unica cosa che si corregge è il numero PURO col
 * punto — la forma in cui arriverebbe una colonna `numeric` letta come testo da PostgREST —
 * perché su questo foglio quel punto è lo stesso difetto che il ramo numerico esiste per
 * impedire, e la difesa varrebbe per metà dei valori che l'interfaccia ammette. Tutto il
 * resto è testo del chiamante e non si tocca: `PeriodoServizio.oreSettimanali` dice che va
 * passato già in forma italiana.
 *
 * `testo()` attorno a `formattaDecimale` perché quella rende stringa VUOTA su un numero non
 * finito, e il vuoto qui non è `null`: una colonna di celle vuote resterebbe stampata invece
 * di sparire.
 */
function oreSettimanali(valore: number | string | null | undefined): string | null {
  if (typeof valore === 'number') {
    return testo(formattaDecimale(valore, LINGUA, CIFRE_ORE_SETTIMANALI))
  }
  const grezzo = testo(valore)
  if (!grezzo) return null
  return DECIMALE_COL_PUNTO.test(grezzo) ? grezzo.replace('.', ',') : grezzo
}

/** Le sette colonne del prospetto, ognuna col proprio modo di leggere il periodo. */
const COLONNE_SERVIZIO: readonly {
  intestazione: string
  peso: number
  valore: (p: PeriodoServizio) => string | null
}[] = [
  { intestazione: 'Dal', peso: 2, valore: (p) => dataIt(p.dal) },
  { intestazione: 'Al', peso: 2, valore: (p) => (p.inCorso ? SERVIZIO_IN_CORSO : dataIt(p.al)) },
  { intestazione: 'Qualifica', peso: 3, valore: (p) => testo(p.qualifica) },
  { intestazione: 'Ordine di scuola', peso: 3, valore: (p) => testo(p.ordine) },
  { intestazione: 'Sede', peso: 3, valore: (p) => testo(p.sede) },
  { intestazione: 'Tipo di rapporto', peso: 3, valore: (p) => testo(p.tipoRapporto) },
  {
    intestazione: 'Ore settimanali',
    peso: 2,
    // `oreSettimanali()` e non `numero()`: 12,75 ore è la forma normale di un part-time, e
    // `numero()` è `String(valore)` — stamperebbe «12.75», col punto inglese, su un atto
    // italiano firmato dal legale rappresentante e protocollato in uscita che vale punteggio
    // di servizio. `numero()` resta ai CONTEGGI interi (righe, giorni, presenze del n. 50).
    valore: (p) => oreSettimanali(p.oreSettimanali),
  },
]

export const modelloCertificatoServizio: ModelloPrestampato<
  PrefillCertificatoServizio,
  RisposteCertificatoServizio
> = {
  slug: 'certificato_servizio',
  etichetta: 'Certificato di servizio',
  soggetto: 'dipendente',
  disponibilePer: ['admin', 'segreteria'],
  firma: 'legaleRappresentante',
  protocollo: 'uscita',
  archiviazione: 'fascicolo_personale',
  campi: [
    {
      id: 'periodi_inclusi',
      etichetta: 'Periodi da certificare',
      tipo: 'sceltaMultipla',
      obbligatorio: true,
      aiuto: "Arrivano dall'anagrafica del personale: si spuntano, non si digitano.",
    },
    {
      id: 'uso',
      etichetta: 'Uso dichiarato',
      tipo: 'testo',
      obbligatorio: false,
      aiuto: 'Per esempio «per graduatorie» o «per concorso». Se manca, resta la sola formula di legge.',
    },
    {
      id: 'riga_disciplinare',
      etichetta: 'Includere la dichiarazione sul profilo disciplinare',
      tipo: 'conferma',
      obbligatorio: false,
      aiuto: 'Va accesa solo se è vera e solo se serve: è una dichiarazione del legale rappresentante.',
    },
  ],
  schema: schemaCertificatoServizio,
  titolo: () => 'CERTIFICATO DI SERVIZIO',
  componi(prefill, risposte) {
    const { dipendente } = prefill
    const periodi = prefill.periodi.filter((p) => risposte.periodi_inclusi.includes(p.id))

    // NESSUN PERIODO RISOLTO = id che in archivio non esistono. Non è un caso di degrado
    // — non manca un dato, manca l'OGGETTO del certificato — e lo schema non può
    // accorgersene, perché non conosce l'anagrafica: controlla che l'elenco non sia
    // vuoto, non che quegli id ci siano. Si rifiuta rumorosamente invece di consegnare un
    // foglio protocollato che vale punteggio e non certifica niente. La route validi gli
    // id contro i periodi che ha appena letto, o catturi questo errore: è la stessa
    // disciplina di `buildDocumentoRichiesta`, che sul documento libero senza titolo né
    // corpo lancia invece di produrre una pagina vuota.
    if (periodi.length === 0) {
      throw new Error(
        'Certificato di servizio: nessuno dei periodi selezionati risulta fra quelli in archivio'
      )
    }

    // Una colonna che l'anagrafica non sa riempire per NESSUNO dei periodi certificati
    // non diventa una colonna di celle vuote: sparisce. È la stessa disciplina di
    // degrado dei certificati per gli alunni, applicata a una tabella invece che a una
    // riga — e su un foglio che vale punteggio una colonna vuota sembra un dato negato.
    const colonne = COLONNE_SERVIZIO.filter((c) => periodi.some((p) => c.valore(p) !== null))

    // «nato/a a X il Y» è una locuzione sola e non vuole virgole dentro — la compone
    // `locuzioneNascita`, la stessa che il n. 30 e il n. 46 usano nella loro forma a campo;
    // il codice fiscale è l'elemento successivo dell'inciso, e quello sì. Ognuno dei tre
    // pezzi può mancare per conto suo senza sgrammaticare gli altri.
    const nascita = locuzioneNascita(dipendente)
    const nato = [
      nascita ? `nato/a ${nascita}` : null,
      testo(dipendente.codiceFiscale) ? `codice fiscale ${testo(dipendente.codiceFiscale)}` : null,
    ].filter(Boolean)

    // L'ANNUNCIO DELL'ELENCO ESISTE SOLO SE L'ELENCO ESISTE. Con periodi in archivio ma
    // tutti privi di campi il prospetto non si stampa (nessuna colonna ha dati), e il
    // capoverso finirebbe con i due punti e sotto il vuoto — su un certificato
    // protocollato, che esce dalla scuola e vale punteggio. Un elenco annunciato e
    // assente è peggio di una riga in meno: la frase si chiude e basta.
    const chiusuraApertura =
      colonne.length > 0
        ? ' ha prestato servizio presso questa istituzione scolastica nei periodi e con le qualifiche di seguito indicati:'
        : ' ha prestato servizio presso questa istituzione scolastica.'

    // I quattro dati identificativi vengono TUTTI da `scuole.config.anagrafica` e sono tutti
    // facoltativi: si compongono prima del titoletto, perché il titoletto esiste solo se
    // almeno uno c'è. Con una sede configurata a metà, `sezione(...)` incondizionata
    // stampava il titoletto verde col suo filetto e sotto il vuoto, subito sopra il blocco di
    // firma — la stessa «sezione visibilmente vuota» che il n. 42 ha eliminato sostituendo
    // l'ombrello «Lesione rilevata» coi titoletti veri. Stessa insidia, stessa disciplina.
    const datiScuola = campiSeValorizzati([
      { etichetta: 'Denominazione', valore: prefill.scuola.ragioneSociale },
      { etichetta: 'P.IVA/C.F.', valore: prefill.scuola.piva },
      { etichetta: 'Sede legale', valore: prefill.scuola.sedeLegale },
      // «Scuola paritaria» fa parte dell'etichetta, ed è la parola che il testo della
      // specifica scrive («Scuola paritaria — codici meccanografici: …»). Non è un
      // ornamento: la parità è la condizione per cui il servizio prestato qui dà punteggio
      // in graduatoria a chi presenta il certificato, ed è l'unica riga del foglio che la
      // afferma. Persa, il certificato certifica un servizio senza dire presso che cosa.
      {
        etichetta: 'Scuola paritaria — codici meccanografici',
        valore: prefill.scuola.codiciMeccanografici,
      },
    ])

    return [
      // L'inciso anagrafico si apre e si CHIUDE con la virgola, o non c'è affatto: con una
      // virgola fissa prima di «ha prestato», un dipendente senza nascita né codice
      // fiscale in archivio uscirebbe con «si certifica che Bianchi Lucia, ha prestato
      // servizio» — la punteggiatura di un dato mancante, su un certificato.
      ...paragrafoSePresente(
        `Visti gli atti d'ufficio, si certifica che ${nomeCompleto(dipendente) ?? ''}` +
          `${nato.length > 0 ? `, ${nato.join(', ')},` : ''}${chiusuraApertura}`
      ),
      ...(colonne.length > 0
        ? [
            {
              // TRE RIGHE VUOTE PERCHÉ LO DICE §2, non perché convenga. `00-impaginazione.md`
              // elenca «periodi di servizio (n. 47)» fra le tabelle ripetibili e chiede
              // «almeno tre righe vuote anche quando i dati sono meno»: nomina questo modulo
              // per nome, e la specifica è vincolante.
              //
              // ⚠️ C'È UN'OBIEZIONE, e non è risolta qui. La ragione che §2 dà per quelle
              // righe — «un modulo consegnato deve poter essere completato a penna» — è vera
              // dei moduli da compilare (delegati, dieta, dosi) e si rovescia su questo
              // foglio, che non è un modulo ma un ATTO firmato dal legale rappresentante e
              // protocollato in uscita, che vale punteggio di servizio: tre righe libere
              // sotto l'ultimo periodo, su un foglio già firmato, sono lo spazio dove
              // aggiungere servizio dopo la firma. L'obiezione va portata a chi possiede
              // `docs/prestampati/` — o §2 toglie il n. 47 dall'elenco e ci scrive la ragione,
              // o la regola resta questa — perché una regola scritta nel documento e una sua
              // eccezione nascosta nel codice sono la cosa peggiore delle due: la prossima
              // persona ne trova una sola e non sa che esiste l'altra.
              tipo: 'tabella' as const,
              intestazioni: colonne.map((c) => c.intestazione),
              larghezze: colonne.map((c) => c.peso),
              righe: periodi.map((p) => colonne.map((c) => c.valore(p) ?? '')),
              righeVuote: 3,
            },
          ]
        : []),
      ...campiSeValorizzati([
        {
          etichetta: 'Codice meccanografico della sede di servizio',
          valore: prefill.sede.codiceMeccanografico,
        },
      ]),
      ...(risposte.riga_disciplinare
        ? paragrafoSePresente(
            'Si certifica altresì che il servizio è stato prestato con regolarità e che nulla osta sotto il ' +
              'profilo disciplinare.'
          )
        : []),
      ...paragrafoSePresente(
        "Il presente certificato viene rilasciato, in carta libera, su richiesta dell'interessato/a per gli " +
          'usi consentiti dalla legge.' + (testo(risposte.uso) ? ` Uso dichiarato: ${testo(risposte.uso)}.` : '')
      ),
      ...(datiScuola.length > 0
        ? [sezione('Dati identificativi della scuola'), ...datiScuola]
        : []),
    ]
  },
}

// ════════════════════════════════════════════════════════════════════════════════
// 49 — STAMPE DI SEZIONE (elenco · allergie · contatti d'emergenza)
// ════════════════════════════════════════════════════════════════════════════════

export const STAMPE_SEZIONE = [
  { valore: 'elenco', etichetta: 'Elenco alunni' },
  { valore: 'allergie', etichetta: 'Allergie, intolleranze e diete speciali' },
  { valore: 'emergenze', etichetta: "Contatti d'emergenza" },
] as const satisfies readonly OpzioneCampo[]

export const ORDINAMENTI_SEZIONE = [
  { valore: 'cognome', etichetta: 'Per cognome' },
  { valore: 'nascita', etichetta: 'Per data di nascita' },
] as const satisfies readonly OpzioneCampo[]

/**
 * Una riga per bambino, con tutto ciò che le tre stampe possono chiedere.
 *
 * Una riga per bambino ANCHE quando la dieta è la stessa di un altro, invece di
 * raggruppare per allergene: chi prepara i piatti ragiona per bambino, non per allergene.
 */
export interface RigaSezione {
  cognome: string
  nome: string
  /** `YYYY-MM-DD`, come la colonna `date` da cui viene. */
  dataNascita?: string | null
  sezione?: string | null
  insegnanti?: string | null
  note?: string | null
  /** Attivo in sezione; `false` = sospeso, escluso salvo richiesta esplicita. */
  attivo?: boolean | null
  // 49.b — cucina
  allergie?: string | null
  alimentiDaEscludere?: string | null
  sostituzioni?: string | null
  motivoDieta?: string | null
  documentoDieta?: string | null
  // 49.c — emergenze
  contattiGenitori?: string | null
  altriContatti?: string | null
  pediatra?: string | null
  /** SOLO ciò che serve in emergenza: allergia grave, epilessia, terapia salvavita. */
  noteSanitarie?: string | null
}

export interface PrefillStampeSezione {
  sezione: { nome?: string | null }
  sede: NucleoSede
  annoScolastico: string
  /**
   * Quando si stampa — sul foglio della cucina è il dato più importante, perché «il rischio
   * non è che manchi: è che sia vecchio» (specifica n. 49). Data secca o istante: la cosa più
   * naturale che faccia una route è `new Date().toISOString()`, e `dataIt` la legge.
   */
  dataStampa: string
  stampatoDa?: string | null
  direzioneTelefono?: string | null
  alunni: readonly RigaSezione[]
}

const schemaStampeSezione = z.object({
  stampa: zOpzioni(STAMPE_SEZIONE),
  ordinamento: zOpzioni(ORDINAMENTI_SEZIONE).default('cognome'),
  includi_sospesi: z.boolean().default(false),
})

export type RisposteStampeSezione = z.infer<typeof schemaStampeSezione>

/** Ha qualcosa che riguarda la cucina? Serve a contare le diete e a scegliere le righe. */
function haDieta(riga: RigaSezione): boolean {
  return [riga.allergie, riga.alimentiDaEscludere, riga.sostituzioni, riga.motivoDieta].some(
    (v) => testo(v) !== null
  )
}

/**
 * Una sezione senza righe si dice a parole, in tutte e tre le stampe.
 *
 * Una tabella con la sola banda di intestazione è ambigua esattamente come il foglio
 * vuoto appeso in cucina: non distingue «non c'è nessuno» da «non è stato caricato
 * niente», e sui contatti d'emergenza la differenza è quella fra un elenco che non serve
 * e un elenco che manca. La frase dice anche il terzo caso, che è il più insidioso —
 * bambini ce ne sono, ma questa stampa li esclude perché sospesi.
 */
function sezioneSenzaRighe(sospesiEsclusi: number): BloccoPrestampato[] {
  if (sospesiEsclusi > 0) {
    const quanti =
      sospesiEsclusi === 1
        ? 'un bambino risulta sospeso e non compare'
        : `${sospesiEsclusi} bambini risultano sospesi e non compaiono`
    return paragrafoSePresente(
      `Nessun bambino attivo in questa sezione: ${quanti} in questa stampa.`
    )
  }
  return paragrafoSePresente('Nessun bambino risulta iscritto in questa sezione.')
}

function ordina(alunni: readonly RigaSezione[], ordinamento: string): RigaSezione[] {
  const copia = [...alunni]
  if (ordinamento === 'nascita') {
    // Confronto di stringhe nudo, non `localeCompare`: una data ISO si ordina da sé, e
    // il collation di una lingua qui non aggiungerebbe niente se non una dipendenza dal
    // runtime. Chi la data non ce l'ha va in fondo — non in cima, come se fosse il più
    // piccolo della sezione.
    const chiave = (a: RigaSezione) => testo(a.dataNascita) ?? '9999-99-99'
    return copia.sort((a, b) => (chiave(a) < chiave(b) ? -1 : chiave(a) > chiave(b) ? 1 : 0))
  }
  return copia.sort((a, b) =>
    `${a.cognome} ${a.nome}`.localeCompare(`${b.cognome} ${b.nome}`, LINGUA, { sensitivity: 'base' })
  )
}

/**
 * Quanto del nome di chi stampa entra nel piede (vedi `piePagina`): quaranta caratteri
 * bastano a un nome e cognome italiani per esteso, e mettono un tetto a un chiamante che ci
 * passasse una frase.
 *
 * I nomi lunghi con cui il piede è stato misurato — qui sotto e nel test — sono INVENTATI, e
 * vanno letti per quello che sono: 28 caratteri, cioè più del nome più lungo che
 * l'applicazione può davvero mettere in questo piede. Misurato in sola lettura
 * sull'archivio, con un solo aggregato e senza estrarre nessun dato personale:
 * `max(length(nome || ' ' || cognome))` vale 23 su `utenti` — che è la tabella da cui
 * `stampatoDa` arriva — 21 su `alunni` e 13 su `pratiche_personale`. Il tetto a 40 resta
 * quello giusto proprio perché è largo: serve al caso che l'archivio non produce.
 */
const MAX_NOME_PIEDE = 40

export const modelloStampeSezione: ModelloPrestampato<PrefillStampeSezione, RisposteStampeSezione> = {
  slug: 'stampe_sezione',
  etichetta: 'Stampe di sezione',
  // Il soggetto è una SEZIONE intera: il pannello chiede la classe e basta, non un
  // alunno. La segreteria le stampa per le proprie sedi, l'insegnante per le proprie
  // sezioni — quel gate è nella route, questa riga dice solo chi può arrivarci.
  soggetto: 'sezione',
  disponibilePer: ['admin', 'segreteria', 'coordinator', 'educator'],
  firma: 'nessuna',
  protocollo: 'nessuno',
  archiviazione: 'nessuna',
  // ⚠️ DUE OPZIONI SU TRE. La specifica (n. 49, «Opzioni») ne elenca tre per l'elenco
  // alunni: ordinamento, sospesi e «con o senza foto» — la griglia con le fotografie che
  // serve all'accoglienza di settembre. La terza non c'è, e la ragione è la stessa del
  // tagliando del n. 31: `BloccoPrestampato` non ha un blocco immagine, e `tipi.ts` non è di
  // questa mano. Va aggiunto lì insieme al `blocchiDopoFirma`, non aggirato qui con una
  // tabella di caselle vuote da incollarci sopra le foto.
  campi: [
    { id: 'stampa', etichetta: 'Quale stampa', tipo: 'scelta', obbligatorio: true, opzioni: STAMPE_SEZIONE },
    {
      id: 'ordinamento',
      etichetta: 'Ordinamento',
      tipo: 'scelta',
      obbligatorio: false,
      opzioni: ORDINAMENTI_SEZIONE,
    },
    {
      id: 'includi_sospesi',
      etichetta: 'Includere i bambini sospesi',
      tipo: 'conferma',
      obbligatorio: false,
    },
  ],
  schema: schemaStampeSezione,
  titolo(prefill, risposte) {
    const sezioneNome = testo(prefill.sezione.nome)
    const coda = sezioneNome ? ` — SEZIONE ${sezioneNome.toUpperCase()}` : ''
    if (risposte.stampa === 'allergie') return `ALLERGIE, INTOLLERANZE E DIETE SPECIALI${coda}`
    if (risposte.stampa === 'emergenze') return `CONTATTI D'EMERGENZA${coda}`
    return `ELENCO ALUNNI${coda}`
  },
  /**
   * Il piede va su OGNI pagina (lo scrive `disegnaPiedi`), ed è ciò che la specifica
   * chiede quando parla di filigrana: se un foglio con nomi, allergie e telefoni finisce
   * dove non deve, si sa da dove viene. Una filigrana in diagonale vorrebbe un blocco
   * nuovo nel motore, che non è di questa mano.
   *
   * ⚠️ LA LUNGHEZZA DI QUESTA RIGA È UN INGOMBRO, NON UNO STILE — e il n. 49 è proprio la
   * stampa che va su più pagine. `disegnaPiedi` (`impaginazione.ts`) centra il piede a
   * x=105 e, quando le pagine sono più d'una, scrive «Pagina n di m» allineato a destra a
   * x=188: misurato con lo jsPDF del progetto (Helvetica corsivo 8 pt), «Pagina 10 di 12»
   * è largo 19,5 mm e comincia a x=168,6. Il piede lungo di prima — «Elenco riservato —
   * contiene dati personali di minori · stampato il … · da …» — cresceva col nome di chi
   * stampa: passava con «Segreteria Finta» (arrivava a 165,4) e SI SOVRAPPONEVA al numero
   * di pagina con due nomi INVENTATI di 28 caratteri, «Maria Antonietta Della Ratta» a
   * 173,0 e «Giuseppina Di Costanzo Aveta» a 174,6 — cioè con nomi già più lunghi dei 23
   * caratteri del più lungo che l'archivio contenga (vedi `MAX_NOME_PIEDE`). La soglia era
   * ~19 caratteri di nome, e quella sì che è la norma e non il caso limite. Con questo testo
   * gli stessi due arrivano a 148,0 e 149,6, e uno di 42 caratteri a 158,6, contro un
   * limite di 165,6.
   *
   * Il taglio a `MAX_NOME_PIEDE` serve al caso opposto — una route che passasse una frase
   * invece di un nome — e non è una garanzia assoluta: quaranta caratteri di lettere
   * ordinarie ci stanno anche tutto maiuscolo (misurato: 37 lettere maiuscole = 112,2 mm
   * sui 121,1 disponibili), quaranta «W» no. Quel residuo è del motore e la riparazione
   * vera sta lì:
   * piede allineato a sinistra invece che centrato, oppure larghezza massima con
   * `splitTextToSize`. Segnalata e non fatta — `impaginazione.ts` non è di questa mano —
   * come per `blocchiDopoFirma` e per il blocco immagine. Il lock che misura questa riga
   * col font vero è nel test di questo file.
   */
  piePagina(prefill) {
    const quando = dataIt(prefill.dataStampa)
    const chi = accorcia(testo(prefill.stampatoDa), MAX_NOME_PIEDE)
    return ['Riservato — dati di minori', quando, chi].filter(Boolean).join(' · ')
  },
  componi(prefill, risposte) {
    const dataStampa = dataIt(prefill.dataStampa)
    const iscritti = prefill.alunni.filter((a) => risposte.includi_sospesi || a.attivo !== false)
    const righe = ordina(iscritti, risposte.ordinamento)
    const intestazione = campiSeValorizzati(
      [
        { etichetta: 'Sede', valore: prefill.sede.nome },
        { etichetta: 'Sezione', valore: prefill.sezione.nome },
        { etichetta: 'Anno scolastico', valore: prefill.annoScolastico },
      ],
      2
    )

    // Prima di scegliere quale tabella disegnare: se non c'è nessuno lo si dice, e si
    // dice in tutte e tre le stampe. La data resta — su un foglio che dichiara «nessuno»
    // il quando è la sola cosa che lo rende verificabile.
    if (righe.length === 0) {
      return [
        ...intestazione,
        ...paragrafoSePresente(dataStampa ? `Aggiornato al ${dataStampa}` : null, 'grassetto'),
        ...sezioneSenzaRighe(prefill.alunni.length - iscritti.length),
      ]
    }

    if (risposte.stampa === 'allergie') {
      const conDieta = righe.filter(haDieta)
      return [
        ...intestazione,
        ...paragrafoSePresente(
          dataStampa ? `Aggiornato al ${dataStampa} — sostituisce ogni copia precedente` : null,
          'grassetto'
        ),
        // Un foglio vuoto appeso in cucina è ambiguo: può voler dire «nessuno ha allergie»
        // o «non l'ha ancora compilato nessuno». Lo si dice a parole. Qui i bambini ci
        // sono — la sezione vuota l'ha già intercettata `sezioneSenzaRighe` più su —
        // e la frase afferma proprio ciò che serve alla cucina: nessuna dieta da fare.
        ...(conDieta.length === 0
          ? paragrafoSePresente(
              'Nessun bambino della sezione ha allergie, intolleranze o diete speciali registrate.'
            )
          : [
              {
                tipo: 'tabella' as const,
                intestazioni: [
                  'Cognome e nome',
                  'Sezione',
                  'Allergie / intolleranze',
                  'Alimenti da escludere',
                  'Sostituzioni',
                  'Motivo',
                  'Documento',
                ],
                larghezze: [4, 2, 4, 4, 4, 3, 3],
                righe: conDieta.map((a) => [
                  nomeCompleto(a) ?? '',
                  testo(a.sezione) ?? testo(prefill.sezione.nome) ?? '',
                  testo(a.allergie) ?? '',
                  testo(a.alimentiDaEscludere) ?? '',
                  testo(a.sostituzioni) ?? '',
                  testo(a.motivoDieta) ?? '',
                  testo(a.documentoDieta) ?? '',
                ]),
              },
            ]),
        ...paragrafoSePresente(
          `Bambini con dieta speciale: ${conDieta.length} su ${righe.length}`
        ),
        ...paragrafoSePresente(
          'In caso di dubbio non somministrare e contattare la segreteria' +
            (testo(prefill.sede.telefono) ? `: ${testo(prefill.sede.telefono)}` : '.'),
          'grassetto'
        ),
      ]
    }

    if (risposte.stampa === 'emergenze') {
      return [
        ...intestazione,
        ...paragrafoSePresente(dataStampa ? `Aggiornato al ${dataStampa}` : null, 'grassetto'),
        {
          tipo: 'tabella',
          intestazioni: [
            'Cognome e nome',
            'Genitori (in ordine di chiamata)',
            'Altri contatti autorizzati',
            'Pediatra',
            'Note sanitarie rilevanti',
          ],
          larghezze: [4, 5, 4, 3, 4],
          righe: righe.map((a) => [
            nomeCompleto(a) ?? '',
            testo(a.contattiGenitori) ?? '',
            testo(a.altriContatti) ?? '',
            testo(a.pediatra) ?? '',
            testo(a.noteSanitarie) ?? '',
          ]),
        },
        ...paragrafoSePresente(
          [
            'Numeri utili: 118',
            testo(prefill.sede.telefono),
            testo(prefill.direzioneTelefono) ? `Direzione ${testo(prefill.direzioneTelefono)}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          'grassetto'
        ),
      ]
    }

    return [
      ...intestazione,
      {
        tipo: 'tabella',
        intestazioni: ['#', 'Cognome e nome', 'Data di nascita', 'Insegnanti', 'Note'],
        larghezze: [1, 6, 3, 4, 4],
        righe: righe.map((a, i) => [
          String(i + 1),
          nomeCompleto(a) ?? '',
          dataIt(a.dataNascita) ?? '',
          testo(a.insegnanti) ?? '',
          testo(a.note) ?? '',
        ]),
      },
      ...paragrafoSePresente(`Totale iscritti: ${righe.length}`),
    ]
  },
}

// ════════════════════════════════════════════════════════════════════════════════
// 50 — REGISTRO DELLE PRESENZE MENSILE
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Gli stati che una giornata può avere, con il simbolo che li rappresenta sul foglio.
 *
 * Sono gli stessi cinque di `MonthlyAttendanceTable` (`attendance/monthly`), e vivono
 * qui insieme al simbolo perché la LEGENDA e la GRIGLIA si stampano dallo stesso
 * elenco: un simbolo cambiato in un posto solo è una legenda che mente.
 *
 * `nessun_dato` non ha simbolo, e non è una dimenticanza: il giorno non ancora arrivato
 * — o quello in cui nessuno ha registrato — non è un'assenza, e stamparci «A» sarebbe
 * inventare una assenza in un documento che rendiconta denaro pubblico.
 */
export const STATI_PRESENZA = [
  { valore: 'presente', etichetta: 'Presente', simbolo: 'P' },
  { valore: 'ritardo', etichetta: 'Entrata posticipata', simbolo: 'R' },
  { valore: 'uscita_anticipata', etichetta: 'Uscita anticipata', simbolo: 'U' },
  { valore: 'assente', etichetta: 'Assente', simbolo: 'A' },
  { valore: 'nessun_dato', etichetta: 'Nessuna registrazione', simbolo: '' },
] as const

export type StatoPresenza = (typeof STATI_PRESENZA)[number]['valore']

/**
 * CHE COS'È UNA PRESENZA, QUANDO SI CONTA — la definizione, e una sola.
 *
 * Solo `presente`. È il conteggio di `calcSummary`, la funzione che alimenta la
 * schermata mensile dell'insegnante e il suo export
 * (`src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx`), dove i
 * quattro contatori si escludono a vicenda: entrata posticipata e uscita anticipata
 * stanno nelle proprie colonne e non entrano nelle presenze.
 *
 * Prima di questa riga il registro sommava anche quelle due, e per lo stesso mese lo
 * schermo e il foglio stampato dichiaravano due «presenze totali» diverse — con quei
 * numeri si rendicontano voucher 0-3, PON, PNRR e SIEI. Fra le due definizioni ha vinto
 * quella che una persona ha davanti agli occhi mentre chiude il mese.
 *
 * ⚠️ La definizione vive ancora in DUE file: `calcSummary` è dentro un componente
 * `'use client'` che si porta appresso next-intl, framer-motion e jsPDF, e importarlo da
 * qui trascinerebbe tutto questo in un modulo puro (è così che in questo repo `vitest`
 * resta verde e `npm run build` cade). L'estrazione in una funzione sola è segnalata nel
 * resoconto, non fatta: quel componente non è di questa mano. Finché sono due, il foglio
 * dichiara in chiaro che cosa conta — `NOTA_CONTEGGIO_PRESENZE`, qui sotto.
 */
const STATO_CHE_CONTA_COME_PRESENZA: StatoPresenza = 'presente'

/**
 * La stessa regola, detta sul foglio a chi legge i numeri senza aver letto il codice.
 *
 * ⚠️ QUI IL FOGLIO DICE SOLO CIÒ CHE `componi` GARANTISCE DA SÉ, e la frase che manca è la
 * più importante di tutte. Prima chiudeva con «È lo stesso conteggio della schermata delle
 * presenze dell'insegnante», e quella era un'affermazione su un ALTRO file: `calcSummary`
 * conta le sole giornate marcate `fattoDelRegistro`, mentre qui si conta qualunque stato
 * arrivi per i `giorni` che il chiamante passa. Le due coincidono finché la route rispetta
 * il contratto dichiarato su `PrefillRegistroPresenze.giorni`; se un giorno passasse il mese
 * intero con dentro le assenze comunicate in anticipo, il foglio dichiarerebbe più assenze
 * dello schermo — e la frase in calce avrebbe giurato il contrario a chi rendiconta un
 * fondo. Le tre regole rimaste sono vere per costruzione: il perimetro è la griglia stampata
 * qui sopra, e chi legge il foglio ce l'ha davanti.
 */
const NOTA_CONTEGGIO_PRESENZE =
  'Come si contano: una presenza è una giornata registrata come presente. Le entrate ' +
  'posticipate e le uscite anticipate hanno una colonna ciascuna, non sono assenze e non ' +
  'entrano nelle presenze; i giorni senza registrazione non si contano affatto. Il ' +
  'conteggio comprende soltanto i giorni elencati nella griglia qui sopra.'

function simboloPresenza(stato: StatoPresenza | undefined): string {
  return STATI_PRESENZA.find((s) => s.valore === stato)?.simbolo ?? ''
}

export interface RigaRegistroPresenze {
  cognome: string
  nome: string
  /**
   * Stato per giorno del mese (1…31). I giorni assenti dalla mappa restano vuoti.
   *
   * Ci vanno i soli FATTI DEL REGISTRO — vedi il contratto di `giorni` qui sotto: un'assenza
   * comunicata dal genitore per un giorno non ancora arrivato non è un fatto del registro, e
   * qui dentro diventerebbe un'assenza contata.
   */
  stati: Readonly<Record<number, StatoPresenza>>
}

export interface PrefillRegistroPresenze {
  sede: NucleoSede
  annoScolastico: string
  sezione: { nome?: string | null; livello?: string | null }
  /**
   * I giorni di attività didattica del mese, in ordine. Vuoto = nessuna griglia.
   *
   * ⚠️ SOLO GIORNATE GIÀ FATTE DEL REGISTRO — il contratto è questo, e il foglio ci si
   * appoggia: `componi` conta qualunque stato riceva per questi giorni, quindi il perimetro
   * lo decide chi riempie il prefill. È la stessa regola di `calcSummary`
   * (`src/components/features/teacher/attendance/MonthlyAttendanceTable.tsx`), che filtra
   * `fattoDelRegistro`: l'assenza che il genitore comunica per domani — o per oggi, prima
   * dell'appello — resta fuori dal riepilogo dello schermo, e deve restare fuori anche di
   * qui. Passare il mese di calendario intero è il modo di stampare un registro che dichiara
   * più assenze della schermata da cui è nato, su un foglio con cui si rendicontano voucher
   * 0-3, PON, PNRR e SIEI.
   */
  giorni: readonly number[]
  righe: readonly RigaRegistroPresenze[]
  /**
   * Le tre date sono ISTANTI (`timestamptz`), non giorni di calendario: le scrive
   * l'applicazione nel momento in cui il mese si chiude e la firma si appone. Assenti, il
   * foglio dice che il registro è ancora aperto e ancora da firmare — che è un'affermazione,
   * non un vuoto, ed è il motivo per cui `dataIt` deve saperle leggere.
   */
  chiusura?: {
    data?: string | null
    insegnante?: string | null
    firmatoIl?: string | null
    direzione?: string | null
    controfirmatoIl?: string | null
  }
}

const schemaRegistroPresenze = z.object({ mese: zAnnoMese })

export type RisposteRegistroPresenze = z.infer<typeof schemaRegistroPresenze>

/**
 * «novembre 2025» dal mese `YYYY-MM`.
 *
 * Giorno 15 e `timeZone: 'UTC'` per la stessa ragione di `nomeMese` in
 * `@/lib/i18n/date`: a mezzanotte locale, con un fuso di lettura diverso, il primo del
 * mese scivola al 31 di quello prima e l'intestazione del registro nomina il mese
 * sbagliato. Minuscolo: in italiano i nomi dei mesi dentro una frase non si alzano.
 *
 * `null` solo per una stringa che non è `YYYY-MM`, che dallo schema (`zAnnoMese`) non può
 * arrivare: chi compone non gli mette accanto un ripiego, perché stampare «2026-10» dove
 * il registro dice «ottobre 2026» sarebbe nascondere che lo schema è cambiato.
 */
function meseEsteso(mese: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(mese)
  if (!m) return null
  return intlDateTime(LINGUA, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15))
  )
}

/** Metà mese: la griglia si spezza in due tabelle, o 31 colonne su 166 mm sono illeggibili. */
const GIORNI_PER_TABELLA = 16

export const modelloRegistroPresenze: ModelloPrestampato<
  PrefillRegistroPresenze,
  RisposteRegistroPresenze
> = {
  slug: 'registro_presenze',
  etichetta: 'Registro presenze mensile',
  // Documento di SEZIONE, non di un bambino: si archivia con `student_id = null` e il
  // riferimento a sede, sezione e mese.
  soggetto: 'sezione',
  disponibilePer: ['educator', 'coordinator', 'admin', 'segreteria'],
  // Le due firme — insegnante di sezione e Direzione — sono righe del documento, non il
  // blocco di firma del motore: quello ha due varianti sole (la famiglia con OTP, il
  // legale rappresentante con la dicitura del D.Lgs 39/93), e nessuna delle due dice
  // «l'insegnante che ha tenuto il registro». Stampare la formula del 39/93 su un
  // registro interno significherebbe dichiarare una cosa che non è.
  firma: 'nessuna',
  protocollo: 'nessuno',
  archiviazione: 'student_documents',
  campi: [
    {
      id: 'mese',
      etichetta: 'Mese',
      tipo: 'mese',
      obbligatorio: true,
      aiuto: 'Finché il mese è aperto le presenze si correggono; alla chiusura il registro si congela.',
    },
  ],
  schema: schemaRegistroPresenze,
  titolo: () => 'REGISTRO DELLE PRESENZE',
  componi(prefill, risposte) {
    const giorni = [...prefill.giorni]
    const righe = [...prefill.righe].sort((a, b) =>
      `${a.cognome} ${a.nome}`.localeCompare(`${b.cognome} ${b.nome}`, LINGUA, { sensitivity: 'base' })
    )

    // Tutti i numeri del riepilogo si CONTANO dalla griglia, non arrivano dal chiamante:
    // sono gli stessi che chiedono i fondi (voucher comunale 0-3, PON, PNRR, SIEI), e due
    // fonti per lo stesso numero è il modo di rendicontare una cifra che il foglio non
    // dimostra.
    const perAlunno = righe.map((riga) => {
      const stati = giorni.map((g) => riga.stati[g])
      return {
        riga,
        presenze: stati.filter((s) => s === STATO_CHE_CONTA_COME_PRESENZA).length,
        assenze: stati.filter((s) => s === 'assente').length,
        ritardi: stati.filter((s) => s === 'ritardo').length,
        uscite: stati.filter((s) => s === 'uscita_anticipata').length,
      }
    })
    const presenzeTotali = perAlunno.reduce((somma, a) => somma + a.presenze, 0)
    const assenzeTotali = perAlunno.reduce((somma, a) => somma + a.assenze, 0)
    const sopraMeta = perAlunno.filter((a) => giorni.length > 0 && a.presenze * 2 > giorni.length).length

    const griglia: BloccoPrestampato[] = []
    for (let inizio = 0; inizio < giorni.length; inizio += GIORNI_PER_TABELLA) {
      const fetta = giorni.slice(inizio, inizio + GIORNI_PER_TABELLA)
      griglia.push({
        tipo: 'tabella',
        intestazioni: ['Alunno/a', ...fetta.map((g) => String(g))],
        larghezze: [5, ...fetta.map(() => 1)],
        righe: righe.map((riga) => [
          nomeCompleto(riga) ?? '',
          ...fetta.map((g) => simboloPresenza(riga.stati[g])),
        ]),
      })
    }

    return [
      ...campiSeValorizzati(
        [
          { etichetta: 'Sede', valore: prefill.sede.nome },
          { etichetta: 'Sezione', valore: prefill.sezione.nome },
          { etichetta: 'Livello', valore: prefill.sezione.livello },
          { etichetta: 'Mese', valore: meseEsteso(risposte.mese) },
          { etichetta: 'Anno scolastico', valore: prefill.annoScolastico },
          { etichetta: 'Codice meccanografico', valore: prefill.sede.codiceMeccanografico },
        ],
        2
      ),

      ...(griglia.length > 0
        ? [
            sezione('Presenze giornaliere'),
            ...griglia,
            {
              tipo: 'paragrafo' as const,
              stile: 'corsivo' as const,
              testo:
                'Legenda: ' +
                STATI_PRESENZA.filter((s) => s.simbolo)
                  .map((s) => `${s.simbolo} = ${s.etichetta.toLowerCase()}`)
                  .join(' · ') +
                '. Cella vuota: nessuna registrazione per quel giorno.',
            },
          ]
        : []),

      sezione('Riepilogo per alunno/a'),
      {
        tipo: 'tabella',
        intestazioni: ['Alunno/a', 'Presenze', 'Assenze', 'Entrate posticipate', 'Uscite anticipate'],
        larghezze: [6, 2, 2, 3, 3],
        righe: perAlunno.map((a) => [
          nomeCompleto(a.riga) ?? '',
          String(a.presenze),
          String(a.assenze),
          String(a.ritardi),
          String(a.uscite),
        ]),
      },
      // La regola di conteggio sta accanto ai numeri, non nella legenda dei simboli: chi
      // rendiconta un fondo guarda queste colonne, e deve poter dire da che cosa vengono
      // senza chiederlo a chi ha scritto il codice.
      { tipo: 'paragrafo', stile: 'corsivo', testo: NOTA_CONTEGGIO_PRESENZE },

      sezione('Riepilogo del mese'),
      ...campiSeValorizzati(
        [
          { etichetta: 'Bambini iscritti nel mese', valore: numero(righe.length) },
          { etichetta: 'Giorni di attività didattica', valore: numero(giorni.length) },
          { etichetta: 'Presenze totali', valore: numero(presenzeTotali) },
          { etichetta: 'Assenze', valore: numero(assenzeTotali) },
        ],
        2
      ),
      // ─── LE DUE ULTIME RIGHE VANNO A TUTTA LARGHEZZA, E NON È UNA PREFERENZA ───────
      //
      // «Bambini con frequenza superiore al 50% dei giorni:» misura 79,2 mm in Helvetica
      // 10 pt — il font con cui `preparaCella` misura le etichette — contro i 78 mm di
      // `LARGHEZZA_COLONNA`. In un blocco a due colonne quella riga può capitare a destra
      // (x=110): lo spazio per il valore va in negativo, `preparaCella` ripiega sul minimo
      // di 12 mm e `disegnaCella` scrive comunque a `x + larghezzaEtichetta + 2`, cioè a
      // 191,2 mm — oltre il margine destro (`MARGINE_DX` = 188). Misurato sul PDF vero: la
      // cifra usciva a 193,4 mm dal bordo del foglio, fuori dalla larghezza utile che §1 e
      // §5.2 di `00-impaginazione.md` fissano in 166 mm. §2 lo dice anche in positivo: le
      // due colonne sono per i campi BREVI, i campi lunghi stanno a tutta larghezza.
      //
      // A una colonna il problema sparisce (79,2 su 166) e per giunta l'impaginazione
      // torna quella della specifica del n. 50, che queste due voci le mette una per riga.
      // Il lock che misura TUTTE le etichette a due colonne col font vero è nel test.
      ...campiSeValorizzati([
        {
          etichetta: 'Media giornaliera di frequenza',
          // Una cifra, e DETTA: la precisione a `formattaDecimale` si passa sempre, perché
          // il suo valore predefinito è nato per un'altra cosa (i megabyte dentro una
          // frase). Qui una cifra è quella giusta — è una media calcolata, non un dato
          // d'archivio come le ore del n. 47, e un secondo decimale suggerirebbe una
          // precisione che una divisione per il numero di giorni non ha.
          valore:
            giorni.length > 0 ? formattaDecimale(presenzeTotali / giorni.length, LINGUA, 1) : null,
        },
        {
          etichetta: 'Bambini con frequenza superiore al 50% dei giorni',
          valore: giorni.length > 0 ? numero(sopraMeta) : null,
        },
      ]),

      sezione('Chiusura del mese'),
      ...campiSeValorizzati([{ etichetta: 'Chiuso il', valore: dataIt(prefill.chiusura?.data) }]),
      // Qui il filetto ci sta: un registro non ancora firmato si stampa per essere firmato.
      {
        tipo: 'campi',
        campi: [
          {
            etichetta: "L'insegnante di sezione",
            valore: rigaFirmata(prefill.chiusura?.insegnante, prefill.chiusura?.firmatoIl, 'firmato'),
          },
          {
            etichetta: 'La Direzione',
            valore: rigaFirmata(prefill.chiusura?.direzione, prefill.chiusura?.controfirmatoIl, 'firmato'),
          },
        ],
      },
    ]
  },
}

// ─── Il registro dei nove ───────────────────────────────────────────────────────

/**
 * L'elenco che il pannello della segreteria mostra. È una vista di sola METADATI:
 * `titolo`, `schema` e `componi` hanno per ogni modello tipi propri, e un elenco che li
 * appiattisse tutti a `unknown` inviterebbe a chiamarli senza sapere che cosa passargli.
 * Chi genera un documento importa il modello per nome.
 */
export const MODELLI_SEGRETERIA: readonly VoceRegistroPrestampati[] = [
  modelloNullaOsta,
  modelloRichiestaDisponibilita,
  modelloSollecito,
  modelloVerbaleInfortunio,
  modelloValutazioneInfanzia,
  modelloCertificatoCompetenze,
  modelloCertificatoServizio,
  modelloStampeSezione,
  modelloRegistroPresenze,
]
