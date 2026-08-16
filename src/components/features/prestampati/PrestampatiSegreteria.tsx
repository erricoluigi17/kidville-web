'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  Search,
  Stamp,
  Trash2,
  X,
} from 'lucide-react'
import { HEADER_BTN, SectionTitle, TONE } from '@/components/ui/cockpit'
import { DateField } from '@/components/ui/DateField'
import { useSediAttive } from '@/lib/context/sede-context'
import { useDateFormat } from '@/lib/i18n/date'
import { eAncoraIscritto } from '@/lib/alunni/stato'
import {
  chiaveEtichetta,
  slugPrestampato,
  type CampoPrestampato,
  type SoggettoPrestampato,
} from '@/lib/prestampati/registro'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'
import { FUOCO_ESITO } from '@/lib/ui/fuoco'

/**
 * IL BANCO DEI PRESTAMPATI — la segreteria genera un foglio già compilato.
 *
 * Il percorso a schermo è quello chiesto, e l'ordine è la parte che conta:
 *
 *  1. **prima si dice di chi si parla** — sede, classe, bambino. La sede per prima perché
 *     `resolveScuolaScrittura` risponde **400** a chi ne ha più d'una e non la dichiara, e
 *     con tre plessi in produzione quello è il caso normale, non il caso limite;
 *  2. **poi il modello**, dall'elenco che la route restituisce per il banco di chi guarda;
 *  3. **poi il solo delta**: in sola lettura ciò che l'app ha già (nome, nascita, codice
 *     fiscale, sezione, anno scolastico) e si chiede il resto dai descrittori del modello;
 *  4. **poi il documento**, col numero di protocollo quando esce dalla scuola e con l'esito
 *     dell'archiviazione detto a voce alta.
 *
 * ─── QUELLO CHE QUESTO PANNELLO NON DECIDE ──────────────────────────────────────
 *
 * Chi può generare che cosa, e perché un foglio oggi non nasce, **non si decide qui**: lo
 * dichiara `GET /api/prestampati` con `generabile` e `motivo`. Un filtro di visibilità
 * scritto nel browser è un filtro che si disattiva con gli strumenti da sviluppatore, e due
 * copie della stessa regola divergono alla prima modifica. Qui si TRADUCE quel `motivo` —
 * che è un enumerato stabile — nella lingua in cui l'operatore sta lavorando: la `spiegazione`
 * che il server manda accanto è prosa italiana per costruzione, e mostrarla dentro
 * un'interfaccia inglese è il difetto che i codici d'errore hanno chiuso una volta.
 *
 * ─── PERCHÉ UN PULSANTE CHE NON C'È È MEGLIO DI UNO SPENTO ──────────────────────
 *
 * I modelli non generabili non hanno pulsante: hanno il loro motivo scritto sotto. Sono
 * undici dei diciassette — otto attestano una firma elettronica del genitore che questo
 * banco non può dichiarare al posto della famiglia, tre aspettano una fonte dati che non
 * esiste ancora — e mostrarli premibili significherebbe mandare una segretaria dentro un
 * rifiuto. Il quarto motivo (`legale_rappresentante_assente`) lo si scopre solo dopo aver
 * letto la configurazione della sede, quindi arriva con la scheda del modello: lì al posto
 * del modulo compare la frase che dice dove si ripara — il perché sta accanto a quel ramo.
 *
 * ─── LE ETICHETTE DEI CAMPI SONO ITALIANE, E VA DETTO ───────────────────────────
 *
 * Il nome dei diciassette modelli viene dal catalogo (`chiaveEtichetta`, che il test del
 * registro tiene allineato nelle due lingue). Le etichette dei CAMPI, i loro aiuti e le voci
 * delle tendine no: arrivano dai descrittori dei modelli, che nascono sul server e sono
 * italiani per costruzione. Tradurli vorrebbe dire una seconda copia di un centinaio di
 * testi in un file che nessuno riallineerebbe: è un debito dichiarato, non una dimenticanza.
 */

// ─── I contratti delle due porte, letti dalle route ─────────────────────────────

/** La voce d'elenco come la compone `voceElenco()` (`api/prestampati/banco.ts`). */
interface VoceModello {
  slug: string
  /** Il nome ITALIANO del server: si mostra solo se lo slug non è fra i diciassette. */
  etichetta: string
  soggetto: SoggettoPrestampato
  firma: string
  protocollo: 'uscita' | 'nessuno'
  archiviazione: string
  generabile: boolean
  motivo?: string
  /**
   * I tre modi di lavorare su un modulo di famiglia, quando il modello ne ha
   * (`modalitaDelModello`, `api/prestampati/banco.ts`). Assente sugli altri undici, e
   * l'assenza è il dato: dove non c'è scelta non si chiede niente.
   */
  modalita?: string[]
}

/**
 * LE TRE MODALITÀ, nell'ordine in cui si presentano allo sportello: prima quella che non
 * produce niente di nuovo (la copia già firmata), poi le due che stampano un foglio.
 *
 * 🔴 DUE DELLE TRE NON PORTANO NESSUNA FIRMA ELETTRONICA, e il pannello deve dirlo: la
 * riga «Firma la famiglia, con un codice usa e getta» del catalogo descrive il modello, non
 * il foglio che sta per uscire. Su una copia vuota e su un modulo tornato di carta quella
 * frase prometterebbe una firma che non ci sarà — che è, in piccolo, lo stesso difetto che
 * il documento non deve avere.
 *
 * ⚠️ E LA TERZA NON PROMETTE PIÙ IL RIQUADRO PRIMA DI AVERLO TROVATO. Fino al 2026-08-16
 * `modalitaFirmaCopiaFirmata` diceva «Il foglio porta il riquadro della firma elettronica,
 * perché quella firma c'è stata davvero» — una frase sulla modalità CHIESTA, non sul foglio
 * CONSEGNATO. Nel mentre la route consegnava «l'ultima riga di quel tipo», che dopo una
 * trascrizione `su_carta` è la trascrizione: il pannello dichiarava una firma elettronica su
 * un foglio che non ne aveva nessuna. La route ora la verifica contro il registro FEA, e
 * questa frase dice la condizione invece di darla per avvenuta.
 */
const MODALITA_ORDINE = ['copia_firmata', 'copia_vuota', 'su_carta'] as const
type Modalita = (typeof MODALITA_ORDINE)[number]

const CHIAVE_MODALITA: Record<Modalita, { titolo: string; aiuto: string; firma: string }> = {
  copia_firmata: {
    titolo: 'modalitaCopiaFirmata',
    aiuto: 'modalitaCopiaFirmataAiuto',
    firma: 'modalitaFirmaCopiaFirmata',
  },
  copia_vuota: {
    titolo: 'modalitaCopiaVuota',
    aiuto: 'modalitaCopiaVuotaAiuto',
    firma: 'modalitaFirmaCopiaVuota',
  },
  su_carta: {
    titolo: 'modalitaSuCarta',
    aiuto: 'modalitaSuCartaAiuto',
    firma: 'modalitaFirmaSuCarta',
  },
}

const modalitaValida = (v: string): v is Modalita =>
  (MODALITA_ORDINE as readonly string[]).includes(v)

/** La stessa voce, più i campi che il form deve chiedere: è la risposta con `?modello=`. */
interface SchedaModello {
  modello: VoceModello & { campi?: readonly CampoPrestampato[] }
  motivo?: string
  /** La prosa del server: ripiego quando il `motivo` non è fra quelli che il pannello traduce. */
  spiegazione?: string
  prefill: PrefillAlunno | PrefillSezione | null
}

interface PrefillAlunno {
  soggetto: 'alunno'
  alunnoId: string
  scuolaId: string
  sezioneId: string | null
  legaleRappresentante: string | null
  dati?: {
    alunno?: {
      nome?: string | null
      cognome?: string | null
      dataNascita?: string | null
      codiceFiscale?: string | null
      sezione?: string | null
    }
    annoScolastico?: string | null
  }
}

interface PrefillSezione {
  soggetto: 'sezione'
  sezioneId: string
  scuolaId: string
  nome: string | null
  livello: string | null
  /** Conteggi, non righe: chi compila deve sapere QUANTI bambini finiranno sul foglio. */
  alunni?: { iscritti?: number; sospesi?: number }
}

/** La riga di `GET /api/admin/sections`, ridotta a ciò che questo pannello legge. */
interface Classe {
  id: string
  name: string | null
}

/** La riga di `GET /api/admin/students`, ridotta a ciò che questo pannello legge. */
interface Alunno {
  id: string
  nome: string | null
  cognome: string | null
  stato: string | null
}

/**
 * Un elenco letto, con la CHIAVE per cui è stato letto.
 *
 * La chiave è ciò che rende superflui i «reset»: se l'operatore cambia sede, la chiave
 * dell'elenco delle classi non combacia più e la schermata torna da sola a «caricamento»
 * invece di mostrare le classi del plesso di prima. Un `useEffect` che azzerasse gli stati
 * a ogni cambio sarebbe per giunta un `setState` sincrono dentro un effetto, che la regola
 * `react-hooks/set-state-in-effect` vieta — a ragione.
 *
 * `errore` esiste perché senza di lui una lettura fallita resterebbe «in caricamento» per
 * sempre: la chiave non combacerebbe mai.
 */
interface Elenco<T> {
  chiave: string
  righe: T[]
  errore: boolean
}

const VUOTO = { chiave: '', righe: [], errore: false }

/** L'elenco dei modelli non dipende da nessuna scelta: una chiave sola, costante. */
const CHIAVE_MODELLI = 'modelli'

/** La rotta della PAGINA, per i log del client: è il luogo dell'incidente. */
const ROTTA = '/admin/modulistica'

