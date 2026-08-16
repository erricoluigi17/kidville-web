'use client';

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  FileText,
  HeartPulse,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { DateField } from '@/components/ui/DateField';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { ACCOMPAGNATORE_GENITORE } from '@/lib/prestampati/modelli/genitore';

/**
 * I PRESTAMPATI DELLA FAMIGLIA — compila, rivedi, firma con l'OTP, scarica.
 *
 * È il banco «genitore» dei diciassette prestampati visto dal telefono di casa: l'elenco
 * lo dichiara `GET /api/parent/prestampati`, la firma la raccolgono `POST`/`PATCH` di
 * `parent/prestampati/firma`. Questo componente **non decide niente**: disegna il contratto
 * che quelle due rotte espongono, e quando il server dice di no lo ripete con le parole del
 * catalogo invece che con la prosa italiana del server (difetto F1 del collaudo del
 * 2026-07-31 — l'app è bilingue, il server no).
 *
 * ─── PERCHÉ IL SELETTORE DEL FIGLIO È UN PASSO E NON UN DETTAGLIO ───────────────
 *
 * La scheda «Certificati self-service» in cui questo pannello vive prendeva — e per i due
 * pulsanti di download prende ancora — **sempre `children[0]`**: il primo figlio
 * dell'elenco, senza chiedere niente a nessuno. Su un certificato scaricato era un fastidio
 * (il PDF sbagliato, che si vede subito e si rifà); qui sarebbe un'altra cosa. Da questa
 * schermata si appone una **firma elettronica con valore legale** su una scheda sanitaria,
 * su un'autorizzazione a somministrare un farmaco, su una richiesta di dieta: con due figli
 * il genitore firmerebbe le allergie di uno sul fascicolo dell'altro, e se ne accorgerebbe
 * — se se ne accorgesse — dopo, quando il documento è già archiviato e non si modifica più.
 *
 * Perciò: con **un solo** figlio la scelta è già fatta (non c'è ambiguità da risolvere, e
 * chiedere un clic in più a chi non ha alternative è solo attrito); con **due o più** non
 * si preseleziona nessuno — il genitore deve dire di chi si parla prima di vedere un solo
 * campo. È l'unico punto della schermata in cui un valore predefinito sarebbe un errore
 * silenzioso invece di una comodità.
 *
 * ─── COSA QUESTA SCHERMATA DICE INVECE DI NASCONDERE ────────────────────────────
 *
 * Quattro casi in cui la strada non è liscia e il prodotto lo dichiara:
 *
 *  · i **certificati** (iscrizione/frequenza, bonus nido) non si firmano con l'OTP — li
 *    sottoscrive il legale rappresentante — e la copia che la famiglia si scarica da sé
 *    porta «Copia a uso della famiglia — non protocollata» (§4.1 di
 *    `docs/prestampati/00-impaginazione.md`);
 *  · l'**autorizzazione ai farmaci** (n. 06) si firma ma resta in attesa della Direzione:
 *    la risposta torna `inAttesaAccettazione: true`, il PDF viaggia solo dentro quella
 *    risposta e nessun elenco lo nominerà. La schermata lo scrive e insiste sul download,
 *    perché quella è l'unica copia che la famiglia riceve;
 *  · la **delega al ritiro** (n. 08) vuole due firme e una scansione che dall'app non si
 *    carica: il pulsante è spento e il motivo è scritto accanto, non lasciato indovinare;
 *  · quando `delegatiNonLetti` è vero l'elenco delle persone delegate **non si è caricato**,
 *    e la schermata lo dice invece di mostrare un elenco vuoto — che a schermo è
 *    indistinguibile da «non c'è nessun delegato».
 *
 * ─── LE FETCH DENTRO GLI EFFETTI ────────────────────────────────────────────────
 *
 * `try`/**`finally`**, mai `try`/`catch`, e l'helper asincrono FUORI dal componente: è la
 * disciplina che `DocumentiFirmatiPanel` documenta per esteso e che
 * `react-hooks/set-state-in-effect` impone. Un `catch` con dentro un `setState`, nel corpo
 * di una funzione chiamata da un effetto, resta un ramo SINCRONO — la regola lo respinge, e
 * ha ragione. Il guasto di rete diventa `corpo: null` dentro `chiedi()`, che vive fuori di
 * qui; il caricamento si spegne nel `finally`, perché una schermata che resta a «Caricamento»
 * su un errore mente dicendo che sta ancora lavorando.
 */

// ─── Il contratto delle due rotte, come arriva ──────────────────────────────────

/** Un campo del modulo, nella forma che `registro.ts` espone (`CampoPrestampato`). */
interface CampoDTO {
  nome: string;
  etichetta: string;
  tipo: string;
  obbligatorio: boolean;
  aiuto?: string;
  opzioni?: readonly { valore: string; etichetta: string }[];
  multipla?: boolean;
  colonne?: readonly CampoDTO[];
  mostraSe?: { campo: string; valori: readonly (string | boolean)[] };
  precompilatoDa?: string;
  opzioniDaApp?: 'delegati_attivi';
  chiestoA?: 'segreteria';
}

interface ModelloElencoDTO {
  slug: string;
  etichetta: string;
  /** `modelli.schedaSanitaria` — la chiave del catalogo, composta dal registro. */
  chiaveEtichetta: string;
  firma: string;
  soggetto: string;
  protocollo: string;
  archiviazione: string;
  firmabileOra: boolean;
  motivoNonFirmabile: string | null;
  /**
   * `true` quando la Scuola quel certificato lo può emettere PER QUESTO BAMBINO, adesso.
   *
   * 🔴 Esiste perché il Bonus Nido offriva a chiunque un pulsante `primary` che per la
   * maggioranza dei bambini non poteva funzionare, e il rifiuto del server arrivava fuori
   * dallo schermo di un telefono: al genitore sembrava che il clic non avesse fatto niente.
   * Il verdetto è lo stesso che il POST userà per rifiutare (`motivoNonGenerabile` in
   * `banco-famiglia.ts`), quindi una scheda accesa è una scheda che funziona.
   *
   * Sui sei moduli che li firma la famiglia è `false` con motivo `null`: «non è roba tua»,
   * non «non si può». Facoltativi tutti e due, perché una risposta più vecchia del client —
   * durante un rilascio — non deve spegnere i pulsanti: senza il campo si ricade sul
   * comportamento di prima, cioè il pulsante c'è e sarà il server a dire di no.
   */
  generabileOra?: boolean;
  motivoNonGenerabile?: string | null;
  /**
   * Il documento di questo modello già nel fascicolo del bambino, quando c'è.
   *
   * È ciò che rende i moduli firmati riscaricabili SEMPRE: prima il PDF viveva solo dentro
   * la risposta 201 della firma, e chi chiudeva la pagina lo perdeva. Sui due certificati
   * dice anche un'altra cosa — che un numero di protocollo per questo bambino è già stato
   * consumato, quindi il pulsante normale RISCARICA invece di emetterne un altro.
   */
  documentoArchiviatoId?: string | null;
  documentoArchiviatoIl?: string | null;
  /** Quale numero riconsegna il riscarico: è ciò che il genitore cerca prima di spedirlo. */
  protocolloArchiviato?: string | null;
}

interface DelegatoDTO {
  id: string;
  nomeCompleto: string;
  relazione: string | null;
}

interface RispostaPrestampati {
  success?: boolean;
  alunno?: {
    id: string;
    cognome: string;
    nome: string;
    dataNascita: string | null;
    luogoNascita: string | null;
    codiceFiscale: string | null;
    sezione: string | null;
  };
  sede?: { nome: string | null; citta: string | null };
  annoScolastico?: string | null;
  /** La gita pubblicata per la sezione del bambino: è ciò che accende il n. 10. */
  uscita?: {
    destinazione: string;
    data: string;
    oraPartenza: string | null;
    oraRientro: string | null;
  } | null;
  modelli?: ModelloElencoDTO[];
  modello?: { slug: string; etichetta: string; chiaveEtichetta: string; firma: string; campi: CampoDTO[] } | null;
  delegati?: DelegatoDTO[] | null;
  delegatiNonLetti?: boolean;
}

/** Il 201 della firma, con i tre rami che il PATCH può prendere. */
interface EsitoFirma {
  success?: boolean;
  documentoId?: string | null;
  archiviato?: boolean;
  inAttesaAccettazione?: boolean;
  motivoMancatoArchivio?: string | null;
  riferimentoFirma?: string | null;
  titolo?: string | null;
  url?: string | null;
  pdfBase64?: string | null;
  signature_log?: { signed_at?: string } | null;
}

/** Il certificato medico già caricato, come lo elenca `GET /api/parent/medical-certificates`. */
interface CertificatoMedico {
  id: string;
  alunno_id?: string | null;
  fileName?: string | null;
  creato_il?: string | null;
}

/** Il figlio, con il minimo che serve a questa schermata: chi è e come si chiama. */
export interface FiglioPrestampati {
  id: string;
  nome: string;
  cognome: string;
}

// ─── Le tre costanti di contratto ───────────────────────────────────────────────

/**
 * I modelli che portano dati sanitari di un minore, e su cui l'avviso va mostrato PRIMA
 * che il genitore scriva.
 *
 * Un insieme dichiarato e non una proprietà dedotta, perché dedurla non si può: la rotta
 * espone `soggetto`, che per tutti e otto vale `alunno`. La regola 6 di
 * `docs/prestampati/README.md` nomina 05, 06 e 07 (più il 42, che è della segreteria) come
 * i fogli con dati dell'art. 9 — è l'unica fonte che lo dice, e sta scritta lì.
 */
const MODELLI_SANITARI: ReadonlySet<string> = new Set([
  'scheda_sanitaria',
  'autorizzazione_farmaci',
  'dieta_speciale',
]);

/**
 * I campi `file` il cui contenuto **è** un certificato sanitario del bambino: gli unici che
 * possono nominare l'archivio dei certificati medici.
 *
 * ⚠️ È la COPIA CLIENT di `CAMPI_CERTIFICATO_SANITARIO` (`banco-famiglia.ts`), e non un
 * import: quel modulo importa `next/server` e non entra in un componente `'use client'` —
 * in questo repo è il modo in cui `vitest` resta verde e `npm run build` cade (memoria del
 * 2026-08-13). La copia può solo essere più STRETTA dell'originale e non più larga: chi
 * decide davvero è `allegatiFuoriPerimetro`, che rifiuta lato server un magazzino non
 * ammesso per quel campo. Qui serve a non offrire alla famiglia un elenco che il server
 * respingerebbe.
 */
const CAMPI_ALLEGATO_SANITARIO: ReadonlySet<string> = new Set(['prescrizionePath', 'certificatoPath']);

/**
 * Il magazzino dei certificati sanitari, nella forma qualificata `bucket:chiave` che la
 * firma si aspetta.
 *
 * Senza il prefisso una chiave nuda varrebbe per il bucket del FASCICOLO (vedi
 * `scomponiRiferimento`), dove la famiglia non scrive: l'allegato risulterebbe assente e la
 * firma tornerebbe indietro con un 422. Stessa ragione dell'insieme qui sopra per cui è una
 * costante locale e non un import.
 */
const MAGAZZINO_CERTIFICATI = 'certificati-medici';