/**
 * I motivi di rifiuto enumerati che il server manda, e la loro chiave di catalogo.
 *
 * Il `motivo` viaggia in un campo suo, enumerato e stabile, proprio perché a tradurlo sia
 * il pannello: è la richiesta che `api/prestampati/banco.ts` e le due route scrivono per
 * esteso accanto a ogni rifiuto. Un motivo che non fosse qui dentro non si inventa: si
 * ripiega sulla `spiegazione` del server, che è italiana ma dice comunque qualcosa.
 *
 * ⚠️ `firma_da_raccogliere` NON C'È PIÙ, e la riga sparita vale un commento: diceva ai sei
 * moduli di famiglia «si genera dal flusso di firma della famiglia, non dallo sportello»,
 * ed era vero finché l'unico foglio che questo banco sapeva produrre era quello già
 * firmato. Dal 2026-08-16 quei sei nascono da qui in una delle tre modalità.
 *
 * `copia_firmata_assente` non è un `MotivoNonGenerabile`: nasce nella route, dopo aver
 * guardato il fascicolo, e viaggia dallo stesso campo per la stessa ragione — è la sola
 * frase che dica cosa fare, cioè far firmare il modulo alla famiglia.
 *
 * 🔴 `copia_firmata_non_elettronica` È IL SUO GEMELLO, E LA DIFFERENZA VALE UNA RIGA. Il
 * primo dice «nel fascicolo non c'è niente»; il secondo dice «c'è qualcosa, e nessuno di
 * quei fogli l'ha firmato elettronicamente la famiglia» — trascrizioni `su_carta`,
 * scansioni. Appiattirli manderebbe la segreteria a far firmare di nuovo un modulo che la
 * famiglia ha già firmato.
 *
 * ⚠️ FINO AL 2026-08-16 IL SECONDO CHIUDEVA CON «L'originale firmato è quello di carta, agli
 * atti», ed era un fatto che il server non aveva misurato: sa soltanto che nessuna impronta
 * ha combaciato, e fra i casi possibili — trascrizioni `su_carta`, scansioni caricate a
 * mano, fogli rigenerati — negli ultimi due un originale di carta agli atti **non esiste**.
 * Era, in piccolo, esattamente ciò che questo ramo esiste per impedire: dichiarare avvenuto
 * un fatto che nessuno ha verificato. Ora la frase dice ciò che si sa e si ferma lì.
 *
 * 🔴 `copia_firmata_non_esaminata` È IL TERZO, e nasce da quella stessa disciplina: quando i
 * documenti di quel tipo sono più di quanti la route ne possa scaricare in una volta,
 * «nessuno di essi è firmato» sarebbe di nuovo un'affermazione su righe che nessuno ha
 * guardato. Dice quindi solo «fra quelli esaminati», che è la verità.
 */
const CHIAVE_MOTIVO: Record<string, string> = {
  firma_senza_flusso: 'motivoFirmaSenzaFlusso',
  fonte_dati_assente: 'motivoFonteDatiAssente',
  legale_rappresentante_assente: 'motivoLegaleRappresentanteAssente',
  copia_firmata_assente: 'motivoCopiaFirmataAssente',
  copia_firmata_non_elettronica: 'motivoCopiaFirmataNonElettronica',
  copia_firmata_non_esaminata: 'motivoCopiaFirmataNonEsaminata',
}

/** Che sottoscrizione pretende il foglio (`FirmaPrestampatoRichiesta`). */
const CHIAVE_FIRMA: Record<string, string> = {
  legale_rappresentante: 'firmaLegale',
  otp_genitore: 'firmaGenitore',
  otp_due_genitori: 'firmaGenitore',
  nessuna: 'firmaNessuna',
}

const CHIAVE_SOGGETTO: Record<SoggettoPrestampato, string> = {
  alunno: 'soggettoAlunno',
  sezione: 'soggettoSezione',
  dipendente: 'soggettoDipendente',
}

/**
 * L'unica stampa di sezione che porta dati dell'art. 9 — allergie, intolleranze e diete.
 *
 * È il `valore` dichiarato da `STAMPE_SEZIONE` in `modelli/segreteria.ts`. Cablarlo qui è
 * una scelta con un prezzo dichiarato: se un giorno quel valore cambiasse, l'avviso
 * sparirebbe in silenzio invece di comparire su una stampa sbagliata. È il verso giusto in
 * cui sbagliare — il piede del foglio dice comunque «Riservato — dati di minori» a ogni
 * pagina — e l'alternativa (mostrare l'avviso su tutte e tre le stampe) sarebbe gridare al
 * lupo sull'elenco alunni, che dati sanitari non ne ha.
 */
const STAMPA_CON_DATI_SANITARI = 'allergie'

// ─── Le classi di stile, nel linguaggio della pagina ────────────────────────────

const CARD = 'rounded-card border border-kidville-line bg-kidville-white p-5'
const ETICHETTA = 'mb-1.5 block font-maven text-sm font-semibold text-kidville-green'
/**
 * ⚠️ `focus:outline-none` NON toglie l'indicatore: lo SOSTITUISCE con l'anello verde della
 * casa (`focus:ring-2`), che è lo stesso di `FUOCO_ESITO` e dei 148 elementi che in `src/`
 * già lo usano. I campi del resto di questa pagina si fermano al cambio di bordo: da solo è
 * un indicatore debole, e chi naviga con il tasto Tab su un modulo di otto campi deve
 * vedere dove si trova.
 */
const CAMPO =
  'w-full rounded-xl border-2 border-kidville-line bg-kidville-white px-3 py-2.5 font-maven text-sm text-kidville-ink focus:border-kidville-green focus:outline-none focus:ring-2 focus:ring-kidville-green'
const BTN_LEGGERO =
  'inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-sub transition-colors hover:bg-kidville-cream'
const AIUTO = 'mt-1 font-maven text-[12.5px] text-kidville-sub'

// ─── La chiamata, FUORI dal componente ──────────────────────────────────────────

interface Risposta<T> {
  ok: boolean
  /** Assente quando il server non ha risposto affatto: `0` somiglierebbe a un codice vero. */
  stato?: number
  corpo: T | null
  /** Il nome della classe d'errore, quando la rete è caduta. Non si perde: lo logga chi chiama. */
  guasto?: string
}

/**
 * La chiamata sta FUORI dal componente ed è `async` per il motivo che
 * `DocumentiFirmatiPanel` documenta: `fetch` può lanciare in modo SINCRONO (URL malformato),
 * e allora il `try` che lo racchiude verrebbe eseguito sincronicamente dentro l'effetto —
 * che è ciò che `react-hooks/set-state-in-effect` vieta. Qui qualunque guasto diventa una
 * promise risolta con `ok: false`: chi chiama non ha nessun ramo sincrono da gestire e non
 * ha bisogno di un `catch`.
 *
 * Il guasto NON viene ingoiato: esce in `guasto` e chi chiama lo scrive in `app_log` con
 * `logClient`, insieme allo stato quando c'è.
 */
async function chiedi<T>(url: string): Promise<Risposta<T>> {
  try {
    const res = await fetch(url)
    const corpo = (await res.json().catch(() => null)) as T | null
    return { ok: res.ok, stato: res.status, corpo }
  } catch (e) {
    return { ok: false, corpo: null, guasto: nomeErrore(e) }
  }
}

// ─── I valori delle risposte, letti senza fidarsi ───────────────────────────────

const testoDi = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''

const listaDi = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const mappaDi = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, valore] of Object.entries(v as Record<string, unknown>)) {
    if (typeof valore === 'string') out[k] = valore
  }
  return out
}

const righeDi = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.map((r) => (r && typeof r === 'object' ? (r as Record<string, unknown>) : {}))
    : []

/** Il campo si mostra? `mostraSe` guarda la risposta di un ALTRO campo. */
function visibile(campo: CampoPrestampato, risposte: Record<string, unknown>): boolean {
  if (!campo.mostraSe) return true
  const valore = risposte[campo.mostraSe.campo]
  return campo.mostraSe.valori.some((atteso) => atteso === valore)
}

/**
 * Il campo è rimasto vuoto?
 *
 * Serve a fermare un invio che il server rifiuterebbe di sicuro — e su un documento
 * protocollato quel rifiuto costerebbe due composizioni jsPDF per niente. Non sostituisce
 * lo schema `zod` del modello, che resta l'unico posto in cui il rifiuto è vero: qui si
 * guarda solo l'assenza, mai la forma.
 */
function vuoto(campo: CampoPrestampato, valore: unknown): boolean {
  if (campo.tipo === 'conferma') return valore !== true
  if (campo.tipo === 'siNo') return typeof valore !== 'boolean'
  if (campo.tipo === 'sceltaMultipla' || campo.multipla) return listaDi(valore).length === 0
  if (campo.tipo === 'griglia') {
    const scelte = mappaDi(valore)
    return (campo.opzioni ?? []).some((riga) => !scelte[riga.valore])
  }
  if (campo.tipo === 'righe') return righeDi(valore).length === 0
  return testoDi(valore).trim() === ''
}

/**
 * Le risposte da spedire: solo i campi VISIBILI, e senza i vuoti.
 *
 * I vuoti si tolgono invece di mandarli come stringa vuota perché diversi schemi dei
 * modelli sono `optional()` su un numero o su una data: `''` non è «non risposto», è un
 * valore che quegli schemi rifiutano. Un campo nascosto da `mostraSe` non viaggia affatto —
 * il suo valore è quello di una domanda che non è stata fatta.
 */
function daSpedire(
  campi: readonly CampoPrestampato[],
  risposte: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const campo of campi) {
    if (!visibile(campo, risposte)) continue
    const valore = risposte[campo.nome]
    if (valore === undefined || valore === null) continue
    if (typeof valore === 'string' && valore.trim() === '') continue
    if (Array.isArray(valore) && valore.length === 0) continue
    if (campo.tipo === 'griglia' && Object.keys(mappaDi(valore)).length === 0) continue
    if (campo.tipo === 'numero') {
      const n = Number(testoDi(valore))
      // Il numero si manda come numero quando lo è; se non lo è si manda com'è, così a
      // dirlo è il messaggio dello schema e non un `NaN` silenzioso.
      out[campo.nome] = Number.isFinite(n) ? n : valore
      continue
    }
    out[campo.nome] = valore
  }
  return out
}

/** Il nome del file dall'header del server, o un ripiego che dice almeno di che foglio è. */
function nomeFileDaHeader(intestazione: string | null, slug: string): string {
  const trovato = /filename="?([^";]+)"?/i.exec(intestazione ?? '')?.[1]?.trim()
  return trovato && trovato.length > 0 ? trovato : `${slug}.pdf`
}

/** Il PDF appena generato scende sul disco: stessa forma dell'export dell'anagrafica. */
function scaricaFile(url: string, nomeFile: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = nomeFile
  a.click()
}

// ─── L'esito di una generazione ─────────────────────────────────────────────────

interface Esito {
  /** URL del blob: resta viva finché non se ne genera un'altra (vedi `genera`). */
  url: string
  nomeFile: string
  /** `X-Prestampato-Protocollo`, quando il foglio esce dalla scuola. */
  protocollo: string | null
  /** `X-Prestampato-Archiviato`: `archiviato` · `fallita` · `non-previsto`. */
  archiviato: string | null
  /** `X-Prestampato-Incompleto`: una parte del modello non è entrata nel PDF. */
  incompleto: boolean
}

// ─── Il pannello ────────────────────────────────────────────────────────────────