/**
 * Quanti secondi passano prima che «rimandamelo» torni premibile.
 *
 * ⚠️ Non si chiama `ATTESA_…`, e non è pignoleria: `__tests__/lib/logging-tetto.test.ts`
 * inventaria per NOME tutte le costanti che dichiarano una scadenza (`TETTO`, `TIMEOUT`,
 * `SCADENZA`, `ATTESA`) perché sono tetti di rete, e li vuole in millisecondi e dichiarati uno
 * per uno. Questo non è un tetto: è un intervallo dell'interfaccia, in secondi, che nessuna
 * fetch guarda.
 */
const RINVIO_DOPO_SECONDI = 60;

/** Gli enumerati del server → le chiavi del catalogo. Espliciti: un valore nuovo si vede. */
const CHIAVE_NON_FIRMABILE: Record<string, string> = {
  'firma-della-scuola': 'nonFirmabileFirmaDellaScuola',
  'seconda-firma-mancante': 'nonFirmabileSecondaFirmaMancante',
  'allegato-non-caricabile': 'nonFirmabileAllegatoNonCaricabile',
};

/**
 * I motivi per cui un certificato NON si emette, e la frase che li spiega.
 *
 * Enumerati e non prosa: il server risponde in italiano, l'app è bilingue, e mandare la
 * frase del server dentro una schermata inglese è il difetto F1 del collaudo del
 * 2026-07-31. Tutti e tre chiedono all'utente cose diverse — due sono da segnalare alla
 * segreteria, il terzo dice che quel certificato non è il suo.
 */
const CHIAVE_MOTIVO_CERTIFICATO: Record<string, string> = {
  'legale-rappresentante-assente': 'certificatoLegaleRappresentanteAssente',
  'autorizzazione-nido-mancante': 'certificatoAutorizzazioneNidoMancante',
  'livello-non-nido': 'certificatoLivelloNonNido',
};

const CHIAVE_MANCATO_ARCHIVIO: Record<string, string> = {
  'tipo-documento-non-ammesso': 'mancatoArchivioTipoDocumentoNonAmmesso',
  'schema-non-pronto': 'mancatoArchivioSchemaNonPronto',
  'archivio-non-scritto': 'mancatoArchivioArchivioNonScritto',
};

// ─── La chiamata, fuori dal componente ──────────────────────────────────────────

interface EsitoRete<T> {
  ok: boolean;
  stato?: number;
  corpo: T | null;
}

/**
 * Una chiamata che **non lancia mai**, e che perciò si può usare in un `try`/`finally`.
 *
 * `fetch` può rigettare in modo sincrono (URL malformato) e la rete può cadere: se il
 * guasto arrivasse fino al componente, il `catch` che lo raccoglie sarebbe un ramo sincrono
 * dentro l'effetto — cioè quello che `react-hooks/set-state-in-effect` vieta. Qui il guasto
 * diventa `corpo: null`, e non viene INGHIOTTITO: `logClient` lo spedisce a `/api/logs`, che
 * è l'unico posto in cui si può vedere che cos'è successo sul telefono di un genitore.
 */
async function chiedi<T>(url: string, userId: string, init?: RequestInit): Promise<EsitoRete<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'x-user-id': userId,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const corpo = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, stato: res.status, corpo };
  } catch (e) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `prestampati-genitore-rete-caduta: ${nomeErrore(e)}`,
    });
    return { ok: false, corpo: null };
  }
}

// ─── Le letture pure sulle risposte in corso di compilazione ────────────────────

type Risposte = Record<string, unknown>;

/**
 * Il campo si mostra? `mostraSe` guarda un ALTRO campo dello stesso livello: al primo
 * livello le risposte del modulo, dentro una tabella la riga a cui la colonna appartiene.
 */
function campoVisibile(campo: CampoDTO, contesto: Risposte): boolean {
  if (!campo.mostraSe) return true;
  const valore = contesto[campo.mostraSe.campo];
  return campo.mostraSe.valori.some((v) => v === valore);
}

/**
 * I campi che il GENITORE vede.
 *
 * Due esclusioni, e nessuna delle due è cosmetica:
 *  · `chiestoA: 'segreteria'` — il modello lo dichiara «chiesto solo a chi emette il
 *    documento allo sportello»: a quante copie stampare e come consegnarle la famiglia non
 *    deve rispondere, e mostrarlo qui sarebbe chiedere un dato che non le appartiene;
 *  · `mostraSe` non soddisfatto — il campo è fuori dal modulo, non vuoto.
 */
function campiVisibili(campi: readonly CampoDTO[], contesto: Risposte): CampoDTO[] {
  return campi.filter((c) => c.chiestoA !== 'segreteria' && campoVisibile(c, contesto));
}

/**
 * Le risposte da spedire: **solo ciò che è visibile**, senza le stringhe rimaste vuote.
 *
 * Non è una pulizia estetica, sono due difetti chiusi:
 *  · un campo che `mostraSe` ha nascosto conserva il valore digitato prima del cambio di
 *    idea. Chi dichiara una dieta «per allergia» e poi passa ad «altro» si porterebbe dietro
 *    il nome del medico e la data del certificato — che lo schema accetta, perché sono
 *    opzionali, e che finirebbero STAMPATI su un foglio che dichiara un'altra cosa;
 *  · una data svuotata dopo essere stata scritta vale `''`, e `zDataYMD` la rifiuta anche
 *    quando il campo è opzionale: il modulo tornerebbe indietro per un campo che il genitore
 *    ha deciso di non compilare.
 *
 * Il `false` e lo `0` restano: sono risposte, non assenze — «vaccinazioni: no» è un dato
 * sanitario che il foglio deve riportare.
 */
function risposteDaInviare(campi: readonly CampoDTO[], risposte: Risposte): Risposte {
  const out: Risposte = {};
  for (const campo of campiVisibili(campi, risposte)) {
    const valore = risposte[campo.nome];
    if (campo.tipo === 'righe') {
      const righe = Array.isArray(valore) ? (valore as Risposte[]) : [];
      out[campo.nome] = righe.map((riga) => risposteDaInviare(campo.colonne ?? [], riga));
      continue;
    }
    if (typeof valore === 'string' && valore.trim() === '') continue;
    if (valore === undefined) continue;
    out[campo.nome] = valore;
  }
  return out;
}

/**
 * Questo modulo chiede un allegato che la famiglia può davvero collegare?
 *
 * Solo il primo livello: dentro una tabella `righe` l'unico campo `file` è la scansione del
 * documento di un delegato, che una porta di caricamento non ce l'ha (e il suo modello non
 * si firma affatto). `mostraSe` non si guarda: l'elenco dei certificati si carica una volta,
 * e farlo dipendere da una risposta che il genitore deve ancora dare vorrebbe dire una
 * seconda chiamata a metà compilazione.
 */
function campiConAllegatoSanitario(campi: readonly CampoDTO[]): boolean {
  return campi.some((c) => c.tipo === 'file' && CAMPI_ALLEGATO_SANITARIO.has(c.nome));
}

/** Vuoto: `undefined`, stringa bianca, elenco senza voci. Lo zero e il `false` NON lo sono. */
function valoreVuoto(valore: unknown): boolean {
  if (valore === undefined || valore === null) return true;
  if (typeof valore === 'string') return valore.trim() === '';
  if (Array.isArray(valore)) return valore.length === 0;
  return false;
}

/** Una riga vuota della tabella: le colonne nascono tutte assenti, non a stringa vuota. */
function rigaVuota(): Risposte {
  return {};
}

/**
 * Le risposte di partenza: le tabelle `righe` nascono con UNA riga già aperta.
 *
 * Senza, il primo contatto con la scheda sanitaria è una tabella dei contatti d'emergenza
 * vuota sotto un'etichetta obbligatoria: il genitore deve indovinare che prima si preme
 * «Aggiungi». La riga aperta rende visibile che cosa il modulo chiede.
 */
function risposteIniziali(campi: readonly CampoDTO[]): Risposte {
  const out: Risposte = {};
  for (const c of campi) {
    if (c.tipo === 'righe') out[c.nome] = [rigaVuota()];
  }
  return out;
}

/**
 * I campi obbligatori rimasti vuoti, per percorso (`contattiEmergenza.0.telefono`).
 *
 * Guarda SOLO ciò che è visibile: un campo nascosto da `mostraSe` non è mancante, è fuori
 * dal modulo. E guarda solo `obbligatorio`, che il modello dichiara come «obbligatorio
 * SEMPRE, in ogni combinazione di risposte»: le regole condizionali vivono nello schema
 * `zod` del server, che è l'unico posto in cui il rifiuto è vero, e ricopiarle qui vorrebbe
 * dire due descrizioni dello stesso modulo che divergono alla prima che cambia.
 */
function campiMancanti(campi: readonly CampoDTO[], risposte: Risposte, prefisso = ''): Record<string, true> {
  const mancanti: Record<string, true> = {};
  for (const campo of campiVisibili(campi, risposte)) {
    const percorso = prefisso ? `${prefisso}.${campo.nome}` : campo.nome;
    const valore = risposte[campo.nome];
    if (campo.tipo === 'righe') {
      const righe = Array.isArray(valore) ? (valore as Risposte[]) : [];
      if (campo.obbligatorio && righe.length === 0) mancanti[percorso] = true;
      righe.forEach((riga, i) => {
        Object.assign(mancanti, campiMancanti(campo.colonne ?? [], riga, `${percorso}.${i}`));
      });
      continue;
    }
    if (campo.obbligatorio && valoreVuoto(valore)) mancanti[percorso] = true;
  }
  return mancanti;
}