export function PrestampatiSegreteria() {
  const t = useTranslations('prestampatiSegreteria')
  const { dataBreve } = useDateFormat()
  /**
   * TRE STATI DELLE SEDI, NON DUE — e qui vale il doppio, perché la sede è il PRIMO passo e
   * senza di lei la generazione risponde 400.
   *
   * `sedi = []` da solo dice due cose diverse: «non ne hai» e «non ho saputo quali hai». Il
   * contesto le separa da quando è stato misurato il danno (`sede-context.tsx`): con la
   * route non-ok l'utente riceveva un'istruzione impossibile — «scegline una dal menu in
   * alto», mentre `SedeSelector` con l'elenco vuoto non si monta affatto — su almeno sette
   * pagine e senza una riga di log.
   *
   * Questa linguetta sta di proposito PRIMA della guardia di sede della pagina
   * (`admin/modulistica/page.tsx`), perché la sede se la sceglie qui dentro: quindi la rete
   * di sicurezza di `SedeNotice` non c'è, e il caricamento e il guasto li deve dire questo
   * pannello. Buttare via `errore`, `loading` e `ricarica` significherebbe stampare «scegli
   * la sede» sopra una tendina che non esiste.
   */
  const {
    sedi,
    effettive,
    sedeCorrente,
    errore: sediInErrore,
    loading: sediInCaricamento,
    ricarica: ricaricaSedi,
  } = useSediAttive()

  const [sedeScelta, setSedeScelta] = useState('')
  const [classeId, setClasseId] = useState('')
  const [alunnoId, setAlunnoId] = useState('')
  const [ricerca, setRicerca] = useState('')
  const [slug, setSlug] = useState('')
  /**
   * La modalità scelta, con lo SLUG per cui è stata scelta.
   *
   * La chiave rende superfluo un `reset`: cambiando modello la modalità di prima non
   * combacia più e la schermata torna da sola a «scegli come stai lavorando», invece di
   * portarsi dietro un «modulo tornato su carta» su un altro modulo. È lo stesso motivo per
   * cui gli elenchi hanno la loro chiave, e la stessa ragione per cui non si scrive uno
   * stato dentro un effetto (`react-hooks/set-state-in-effect`).
   */
  const [scelta, setScelta] = useState<{ chiave: string; modalita: Modalita | ''; consegnatoIl: string }>({
    chiave: '',
    modalita: '',
    consegnatoIl: '',
  })

  const [modelli, setModelli] = useState<Elenco<VoceModello>>(VUOTO)
  const [classi, setClassi] = useState<Elenco<Classe>>(VUOTO)
  const [alunni, setAlunni] = useState<Elenco<Alunno>>(VUOTO)
  const [scheda, setScheda] = useState<{ chiave: string; dati: SchedaModello | null; errore: boolean }>({
    chiave: '',
    dati: null,
    errore: false,
  })

  const [risposte, setRisposte] = useState<{ chiave: string; valori: Record<string, unknown> }>({
    chiave: '',
    valori: {},
  })
  const [erroriCampo, setErroriCampo] = useState<Record<string, string>>({})
  const [errore, setErrore] = useState<string | null>(null)
  const [inGenerazione, setInGenerazione] = useState(false)
  const [esito, setEsito] = useState<Esito | null>(null)

  /** L'ultimo blob generato: si revoca quando ne arriva un altro e quando si smonta. */
  const urlCorrente = useRef<string | null>(null)
  /** Il ricovero del fuoco: la conferma smonta il comando che l'ha lanciata (WCAG 2.4.3). */
  const ricoveroEsito = useRef<HTMLDivElement | null>(null)

  // ── Le sedi fra cui si sceglie ─────────────────────────────────────────────
  // Sono le sedi ATTIVE, non tutte quelle accessibili: le due letture della route
  // (`resolveScuoleAttive`) rispettano la selezione del cookie, e offrire qui una sede
  // che quella selezione esclude vorrebbe dire un 403 dopo il clic.
  const sediSelezionabili = useMemo(
    () => sedi.filter((s) => effettive.includes(s.id)),
    [sedi, effettive],
  )
  // Chi ha UNA sola sede attiva non la sceglie: `sedeCorrente` è già quella, e chiederla
  // sarebbe una tendina con una voce sola. Chi ne ha più d'una la dichiara, e finché non lo
  // fa la sede resta vuota — che è ciò che il passo 1 dice a parole.
  const sede =
    sedeScelta && sediSelezionabili.some((s) => s.id === sedeScelta) ? sedeScelta : sedeCorrente ?? ''
  const nomeSede = sediSelezionabili.find((s) => s.id === sede)?.nome ?? null

  // ── Gli elenchi, validi solo per la chiave con cui sono stati letti ────────
  const classiPronte = classi.chiave === sede
  const classe = classiPronte ? classi.righe.find((c) => c.id === classeId) ?? null : null
  const chiaveAlunni = classe ? `${sede}|${classe.name ?? ''}` : ''
  const alunniPronti = chiaveAlunni !== '' && alunni.chiave === chiaveAlunni
  const alunno = alunniPronti ? alunni.righe.find((a) => a.id === alunnoId) ?? null : null

  const modello = modelli.righe.find((m) => m.slug === slug) ?? null
  const soggetto = modello?.soggetto ?? 'alunno'
  const soggettoId =
    soggetto === 'sezione' ? classe?.id ?? '' : soggetto === 'alunno' ? alunno?.id ?? '' : ''
  // La scheda si chiede solo per i modelli che il banco può davvero generare: su quelli
  // spenti il motivo lo dà già l'elenco, e leggere l'anagrafica di un bambino per un foglio
  // che non può uscire sarebbe leggerla per niente.
  const chiaveScheda =
    modello && modello.generabile && soggettoId ? `${modello.slug}|${soggettoId}` : ''
  const schedaPronta = chiaveScheda !== '' && scheda.chiave === chiaveScheda
  const dati = schedaPronta ? scheda.dati : null

  // ── La modalità, per i sei moduli di famiglia ──────────────────────────────
  //
  // L'elenco dei modi lo dichiara il SERVER (`voceElenco`), e il pannello non lo deduce:
  // dedurlo da `firma === 'otp_genitore'` sarebbe una seconda copia della regola di
  // `modalitaDelModello`, e due copie divergono alla prima modifica.
  const modiDisponibili = useMemo(
    () => (modello?.modalita ?? []).filter(modalitaValida),
    [modello?.modalita],
  )
  const modalita = scelta.chiave === slug && scelta.modalita ? scelta.modalita : ''
  const consegnatoIl = scelta.chiave === slug ? scelta.consegnatoIl : ''
  /** Serve una scelta e non è ancora stata fatta: la scheda non si compila. */
  const modalitaDaScegliere = modiDisponibili.length > 0 && !modalita
  /**
   * Le risposte si chiedono SOLO quando la segreteria sta trascrivendo un modulo tornato
   * compilato su carta. Sugli altri due fogli nessuno ha risposto niente — la copia firmata
   * esiste già, la copia vuota la compila la famiglia a penna — e mostrare otto campi
   * obbligatori davanti a un modulo che uscirà comunque vuoto è lavoro chiesto per niente.
   */
  const chiedeRisposte = modiDisponibili.length === 0 || modalita === 'su_carta'

  const campi = useMemo(() => dati?.modello.campi ?? [], [dati])
  const valori = risposte.chiave === chiaveScheda ? risposte.valori : {}
  const motivoScheda = dati?.motivo ?? null
  const generabile = schedaPronta && !!dati?.prefill && !motivoScheda && !modalitaDaScegliere

  // ── Le quattro letture ─────────────────────────────────────────────────────
  //
  // Hanno tutte la stessa forma, ed è quella di `sede-context.tsx`, che la documenta per
  // esteso: **una sola scrittura di stato, nel `finally`, con il GUASTO come valore di
  // partenza**. Non è un vezzo, tiene insieme due vincoli che si scontrano —
  // `react-hooks/set-state-in-effect` (severità `error`) non ammette un `setState`
  // raggiungibile in modo sincrono dall'effetto, e un guasto non può passare per uno stato
  // normale (AGENTS.md regola 6). Il `finally` gira comunque, anche se qualcosa lanciasse:
  // l'elenco non resta mai «in caricamento» per sempre.
  //
  // Il GETTONE è l'altra metà: la risposta di una richiesta SUPERATA non si scrive. Senza,
  // chi cambia classe due volte in fretta può vedere la risposta della prima arrivare per
  // ultima e riportare a schermo l'elenco di prima — o, con la chiave che non combacia più,
  // lasciare la schermata a «caricamento» all'infinito.
  const gettoni = useRef({ modelli: 0, classi: 0, alunni: 0, scheda: 0 })

  const caricaModelli = useCallback(async () => {
    const mio = ++gettoni.current.modelli
    let esito: Elenco<VoceModello> = { chiave: CHIAVE_MODELLI, righe: [], errore: true }
    try {
      const r = await chiedi<{ data?: { modelli?: VoceModello[] } }>('/api/prestampati')
      const righe = r.corpo?.data?.modelli
      if (!r.ok || !Array.isArray(righe)) {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `prestampati-modelli-non-letti: ${r.guasto ?? 'risposta inattesa'}`,
          route: ROTTA,
          stato: r.stato,
        })
        return
      }
      esito = { chiave: CHIAVE_MODELLI, righe, errore: false }
    } finally {
      if (mio === gettoni.current.modelli) setModelli(esito)
    }
  }, [])

  const caricaClassi = useCallback(async (chiave: string) => {
    const mio = ++gettoni.current.classi
    let esito: Elenco<Classe> = { chiave, righe: [], errore: true }
    try {
      const r = await chiedi<Classe[]>(
        `/api/admin/sections?scuola_id=${encodeURIComponent(chiave)}`,
      )
      if (!r.ok || !Array.isArray(r.corpo)) {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `prestampati-classi-non-lette: ${r.guasto ?? 'risposta inattesa'}`,
          route: ROTTA,
          stato: r.stato,
        })
        return
      }
      esito = { chiave, righe: r.corpo, errore: false }
    } finally {
      if (mio === gettoni.current.classi) setClassi(esito)
    }
  }, [])

  const caricaAlunni = useCallback(async (chiave: string, sedeId: string, classeNome: string) => {
    const mio = ++gettoni.current.alunni
    let esito: Elenco<Alunno> = { chiave, righe: [], errore: true }
    try {
      const p = new URLSearchParams({ scuola_id: sedeId, classe_sezione: classeNome })
      const r = await chiedi<Alunno[]>(`/api/admin/students?${p.toString()}`)
      if (!r.ok || !Array.isArray(r.corpo)) {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `prestampati-alunni-non-letti: ${r.guasto ?? 'risposta inattesa'}`,
          route: ROTTA,
          stato: r.stato,
        })
        return
      }
      // Il confine è quello del server: `caricaPrefillAlunno` rifiuta con 409 chi non è più
      // fra gli iscritti, e `eAncoraIscritto` è la stessa funzione che quel rifiuto usa —
      // «sospeso» compreso, che è un bambino che frequenta.
      esito = { chiave, righe: r.corpo.filter((a) => eAncoraIscritto(a.stato)), errore: false }
    } finally {
      if (mio === gettoni.current.alunni) setAlunni(esito)
    }
  }, [])

  const caricaScheda = useCallback(
    async (chiave: string, modelloSlug: string, tipo: SoggettoPrestampato, id: string) => {
      const mio = ++gettoni.current.scheda
      let esito = { chiave, dati: null as SchedaModello | null, errore: true }
      let messaggio: string | null = null
      try {
        const p = new URLSearchParams({ modello: modelloSlug })
        p.set(tipo === 'sezione' ? 'sezioneId' : 'alunnoId', id)
        const r = await chiedi<{ data?: SchedaModello }>(`/api/prestampati?${p.toString()}`)
        if (!r.ok || !r.corpo?.data?.modello) {
          // Il testo lo dà il CATALOGO del codice, non la prosa del server: quella nasce
          // dove il locale non esiste ed è italiana per costruzione.
          messaggio = messaggioDaCorpo(r.corpo, t('erroreElenco'))
          logClient({
            livello: 'error',
            evento: 'fetch',
            messaggio: `prestampati-scheda-non-letta: ${r.guasto ?? 'risposta inattesa'}`,
            route: ROTTA,
            stato: r.stato,
          })
          return
        }
        esito = { chiave, dati: r.corpo.data, errore: false }
      } finally {
        if (mio === gettoni.current.scheda) {
          setScheda(esito)
          setErrore(messaggio)
        }
      }
    },
    [t],
  )

  useEffect(() => {
    void caricaModelli()
  }, [caricaModelli])

  useEffect(() => {
    if (!sede) return
    void caricaClassi(sede)
  }, [sede, caricaClassi])

  useEffect(() => {
    if (!chiaveAlunni || !classe?.name) return
    void caricaAlunni(chiaveAlunni, sede, classe.name)
  }, [chiaveAlunni, classe?.name, sede, caricaAlunni])

  useEffect(() => {
    if (!chiaveScheda || !modello) return
    void caricaScheda(chiaveScheda, modello.slug, modello.soggetto, soggettoId)
  }, [chiaveScheda, modello, soggettoId, caricaScheda])

  // Il fuoco sulla conferma: la generazione SMONTA il comando che l'ha lanciata, e senza
  // questo il fuoco cadrebbe su `<body>` — cioè all'inizio della pagina.
  useEffect(() => {
    if (esito) ricoveroEsito.current?.focus()
  }, [esito])

  // L'ultimo blob si revoca allo smontaggio: quelli precedenti li revoca `genera`.
  useEffect(
    () => () => {
      if (urlCorrente.current) URL.revokeObjectURL(urlCorrente.current)
    },
    [],
  )

  // ── I gesti ────────────────────────────────────────────────────────────────

  /**
   * «QUESTA PRATICA NON VALE PIÙ»: lo dicono tutti e quattro i `scegli*`, ed è per questo che
   * porta via anche gli errori di CAMPO.
   *
   * Le risposte si azzerano da sole — la chiave di `risposte` non combacia più — ma
   * `erroriCampo` è una mappa a parte e nessuna chiave la governa: senza questa riga, i
   * «Campo obbligatorio» rossi della pratica di un bambino restavano accesi sul modulo bianco
   * del bambino dopo, su campi che nessuno aveva ancora toccato.
   */
  const dimenticaEsito = useCallback(() => {
    setEsito(null)
    setErrore(null)
    setErroriCampo({})
  }, [])

  const scegliSede = (id: string) => {
    setSedeScelta(id)
    setClasseId('')
    setAlunnoId('')
    setRicerca('')
    dimenticaEsito()
  }

  const scegliClasse = (id: string) => {
    setClasseId(id)
    setAlunnoId('')
    setRicerca('')
    dimenticaEsito()
  }

  const scegliAlunno = (id: string) => {
    setAlunnoId(id)
    dimenticaEsito()
  }

  const scegliModello = (nuovo: string) => {
    setSlug(nuovo)
    dimenticaEsito()
  }

  const scegliModalita = (nuova: Modalita) => {
    setScelta({ chiave: slug, modalita: nuova, consegnatoIl: '' })
    dimenticaEsito()
  }

  const scegliConsegnatoIl = (iso: string) => {
    setScelta((prec) => ({ ...prec, chiave: slug, consegnatoIl: iso }))
    setErroriCampo((prec) => {
      if (!prec.consegnatoIl) return prec
      const resto = { ...prec }
      delete resto.consegnatoIl
      return resto
    })
  }

  const rispondi = (nome: string, valore: unknown) => {
    setRisposte((prec) => ({
      chiave: chiaveScheda,
      valori: { ...(prec.chiave === chiaveScheda ? prec.valori : {}), [nome]: valore },
    }))
    // L'errore di un campo se ne va appena qualcuno lo tocca: lasciarlo acceso mentre si
    // digita la correzione è il modo di far credere che la correzione non sia servita.
    setErroriCampo((prec) => {
      if (!prec[nome]) return prec
      const resto = { ...prec }
      delete resto[nome]
      return resto
    })
  }

  /**
   * La generazione: un POST, un PDF, e tre header che raccontano com'è andata.
   *
   * I campi obbligatori si controllano PRIMA di partire. Non è una seconda validazione —
   * la forma la giudica lo schema del modello, sul server — ma il modo di non far
   * comporre due volte un PDF per un campo lasciato in bianco: sui fogli che escono dalla
   * scuola quella prova a vuoto è ciò che impedisce di bruciare un numero di protocollo.
   */
  const genera = async () => {
    if (!modello || !sede || !soggettoId) return
    if (modalitaDaScegliere) return
    const mancanti: Record<string, string> = {}
    // I campi si controllano SOLO quando vengono chiesti: su una copia vuota nessuno ha
    // risposto niente per costruzione, e pretendere qui una risposta obbligatoria
    // impedirebbe di stampare proprio il foglio che deve uscire in bianco.
    if (chiedeRisposte) {
      for (const campo of campi) {
        if (!campo.obbligatorio || !visibile(campo, valori)) continue
        if (vuoto(campo, valori[campo.nome])) mancanti[campo.nome] = t('campoObbligatorio')
      }
    }
    // La data di consegna è il dato che la dicitura STAMPA sul foglio: senza, quella frase
    // direbbe che un originale firmato esiste senza dire da quando.
    if (modalita === 'su_carta' && !consegnatoIl) {
      mancanti.consegnatoIl = t('campoObbligatorio')
    }
    if (Object.keys(mancanti).length > 0) {
      setErroriCampo(mancanti)
      setErrore(t('campoNonValido'))
      return
    }

    setErroriCampo({})
    setErrore(null)
    setInGenerazione(true)
    try {
      const res = await fetch('/api/prestampati/genera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modello: modello.slug,
          scuolaId: sede,
          ...(modello.soggetto === 'sezione' ? { sezioneId: soggettoId } : { alunnoId: soggettoId }),
          // Le risposte si mandano solo dove sono state chieste: mandarle su una copia vuota
          // significherebbe mandare quello che è rimasto scritto prima di cambiare modalità.
          risposte: chiedeRisposte ? daSpedire(campi, valori) : {},
          ...(modalita ? { modalita } : {}),
          ...(modalita === 'su_carta' && consegnatoIl ? { consegnatoIl } : {}),
        }),
      })

      if (!res.ok) {
        // Il corpo si legge UNA volta sola e serve a due cose: il messaggio e gli errori di
        // campo. `messaggioDaCorpo` traduce il `codice` col catalogo; il 400 di validazione
        // non ne ha uno, e la sua prosa («Dati non validi») è italiana per costruzione —
        // quindi lì vince la frase tradotta di questo pannello.
        const corpo = (await res.json().catch(() => null)) as
          | { details?: { path?: string; message?: string }[]; motivo?: string }
          | null
        const dettagli = Array.isArray(corpo?.details) ? corpo.details : []
        if (dettagli.length > 0) {
          const perCampo: Record<string, string> = {}
          for (const d of dettagli) {
            // `path` può essere annidato (`livelli.CODICE`): l'errore si mostra sul campo
            // di primo livello, che è quello che l'operatore vede.
            const campo = String(d.path ?? '').split('.')[0]
            if (campo) perCampo[campo] = String(d.message ?? t('campoNonValido'))
          }
          setErroriCampo(perCampo)
        }
        const motivo = typeof corpo?.motivo === 'string' ? CHIAVE_MOTIVO[corpo.motivo] : undefined
        setErrore(
          motivo
            ? t(motivo)
            : dettagli.length > 0
              ? t('campoNonValido')
              : messaggioDaCorpo(corpo, t('erroreGenerazione')),
        )
        // Nel messaggio va lo SLUG e nient'altro: è un enumerato — non un nome, non un
        // codice fiscale — ed è l'unica cosa che dice QUALE foglio non è uscito.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `prestampato-non-generato: ${modello.slug}`,
          route: ROTTA,
          stato: res.status,
        })
        return
      }

      const blob = await res.blob()
      if (urlCorrente.current) URL.revokeObjectURL(urlCorrente.current)
      const url = URL.createObjectURL(blob)
      urlCorrente.current = url
      const nomeFile = nomeFileDaHeader(res.headers.get('Content-Disposition'), modello.slug)
      setEsito({
        url,
        nomeFile,
        protocollo: res.headers.get('X-Prestampato-Protocollo'),
        archiviato: res.headers.get('X-Prestampato-Archiviato'),
        incompleto: res.headers.get('X-Prestampato-Incompleto') !== null,
      })
      scaricaFile(url, nomeFile)
    } catch (e) {
      // La rete è caduta davvero: il server non ha risposto, e non si sa se il documento
      // sia stato generato. Un `catch` che non logga sarebbe un bug.
      setErrore(t('erroreGenerazione'))
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `prestampato-generazione-fallita: ${modello.slug} · ${nomeErrore(e)}`,
        route: ROTTA,
      })
    } finally {
      setInGenerazione(false)
    }
  }

  // ── Ciò che si disegna ─────────────────────────────────────────────────────

  const nomeModello = (v: VoceModello) =>
    slugPrestampato(v.slug) ? t(chiaveEtichetta(v.slug)) : v.etichetta

  const testoMotivo = (motivo?: string | null, spiegazione?: string | null) => {
    const chiave = motivo ? CHIAVE_MOTIVO[motivo] : undefined
    return chiave ? t(chiave) : spiegazione ?? null
  }

  const generabili = modelli.righe.filter((m) => m.generabile)
  const spenti = modelli.righe.filter((m) => !m.generabile)

  const alunniVisibili = alunniPronti
    ? alunni.righe.filter((a) =>
        `${a.cognome ?? ''} ${a.nome ?? ''}`.toLowerCase().includes(ricerca.trim().toLowerCase()),
      )
    : []

  const serveAlunno = !modello || modello.soggetto === 'alunno'
  const serveClasse = !modello || modello.soggetto !== 'dipendente'

  return (
    <div className="space-y-5">
      <SectionTitle icon={FileText} title={t('titolo')} sub={t('sottotitolo')} />

      {/* ── 1. Di chi parla il documento ───────────────────────────────── */}
      <section className={CARD} aria-labelledby="prest-soggetto">
        <h3
          id="prest-soggetto"
          className="mb-3 font-barlow text-[15px] font-bold uppercase tracking-[0.04em] text-kidville-green"
        >
          {t('passoSoggetto')}
        </h3>

        {/* Le sedi PRIMA di tutto, e coi loro tre stati: «non so quali sedi hai» non è
            «scegline una», ed è l'unico dei tre che si ripara con un «Riprova». */}
        {sediInCaricamento ? (
          <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
        ) : sediInErrore ? (
          <Avviso
            tono="error"
            testo={t('erroreSedi')}
            azione={ricaricaSedi}
            etichettaAzione={t('riprova')}
          />
        ) : (
          <>
            {sediSelezionabili.length > 1 && (
              <div className="mb-4">
                <label className={ETICHETTA} htmlFor="prest-sede">
                  {t('scegliSede')}
                </label>
                <select
                  id="prest-sede"
                  className={CAMPO}
                  value={sede}
                  onChange={(e) => scegliSede(e.target.value)}
                >
                  <option value="">{t('scegliSedeSegnaposto')}</option>
                  {sediSelezionabili.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.nome}
                    </option>
                  ))}
                </select>
                <p className={AIUTO}>{t('scegliSedeAiuto')}</p>
              </div>
            )}

            {!sede ? (
              <p className="font-maven text-sm text-kidville-sub">{t('sedeDaScegliere')}</p>
            ) : !serveClasse ? (
              <div>
                <p className={ETICHETTA}>{t('scegliDipendente')}</p>
                <p className="font-maven text-sm text-kidville-sub">{t('dipendenteDaAnagrafica')}</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className={ETICHETTA} htmlFor="prest-classe">
                    {t('scegliClasse')}
                  </label>
                  {!classiPronte ? (
                    <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
                  ) : classi.errore ? (
                    <Avviso
                      tono="error"
                      testo={t('erroreElenco')}
                      azione={() => void caricaClassi(sede)}
                      etichettaAzione={t('riprova')}
                    />
                  ) : classi.righe.length === 0 ? (
                    <p className="font-maven text-sm text-kidville-sub">{t('vuotoClassi')}</p>
                  ) : (
                    <select
                      id="prest-classe"
                      className={CAMPO}
                      value={classeId}
                      onChange={(e) => scegliClasse(e.target.value)}
                    >
                      <option value="">{t('scegliClasseSegnaposto')}</option>
                      {classi.righe.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name ?? c.id}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {classe && serveAlunno && (
                  <div>
                    <span className={ETICHETTA}>{t('scegliAlunno')}</span>
                    {!alunniPronti ? (
                      <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
                    ) : alunni.errore ? (
                      <Avviso
                        tono="error"
                        testo={t('erroreElenco')}
                        azione={() => void caricaAlunni(chiaveAlunni, sede, classe.name ?? '')}
                        etichettaAzione={t('riprova')}
                      />
                    ) : alunno ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-sm font-semibold text-kidville-white">
                          {[alunno.cognome, alunno.nome].filter(Boolean).join(' ') || alunno.id}
                        </span>
                        <button
                          type="button"
                          className={BTN_LEGGERO}
                          onClick={() => scegliAlunno('')}
                        >
                          {t('cambiaAlunno')}
                        </button>
                      </div>
                    ) : alunni.righe.length === 0 ? (
                      <p className="font-maven text-sm text-kidville-sub">{t('vuotoAlunni')}</p>
                    ) : (
                      <>
                        <div className="relative">
                          <Search
                            size={16}
                            aria-hidden="true"
                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub"
                          />
                          <input
                            type="search"
                            value={ricerca}
                            onChange={(e) => setRicerca(e.target.value)}
                            placeholder={t('cercaAlunno')}
                            aria-label={t('cercaAlunno')}
                            className={`${CAMPO} pl-9`}
                          />
                        </div>
                        <p className={AIUTO}>{t('scegliAlunnoSegnaposto')}</p>
                        {alunniVisibili.length === 0 ? (
                          <p className="mt-2 font-maven text-sm text-kidville-sub">
                            {t('nessunRisultato')}
                          </p>
                        ) : (
                          <ul className="mt-2 max-h-64 divide-y divide-kidville-line overflow-y-auto rounded-xl border border-kidville-line">
                            {alunniVisibili.map((a) => (
                              <li key={a.id}>
                                <button
                                  type="button"
                                  onClick={() => scegliAlunno(a.id)}
                                  className="w-full px-3 py-2.5 text-left font-maven text-sm text-kidville-ink transition-colors hover:bg-kidville-cream"
                                >
                                  {[a.cognome, a.nome].filter(Boolean).join(' ') || a.id}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ── 2. Il modello ──────────────────────────────────────────────── */}
      <section className={CARD} aria-labelledby="prest-modulo">
        <h3
          id="prest-modulo"
          className="font-barlow text-[15px] font-bold uppercase tracking-[0.04em] text-kidville-green"
        >
          {t('scegliModulo')}
        </h3>
        {modelli.chiave !== CHIAVE_MODELLI ? (
          <p className="mt-3 font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
        ) : modelli.errore ? (
          <Avviso
            tono="error"
            testo={t('erroreElenco')}
            azione={() => void caricaModelli()}
            etichettaAzione={t('riprova')}
          />
        ) : modelli.righe.length === 0 ? (
          <p className="mt-3 font-maven text-sm text-kidville-sub">{t('vuotoModuli')}</p>
        ) : (
          <>
            <p className="mt-1 font-maven text-[12.5px] text-kidville-sub">
              {t('moduliDisponibili', { n: generabili.length })}
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {generabili.map((m) => {
                const scelto = m.slug === slug
                return (
                  <li key={m.slug}>
                    <button
                      type="button"
                      aria-pressed={scelto}
                      onClick={() => scegliModello(m.slug)}
                      className={`w-full rounded-xl border-2 p-3 text-left transition-colors ${
                        scelto
                          ? 'border-kidville-green bg-kidville-green-soft'
                          : 'border-kidville-line hover:border-kidville-green'
                      }`}
                    >
                      <span className="block font-barlow text-sm font-bold uppercase text-kidville-green">
                        {nomeModello(m)}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-pill px-2 py-0.5 font-maven text-[11px] font-bold ${TONE.neutral.chipBg} ${TONE.neutral.text}`}
                        >
                          {t(CHIAVE_SOGGETTO[m.soggetto])}
                        </span>
                        {m.protocollo === 'uscita' && (
                          <span
                            className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 font-maven text-[11px] font-bold ${TONE.info.chipBg} ${TONE.info.text}`}
                          >
                            <Stamp size={11} aria-hidden="true" /> {t('protocolloTitolo')}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {!slug && (
              <p className="mt-3 font-maven text-sm text-kidville-sub">{t('scegliModuloSegnaposto')}</p>
            )}

            {spenti.length > 0 && (
              <div className="mt-5 border-t border-kidville-line pt-4">
                <h4 className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                  {t('moduliNonGenerabili')}
                </h4>
                <ul className="mt-2 space-y-2">
                  {spenti.map((m) => (
                    <li key={m.slug} className="font-maven text-[12.5px] text-kidville-sub">
                      <span className="font-semibold text-kidville-ink">{nomeModello(m)}</span>
                      {' — '}
                      {testoMotivo(m.motivo) ?? t('erroreModuloSconosciuto')}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── 3. Il solo delta ───────────────────────────────────────────── */}
      {modello && modello.generabile && (
        <section className={CARD} aria-labelledby="prest-campi">
          <h3
            id="prest-campi"
            className="font-barlow text-[15px] font-bold uppercase tracking-[0.04em] text-kidville-green"
          >
            {t('campiTitolo')}
          </h3>

          {!soggettoId ? (
            <p className="mt-3 font-maven text-sm text-kidville-sub">
              {modello.soggetto === 'sezione'
                ? t('scegliClasseSegnaposto')
                : modello.soggetto === 'dipendente'
                  ? t('scegliDipendenteSegnaposto')
                  : t('scegliAlunnoSegnaposto')}
            </p>
          ) : !schedaPronta ? (
            // L'ordine è quello che conta: `schedaPronta` dice che la risposta arrivata è
            // quella di QUESTA scheda, e solo dopo si può guardare se è andata male.
            // Guardare `scheda.errore` prima mostrerebbe il rosso della scheda precedente
            // mentre la nuova è ancora in volo.
            <p className="mt-3 font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
          ) : scheda.errore ? (
            <Avviso
              tono="error"
              testo={errore ?? t('erroreElenco')}
              azione={() =>
                void caricaScheda(chiaveScheda, modello.slug, modello.soggetto, soggettoId)
              }
              etichettaAzione={t('riprova')}
            />
          ) : motivoScheda ? (
            // IL MOTIVO AL POSTO DEL MODULO, e la scelta va detta perché diverge da ciò che
            // la route immagina («il form si compila, il pulsante resta spento»). Qui il
            // motivo che si scopre solo adesso è uno solo — il nome del legale
            // rappresentante mancante nella configurazione della sede — e al 2026-08-14 in
            // produzione scatta su TUTTE le sedi: far compilare otto competenze per un
            // foglio che non può uscire sarebbe lavoro buttato. Resta l'unica cosa
            // eseguibile, cioè dove si ripara.
            <Avviso tono="warn" testo={testoMotivo(motivoScheda, dati?.spiegazione) ?? t('erroreGenerazione')} />
          ) : (
            <>
              {/* Quello che l'app ha già: in sola lettura, così si controlla senza riscriverlo. */}
              <div className="mt-3 rounded-xl border border-kidville-line bg-kidville-cream p-3">
                <h4 className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                  {t('giaInArchivio')}
                </h4>
                <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  {dati?.prefill?.soggetto === 'alunno' ? (
                    <>
                      <Dato etichetta={t('soggettoAlunno')} valore={nomeDaPrefill(dati.prefill)} vuotoTesto={t('datoAssente')} />
                      <Dato
                        etichetta={t('datoNascita')}
                        valore={
                          dati.prefill.dati?.alunno?.dataNascita
                            ? dataBreve(dati.prefill.dati.alunno.dataNascita)
                            : null
                        }
                        vuotoTesto={t('datoAssente')}
                      />
                      <Dato
                        etichetta={t('datoCodiceFiscale')}
                        valore={dati.prefill.dati?.alunno?.codiceFiscale ?? null}
                        vuotoTesto={t('datoAssente')}
                      />
                      <Dato
                        etichetta={t('datoSezione')}
                        valore={dati.prefill.dati?.alunno?.sezione ?? null}
                        vuotoTesto={t('datoAssente')}
                      />
                      <Dato etichetta={t('datoSede')} valore={nomeSede} vuotoTesto={t('datoAssente')} />
                      <Dato
                        etichetta={t('datoAnnoScolastico')}
                        valore={dati.prefill.dati?.annoScolastico ?? null}
                        vuotoTesto={t('datoAssente')}
                      />
                    </>
                  ) : dati?.prefill?.soggetto === 'sezione' ? (
                    <>
                      <Dato etichetta={t('datoSezione')} valore={dati.prefill.nome} vuotoTesto={t('datoAssente')} />
                      <Dato etichetta={t('datoSede')} valore={nomeSede} vuotoTesto={t('datoAssente')} />
                    </>
                  ) : null}
                </dl>
                {/* DUE NUMERI E NON UNO, ed è la differenza fra ciò che si legge e ciò che
                    si stampa: la stampa esclude i sospesi salvo richiesta esplicita, e un
                    conteggio solo annuncerebbe venticinque bambini su un foglio che ne
                    stampa ventitré. */}
                {dati?.prefill?.soggetto === 'sezione' && (
                  <p className="mt-1 font-maven text-[12.5px] text-kidville-ink">
                    {t('sezioneIscritti', { n: dati.prefill.alunni?.iscritti ?? 0 })}
                    {' · '}
                    {t('sezioneSospesi', { n: dati.prefill.alunni?.sospesi ?? 0 })}
                  </p>
                )}
                <p className={AIUTO}>{t('campiSottotitolo')}</p>
              </div>

              {/* ── LE TRE MODALITÀ, prima di ogni campo ─────────────────────
                  Viene prima perché DECIDE cosa viene dopo: la copia firmata non chiede
                  niente, la copia vuota nemmeno, e solo la trascrizione di un modulo
                  tornato di carta apre il form. Chiedere i campi e poi la modalità
                  significherebbe far compilare otto risposte per poi buttarle via. */}
              {modiDisponibili.length > 0 && (
                <fieldset className="mt-4 rounded-xl border border-kidville-line p-3">
                  <legend className="px-1 font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                    {t('modalitaTitolo')}
                  </legend>
                  <p className={AIUTO}>{t('modalitaSottotitolo')}</p>
                  <div className="mt-2 space-y-2">
                    {modiDisponibili.map((m) => (
                      <label key={m} className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="radio"
                          name="prest-modalita"
                          value={m}
                          checked={modalita === m}
                          onChange={() => scegliModalita(m)}
                          className={`mt-0.5 h-4 w-4 shrink-0 accent-kidville-green ${FUOCO_ESITO}`}
                        />
                        <span>
                          <span className="block font-maven text-sm font-semibold text-kidville-ink">
                            {t(CHIAVE_MODALITA[m].titolo)}
                          </span>
                          <span className="block font-maven text-[12.5px] text-kidville-sub">
                            {t(CHIAVE_MODALITA[m].aiuto)}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>

                  {modalita === 'su_carta' && (
                    <div className="mt-3">
                      <label className={ETICHETTA} htmlFor="prest-consegnato-il">
                        {t('modalitaConsegnatoIl')}
                      </label>
                      <DateField
                        id="prest-consegnato-il"
                        value={consegnatoIl}
                        onChange={scegliConsegnatoIl}
                        className={CAMPO}
                        aria-describedby="prest-consegnato-il-aiuto"
                      />
                      <p className={AIUTO} id="prest-consegnato-il-aiuto">
                        {t('modalitaConsegnatoIlAiuto')}
                      </p>
                      {erroriCampo.consegnatoIl && (
                        <p role="alert" className={`${AIUTO} font-semibold ${TONE.error.text}`}>
                          {erroriCampo.consegnatoIl}
                        </p>
                      )}
                    </div>
                  )}
                </fieldset>
              )}

              {modalitaDaScegliere ? (
                <p className="mt-4 font-maven text-sm text-kidville-sub">{t('modalitaDaScegliere')}</p>
              ) : !chiedeRisposte ? (
                // Nessun campo, e il perché si DICE: un riquadro «Da compilare» che resta
                // vuoto senza spiegazione somiglia a una schermata che non ha caricato.
                <p className="mt-4 font-maven text-sm text-kidville-sub">
                  {modalita === 'copia_firmata' ? t('modalitaSenzaCampiFirmata') : t('modalitaSenzaCampiVuota')}
                </p>
              ) : campi.length === 0 ? (
                <p className="mt-4 font-maven text-sm text-kidville-sub">{t('campiNessuno')}</p>
              ) : (
                <div className="mt-4 space-y-4">
                  {campi
                    .filter((campo) => visibile(campo, valori))
                    .map((campo) => (
                      <CampoForm
                        key={campo.nome}
                        campo={campo}
                        valore={valori[campo.nome]}
                        errore={erroriCampo[campo.nome]}
                        onChange={(v) => rispondi(campo.nome, v)}
                      />
                    ))}
                </div>
              )}

              {valori.stampa === STAMPA_CON_DATI_SANITARI && (
                <Avviso tono="warn" testo={t('avvisoSanitario')} />
              )}

              <p className="mt-4 font-maven text-[12.5px] text-kidville-sub">
                {modello.protocollo === 'uscita' ? t('protocolloConsuma') : t('protocolloNessuno')}
              </p>
              {/* 🔴 LA RIGA DELLA FIRMA DESCRIVE IL FOGLIO CHE ESCE, non il modello.
                  «Firma la famiglia, con un codice usa e getta» è vera del modulo firmato
                  nell'app; su una copia vuota e su un modulo tornato di carta prometterebbe
                  una firma elettronica che non ci sarà — che è, in piccolo, esattamente il
                  difetto che il documento non deve avere. */}
              <p className="font-maven text-[12.5px] text-kidville-sub">
                <span className="font-semibold">{t('firmaTitolo')}</span>
                {' — '}
                {modalita
                  ? t(CHIAVE_MODALITA[modalita].firma)
                  : CHIAVE_FIRMA[modello.firma]
                    ? t(CHIAVE_FIRMA[modello.firma])
                    : modello.firma}
              </p>
            </>
          )}
        </section>
      )}

      {/* ── 4. Il documento ────────────────────────────────────────────── */}
      {generabile && (
        <section className={CARD} aria-labelledby="prest-documento">
          <h3
            id="prest-documento"
            className="mb-3 font-barlow text-[15px] font-bold uppercase tracking-[0.04em] text-kidville-green"
          >
            {t('passoDocumento')}
          </h3>

          {errore && !esito && <Avviso tono="error" testo={errore} />}

          {esito ? (
            <div
              ref={ricoveroEsito}
              tabIndex={-1}
              role="status"
              className={`rounded-card border border-kidville-success bg-kidville-success-soft p-4 ${FUOCO_ESITO}`}
            >
              <p className="flex items-center gap-2 font-barlow text-sm font-bold uppercase text-kidville-success">
                <CheckCircle2 size={18} aria-hidden="true" /> {t('confermaGenerato')}
              </p>
              {esito.protocollo && (
                <p className="mt-1.5 font-maven text-sm text-kidville-ink">
                  {t('protocolloAssegnato', { numero: esito.protocollo })}
                </p>
              )}
              <p className="mt-1 font-maven text-sm text-kidville-ink">
                {esito.archiviato === 'archiviato'
                  ? t('confermaArchiviato')
                  : esito.archiviato === 'fallita'
                    ? t('archiviazioneFallita')
                    : t('archiviazioneNonPrevista')}
              </p>
              {esito.incompleto && (
                <p className="mt-1 flex items-start gap-2 font-maven text-sm font-semibold text-kidville-warn">
                  <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                  {t('documentoIncompleto')}
                </p>
              )}
              {/* COME SI RIPARTE, detto a parole. Finché questo riquadro è aperto il comando
                  «Genera» non c'è — ed è voluto: un foglio che ha già consumato un numero di
                  protocollo non si rifà con un secondo clic distratto. Ma un pulsante che
                  sparisce senza che niente lo dica lascia chi deve correggere un campo davanti
                  al documento di prima e a nessuna strada evidente. La strada è «Chiudi», e
                  ora sta scritta accanto al pulsante che la apre. */}
              <p className={AIUTO}>{t('esitoRiparti')}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={esito.url}
                  download={esito.nomeFile}
                  className="inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-[13px] font-bold uppercase tracking-[0.03em] text-kidville-white"
                >
                  <Download size={15} aria-hidden="true" /> {t('scarica')}
                </a>
                <a
                  href={esito.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={BTN_LEGGERO}
                >
                  <ExternalLink size={15} aria-hidden="true" /> {t('anteprima')}
                </a>
                <button type="button" className={BTN_LEGGERO} onClick={dimenticaEsito}>
                  <X size={15} aria-hidden="true" /> {t('chiudi')}
                </button>
              </div>
            </div>
          ) : inGenerazione ? (
            <p role="status" className="font-maven text-sm font-semibold text-kidville-green">
              {t('generazioneInCorso')}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={HEADER_BTN} onClick={() => void genera()}>
                <FileText size={17} aria-hidden="true" /> {t('genera')}
              </button>
              <button type="button" className={BTN_LEGGERO} onClick={() => scegliModello('')}>
                {t('annulla')}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/** Cognome e nome dal precompilato: è quello che finirà stampato sul foglio. */
function nomeDaPrefill(prefill: PrefillAlunno): string | null {
  const a = prefill.dati?.alunno
  const nome = [a?.cognome, a?.nome].map((p) => p?.trim()).filter(Boolean).join(' ')
  return nome || null
}

/** Una riga in sola lettura del precompilato. Il vuoto si DICE, non si lascia in bianco. */
function Dato({
  etichetta,
  valore,
  vuotoTesto,
}: {
  etichetta: string
  valore: string | null
  vuotoTesto: string
}) {
  return (
    <div className="flex gap-2">
      <dt className="font-maven text-[12.5px] text-kidville-sub">{etichetta}</dt>
      <dd className="font-maven text-[12.5px] font-semibold text-kidville-ink">
        {valore ?? vuotoTesto}
      </dd>
    </div>
  )
}

/** Un avviso in linea, con il suo eventuale «Riprova». */
function Avviso({
  tono,
  testo,
  azione,
  etichettaAzione,
}: {
  tono: 'error' | 'warn'
  testo: string
  azione?: () => void
  etichettaAzione?: string
}) {
  return (
    <div
      role="alert"
      className={`mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2 font-maven text-sm ${
        tono === 'error'
          ? `${TONE.error.border} ${TONE.error.softBg} ${TONE.error.text}`
          : `${TONE.warn.border} ${TONE.warn.softBg} ${TONE.warn.text}`
      }`}
    >
      <span>{testo}</span>
      {azione && etichettaAzione && (
        <button type="button" onClick={azione} className="font-bold underline">
          {etichettaAzione}
        </button>
      )}
    </div>
  )
}

// ─── Il form del delta ──────────────────────────────────────────────────────────

/**
 * Un elenco CHIUSO rimasto senza voci: le costruisce l'app da un archivio che questo banco
 * non legge (i delegati attivi, i periodi di servizio). Sta qui, e non dentro `Controllo`,
 * perché lo guardano in due — chi disegna il controllo e chi decide se l'etichetta può
 * puntarci — e una regola che vale per due strade deve vivere in un posto solo.
 */
const elencoChiusoVuoto = (campo: CampoPrestampato): boolean =>
  (campo.tipo === 'scelta' || campo.tipo === 'sceltaMultipla' || campo.tipo === 'griglia') &&
  (campo.opzioni ?? []).length === 0

/**
 * Il campo produce UN SOLO elemento etichettabile?
 *
 * Da questo dipende `htmlFor`, e la domanda non è accademica: `for` che punta a un id
 * inesistente è un attributo che non fa niente — il clic sull'etichetta non porta il fuoco da
 * nessuna parte. I GRUPPI (caselle multiple, griglia, sì/no, tabella a righe) e i due casi in
 * cui al posto del controllo esce una frase (`file`, elenco chiuso senza voci) il loro nome
 * accessibile se lo prendono con `aria-labelledby`, che è perché l'etichetta ha anche un id.
 */
function controlloSingolo(campo: CampoPrestampato): boolean {
  if (campo.tipo === 'file' || elencoChiusoVuoto(campo)) return false
  if (
    campo.tipo === 'griglia' ||
    campo.tipo === 'sceltaMultipla' ||
    campo.tipo === 'righe' ||
    campo.tipo === 'siNo'
  ) {
    return false
  }
  return !(campo.tipo === 'scelta' && campo.multipla)
}

/**
 * Un campo del modulo: etichetta, aiuto, errore e il controllo che il suo `tipo` chiede.
 *
 * `chiestoA: 'segreteria'` non nasconde niente qui — questo È lo sportello — ma si mostra:
 * quei campi governano il rilascio (uso dichiarato, numero di copie, consegna) e non il
 * testo del documento, e chi compila deve poterli distinguere dal resto.
 */
function CampoForm({
  campo,
  valore,
  errore,
  onChange,
}: {
  campo: CampoPrestampato
  valore: unknown
  errore?: string
  onChange: (valore: unknown) => void
}) {
  const t = useTranslations('prestampatiSegreteria')
  const id = `prest-campo-${campo.nome}`
  const idEtichetta = `${id}-etichetta`
  const idAiuto = campo.aiuto ? `${id}-aiuto` : undefined
  const idErrore = errore ? `${id}-errore` : undefined
  const descritto = [idAiuto, idErrore].filter(Boolean).join(' ') || undefined

  return (
    <div>
      {/* `htmlFor` SOLO dove esiste davvero un controllo con quell'id (input, select,
          textarea); i GRUPPI — caselle multiple, griglia, sì/no, tabella a righe — non sono
          elementi etichettabili e si prendono lo stesso testo con `aria-labelledby`, che è
          perché l'etichetta ha anche un id. Emetterlo comunque lasciava un `for` penzolante:
          il nome accessibile c'era, il clic sull'etichetta non portava il fuoco da nessuna
          parte. */}
      <label className={ETICHETTA} htmlFor={controlloSingolo(campo) ? id : undefined} id={idEtichetta}>
        {campo.etichetta}
        {campo.obbligatorio && (
          <span className={TONE.error.text} title={t('campoObbligatorio')}>
            {' *'}
            <span className="sr-only">{t('campoObbligatorio')}</span>
          </span>
        )}
        {campo.chiestoA === 'segreteria' && (
          <span
            className={`ml-2 rounded-pill px-2 py-0.5 font-maven text-[11px] font-bold ${TONE.neutral.chipBg} ${TONE.neutral.text}`}
          >
            {t('campoDUfficio')}
          </span>
        )}
      </label>

      <Controllo
        campo={campo}
        id={id}
        idEtichetta={idEtichetta}
        descritto={descritto}
        valore={valore}
        onChange={onChange}
      />

      {campo.aiuto && (
        <p id={idAiuto} className={AIUTO}>
          {campo.aiuto}
        </p>
      )}
      {errore && (
        <p id={idErrore} className={`mt-1 font-maven text-[12.5px] font-semibold ${TONE.error.text}`}>
          {errore}
        </p>
      )}
    </div>
  )
}

/**
 * Il controllo di un campo, per `tipo`.
 *
 * I tipi sono l'unione dei due file dei modelli (`TipoCampoPrestampato`), e si rispettano
 * tutti: `multipla` trasforma una scelta in caselle, `colonne` una `righe` in tabella,
 * `opzioni`/`valoriAmmessi` sono elenchi CHIUSI — mai un campo libero al posto di una
 * tendina, perché lo schema `zod` del modello accetta solo quei valori.
 */
function Controllo({
  campo,
  id,
  idEtichetta,
  descritto,
  valore,
  onChange,
}: {
  campo: CampoPrestampato
  id: string
  /** L'etichetta che nomina un GRUPPO di controlli, quando il campo non è uno solo. */
  idEtichetta?: string
  descritto?: string
  valore: unknown
  onChange: (valore: unknown) => void
}) {
  const t = useTranslations('prestampatiSegreteria')
  const opzioni = campo.opzioni ?? []
  const comuni = { id, 'aria-describedby': descritto, className: CAMPO }
  const gruppo = { 'aria-labelledby': idEtichetta, 'aria-describedby': descritto }

  // Un elenco chiuso senza voci non si trasforma in un campo libero: quelle voci le
  // costruisce l'app da un archivio (i delegati attivi, i periodi di servizio) che questo
  // banco non legge. Meglio dirlo che accettare un valore che lo schema rifiuterà.
  if (campo.tipo === 'file' || elencoChiusoVuoto(campo)) {
    return (
      <p className="font-maven text-sm text-kidville-sub">
        {campo.tipo === 'file' ? t('campoConAllegato') : t('campoSenzaOpzioni')}
      </p>
    )
  }

  if (campo.tipo === 'griglia') {
    const scelte = mappaDi(valore)
    const livelli = campo.valoriAmmessi ?? []
    return (
      <div role="group" {...gruppo} className="space-y-2">
        {opzioni.map((riga) => (
          <div key={riga.valore} className="flex flex-wrap items-center gap-2">
            <label
              className="min-w-[200px] flex-1 font-maven text-[13px] text-kidville-ink"
              htmlFor={`${id}-${riga.valore}`}
            >
              {riga.etichetta}
            </label>
            <select
              id={`${id}-${riga.valore}`}
              className={`${CAMPO} sm:w-auto`}
              value={scelte[riga.valore] ?? ''}
              onChange={(e) => onChange({ ...scelte, [riga.valore]: e.target.value })}
            >
              <option value="">{t('sceltaSegnaposto')}</option>
              {livelli.map((l) => (
                <option key={l.valore} value={l.valore}>
                  {l.etichetta}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    )
  }

  if (campo.tipo === 'sceltaMultipla' || (campo.tipo === 'scelta' && campo.multipla)) {
    const scelte = listaDi(valore)
    return (
      <div role="group" {...gruppo} className="flex flex-wrap gap-x-4 gap-y-2">
        {opzioni.map((o) => (
          <label key={o.valore} className="flex items-center gap-2 font-maven text-sm text-kidville-ink">
            <input
              type="checkbox"
              className="h-4 w-4 accent-kidville-green"
              checked={scelte.includes(o.valore)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...scelte, o.valore]
                    : scelte.filter((v) => v !== o.valore),
                )
              }
            />
            {o.etichetta}
          </label>
        ))}
      </div>
    )
  }

  if (campo.tipo === 'scelta') {
    return (
      <select {...comuni} value={testoDi(valore)} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('sceltaSegnaposto')}</option>
        {opzioni.map((o) => (
          <option key={o.valore} value={o.valore}>
            {o.etichetta}
          </option>
        ))}
      </select>
    )
  }

  if (campo.tipo === 'conferma') {
    // Nessuna etichetta qui dentro: il testo lo porta già la `<label>` del campo, e
    // ripeterlo accanto alla casella lo farebbe leggere due volte — a schermo e allo
    // screen reader.
    return (
      <input
        id={id}
        aria-describedby={descritto}
        type="checkbox"
        className="h-4 w-4 accent-kidville-green"
        checked={valore === true}
        onChange={(e) => onChange(e.target.checked)}
      />
    )
  }

  if (campo.tipo === 'siNo') {
    // Due bottoni radio e non una casella: «non risposto» e «no» sono due cose diverse, e
    // su un campo obbligatorio la differenza decide se il foglio nasce.
    return (
      <div role="radiogroup" {...gruppo} className="flex gap-4">
        {[true, false].map((scelta) => (
          <label
            key={String(scelta)}
            className="flex items-center gap-2 font-maven text-sm text-kidville-ink"
          >
            <input
              type="radio"
              name={id}
              className="h-4 w-4 accent-kidville-green"
              checked={valore === scelta}
              onChange={() => onChange(scelta)}
            />
            {scelta ? t('rispostaSi') : t('rispostaNo')}
          </label>
        ))}
      </div>
    )
  }

  if (campo.tipo === 'righe') {
    return (
      <Righe campo={campo} id={id} gruppo={gruppo} valore={valore} onChange={onChange} />
    )
  }

  if (campo.tipo === 'data') {
    return (
      <DateField
        id={id}
        aria-describedby={descritto}
        className={CAMPO}
        value={testoDi(valore)}
        onChange={onChange}
      />
    )
  }

  if (campo.tipo === 'testoLungo') {
    return (
      <textarea
        {...comuni}
        rows={4}
        value={testoDi(valore)}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  const tipoInput =
    campo.tipo === 'numero'
      ? 'number'
      : campo.tipo === 'telefono'
        ? 'tel'
        : campo.tipo === 'email'
          ? 'email'
          : campo.tipo === 'ora'
            ? 'time'
            : campo.tipo === 'mese'
              ? 'month'
              : 'text'

  return (
    <input
      {...comuni}
      type={tipoInput}
      value={testoDi(valore)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/**
 * La tabella a righe ripetibili (delegati, alimenti, dosi): le colonne le dichiara il
 * modello, e una riga si aggiunge e si toglie a mano.
 */
function Righe({
  campo,
  id,
  gruppo,
  valore,
  onChange,
}: {
  campo: CampoPrestampato
  id: string
  gruppo: { 'aria-labelledby'?: string; 'aria-describedby'?: string }
  valore: unknown
  onChange: (valore: unknown) => void
}) {
  const t = useTranslations('prestampatiSegreteria')
  const righe = righeDi(valore)
  const colonne: readonly CampoPrestampato[] = campo.colonne ?? []

  const aggiorna = (indice: number, nome: string, v: unknown) =>
    onChange(righe.map((r, i) => (i === indice ? { ...r, [nome]: v } : r)))

  return (
    <div role="group" {...gruppo} className="space-y-3">
      {righe.map((riga, indice) => (
        <div key={indice} className="rounded-xl border border-kidville-line p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {colonne.map((colonna) => {
              // Stessa regola dell'etichetta di un campo intero, e per lo stesso motivo: una
              // colonna può essere un gruppo o un allegato (`file`), e allora l'id a cui
              // `htmlFor` punterebbe non esiste. Il nome accessibile passa da `aria-labelledby`.
              const idCella = `${id}-${indice}-${colonna.nome}`
              const idEtichettaCella = `${idCella}-etichetta`
              return (
                <div key={colonna.nome}>
                  <label
                    id={idEtichettaCella}
                    className="mb-1 block font-maven text-[12.5px] font-semibold text-kidville-sub"
                    htmlFor={controlloSingolo(colonna) ? idCella : undefined}
                  >
                    {colonna.etichetta}
                  </label>
                  <Controllo
                    campo={colonna}
                    id={idCella}
                    idEtichetta={idEtichettaCella}
                    valore={riga[colonna.nome]}
                    onChange={(v) => aggiorna(indice, colonna.nome, v)}
                  />
                </div>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => onChange(righe.filter((_, i) => i !== indice))}
            className={`mt-2 ${BTN_LEGGERO}`}
          >
            <Trash2 size={15} aria-hidden="true" /> {t('rimuoviRiga')}
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...righe, {}])} className={BTN_LEGGERO}>
        {t('aggiungiRiga')}
      </button>
    </div>
  )
}