/** Il PDF che arriva dentro la risposta: si scarica senza passare da nessun indirizzo. */
function scaricaBase64(base64: string, nomeFile: string): void {
  const binario = atob(base64);
  const byte = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) byte[i] = binario.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([byte], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeFile;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Il pannello ────────────────────────────────────────────────────────────────

const CLASSE_CAMPO =
  'w-full border-2 border-kidville-line rounded-xl px-4 py-2.5 font-maven text-sm text-kidville-ink bg-white focus:outline-none focus:border-kidville-green';

type Passo = 'modulo' | 'compila' | 'rivedi' | 'firma' | 'fatto';

export function PrestampatiGenitore({
  figli,
  onAlunnoScelto,
}: {
  figli: readonly FiglioPrestampati[];
  /**
   * Il figlio scelto qui, comunicato a chi ospita il pannello. Serve alla scheda che lo
   * contiene per smettere di prendere `children[0]`: la scelta la fa il genitore una volta
   * sola, e vale per tutto quello che c'è in quella scheda.
   */
  onAlunnoScelto?: (alunnoId: string) => void;
}) {
  const t = useTranslations('prestampatiGenitore');
  const { dataBreve, dataOra } = useDateFormat();
  const { userId, ready } = useSessionIdentity();
  const uid = useId();

  // Un solo figlio: la scelta non è ambigua e si fa da sé. Due o più: nessun preselezionato,
  // e il perché sta nella testata di questo file.
  const [alunnoId, setAlunnoId] = useState(() => (figli.length === 1 ? figli[0].id : ''));
  const [passo, setPasso] = useState<Passo>('modulo');

  const [elenco, setElenco] = useState<RispostaPrestampati | null>(null);
  const [elencoInCorso, setElencoInCorso] = useState(() => figli.length === 1);
  const [erroreElenco, setErroreElenco] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [dettaglio, setDettaglio] = useState<RispostaPrestampati | null>(null);
  const [dettaglioInCorso, setDettaglioInCorso] = useState(false);
  const [erroreDettaglio, setErroreDettaglio] = useState<string | null>(null);

  const [certificati, setCertificati] = useState<CertificatoMedico[] | null>(null);
  const [certificatiInCorso, setCertificatiInCorso] = useState(false);
  const [certificatiNonLetti, setCertificatiNonLetti] = useState(false);

  const [risposte, setRisposte] = useState<Risposte>({});
  const [erroriCampo, setErroriCampo] = useState<Record<string, string>>({});
  const [mancanti, setMancanti] = useState<Record<string, true>>({});

  const [otp, setOtp] = useState<{ email: string | null; expiry: number; ticket: string } | null>(null);
  const [codice, setCodice] = useState('');
  const [attesaRinvio, setAttesaRinvio] = useState(0);
  const [inCorso, setInCorso] = useState<'invio' | 'firma' | null>(null);
  const [erroreFirma, setErroreFirma] = useState<string | null>(null);
  const [avviso, setAvviso] = useState<string | null>(null);

  const [esito, setEsito] = useState<EsitoFirma | null>(null);

  /** Lo slug del certificato in lavorazione: spegne il suo pulsante, non tutta la pagina. */
  const [certificatoInCorso, setCertificatoInCorso] = useState<string | null>(null);
  /**
   * L'esito del gesto sul documento, ATTACCATO ALLO SLUG che l'ha prodotto.
   *
   * 🔴 Prima era una stringa sola, disegnata in cima all'elenco: misurato su una finestra
   * 430×900 (la misura di un telefono, che è come questa app si usa), il pulsante del Bonus
   * Nido stava a `y≈768` e il suo rifiuto veniva disegnato a `y = -777` — 777 px sopra la
   * finestra. Gli screenshot prima e dopo il clic erano identici: al genitore sembrava che il
   * pulsante non facesse niente, e l'unica traccia era una riga rossa nella console.
   *
   * Con lo slug accanto, il messaggio si disegna DENTRO la scheda che l'ha chiesto — cioè
   * dove l'occhio è già — e non c'è nessuno scroll da indovinare.
   */
  const [erroreCertificato, setErroreCertificato] = useState<{
    slug: string;
    testo: string;
    tono: 'errore' | 'attenzione';
  } | null>(null);

  /**
   * L'elenco dei figli arriva da chi ospita il pannello e di norma è già in mano al primo
   * render. Se arrivasse dopo — o cambiasse — la scelta OBBLIGATA di chi ha un figlio solo va
   * rifatta: setState condizionale in render, la stessa disciplina di `DateField`, non un
   * effetto (che qui sarebbe un `set-state-in-effect` in piena regola).
   *
   * `onAlunnoScelto` NON si chiama da qui: aggiornare un altro componente mentre questo
   * renderizza è ciò che React vieta. Non serve — con un figlio solo il valore di ripiego di
   * chi ospita (il primo dell'elenco) è già quel figlio; la differenza nasce da due in su, e
   * là la scelta la fa una persona, cioè un evento.
   */
  const [figliNoti, setFigliNoti] = useState(figli);
  if (figli !== figliNoti) {
    setFigliNoti(figli);
    if (!alunnoId && figli.length === 1) {
      setAlunnoId(figli[0].id);
      setElencoInCorso(true);
    }
  }

  const modelli = useMemo(() => elenco?.modelli ?? [], [elenco]);
  const scelto = useMemo(() => modelli.find((m) => m.slug === slug) ?? null, [modelli, slug]);
  /**
   * Il ticket dell'OTP firma `email:code:expiry` e non nomina né il modulo né le risposte:
   * dopo un 422 «correggi i campi» è ancora buono. Riusarlo non è un'ottimizzazione — il
   * budget degli invii è di 5 per finestra di dieci minuti ed è CONDIVISO fra tutte le porte
   * OTP: chiedere un codice nuovo a ogni correzione lascerebbe la famiglia senza modo di
   * firmare l'autorizzazione a un farmaco.
   */
  const otpAncoraValido = !!otp && Date.now() < otp.expiry;
  const campi = useMemo(() => dettaglio?.modello?.campi ?? [], [dettaglio]);
  const serveAllegatoSanitario = useMemo(() => campiConAllegatoSanitario(campi), [campi]);

  // ── L'elenco dei modelli della famiglia ──────────────────────────────────────

  const caricaElenco = useCallback(async () => {
    // Finché l'identità non è risolta non si chiede niente: `ready` distingue «non lo so
    // ancora» da «non c'è nessuno», e senza questa riga la prima chiamata partirebbe senza
    // `x-user-id` prendendosi un 401 evitabile. Senza figlio scelto non c'è niente da
    // chiedere: la rotta pretende `alunnoId`.
    if (!ready || !userId || !alunnoId) return;
    // I parametri si compongono PRIMA del `try`: dentro, il primo statement deve essere
    // l'`await`, o il `finally` — che chiama setState — torna a essere raggiungibile in modo
    // sincrono dall'effetto.
    const url = `/api/parent/prestampati?alunnoId=${encodeURIComponent(alunnoId)}`;
    try {
      const r = await chiedi<RispostaPrestampati>(url, userId);
      if (!r.ok || !r.corpo?.success) {
        setErroreElenco(soloCatalogoDaCorpo(r.corpo, t('erroreElenco')));
        setElenco(null);
        return;
      }
      setErroreElenco(null);
      setElenco(r.corpo);
    } finally {
      // `finally`, non `catch`: se il caricamento resta acceso su un errore, la schermata
      // mente dicendo che sta ancora lavorando.
      setElencoInCorso(false);
    }
  }, [ready, userId, alunnoId, t]);

  useEffect(() => {
    caricaElenco();
  }, [caricaElenco]);

  // ── Il modulo scelto: campi, delegati, precompilato ──────────────────────────

  const caricaDettaglio = useCallback(async () => {
    if (!ready || !userId || !alunnoId || !slug) return;
    const url = `/api/parent/prestampati?alunnoId=${encodeURIComponent(alunnoId)}&slug=${encodeURIComponent(slug)}`;
    try {
      const r = await chiedi<RispostaPrestampati>(url, userId);
      if (!r.ok || !r.corpo?.success || !r.corpo.modello) {
        setErroreDettaglio(soloCatalogoDaCorpo(r.corpo, t('erroreModulo')));
        setDettaglio(null);
        return;
      }
      setErroreDettaglio(null);
      setDettaglio(r.corpo);
      setRisposte(risposteIniziali(r.corpo.modello.campi));
      // L'attesa dei certificati si accende QUI, dove per la prima volta si sa se questo
      // modulo un allegato lo chiede davvero: accenderla alla scelta del modulo — cioè prima
      // di conoscerne i campi — la lascerebbe accesa per sempre sui sei modelli che non ne
      // hanno, perché l'effetto che la spegne su quelli non parte nemmeno.
      setCertificatiInCorso(campiConAllegatoSanitario(r.corpo.modello.campi));
    } finally {
      setDettaglioInCorso(false);
    }
  }, [ready, userId, alunnoId, slug, t]);

  useEffect(() => {
    caricaDettaglio();
  }, [caricaDettaglio]);

  // ── I certificati già caricati, SOLO per i moduli che chiedono un allegato ────
  //
  // «Ciò che non si legge non si può perdere»: per sei modelli su otto quell'elenco non
  // c'entra niente, e caricarlo per comodità lo farebbe passare da ogni compilazione. Il
  // percorso del file non esce dalla rotta (è un dato sanitario) e non serve: la chiave si
  // ricompone da `alunno_id` e `fileName`, che sono le due parti di `<alunnoId>/<uuid>.<est>`
  // — la forma con cui `POST /api/parent/medical-certificates` scrive nel bucket.

  const caricaCertificati = useCallback(async () => {
    if (!ready || !userId || !alunnoId || !serveAllegatoSanitario) return;
    try {
      const r = await chiedi<{ success?: boolean; data?: CertificatoMedico[] }>(
        '/api/parent/medical-certificates',
        userId,
      );
      if (!r.ok || !r.corpo?.success || !Array.isArray(r.corpo.data)) {
        // Un elenco vuoto e un elenco non letto sono identici a schermo: senza questo
        // booleano il genitore leggerebbe «non hai caricato nessun certificato» mentre il
        // suo certificato c'è, e riproverebbe a caricarlo.
        setCertificatiNonLetti(true);
        setCertificati(null);
        return;
      }
      setCertificatiNonLetti(false);
      setCertificati(r.corpo.data.filter((c) => c.alunno_id === alunnoId && !!c.fileName));
    } finally {
      setCertificatiInCorso(false);
    }
  }, [ready, userId, alunnoId, serveAllegatoSanitario]);

  useEffect(() => {
    caricaCertificati();
  }, [caricaCertificati]);

  // ── Il conto alla rovescia del rinvio ────────────────────────────────────────
  //
  // Non è cosmetico: `LIMITE_OTP_INVIO` è di 5 invii per finestra di dieci minuti ed è un
  // budget CONDIVISO fra tutte le porte OTP. Cinque tocchi su «rimandamelo» lascerebbero il
  // genitore senza modo di firmare l'autorizzazione a un farmaco.
  useEffect(() => {
    if (attesaRinvio <= 0) return;
    const timer = setTimeout(() => setAttesaRinvio((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [attesaRinvio]);

  // ── I gesti ──────────────────────────────────────────────────────────────────

  const scegliAlunno = (id: string) => {
    setAlunnoId(id);
    setElencoInCorso(!!id);
    setElenco(null);
    setErroreElenco(null);
    tornaAllaScelta();
    onAlunnoScelto?.(id);
  };

  function tornaAllaScelta() {
    setPasso('modulo');
    setSlug('');
    setDettaglio(null);
    setErroreDettaglio(null);
    setRisposte({});
    setErroriCampo({});
    setMancanti({});
    setOtp(null);
    setCodice('');
    setErroreFirma(null);
    setAvviso(null);
    setEsito(null);
    setCertificati(null);
    setCertificatiInCorso(false);
    setCertificatiNonLetti(false);
  }

  /**
   * «Riprova» RICHIAMA la rotta. Non rimette a posto uno stato sperando che l'effetto se ne
   * accorga — perché non se ne accorge.
   *
   * Qui c'era `scegliAlunno(alunnoId)`, cioè riscrivere nella tendina l'id che c'è già:
   * `setAlunnoId(stesso valore)` è un bail-out di React, `caricaElenco` dipende da
   * `[ready, userId, alunnoId, t]` e nessuna di quelle quattro cambia (`t` lo memoizza
   * `use-intl`), quindi l'effetto NON riparte. Del gesto sopravvivevano solo gli altri due
   * setState — errore cancellato, caricamento acceso — cioè uno spinner che mente per
   * sempre, e con un figlio solo l'unica via d'uscita era ricaricare la pagina. Misurato:
   * elenco a 503, `fetch` chiamato una volta; dopo il clic, ancora una.
   *
   * Il vicinato risolve la stessa cosa in una riga (`DocumentiFirmatiPanel.tsx:277`,
   * `onClick={() => void carica()}`): la chiamata parte da un EVENTO, non da un effetto,
   * quindi `react-hooks/set-state-in-effect` non c'entra e i due setState stanno qui.
   */
  const riprovaElenco = () => {
    setElencoInCorso(true);
    setErroreElenco(null);
    void caricaElenco();
  };

  /** Stessa cosa sul modulo: lo `slug` è già quello giusto, va solo richiesto di nuovo. */
  const riprovaDettaglio = () => {
    setDettaglioInCorso(true);
    setErroreDettaglio(null);
    void caricaDettaglio();
  };

  const scegliModulo = (m: ModelloElencoDTO) => {
    if (!m.firmabileOra) return;
    setSlug(m.slug);
    setDettaglioInCorso(true);
    setDettaglio(null);
    setErroreDettaglio(null);
    setErroriCampo({});
    setMancanti({});
    setCertificati(null);
    setCertificatiNonLetti(false);
    setPasso('compila');
  };

  const cambiaValore = (percorso: string, nome: string, valore: unknown) => {
    setRisposte((prec) => ({ ...prec, [nome]: valore }));
    setErroriCampo((prec) => {
      if (!(percorso in prec)) return prec;
      const copia = { ...prec };
      delete copia[percorso];
      return copia;
    });
    setMancanti((prec) => {
      if (!(percorso in prec)) return prec;
      const copia = { ...prec };
      delete copia[percorso];
      return copia;
    });
  };

  const vaiARivedi = () => {
    const buchi = campiMancanti(campi, risposte);
    setMancanti(buchi);
    if (Object.keys(buchi).length > 0) return;
    setPasso('rivedi');
  };

  const chiediCodice = async (rinvio: boolean) => {
    if (!userId || !slug || !alunnoId || inCorso) return;
    setInCorso('invio');
    setErroreFirma(null);
    setAvviso(null);
    const r = await chiedi<{ success?: boolean; email?: string | null; expiry?: number; ticket?: string; sent?: boolean }>(
      '/api/parent/prestampati/firma',
      userId,
      { method: 'POST', body: JSON.stringify({ slug, alunnoId }) },
    );
    setInCorso(null);
    if (!r.ok || !r.corpo?.ticket || typeof r.corpo.expiry !== 'number') {
      setErroreFirma(
        r.stato === 429
          ? soloCatalogoDaCorpo(r.corpo, t('otpTroppiTentativi'))
          : soloCatalogoDaCorpo(r.corpo, t('otpNonInviato')),
      );
      return;
    }
    setOtp({ email: r.corpo.email ?? null, expiry: r.corpo.expiry, ticket: r.corpo.ticket });
    setCodice('');
    setAttesaRinvio(RINVIO_DOPO_SECONDI);
    setPasso('firma');
    // `sent` dice se il provider ha accettato la consegna: senza questa riga «il codice non
    // arriva» e «il codice non è mai partito» sarebbero la stessa schermata.
    setAvviso(r.corpo.sent === false ? t('otpNonConsegnato') : rinvio ? t('otpInviato') : null);
  };

  const firma = async () => {
    if (!userId || !otp || !slug || !alunnoId || inCorso) return;
    setInCorso('firma');
    setErroreFirma(null);
    setAvviso(null);
    const r = await chiedi<EsitoFirma & { errori?: { campo: string; messaggio: string }[]; motivo?: string; motivoNonFirmabile?: string }>(
      '/api/parent/prestampati/firma',
      userId,
      {
        method: 'PATCH',
        body: JSON.stringify({
          slug,
          alunnoId,
          code: codice,
          expiry: otp.expiry,
          ticket: otp.ticket,
          risposte: risposteDaInviare(campi, risposte),
        }),
      },
    );
    setInCorso(null);

    if (r.ok && r.corpo?.success) {
      setEsito(r.corpo);
      setPasso('fatto');
      return;
    }

    // Il modulo va corretto: gli errori tornano CAMPO PER CAMPO e si mostrano lì, non in
    // fondo alla pagina. Il codice non è stato speso — il server lo dice — quindi si torna
    // alla compilazione senza far ricominciare la firma da capo.
    const errori = r.corpo?.errori;
    if (Array.isArray(errori) && errori.length > 0) {
      const mappa: Record<string, string> = {};
      for (const e of errori) if (e.campo) mappa[e.campo] = e.messaggio;
      setErroriCampo(mappa);
      setPasso('compila');
      setErroreFirma(soloCatalogoDaCorpo(r.corpo, t('erroreDatiMancanti')));
      return;
    }

    // L'OTP: gli enumerati del server, tradotti qui. `motivo` distingue i tre casi che al
    // genitore chiedono tre cose diverse — ricontrolla le cifre, chiedine un altro, ne hai
    // già usato uno.
    const motivo = r.corpo?.motivo;
    if (motivo === 'scaduto') setErroreFirma(t('otpScaduto'));
    else if (motivo === 'gia-usato') setErroreFirma(t('otpGiaUsato'));
    else if (motivo === 'non-valido') setErroreFirma(t('otpErrato'));
    else if (r.corpo?.motivoNonFirmabile) setErroreFirma(testoNonFirmabile(r.corpo.motivoNonFirmabile));
    else if (r.stato === 429) setErroreFirma(soloCatalogoDaCorpo(r.corpo, t('otpTroppiTentativi')));
    else setErroreFirma(soloCatalogoDaCorpo(r.corpo, r.stato === 500 ? t('erroreGenerazione') : t('erroreFirma')));
  };

  function testoNonFirmabile(motivo: string | null): string {
    const chiave = motivo ? CHIAVE_NON_FIRMABILE[motivo] : undefined;
    return chiave ? t(chiave) : t('erroreFirma');
  }

  /**
   * «Dammi il documento di questo modello», ed è UN solo gesto per tre casi.
   *
   * ─── LA REGOLA DEL TITOLARE, E PERCHÉ `nuovo` HA UN PULSANTE SUO ────────────────
   *
   * > «Una volta che il genitore ha scaricato il suo certificato, quel certificato resta
   * > salvato, e quando lo va a riprendere riscarica sempre lo stesso.»
   *
   * Quindi il gesto normale — quello grande, quello che si preme senza pensarci —
   * **riscarica**: stesso file, stesso numero di protocollo, nessuna riga nuova nel
   * registro. `nuovo: true` è l'altro pulsante, secondario e visivamente più leggero, e
   * ne emette uno con data e protocollo nuovi. Se i due avessero lo stesso peso il
   * genitore brucerebbe numeri di protocollo per sbaglio, su un registro che è WORM: un
   * numero consumato non torna indietro.
   *
   * ⚠️ IL DOWNLOAD NON PASSA DA UN `<a href>` COSTRUITO A MANO: l'URL è firmato e dura un
   * minuto, quindi lo si apre appena arriva. Quando l'archiviazione non è riuscita il
   * server consegna i byte dentro la risposta (`pdfBase64`), perché il numero di
   * protocollo è già stato consumato e la famiglia ha diritto al foglio comunque.
   */
  const chiediDocumento = async (m: ModelloElencoDTO, nuovo: boolean) => {
    if (!userId || !alunnoId || certificatoInCorso) return;
    setCertificatoInCorso(m.slug);
    setErroreCertificato(null);
    const r = await chiedi<{
      success?: boolean;
      url?: string | null;
      pdfBase64?: string | null;
      riuso?: boolean;
      archiviato?: boolean;
      motivo?: string;
    }>('/api/parent/prestampati', userId, {
      method: 'POST',
      body: JSON.stringify({ alunnoId, slug: m.slug, nuovo }),
    });
    setCertificatoInCorso(null);

    if (!r.ok || !r.corpo?.success) {
      const chiave = r.corpo?.motivo ? CHIAVE_MOTIVO_CERTIFICATO[r.corpo.motivo] : undefined;
      setErroreCertificato({
        slug: m.slug,
        tono: 'errore',
        testo: chiave ? t(chiave) : soloCatalogoDaCorpo(r.corpo, t('erroreCertificato')),
      });
      return;
    }

    if (r.corpo.url) window.open(r.corpo.url, '_blank', 'noopener,noreferrer');
    else if (r.corpo.pdfBase64) scaricaBase64(r.corpo.pdfBase64, `${m.slug}.pdf`);

    /**
     * 🔴 `archiviato: false` NON È UN SUCCESSO PIENO, e ignorarlo era il difetto misurato in
     * produzione: la rotta rispondeva 201 con `documentoId: null` (il bucket del fascicolo non
     * esisteva), il client guardava solo `success`, consegnava il PDF e ripresentava «Genera
     * il certificato» — cioè invitava al clic che avrebbe bruciato il numero dopo. Due numeri
     * di protocollo consumati in settanta secondi, su un registro WORM.
     *
     * `=== false` e non `!archiviato`: una risposta senza il campo (client più nuovo del
     * server, durante un rilascio) non deve inventare un allarme.
     */
    if (r.corpo.archiviato === false) {
      setErroreCertificato({ slug: m.slug, tono: 'attenzione', testo: t('certificatoNonArchiviato') });
    } else {
      setErroreCertificato(null);
    }

    // L'elenco si ricarica: dopo la prima emissione il modello ha un documento in archivio,
    // e il pulsante deve cambiare da «Genera» a «Scarica» — o il gesto dopo emetterebbe un
    // secondo numero di protocollo credendo di riscaricare il primo.
    void caricaElenco();
  };

  // ── Il disegno ───────────────────────────────────────────────────────────────

  const alunno = elenco?.alunno;
  const nomeModulo = (m: { chiaveEtichetta: string }) => t(m.chiaveEtichetta);
  const descrizioneModulo = (m: { chiaveEtichetta: string }) =>
    t(m.chiaveEtichetta.replace(/^modelli\./, 'descrizioni.'));

  if (figli.length === 0) {
    return (
      <p className="rounded-card border border-kidville-line bg-white px-4 py-6 text-center font-maven text-sm text-kidville-sub">
        {t('vuotoFigli')}
      </p>
    );
  }

  return (
    <section className="space-y-5" aria-labelledby={`${uid}-titolo`}>
      <header className="space-y-1">
        <h3 id={`${uid}-titolo`} className="font-barlow text-xl font-black uppercase tracking-wide text-kidville-green">
          {t('titolo')}
        </h3>
        <p className="font-maven text-xs leading-relaxed text-kidville-sub">{t('sottotitolo')}</p>
      </header>

      {/* 1 · Per chi */}
      <div className="rounded-card border border-kidville-line bg-white p-4">
        <label htmlFor={`${uid}-figlio`} className="mb-1 block font-maven text-xs font-semibold text-kidville-green">
          {t('scegliFiglio')}
        </label>
        <select
          id={`${uid}-figlio`}
          value={alunnoId}
          onChange={(e) => scegliAlunno(e.target.value)}
          className={CLASSE_CAMPO}
        >
          <option value="">{t('scegliFiglioSegnaposto')}</option>
          {figli.map((f) => (
            <option key={f.id} value={f.id}>
              {f.cognome} {f.nome}
            </option>
          ))}
        </select>
      </div>

      {alunnoId && erroreElenco && (
        <Avviso tono="errore" testo={erroreElenco} azione={{ etichetta: t('riprova'), onClick: riprovaElenco }} />
      )}

      {alunnoId && elencoInCorso && !erroreElenco && (
        <p className="py-6 text-center font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
      )}

      {/* 2 · Che modulo */}
      {alunnoId && passo === 'modulo' && elenco && !erroreElenco && (
        <div className="space-y-3">
          <h4 className="font-barlow text-base font-bold uppercase tracking-wide text-kidville-green">
            {t('scegliModulo')}
          </h4>
          {modelli.length === 0 ? (
            <p className="rounded-card border border-dashed border-kidville-line px-4 py-8 text-center font-maven text-sm text-kidville-sub">
              {t('vuotoModuli')}
            </p>
          ) : (
            <ul className="space-y-3">
              {modelli.map((m) => (
                <li key={m.slug}>
                  <SchedaModello
                    modello={m}
                    titolo={nomeModulo(m)}
                    descrizione={descrizioneModulo(m)}
                    motivo={testoNonFirmabile(m.motivoNonFirmabile)}
                    onScegli={() => scegliModulo(m)}
                    onDocumento={(nuovo) => chiediDocumento(m, nuovo)}
                    inCorso={certificatoInCorso === m.slug}
                    esitoGesto={erroreCertificato?.slug === m.slug ? erroreCertificato : null}
                    uscita={m.slug === 'autorizzazione_uscita' ? (elenco?.uscita ?? null) : null}
                    dataBreve={dataBreve}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 3 · Compila */}
      {alunnoId && passo === 'compila' && (
        <div className="space-y-4 rounded-card border border-kidville-line bg-white p-4 sm:p-5">
          <IntestazioneModulo
            titolo={scelto ? nomeModulo(scelto) : ''}
            onIndietro={tornaAllaScelta}
            etichettaIndietro={t('cambiaModulo')}
          />

          {scelto && MODELLI_SANITARI.has(scelto.slug) && <Avviso tono="attenzione" icona={HeartPulse} testo={t('avvisoSanitario')} />}
          {scelto?.firma === 'otp_due_genitori' && <Avviso tono="attenzione" testo={t('firmaDueGenitori')} />}

          {alunno && (
            <DatiDellApp
              alunno={alunno}
              sede={elenco?.sede ?? null}
              annoScolastico={elenco?.annoScolastico ?? null}
              dataBreve={dataBreve}
            />
          )}

          {erroreDettaglio && (
            <Avviso
              tono="errore"
              testo={erroreDettaglio}
              azione={{ etichetta: t('riprova'), onClick: riprovaDettaglio }}
            />
          )}

          {dettaglioInCorso && !erroreDettaglio && (
            <p className="py-6 text-center font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
          )}

          {dettaglio?.modello && (
            <>
              <div>
                <h5 className="font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">
                  {t('campiTitolo')}
                </h5>
                <p className="mt-0.5 font-maven text-xs text-kidville-sub">{t('campiSottotitolo')}</p>
              </div>

              {dettaglio.delegatiNonLetti && <Avviso tono="attenzione" testo={t('delegatiNonLetti')} />}

              <div className="space-y-5">
                {campiVisibili(campi, risposte).map((campo) => (
                  <CampoView
                    key={campo.nome}
                    campo={campo}
                    percorso={campo.nome}
                    idBase={`${uid}-${campo.nome}`}
                    valore={risposte[campo.nome]}
                    onValore={(v) => cambiaValore(campo.nome, campo.nome, v)}
                    errore={erroriCampo[campo.nome]}
                    mancante={!!mancanti[campo.nome]}
                    erroriCampo={erroriCampo}
                    mancanti={mancanti}
                    delegati={dettaglio.delegati ?? null}
                    delegatiNonLetti={!!dettaglio.delegatiNonLetti}
                    certificati={certificati}
                    certificatiNonLetti={certificatiNonLetti}
                    certificatiInCorso={certificatiInCorso}
                    alunnoId={alunnoId}
                    dataBreve={dataBreve}
                  />
                ))}
              </div>

              {erroreFirma && <Avviso tono="errore" testo={erroreFirma} />}

              <div className="flex justify-end gap-3 border-t border-kidville-line pt-4">
                <Btn variant="ghost" size="sm" onClick={tornaAllaScelta}>
                  {t('indietro')}
                </Btn>
                <Btn variant="primary" size="md" onClick={vaiARivedi}>
                  {t('rivedi')} <ArrowRight size={16} aria-hidden="true" />
                </Btn>
              </div>
            </>
          )}
        </div>
      )}

      {/* 4 · Rivedi */}
      {alunnoId && passo === 'rivedi' && dettaglio?.modello && (
        <div className="space-y-4 rounded-card border border-kidville-line bg-white p-4 sm:p-5">
          <IntestazioneModulo
            titolo={scelto ? nomeModulo(scelto) : ''}
            onIndietro={() => setPasso('compila')}
            etichettaIndietro={t('indietro')}
          />
          <div>
            <h5 className="font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">
              {t('riepilogoTitolo')}
            </h5>
            <p className="mt-0.5 font-maven text-xs text-kidville-sub">{t('riepilogoSottotitolo')}</p>
          </div>

          {alunno && (
            <DatiDellApp
              alunno={alunno}
              sede={elenco?.sede ?? null}
              annoScolastico={elenco?.annoScolastico ?? null}
              dataBreve={dataBreve}
            />
          )}

          <Riepilogo
            campi={campi}
            risposte={risposte}
            delegati={dettaglio.delegati ?? null}
            certificati={certificati}
            dataBreve={dataBreve}
          />

          <div className="flex justify-end gap-3 border-t border-kidville-line pt-4">
            <Btn variant="ghost" size="sm" onClick={() => setPasso('compila')}>
              <ArrowLeft size={16} aria-hidden="true" /> {t('indietro')}
            </Btn>
            <Btn
              variant="primary"
              size="md"
              aria-disabled={inCorso === 'invio'}
              onClick={() => (otpAncoraValido ? setPasso('firma') : chiediCodice(false))}
            >
              <ShieldCheck size={16} aria-hidden="true" />
              {inCorso === 'invio'
                ? t('invioInCorso')
                : otpAncoraValido
                  ? t('otpConferma')
                  : t('otpInvia')}
            </Btn>
          </div>

          {erroreFirma && <Avviso tono="errore" testo={erroreFirma} />}
        </div>
      )}

      {/* 5 · Firma */}
      {alunnoId && passo === 'firma' && otp && (
        <div className="space-y-4 rounded-card border border-kidville-line bg-white p-4 sm:p-5">
          <div>
            <h5 className="font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">
              {t('otpTitolo')}
            </h5>
            <p className="mt-0.5 font-maven text-xs text-kidville-sub">{t('otpSottotitolo')}</p>
            <p className="mt-2 font-maven text-xs text-kidville-sub">
              {otp.email ? t('otpInviatoA', { email: otp.email }) : t('otpInviato')}
            </p>
          </div>

          {avviso && <Avviso tono="attenzione" testo={avviso} />}

          <div>
            <label htmlFor={`${uid}-otp`} className="mb-1 block font-maven text-xs font-semibold text-kidville-green">
              {t('otpCodice')}
            </label>
            <input
              id={`${uid}-otp`}
              value={codice}
              onChange={(e) => setCodice(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={t('otpCodiceSegnaposto')}
              aria-invalid={erroreFirma ? true : undefined}
              aria-describedby={erroreFirma ? `${uid}-otp-errore` : undefined}
              className={`${CLASSE_CAMPO} text-center font-mono text-xl tracking-[0.4em]`}
            />
          </div>

          {erroreFirma && (
            <p id={`${uid}-otp-errore`} role="alert" className="flex items-center gap-1.5 font-maven text-xs text-kidville-error-strong">
              <AlertTriangle size={14} aria-hidden="true" /> {erroreFirma}
            </p>
          )}

          <div className="flex flex-col gap-2 border-t border-kidville-line pt-4 sm:flex-row sm:items-center sm:justify-between">
            {/* `disabled` solo per l'attesa, che è un comando davvero non disponibile; per
                l'invio in corso `aria-disabled` più la guardia dentro `chiediCodice` — un
                `disabled` mentre la richiesta è in volo fa scappare il fuoco su `<body>`
                (vedi la testata di `Btn`). */}
            <button
              type="button"
              onClick={() => chiediCodice(true)}
              disabled={attesaRinvio > 0}
              aria-disabled={inCorso !== null || undefined}
              className="font-maven text-xs font-semibold text-kidville-green underline disabled:text-kidville-sub disabled:no-underline"
            >
              {attesaRinvio > 0 ? t('otpAttesa', { n: attesaRinvio }) : t('otpRinvia')}
            </button>
            <div className="flex justify-end gap-3">
              <Btn variant="ghost" size="sm" onClick={() => setPasso('rivedi')}>
                {t('indietro')}
              </Btn>
              <Btn
                variant="primary"
                size="md"
                aria-disabled={inCorso === 'firma' || codice.length !== 6}
                onClick={() => codice.length === 6 && firma()}
              >
                <ShieldCheck size={16} aria-hidden="true" />
                {inCorso === 'firma' ? t('firmaInCorso') : t('otpConferma')}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* 6 · Fatto */}
      {alunnoId && passo === 'fatto' && esito && (
        <Conferma esito={esito} slug={slug} onNuovo={tornaAllaScelta} dataOra={dataOra} />
      )}
    </section>
  );
}

// ─── I pezzi ────────────────────────────────────────────────────────────────────

function IntestazioneModulo({
  titolo,
  onIndietro,
  etichettaIndietro,
}: {
  titolo: string;
  onIndietro: () => void;
  etichettaIndietro: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <h4 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">{titolo}</h4>
      <button
        type="button"
        onClick={onIndietro}
        className="flex min-h-[44px] shrink-0 items-center rounded-pill border border-kidville-green px-4 font-maven text-xs font-bold text-kidville-green"
      >
        {etichettaIndietro}
      </button>
    </div>
  );
}

/**
 * Una voce dell'elenco dei modelli.
 *
 * Il pulsante spento DICE PERCHÉ: `motivoNonFirmabile` è un enumerato e la frase viene dal
 * catalogo, non dalla prosa del server.
 *
 * ─── I DUE CERTIFICATI NON SONO PIÙ «UNA COPIA NON PROTOCOLLATA» ────────────────
 *
 * Qui c'erano il bollino «Copia a uso della famiglia — non protocollata» e l'avviso «se un
 * ente lo vuole protocollato, chiedilo in segreteria». Erano veri quando il certificato
 * nasceva da jsPDF nel browser, senza numero e senza archivio; dal 2026-08-16 lo emette
 * `POST /api/parent/prestampati` — carta intestata, firma del legale rappresentante,
 * numero di protocollo in uscita, copia nel fascicolo — e quelle due frasi sarebbero
 * diventate **false su un foglio diretto all'INPS o a un datore di lavoro**. Al loro posto
 * c'è ciò che il foglio è davvero.
 *
 * ─── PERCHÉ LE AZIONI STANNO FUORI DALLA SCHEDA ─────────────────────────────────
 *
 * La scheda di un modulo firmabile È un pulsante (aprire il modulo è il gesto principale),
 * e un pulsante dentro un pulsante non è HTML valido: un clic su «Scarica» aprirebbe anche
 * il modulo. Le azioni sono quindi una riga sorella, sotto la scheda.
 *
 * ─── IL PESO VISIVO È LA PARTE CHE CONTA ────────────────────────────────────────
 *
 * «Generane uno nuovo» è un `ghost` piccolo e non un `primary`: emette un numero di
 * protocollo, e il registro è WORM — un numero consumato non torna indietro. Se avesse lo
 * stesso peso del riscarico, il genitore ne brucerebbe uno ogni volta che vuole rivedere
 * il proprio certificato. Non è un dettaglio di stile: è la differenza fra un registro che
 * conta i documenti emessi e uno che conta i clic.
 */
function SchedaModello({
  modello,
  titolo,
  descrizione,
  motivo,
  onScegli,
  onDocumento,
  inCorso,
  esitoGesto,
  uscita,
  dataBreve,
}: {
  modello: ModelloElencoDTO;
  titolo: string;
  descrizione: string;
  motivo: string;
  onScegli: () => void;
  onDocumento: (nuovo: boolean) => void;
  inCorso: boolean;
  /** L'esito dell'ULTIMO gesto su QUESTA scheda, o `null`: si disegna qui, non in cima. */
  esitoGesto: { testo: string; tono: 'errore' | 'attenzione' } | null;
  uscita: { destinazione: string; data: string; oraPartenza: string | null; oraRientro: string | null } | null;
  dataBreve: (v: string | null) => string;
}) {
  const t = useTranslations('prestampatiGenitore');
  const certificato = modello.protocollo === 'uscita';
  const dueFirme = modello.firma === 'otp_due_genitori';
  const archiviato = !!modello.documentoArchiviatoId;
  /**
   * Il certificato si può EMETTERE per questo bambino?
   *
   * `!== false` e non `=== true`: una risposta senza il campo — un server più vecchio del
   * client, durante un rilascio — deve lasciare il pulsante dov'era, e sarà il POST a dire
   * di no. La direzione in cui si sbaglia si sceglie, e qui si sceglie di non spegnere.
   */
  const emettibile = modello.generabileOra !== false;
  /** Il perché, quando c'è: viene dal catalogo bilingue, mai dalla prosa del server. */
  const motivoEmissione = modello.motivoNonGenerabile
    ? CHIAVE_MOTIVO_CERTIFICATO[modello.motivoNonGenerabile]
    : undefined;

  const corpo = (
    <>
      <div className="flex items-start gap-3">
        <FileText size={18} className="mt-0.5 shrink-0 text-kidville-green" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-barlow text-base font-bold uppercase tracking-wide text-kidville-green">{titolo}</p>
          <p className="mt-1 font-maven text-xs leading-relaxed text-kidville-sub">{descrizione}</p>
        </div>
        {modello.firmabileOra ? (
          <ArrowRight size={18} className="ml-auto mt-0.5 shrink-0 text-kidville-green" aria-hidden="true" />
        ) : (
          <Lock size={16} className="ml-auto mt-0.5 shrink-0 text-kidville-sub" aria-hidden="true" />
        )}
      </div>

      {certificato && (
        <p className="mt-3 inline-flex rounded-pill bg-kidville-yellow-light px-2.5 py-1 font-maven text-[11px] font-bold text-kidville-green">
          {t('certificatoProtocollato')}
        </p>
      )}

      {/* La gita che si sta autorizzando, prima di aprire il modulo: dove si va e quando.
          Un'autorizzazione che non dice la destinazione si firma alla cieca.

          ⚠️ DUE FRASI E NON UNA, perché gli orari POSSONO mancare: l'unica schermata che crea
          uscite (`TeacherAgendaCard` → `agenda:POST`) non li scrive, e fino al 2026-08-16 il
          server rispondeva a quel caso con «nessuna gita», cioè il modulo non compariva mai.
          Ora compare, e la riga dice ciò che si sa: `partenza , rientro` con due valori vuoti
          si legge come un orario deciso e non comunicato — è la stessa disciplina dei
          prestampati, «mai una riga vuota che sembri un valore». */}
      {uscita && (
        <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-ink">
          {uscita.oraPartenza && uscita.oraRientro
            ? t('uscitaRiga', {
                destinazione: uscita.destinazione,
                data: dataBreve(uscita.data),
                partenza: uscita.oraPartenza,
                rientro: uscita.oraRientro,
              })
            : t('uscitaRigaSenzaOrari', {
                destinazione: uscita.destinazione,
                data: dataBreve(uscita.data),
              })}
        </p>
      )}

      {dueFirme && (
        <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-sub">
          {t('firmaDueGenitori')} {t('firmaInAttesa')}
        </p>
      )}

      {!modello.firmabileOra && !certificato && (
        <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-sub">{motivo}</p>
      )}

      {/* Il certificato che per QUESTO bambino non si emette lo dice sulla scheda, invece di
          promettere un pulsante che il server rifiuterà: sulla sede di Giugliano la
          maggioranza dei bambini non è al nido, quindi era il caso normale, non il limite. */}
      {certificato && !emettibile && motivoEmissione && (
        <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-sub">
          {t(motivoEmissione)}
        </p>
      )}

      {archiviato && modello.documentoArchiviatoIl && (
        <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-sub">
          {t('documentoArchiviatoIl', { data: dataBreve(modello.documentoArchiviatoIl) })}
          {/* Il numero accanto alla data, ed è dove il genitore lo cerca: senza, per sapere
              se il foglio che manda all'INPS è il 5 o il 6 doveva aprire il PDF. In un
              elemento suo, non concatenato: è un dato, e si deve poter leggere da solo. */}
          {modello.protocolloArchiviato && (
            <>
              {' '}
              <span>{t('certificatoNumero', { numero: modello.protocolloArchiviato })}</span>
            </>
          )}
        </p>
      )}
    </>
  );

  const scheda = modello.firmabileOra ? (
    <button
      type="button"
      onClick={onScegli}
      className="w-full rounded-card border border-kidville-line bg-white p-4 text-left transition-colors hover:border-kidville-green"
    >
      {corpo}
    </button>
  ) : (
    <div className="rounded-card border border-dashed border-kidville-line bg-kidville-neutral-soft p-4 text-left">
      {corpo}
    </div>
  );

  /**
   * I due certificati si generano da qui; gli altri sei si riscaricano solo se firmati.
   *
   * ⚠️ E un certificato NON emettibile per questo bambino non porta nessun pulsante — a meno
   * che uno ce ne sia già in archivio, e allora il riscarico resta: un bambino passato
   * dal nido all'infanzia non deve perdere il certificato che ha già. Ciò che sparisce in
   * quel caso è «Generane uno nuovo», più sotto.
   */
  const mostraAzioni = (certificato && emettibile) || archiviato;
  if (!mostraAzioni) return esitoGesto ? conEsito(scheda, esitoGesto) : scheda;

  return conEsito(
    <div className="space-y-2">
      {scheda}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Btn
          variant={certificato ? 'primary' : 'ghost'}
          size="sm"
          aria-disabled={inCorso || undefined}
          onClick={() => onDocumento(false)}
        >
          <Download size={15} aria-hidden="true" />
          {/* Tre etichette e non due: «Scarica il certificato» su una scheda sanitaria
              firmata sarebbe una parola sbagliata su un documento sanitario. */}
          {inCorso
            ? t('certificatoInCorso')
            : !certificato
              ? t('documentoScarica')
              : archiviato
                ? t('certificatoScarica')
                : t('certificatoGenera')}
        </Btn>
        {/* «Generane uno nuovo» sparisce se un altro non se ne può emettere: offrirlo su un
            bambino che il nido non lo frequenta più sarebbe un numero di protocollo bruciato
            per ottenere un 422. */}
        {certificato && archiviato && emettibile && (
          <button
            type="button"
            onClick={() => onDocumento(true)}
            aria-disabled={inCorso || undefined}
            className="font-maven text-xs font-semibold text-kidville-sub underline underline-offset-2 hover:text-kidville-green"
          >
            {t('certificatoNuovo')}
          </button>
        )}
        {certificato && archiviato && emettibile && (
          <span className="basis-full font-maven text-[11px] leading-relaxed text-kidville-sub">
            {t('certificatoNuovoAiuto')}
          </span>
        )}
      </div>
    </div>,
    esitoGesto,
  );
}

/**
 * L'esito del gesto, disegnato SOTTO la scheda che l'ha chiesto e dentro la stessa voce.
 *
 * 🔴 È la riparazione del rifiuto invisibile: con il banner in cima all'elenco, il messaggio
 * del Bonus Nido finiva a `y = -777` su una finestra da telefono e nessuno lo vedeva. Qui è
 * a un dito dal pulsante, e non c'è nessuno scroll da azzeccare.
 *
 * `role="status"` e non `role="alert"`: non interrompe chi sta leggendo, ma viene annunciato
 * — perché chi usa uno screen reader non ha nemmeno la riga rossa della console.
 */
function conEsito(
  scheda: ReactNode,
  esito: { testo: string; tono: 'errore' | 'attenzione' } | null,
): ReactNode {
  if (!esito) return scheda;
  return (
    <div className="space-y-2">
      {scheda}
      <div role="status">
        <Avviso tono={esito.tono} testo={esito.testo} />
      </div>
    </div>
  );
}

/** Ciò che l'app sa già e non richiede: si mostra, non si compila. */
function DatiDellApp({
  alunno,
  sede,
  annoScolastico,
  dataBreve,
}: {
  alunno: NonNullable<RispostaPrestampati['alunno']>;
  sede: { nome: string | null; citta: string | null } | null;
  annoScolastico: string | null;
  dataBreve: (v: string | null) => string;
}) {
  const t = useTranslations('prestampatiGenitore');
  const mancante = t('nonIndicato');
  const nascita = [alunno.dataNascita ? dataBreve(alunno.dataNascita) : '', alunno.luogoNascita ?? '']
    .filter(Boolean)
    .join(' · ');

  const righe: { etichetta: string; valore: string }[] = [
    { etichetta: t('datiApp.bambino'), valore: `${alunno.cognome} ${alunno.nome}`.trim() || mancante },
    { etichetta: t('datiApp.nascita'), valore: nascita || mancante },
    { etichetta: t('datiApp.codiceFiscale'), valore: alunno.codiceFiscale || mancante },
    { etichetta: t('datiApp.sezione'), valore: alunno.sezione || mancante },
    { etichetta: t('datiApp.sede'), valore: sede?.nome || mancante },
    { etichetta: t('datiApp.annoScolastico'), valore: annoScolastico || mancante },
  ];

  return (
    <section className="rounded-xl border border-kidville-line bg-kidville-cream/50 p-3">
      <h5 className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
        {t('datiApp.titolo')}
      </h5>
      <dl className="mt-2 space-y-1">
        {righe.map((r) => (
          <div key={r.etichetta} className="flex gap-2 font-maven text-xs">
            <dt className="min-w-[128px] shrink-0 text-kidville-sub">{r.etichetta}</dt>
            <dd className="font-semibold text-kidville-ink">{r.valore}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Un campo del modulo. Si disegna da ciò che il modello DICHIARA — `tipo`, `obbligatorio`,
 * `opzioni`, `mostraSe`, `multipla`, `colonne` — e non da un elenco di nomi tenuto a mano:
 * un campo nuovo nel modello compare qui senza che nessuno tocchi questo file.
 *
 * È ricorsivo perché lo sono i modelli: una tabella `righe` contiene colonne che sono campi
 * a tutti gli effetti, e il loro `mostraSe` guarda la RIGA, non il modulo.
 */
function CampoView({
  campo,
  percorso,
  idBase,
  valore,
  onValore,
  errore,
  mancante,
  erroriCampo,
  mancanti,
  delegati,
  delegatiNonLetti,
  certificati,
  certificatiNonLetti,
  certificatiInCorso,
  alunnoId,
  dataBreve,
}: {
  campo: CampoDTO;
  percorso: string;
  idBase: string;
  valore: unknown;
  onValore: (v: unknown) => void;
  errore?: string;
  mancante: boolean;
  erroriCampo: Record<string, string>;
  mancanti: Record<string, true>;
  delegati: DelegatoDTO[] | null;
  delegatiNonLetti: boolean;
  certificati: CertificatoMedico[] | null;
  certificatiNonLetti: boolean;
  certificatiInCorso: boolean;
  alunnoId: string;
  dataBreve: (v: string | null) => string;
}) {
  const t = useTranslations('prestampatiGenitore');
  const idCampo = idBase;
  const idAiuto = `${idBase}-aiuto`;
  const idErrore = `${idBase}-errore`;
  const messaggio = errore ?? (mancante ? t('campoObbligatorio') : null);
  const descritto = [campo.aiuto ? idAiuto : '', messaggio ? idErrore : ''].filter(Boolean).join(' ');

  const etichetta = (
    <span className="block font-maven text-sm font-semibold text-kidville-green">
      {campo.etichetta}
      {campo.obbligatorio && <span className="text-kidville-error"> *</span>}
    </span>
  );

  // ── Tabella a righe ripetibili ────────────────────────────────────────────────
  if (campo.tipo === 'righe') {
    const righe = Array.isArray(valore) ? (valore as Risposte[]) : [];
    const aggiorna = (i: number, nome: string, v: unknown) =>
      onValore(righe.map((r, k) => (k === i ? { ...r, [nome]: v } : r)));

    return (
      <fieldset className="space-y-3">
        <legend className="mb-1">{etichetta}</legend>
        {campo.aiuto && (
          <p id={idAiuto} className="font-maven text-xs text-kidville-sub">
            {campo.aiuto}
          </p>
        )}
        {righe.map((riga, i) => (
          <div key={`${percorso}-${i}`} className="space-y-3 rounded-xl border border-kidville-line p-3">
            <div className="flex items-center justify-between">
              <span className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                {t('riga', { n: i + 1 })}
              </span>
              {righe.length > 1 && (
                <button
                  type="button"
                  onClick={() => onValore(righe.filter((_, k) => k !== i))}
                  aria-label={t('rimuoviRiga')}
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-kidville-sub hover:text-kidville-error-strong"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              )}
            </div>
            {campiVisibili(campo.colonne ?? [], riga).map((colonna) => (
              <CampoView
                key={colonna.nome}
                campo={colonna}
                percorso={`${percorso}.${i}.${colonna.nome}`}
                idBase={`${idBase}-${i}-${colonna.nome}`}
                valore={riga[colonna.nome]}
                onValore={(v) => aggiorna(i, colonna.nome, v)}
                errore={erroriCampo[`${percorso}.${i}.${colonna.nome}`]}
                mancante={!!mancanti[`${percorso}.${i}.${colonna.nome}`]}
                erroriCampo={erroriCampo}
                mancanti={mancanti}
                delegati={delegati}
                delegatiNonLetti={delegatiNonLetti}
                certificati={certificati}
                certificatiNonLetti={certificatiNonLetti}
                certificatiInCorso={certificatiInCorso}
                alunnoId={alunnoId}
                dataBreve={dataBreve}
              />
            ))}
          </div>
        ))}
        <button
          type="button"
          onClick={() => onValore([...righe, rigaVuota()])}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-pill border border-kidville-green px-4 font-maven text-xs font-bold text-kidville-green"
        >
          <Plus size={14} aria-hidden="true" /> {t('aggiungiRiga')}
        </button>
        {messaggio && (
          <p id={idErrore} role="alert" className="font-maven text-xs text-kidville-error-strong">
            {messaggio}
          </p>
        )}
      </fieldset>
    );
  }

  // ── Sì / No ───────────────────────────────────────────────────────────────────
  if (campo.tipo === 'siNo') {
    return (
      <fieldset>
        <legend className="mb-1.5">{etichetta}</legend>
        {campo.aiuto && (
          <p id={idAiuto} className="mb-1.5 font-maven text-xs text-kidville-sub">
            {campo.aiuto}
          </p>
        )}
        <div className="flex gap-2">
          {[true, false].map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={valore === v}
              onClick={() => onValore(v)}
              className={`min-h-[44px] rounded-pill border-2 px-5 font-maven text-sm font-semibold transition-colors ${
                valore === v
                  ? 'border-kidville-green bg-kidville-green text-kidville-yellow-ink'
                  : 'border-kidville-line text-kidville-sub'
              }`}
            >
              {v ? t('si') : t('no')}
            </button>
          ))}
        </div>
        {messaggio && (
          <p id={idErrore} role="alert" className="mt-1 font-maven text-xs text-kidville-error-strong">
            {messaggio}
          </p>
        )}
      </fieldset>
    );
  }

  // ── Scelta multipla (i giorni di un permesso ricorrente) ──────────────────────
  if (campo.tipo === 'scelta' && campo.multipla) {
    const scelte = Array.isArray(valore) ? (valore as string[]) : [];
    return (
      <fieldset>
        <legend className="mb-1.5">{etichetta}</legend>
        {campo.aiuto && (
          <p id={idAiuto} className="mb-1.5 font-maven text-xs text-kidville-sub">
            {campo.aiuto}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {(campo.opzioni ?? []).map((o) => {
            const attiva = scelte.includes(o.valore);
            return (
              <button
                key={o.valore}
                type="button"
                aria-pressed={attiva}
                onClick={() =>
                  onValore(attiva ? scelte.filter((s) => s !== o.valore) : [...scelte, o.valore])
                }
                className={`min-h-[44px] rounded-pill border-2 px-4 font-maven text-sm font-semibold transition-colors ${
                  attiva
                    ? 'border-kidville-green bg-kidville-green text-kidville-yellow-ink'
                    : 'border-kidville-line text-kidville-sub'
                }`}
              >
                {o.etichetta}
              </button>
            );
          })}
        </div>
        {messaggio && (
          <p id={idErrore} role="alert" className="mt-1 font-maven text-xs text-kidville-error-strong">
            {messaggio}
          </p>
        )}
      </fieldset>
    );
  }

  // ── Chi ritira il bambino: l'elenco lo costruisce l'app ───────────────────────
  //
  // ⚠️ QUI NON SI SCRIVE UN NOME A MANO, e non è una semplificazione: la firma risolve la
  // scelta in un nome SOLO se è l'uuid di un delegato di questo bambino (o il valore
  // convenzionale «io stesso»). Qualunque altra stringa arriva al modello come delegato non
  // risolto e il foglio viene rifiutato con «Il delegato indicato non risulta fra i delegati
  // attivi» — cioè un campo di testo libero sarebbe un muro con l'aria di una via d'uscita.
  // Quando l'elenco non si è caricato la schermata lo DICE (`delegatiNonLetti`, mostrato più
  // in alto) invece di far scrivere un nome che verrebbe respinto.
  if (campo.opzioniDaApp === 'delegati_attivi') {
    return (
      <div>
        <label htmlFor={idCampo} className="mb-1 block">
          {etichetta}
        </label>
        {campo.aiuto && (
          <p id={idAiuto} className="mb-1 font-maven text-xs text-kidville-sub">
            {campo.aiuto}
          </p>
        )}
        <select
          id={idCampo}
          value={typeof valore === 'string' ? valore : ''}
          onChange={(e) => onValore(e.target.value)}
          aria-invalid={messaggio ? true : undefined}
          aria-describedby={descritto || undefined}
          className={CLASSE_CAMPO}
        >
          <option value="">{t('scegliSegnaposto')}</option>
          <option value={ACCOMPAGNATORE_GENITORE}>{t('accompagnatoreIoStesso')}</option>
          {(delegati ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.relazione ? `${d.nomeCompleto} · ${d.relazione}` : d.nomeCompleto}
            </option>
          ))}
        </select>
        {!delegatiNonLetti && (delegati?.length ?? 0) === 0 && (
          <p className="mt-1 font-maven text-xs text-kidville-sub">{t('delegatiVuoti')}</p>
        )}
        {messaggio && (
          <p id={idErrore} role="alert" className="mt-1 font-maven text-xs text-kidville-error-strong">
            {messaggio}
          </p>
        )}
      </div>
    );
  }

  // ── L'allegato ────────────────────────────────────────────────────────────────
  //
  // Il file NON si carica da qui: la porta della famiglia è `POST /api/parent/medical-
  // certificates` (scheda «Certificati Medici»), e la sua risposta non restituisce il
  // percorso nello storage — è un dato sanitario e resta al server. La chiave si RICOMPONE
  // dalle due parti che l'elenco espone, `alunno_id` e `fileName`, che sono esattamente
  // com'è fatto `<alunnoId>/<uuid>.<estensione>`; il prefisso del magazzino serve perché una
  // chiave nuda varrebbe per il bucket del fascicolo, dove la famiglia non scrive.
  if (campo.tipo === 'file') {
    if (!CAMPI_ALLEGATO_SANITARIO.has(campo.nome)) {
      return (
        <div>
          {etichetta}
          <p className="mt-1 font-maven text-xs leading-relaxed text-kidville-sub">{t('allegatoNonCaricabile')}</p>
        </div>
      );
    }
    return (
      <div>
        <label htmlFor={idCampo} className="mb-1 block">
          {etichetta}
        </label>
        <p id={idAiuto} className="mb-1 font-maven text-xs text-kidville-sub">
          {campo.aiuto ?? t('allegatoAiuto')}
        </p>
        {certificatiNonLetti ? (
          <p className="font-maven text-xs text-kidville-error-strong">{t('allegatoNonLetto')}</p>
        ) : certificatiInCorso ? (
          <p className="font-maven text-xs text-kidville-sub">{t('caricamento')}</p>
        ) : (certificati ?? []).length === 0 ? (
          <p className="font-maven text-xs leading-relaxed text-kidville-sub">{t('allegatoVuoto')}</p>
        ) : (
          <select
            id={idCampo}
            value={typeof valore === 'string' ? valore : ''}
            onChange={(e) => onValore(e.target.value)}
            aria-invalid={messaggio ? true : undefined}
            aria-describedby={descritto || undefined}
            className={CLASSE_CAMPO}
          >
            <option value="">{t('allegatoScegli')}</option>
            {(certificati ?? []).map((c) => (
              <option key={c.id} value={`${MAGAZZINO_CERTIFICATI}:${alunnoId}/${c.fileName}`}>
                {t('allegatoVoce', { data: dataBreve(c.creato_il ?? null) })}
              </option>
            ))}
          </select>
        )}
        {messaggio && (
          <p id={idErrore} role="alert" className="mt-1 font-maven text-xs text-kidville-error-strong">
            {messaggio}
          </p>
        )}
      </div>
    );
  }

  // ── I campi semplici ──────────────────────────────────────────────────────────
  const testo = typeof valore === 'string' ? valore : typeof valore === 'number' ? String(valore) : '';

  return (
    <div>
      <label htmlFor={idCampo} className="mb-1 block">
        {etichetta}
      </label>
      {campo.aiuto && (
        <p id={idAiuto} className="mb-1 font-maven text-xs text-kidville-sub">
          {campo.aiuto}
        </p>
      )}

      {campo.tipo === 'scelta' ? (
        <select
          id={idCampo}
          value={testo}
          onChange={(e) => onValore(e.target.value)}
          aria-invalid={messaggio ? true : undefined}
          aria-describedby={descritto || undefined}
          className={CLASSE_CAMPO}
        >
          <option value="">{t('scegliSegnaposto')}</option>
          {(campo.opzioni ?? []).map((o) => (
            <option key={o.valore} value={o.valore}>
              {o.etichetta}
            </option>
          ))}
        </select>
      ) : campo.tipo === 'testoLungo' ? (
        <textarea
          id={idCampo}
          value={testo}
          onChange={(e) => onValore(e.target.value)}
          aria-invalid={messaggio ? true : undefined}
          aria-describedby={descritto || undefined}
          className={`${CLASSE_CAMPO} h-24 resize-none`}
        />
      ) : campo.tipo === 'data' ? (
        <DateField
          id={idCampo}
          value={testo}
          onChange={(iso) => onValore(iso)}
          aria-describedby={descritto || undefined}
          className={CLASSE_CAMPO}
        />
      ) : (
        <input
          id={idCampo}
          type={campo.tipo === 'ora' ? 'time' : campo.tipo === 'numero' ? 'number' : campo.tipo === 'telefono' ? 'tel' : 'text'}
          inputMode={campo.tipo === 'numero' ? 'numeric' : campo.tipo === 'telefono' ? 'tel' : undefined}
          value={testo}
          onChange={(e) =>
            // Il `numero` viaggia come numero: lo schema lo accetterebbe anche come stringa
            // (`z.coerce.number()`), ma un campo vuoto convertito a `0` dichiarerebbe uno zero
            // che nessuno ha scritto — sull'ordine di chiamata di un contatto d'emergenza
            // sarebbe un dato inventato.
            onValore(
              campo.tipo === 'numero'
                ? e.target.value === ''
                  ? ''
                  : Number(e.target.value)
                : e.target.value,
            )
          }
          aria-invalid={messaggio ? true : undefined}
          aria-describedby={descritto || undefined}
          className={CLASSE_CAMPO}
        />
      )}

      {messaggio && (
        <p id={idErrore} role="alert" className="mt-1 font-maven text-xs text-kidville-error-strong">
          {messaggio}
        </p>
      )}
    </div>
  );
}

/** Il riepilogo prima della firma: le stesse etichette del modulo, i valori resi leggibili. */
function Riepilogo({
  campi,
  risposte,
  delegati,
  certificati,
  dataBreve,
}: {
  campi: readonly CampoDTO[];
  risposte: Risposte;
  delegati: DelegatoDTO[] | null;
  certificati: CertificatoMedico[] | null;
  dataBreve: (v: string | null) => string;
}) {
  const t = useTranslations('prestampatiGenitore');
  const vuoto = t('nonIndicato');

  const leggibile = (campo: CampoDTO, valore: unknown): string => {
    if (valore === true) return t('si');
    if (valore === false) return t('no');
    if (valoreVuoto(valore)) return vuoto;
    if (campo.opzioniDaApp === 'delegati_attivi') {
      if (valore === ACCOMPAGNATORE_GENITORE) return t('accompagnatoreIoStesso');
      return delegati?.find((d) => d.id === valore)?.nomeCompleto ?? vuoto;
    }
    if (campo.tipo === 'file') {
      const chiave = String(valore).split('/').pop();
      const c = (certificati ?? []).find((x) => x.fileName === chiave);
      return c ? t('allegatoVoce', { data: dataBreve(c.creato_il ?? null) }) : vuoto;
    }
    if (campo.tipo === 'data') return dataBreve(String(valore)) || String(valore);
    if (Array.isArray(valore)) {
      return valore
        .map((v) => (campo.opzioni ?? []).find((o) => o.valore === v)?.etichetta ?? String(v))
        .join(', ');
    }
    if (campo.opzioni && campo.opzioni.length > 0) {
      return campo.opzioni.find((o) => o.valore === valore)?.etichetta ?? String(valore);
    }
    return String(valore);
  };

  return (
    <dl className="space-y-2 rounded-xl border border-kidville-line p-3">
      {campiVisibili(campi, risposte).map((campo) => {
        const valore = risposte[campo.nome];
        if (campo.tipo === 'righe') {
          const righe = Array.isArray(valore) ? (valore as Risposte[]) : [];
          return (
            <div key={campo.nome} className="font-maven text-xs">
              <dt className="text-kidville-sub">{campo.etichetta}</dt>
              <dd className="mt-1 space-y-1">
                {righe.length === 0 ? (
                  <span className="text-kidville-ink">{vuoto}</span>
                ) : (
                  righe.map((riga, i) => (
                    <p key={`${campo.nome}-${i}`} className="text-kidville-ink">
                      {campiVisibili(campo.colonne ?? [], riga)
                        .map((c) => `${c.etichetta}: ${leggibile(c, riga[c.nome])}`)
                        .join(' · ')}
                    </p>
                  ))
                )}
              </dd>
            </div>
          );
        }
        return (
          <div key={campo.nome} className="flex gap-2 font-maven text-xs">
            <dt className="min-w-[128px] shrink-0 text-kidville-sub">{campo.etichetta}</dt>
            <dd className="text-kidville-ink">{leggibile(campo, valore)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * L'esito della firma, nei TRE rami che il PATCH può prendere — e nessuno dei tre si
 * traveste da un altro.
 *
 * `archiviato: true` è il caso felice; `inAttesaAccettazione: true` è il n. 06, firmato ma
 * non ancora valido, con il PDF che esiste solo dentro questa risposta;
 * `motivoMancatoArchivio` è il foglio firmato che in archivio non è entrato. Negli ultimi
 * due il download non è un di più: è l'unica copia che la famiglia riceve, e la schermata
 * lo dice invece di annunciare un archivio che non c'è.
 */
function Conferma({
  esito,
  slug,
  onNuovo,
  dataOra,
}: {
  esito: EsitoFirma;
  slug: string;
  onNuovo: () => void;
  dataOra: (v: string | null) => string;
}) {
  const t = useTranslations('prestampatiGenitore');

  const inAttesa = esito.inAttesaAccettazione === true;
  const nonArchiviato = !inAttesa && esito.archiviato === false;
  const chiaveMotivo = esito.motivoMancatoArchivio
    ? CHIAVE_MANCATO_ARCHIVIO[esito.motivoMancatoArchivio]
    : undefined;

  const titolo = inAttesa
    ? t('inAttesaDirezioneTitolo')
    : nonArchiviato
      ? t('mancatoArchivioTitolo')
      : t('confermaTitolo');

  const testo = inAttesa
    ? t('inAttesaDirezioneTesto')
    : nonArchiviato
      ? t(chiaveMotivo ?? 'mancatoArchivioArchivioNonScritto')
      : t('confermaTesto');

  const tono = inAttesa || nonArchiviato ? 'attenzione' : 'ok';

  return (
    <div className="space-y-4 rounded-card border border-kidville-line bg-white p-4 sm:p-5" role="status">
      <div className="flex items-start gap-3">
        {tono === 'ok' ? (
          <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-kidville-success" aria-hidden="true" />
        ) : (
          <AlertTriangle size={22} className="mt-0.5 shrink-0 text-kidville-warn" aria-hidden="true" />
        )}
        <div>
          <h4 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">{titolo}</h4>
          <p className="mt-1 font-maven text-xs leading-relaxed text-kidville-sub">{testo}</p>
        </div>
      </div>

      {(esito.riferimentoFirma || esito.signature_log?.signed_at) && (
        <section className="rounded-xl border border-kidville-line bg-kidville-cream/50 p-3">
          <h5 className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
            {t('firmaDettaglio')}
          </h5>
          <dl className="mt-2 space-y-1 font-maven text-xs">
            {esito.signature_log?.signed_at && (
              <div className="flex gap-2">
                <dt className="min-w-[104px] shrink-0 text-kidville-sub">{t('firmaIstante')}</dt>
                <dd className="text-kidville-ink">{dataOra(esito.signature_log.signed_at)}</dd>
              </div>
            )}
            {esito.riferimentoFirma && (
              <div className="flex gap-2">
                <dt className="min-w-[104px] shrink-0 text-kidville-sub">{t('firmaRiferimento')}</dt>
                <dd className="break-all font-mono text-[11px] text-kidville-ink">{esito.riferimentoFirma}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <div className="flex flex-wrap justify-end gap-3 border-t border-kidville-line pt-4">
        {/* Qui manca il secondo comando, «Scarica la ricevuta della firma»: la voce di
            catalogo `scaricaRicevuta` esiste già ma NON si rende, e non per dimenticanza.
            `GET /api/fea/receipt` accetta `entita: z.enum(['pagella','giustifica','forms'])`
            e `firme_documenti` non ha una colonna dove conservare il `signature_log`, che
            oggi vive solo dentro la risposta 201 qui accanto. Il comando torna il giorno in
            cui esistono tutt'e due: un ramo `prestampato` in `resolveEntita` e la colonna
            per il log. La chiave resta perché quel giorno la frase è già scritta in due
            lingue — vedi la testata di `registraFirma` in `parent/prestampati/firma`. */}
        {esito.url ? (
          <a
            href={esito.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-pill bg-kidville-green px-6 py-2.5 font-barlow text-[15.5px] font-extrabold uppercase tracking-[0.05em] text-kidville-yellow-ink"
          >
            <Download size={16} aria-hidden="true" /> {t('scarica')}
          </a>
        ) : esito.pdfBase64 ? (
          <Btn variant="primary" size="md" onClick={() => scaricaBase64(esito.pdfBase64 as string, `${slug}.pdf`)}>
            <Download size={16} aria-hidden="true" /> {t('scarica')}
          </Btn>
        ) : null}
        <Btn variant="ghost" size="sm" onClick={onNuovo}>
          {t('nuovoModulo')}
        </Btn>
      </div>
    </div>
  );
}

/**
 * Un riquadro di avviso: errore, attenzione. Con un'azione facoltativa a destra.
 *
 * ⚠️ ANCHE IL TONO «ATTENZIONE» SI ANNUNCIA. Qui `role` compariva solo sull'errore, e
 * l'unica conferma del rinvio del codice OTP passa da qui: chi usa uno screen reader
 * premeva «Non è arrivato: rimandamelo» e non sentiva niente — nemmeno «il codice non
 * risulta consegnato», che è l'avviso che cambia il da farsi (si scrive alla segreteria
 * invece di aspettare). `status` invece di `alert` perché non interrompe la lettura in
 * corso: è un esito, non un guasto.
 */
function Avviso({
  tono,
  testo,
  icona: Icona,
  azione,
}: {
  tono: 'errore' | 'attenzione';
  testo: string;
  icona?: typeof AlertTriangle;
  azione?: { etichetta: string; onClick: () => void };
}) {
  const errore = tono === 'errore';
  const Segno = Icona ?? AlertTriangle;
  return (
    <div
      role={errore ? 'alert' : 'status'}
      className={`flex items-start justify-between gap-3 rounded-xl border px-3 py-2 font-maven text-xs leading-relaxed ${
        errore
          ? 'border-kidville-error bg-kidville-error-soft text-kidville-error-strong'
          : 'border-kidville-yellow bg-kidville-cream text-kidville-ink'
      }`}
    >
      <span className="flex items-start gap-2">
        <Segno size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        {testo}
      </span>
      {azione && (
        <button type="button" onClick={azione.onClick} className="shrink-0 font-bold underline">
          {azione.etichetta}
        </button>
      )}
    </div>
  );
}
