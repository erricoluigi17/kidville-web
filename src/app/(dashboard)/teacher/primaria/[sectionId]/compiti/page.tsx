'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FileText, Image as ImageIcon, Loader2, Paperclip, Users } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { annoScolasticoCorrente } from '@/lib/anno-scolastico';
import { addGiorni, isoToIt } from '@/lib/format/data';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco';
import { decidiStatoElenco } from '@/lib/ui/filtri/motore';

/**
 * ─── LA LINGUETTA «COMPITI» DELLA CLASSE ─────────────────────────────────────
 *
 * Tutti i compiti per casa di una classe in una lista sola, dal più recente. È
 * la stessa materia del registro vista dall'altro verso: il registro mostra UN
 * giorno con dentro tutto (argomento, firme, allegati), qui si mostra UNA cosa
 * sola — i compiti — su tutto il periodo. Prima di questa pagina, per sapere che
 * cosa era stato assegnato nella settimana bisognava aprire cinque giorni.
 *
 * Montata dentro `ClasseShell`, che porta già intestazione, nome della classe e
 * linguette: qui NON si rifà nessuna intestazione di pagina.
 *
 * ⚠️ NON sono i «compiti» di `/admin/compiti`, che nel cockpit sono i task
 * interni dello staff. Stessa parola, due cose diverse: questa vive dentro la
 * classe (`…/primaria/[sectionId]/compiti`) e non tocca quella voce di menu.
 *
 * La stessa pagina serve il docente e la segreteria: `/admin/primaria/[sectionId]/compiti`
 * è un re-export di questo file, come già fa il registro.
 */

/** La rotta della PAGINA: è il luogo dell'incidente, non l'URL della fetch. */
const ROTTA = '/teacher/primaria/[sectionId]/compiti';

// ─────────────────────────────────────────────────────────────────────────────
// Il contratto della GET (`src/app/api/primaria/compiti/route.ts`)
// ─────────────────────────────────────────────────────────────────────────────

/** Un allegato del registro. `file_url` è un URL FIRMATO, oppure `null`. */
interface Allegato {
  id: string;
  tipo: string | null;
  /**
   * PER CHE COSA È STATO CARICATO: `'argomento'` (la foto della lavagna, il
   * materiale della lezione) oppure `'compiti'` (il file che il bambino deve
   * fare a casa). `null` quando la riga non lo dichiara.
   *
   * 🔴 SI LEGGE, e non è un di più. La route lo espone APPOSTA e scrive nel
   * proprio commento che «a etichettarlo è la linguetta»: la linguetta è questa.
   * Il motivo è misurato, non teorico — `primaria/allegati:POST` ha
   * `.default('argomento')` e l'unico caricatore dell'app non manda mai il
   * campo, quindi OGGI il 100% degli allegati nascerebbe `'argomento'` e
   * comparirebbe qui, sotto la parola «Compiti», come se fosse il compito. Con
   * `allegati_registro` a zero righe non se ne accorgerebbe nessuno per mesi:
   * è la forma esatta del guasto delle email che rispondevano 403.
   *
   * Non si FILTRA (sarebbe una lista vuota per sempre, e la route lo dichiara):
   * si mostra tutto e si dice che cos'è.
   */
  ambito: string | null;
  file_name: string | null;
  /**
   * ⚠️ `null` = non si è potuto firmare allo Storage. Non è «nessun file»: è un
   * file che adesso non si apre. Ci si rende il NOME senza collegamento — un'ancora
   * verso `null` porta a `/…/compiti/null`, cioè una 404 al posto di un documento.
   * È la stessa regola che segue la vista del genitore.
   */
  file_url: string | null;
}

/** L'assegnazione mirata: il testo e QUANTI bambini, mai chi. */
interface Individualizzato {
  compiti: string;
  destinatari: number;
}

interface VoceCompito {
  id: string;
  data: string;
  ora_lezione: number;
  materia: string | null;
  compiti: string | null;
  data_consegna_compiti: string | null;
  allegati: Allegato[];
  individualizzati: Individualizzato[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Il periodo
// ─────────────────────────────────────────────────────────────────────────────

type Periodo = '30' | '90' | 'anno';

/**
 * Il periodo di partenza.
 *
 * ⚠️ NON è il «riposo» di un filtro, e la differenza non è di lessico: il
 * periodo è la CORNICE della richiesta — c'è sempre, anche a questo valore — e
 * nessun comando lo riporta qui dentro. Vedi il blocco sui testi dello stato
 * vuoto, più sotto.
 */
const PERIODO_PREDEFINITO: Periodo = '30';

const PERIODI: readonly { valore: Periodo; chiave: string }[] = [
  { valore: '30', chiave: 'classeCompitiPeriodo30' },
  { valore: '90', chiave: 'classeCompitiPeriodo90' },
  { valore: 'anno', chiave: 'classeCompitiPeriodoAnno' },
];

/**
 * IL TETTO CHE IL CLIENT SI DÀ, un giorno più stretto di quello della route.
 *
 * La route rifiuta con 400 un intervallo più lungo di 365 giorni
 * (`GIORNI_MAX_INTERVALLO`) e lo misura con il PROPRIO `oggiFiscaleISO()`. Il
 * `dataDa`, però, lo calcola il client: fra i due istanti può passare la
 * mezzanotte italiana, e con 365 esatti una richiesta composta alle 23:59:59 e
 * valutata un secondo dopo vale 366 → 400, con «Riprova» che ritenta
 * all'infinito perché a essere invecchiata è la data, non la rete. Il margine lo
 * dà questo clamp, non l'aritmetica: sul tetto della route il margine è ZERO.
 *
 * ⚠️ IL TETTO DELLA ROUTE È TORNATO A 365 (2026-09-19) INSIEME ALLA PAGINAZIONE,
 * e non è un ritorno al punto di partenza. Prima la finestra valeva 223 giorni
 * perché era il tetto delle RIGHE (`MAX_RIGHE`) travestito da tetto dei giorni:
 * un anno scolastico intero non ci stava, e la pastiglia «Anno scolastico»
 * prendeva un 400. Ora le righe si leggono a pagine, quindi la finestra può
 * dire di nuovo «un anno» senza promettere ciò che non può mantenere — ed è il
 * motivo per cui questa costante non si tocca: era e resta il margine del
 * confine di giornata.
 *
 * È la stessa costante, con la stessa ragione, della bacheca del genitore
 * (`GIORNI_INDIETRO_MASSIMI` in `LezioniCompitiSections`).
 */
const GIORNI_INDIETRO_MASSIMI = 364;

/**
 * Il `dataDa` che parte verso l'API.
 *
 * ⚠️ «Oggi» è `oggiFiscaleISO()` (fuso `Europe/Rome`), MAI
 * `new Date().toISOString()`: il runtime gira in UTC e fra mezzanotte e le due
 * italiane le due date non coincidono — il periodo partirebbe da un giorno che
 * in Italia non è ancora arrivato. È la stessa correzione già pagata quattro
 * volte in questo repo (appello, registro, conteggi delle email).
 *
 * ⚠️ L'OROLOGIO SI LEGGE UNA VOLTA SOLA, ed è il motivo della riga
 * `new Date(`${oggi}T12:00:00Z`)`. Fino al 2026-09-19 qui c'erano DUE letture —
 * `oggiFiscaleISO()` e il `new Date()` predefinito di `annoScolasticoCorrente()`
 * — con la soglia dell'anno scolastico proprio in mezzo: a cavallo della
 * mezzanotte romana del 1° agosto, per i microsecondi fra le due chiamate,
 * «oggi» poteva essere ancora il 31 luglio mentre l'anno era già quello nuovo, e
 * `dataDa` usciva il 1° agosto, cioè UN GIORNO NEL FUTURO rispetto a oggi.
 * `annoScolasticoCorrente` accetta una `Date` apposta: gliela si passa, derivata
 * dalla stessa lettura. Mezzogiorno UTC del giorno civile italiano cade sempre
 * dentro quello stesso giorno a Roma (UTC+1 o +2), quindi la conversione non
 * sposta di nuovo la data che si sta cercando di tenere ferma.
 *
 * ⚠️ «Anno» È L'ANNO SCOLASTICO, e lo decide `annoScolasticoCorrente()` — l'unica
 * definizione di anno scolastico che questo repo abbia (soglia al 1° agosto, col
 * giorno contato a Roma). NON `annoFiscale()`: quello vive in
 * `@/lib/format/fiscal-date`, che parla di data documento e di numerazione delle
 * fatture, ed era un errore di categoria alla sorgente. Si vedeva, misurato: col
 * 1° gennaio come inizio, il 10 gennaio «anno» copriva NOVE giorni — meno di
 * «Ultimi 30 giorni» — e restava più stretto di «Ultimi 90» fino al 31 marzo.
 * Per un quarto dell'anno scolastico, e proprio quello in cui i compiti sono più
 * fitti, chi chiedeva di vedere di PIÙ vedeva di MENO.
 *
 * ⚠️ La terza pastiglia non è il gradino più largo di una scala: è una CORNICE
 * con un nome, ed è il motivo per cui l'etichetta dice «Anno scolastico» e non
 * «Anno in corso». Fra agosto e ottobre contiene meno di 90 giorni, e deve: quel
 * che resta fuori è l'anno scolastico PRECEDENTE, che in questa linguetta non
 * c'entra.
 *
 * ⚠️ Si chiama da un gestore di evento o dentro la lettura, MAI nel corpo del
 * render: `new Date()` nel render è un disallineamento di idratazione in attesa
 * di accadere. (Stessa regola, stesse parole, del gemello del genitore.)
 */
function dataDaDelPeriodo(periodo: Periodo): string {
  const oggi = oggiFiscaleISO();
  const limite = addGiorni(oggi, -GIORNI_INDIETRO_MASSIMI);
  if (periodo === 'anno') {
    // `annoScolasticoCorrente()` → «2026/2027»: l'anno che apre è quello del 1° agosto.
    const inizio = `${annoScolasticoCorrente(new Date(`${oggi}T12:00:00Z`)).slice(0, 4)}-08-01`;
    // Confronto lessicografico su `YYYY-MM-DD`: coincide con quello di calendario.
    // Il clamp morde in un giorno solo — il 31 luglio di un anno bisestile, quando
    // il 1° agosto precedente dista 365 giorni — ed è esattamente il giorno in cui
    // senza di lui la route risponderebbe 400.
    return inizio < limite ? limite : inizio;
  }
  return addGiorni(oggi, -Number(periodo));
}

// ─────────────────────────────────────────────────────────────────────────────
// La lettura
// ─────────────────────────────────────────────────────────────────────────────

/** L'esito di una GET: mai un'eccezione, sempre qualcosa da mostrare. */
interface Esito {
  voci: VoceCompito[] | null;
  /**
   * IL CURSORE DELLA PAGINA SUCCESSIVA, oppure `null` = non c'è altro da leggere.
   *
   * ⚠️ È OPACO. Si rimanda identico alla route e non si interpreta, non si
   * confronta, non si costruisce: la sua forma appartiene a chi lo emette, e
   * qualunque lettura che ne facessimo qui diventerebbe un vincolo su un
   * dettaglio che la route ha il diritto di cambiare domani.
   */
  prossimoCursore: string | null;
}

/**
 * Il corpo della risposta COME ARRIVA, non come lo promette il contratto.
 *
 * `await res.json()` restituisce `any`: un `as` non controlla niente, e un 200
 * malformato (un proxy che riscrive, un deploy a metà, una route cambiata)
 * entrerebbe nella pagina come lista vuota — cioè come l'affermazione «in questo
 * periodo non è stato assegnato nessun compito», su una classe che nessuno ha
 * letto. È la conflazione contro cui la route spende tre commenti; qui la si
 * chiude dichiarando `unknown` proprio dove il contratto promette una lista.
 */
interface CorpoCompiti {
  success?: boolean;
  data?: { compiti?: unknown; prossimoCursore?: unknown };
}

/**
 * Un allegato con i campi che il render tocca, GARANTITI del tipo giusto.
 *
 * Vale per `ambito` la stessa ragione che vale per le liste di `vocePulita`: il
 * confronto `ambito === 'compiti'` su un numero o un oggetto non lancia, ma è
 * sempre falso — cioè marcherebbe come «dell'argomento» un allegato di cui non
 * si sa niente, il che è un'affermazione, non una prudenza. Qui un valore che
 * non è una stringa diventa `null`, che è la casella «non dichiarato».
 */
function allegatoPulito(grezzo: unknown): Allegato {
  const a = (grezzo ?? {}) as Partial<Allegato>;
  return {
    id: typeof a.id === 'string' ? a.id : '',
    tipo: typeof a.tipo === 'string' ? a.tipo : null,
    ambito: typeof a.ambito === 'string' ? a.ambito : null,
    file_name: typeof a.file_name === 'string' ? a.file_name : null,
    file_url: typeof a.file_url === 'string' ? a.file_url : null,
  };
}

/**
 * Una voce con le sue liste GARANTITE liste.
 *
 * Il render fa `voce.individualizzati.map(…)` e `voce.allegati.map(…)`: su una
 * riga che arriva senza quei campi è un `TypeError` non catturato, cioè la
 * linguetta che sparisce invece di dire che cos'è successo. Le righe non si
 * scartano (una riga mal formata è pur sempre un compito che qualcuno ha
 * scritto): si normalizzano, e i campi che il render tocca hanno il tipo che il
 * render si aspetta.
 *
 * ⚠️ NORMALIZZA IL TIPO, NON LA FORMA, ed è una distinzione che è già costata:
 * `data_consegna_compiti` qui esce «una stringa oppure `null`», ma una stringa
 * che non sia `YYYY-MM-DD` resta una stringa — e `isoToIt` le risponde `''`.
 * Chi si fida del solo «non vuoto» stampa «Consegna entro il » e una pastiglia
 * verde vuota. Perciò il render guarda la data FORMATTATA, non quella grezza.
 */
function vocePulita(grezza: unknown): VoceCompito {
  const v = (grezza ?? {}) as Partial<VoceCompito>;
  return {
    id: typeof v.id === 'string' ? v.id : '',
    data: typeof v.data === 'string' ? v.data : '',
    ora_lezione: typeof v.ora_lezione === 'number' ? v.ora_lezione : 0,
    materia: typeof v.materia === 'string' ? v.materia : null,
    compiti: typeof v.compiti === 'string' ? v.compiti : null,
    data_consegna_compiti:
      typeof v.data_consegna_compiti === 'string' ? v.data_consegna_compiti : null,
    allegati: Array.isArray(v.allegati) ? v.allegati.map(allegatoPulito) : [],
    individualizzati: Array.isArray(v.individualizzati) ? v.individualizzati : [],
  };
}

/**
 * Una GET che non può sparire in silenzio — quattro modi di fallire, nessuno muto:
 *  · la fetch che non parte (rete giù, WebView in background) → `stato: 0`;
 *  · una risposta non-JSON (413/502 rispondono HTML: il `json()` LANCIA);
 *  · un 4xx/5xx applicativo;
 *  · un 200 con un corpo che non è quello promesso.
 *
 * `voci: null` è il guasto, e la pagina lo rende come ERRORE con «Riprova»: una
 * lettura fallita non è mai «nessun compito assegnato».
 *
 * ⚠️ IL 400 DEL PERIODO NON ARRIVA PIÙ QUI, e il commento che stava in questo
 * punto diceva il falso su due cose. Diceva che «il `details[0].message` del 400
 * resta nel log del server» — ma la route non produce più `details` per quel
 * rifiuto: i due controlli del periodo sono usciti da `superRefine` e portano
 * ciascuno un `codice` (`PERIODO_TROPPO_LUNGO`, `PERIODO_ROVESCIATO`). E diceva
 * che quei messaggi «non sono tradotti»: lo sono, in `shared`
 * (`errorePeriodoTroppoLungo`, `errorePeriodoRovesciato`), in italiano e in
 * inglese. Il motivo per cui questa pagina non li mostra comunque è un altro, e
 * più semplice: con il tetto della route tornato a 365 giorni e il clamp di
 * `GIORNI_INDIETRO_MASSIMI` a 364, nessuna delle tre pastiglie può comporre un
 * intervallo che li faccia scattare — e `dataA` non lo manda nessuno, quindi il
 * periodo rovesciato non esiste proprio. Un ramo d'interfaccia per un rifiuto
 * irraggiungibile è un ramo che nessuno vedrà mai fallire.
 *
 * ⚠️ IL 403 ESCE COME GUASTO, E «RIPROVA» NON RIUSCIRÀ MAI. Un docente che apre
 * (o a cui viene passato) l'indirizzo di una classe di un altro plesso riceve il
 * 403 di `requireDocente`/`assertSezioneInScope`, e qui diventa «Non è stato
 * possibile leggere i compiti» con un bottone che ritenterà all'infinito: a
 * essere sbagliato è il diritto, non la rete. È una scelta, non una svista —
 * distinguere «non tuo» da «non riuscito» vorrebbe dire dire a chi non ha
 * accesso che quella classe ESISTE, che è esattamente l'informazione che il gate
 * non vuole dare. Il motivo vero resta nel log del server, col suo stato.
 */
async function chiediCompiti(url: string): Promise<Esito> {
  const res = await fetch(url).catch((e: unknown) => {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `compiti-classe-non-caricati: ${nomeErrore(e)}`,
      route: ROTTA,
      stato: 0,
    });
    return null;
  });
  if (!res) return { voci: null, prossimoCursore: null };
  const corpo = (await res.json().catch(() => null)) as CorpoCompiti | null;
  if (res.ok && corpo?.success) {
    const grezze = corpo.data?.compiti;
    if (Array.isArray(grezze)) {
      const c = corpo.data?.prossimoCursore;
      return {
        voci: grezze.map(vocePulita),
        // La stringa VUOTA non è un cursore: rimandarla chiederebbe per sempre
        // la stessa pagina. `null` e `''` significano tutti e due «finito».
        prossimoCursore: typeof c === 'string' && c !== '' ? c : null,
      };
    }
    // Un 200 senza la lista è un GUASTO, non una classe senza compiti. Il log ha
    // un messaggio suo: «non caricati» e «corpo malformato» si correggono in due
    // posti diversi, e uno dei due non è la rete.
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: 'compiti-classe-corpo-malformato',
      route: ROTTA,
      stato: res.status,
    });
    return { voci: null, prossimoCursore: null };
  }
  logClient({
    livello: 'error',
    evento: 'fetch',
    messaggio: 'compiti-classe-non-caricati',
    route: ROTTA,
    stato: res.status,
  });
  return { voci: null, prossimoCursore: null };
}

/**
 * QUANTE PAGINE DI SEGUITO SI LEGGONO QUANDO NON PORTANO NIENTE.
 *
 * 🔴 UNA PAGINA PUÒ TORNARE VUOTA CON UN CURSORE VALIDO, e la route lo dichiara:
 * pagina le RIGHE DI REGISTRO e restituisce solo quelle che hanno un compito.
 * Una settimana in cui nessuno ha assegnato niente è una pagina di righe vere
 * con zero compiti dentro. «Nessun compito in questa pagina» NON È «non ci sono
 * più compiti»: fermarsi lì direbbe a un docente che la classe non ha compiti
 * mentre il cursore è ancora vivo — la bugia esatta che la paginazione deve
 * impedire. Quindi la lettura NON si ferma su una pagina vuota: va avanti finché
 * non trova almeno una riga o finché il cursore non finisce.
 *
 * Il tetto non serve a limitare quel seguito — serve a non girare all'infinito se
 * un giorno la route restituisse un cursore che non avanza. Se morde, la lettura
 * si dichiara FALLITA (e lascia una riga di log a `error`): con zero righe in
 * mano, «non ci sono compiti» sarebbe di nuovo un'affermazione non provata.
 */
const PAGINE_DI_SEGUITO_MASSIME = 25;

/**
 * Lo stato di UNA lettura, con dentro il periodo A CUI APPARTIENE.
 *
 * ⚠️ IL PERIODO STA QUI DENTRO, E NON È RIDONDANTE: è quello che rende
 * impossibile mostrare l'elenco di un periodo sotto la pastiglia di un altro.
 * Vedi il blocco `vista` nel componente.
 */
interface Lettura {
  periodo: Periodo;
  voci: VoceCompito[];
  /** `null` = non c'è altro da leggere. Opaco: si rimanda, non si legge. */
  cursore: string | null;
  /** La PRIMA pagina di questo periodo è in volo: a schermo va lo spinner. */
  caricando: boolean;
  /** La pagina SUCCESSIVA è in volo: le righe già lette RESTANO. */
  caricandoAltri: boolean;
  /** La prima pagina è fallita: non c'è nessun elenco da mostrare. */
  errore: boolean;
  /** La pagina successiva è fallita: l'elenco resta, l'avviso è un altro. */
  erroreAltri: boolean;
}

const LETTURA_VUOTA: Omit<Lettura, 'periodo'> = {
  voci: [],
  cursore: null,
  caricando: true,
  caricandoAltri: false,
  errore: false,
  erroreAltri: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// La pagina
// ─────────────────────────────────────────────────────────────────────────────

const CHIP = 'font-barlow inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3 py-1 text-[12px] font-bold uppercase tracking-wide transition';
const ALLEGATO = 'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11px]';
const CARICA_ALTRI =
  'inline-flex items-center gap-1.5 rounded-pill border border-kidville-line bg-white px-3.5 py-2 font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green transition-colors hover:bg-kidville-cream disabled:cursor-wait';

function iconaAllegato(tipo: string | null) {
  return tipo === 'pdf' ? <FileText size={11} /> : <ImageIcon size={11} />;
}

function CompitiClasse() {
  const t = useTranslations('shared');
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  // La stessa identità della pagina sorella del registro: l'uuid finisce solo
  // nella query di una fetch, mai in un attributo renderizzato — quindi qui non
  // serve il doppio passaggio di `useTeacherIdentity`, che esiste per gli href.
  const userId = getCurrentTeacherId(search);

  const [periodo, setPeriodo] = useState<Periodo>(PERIODO_PREDEFINITO);
  const [lettura, setLettura] = useState<Lettura>({
    periodo: PERIODO_PREDEFINITO,
    ...LETTURA_VUOTA,
  });

  /**
   * ─── L'ELENCO CHE NON È DI QUESTO PERIODO NON SI AZZERA: NON SI MOSTRA ──────
   *
   * 🔴 IL DIFETTO CHIUSO QUI, misurato: cliccata «Anno scolastico», la pastiglia
   * passava subito ad `aria-pressed="true"` mentre a schermo restavano l'elenco
   * degli ultimi 30 giorni e il suo avviso, senza spinner e senza niente addosso
   * che lo dicesse — per tutto il tempo della lettura, che su WebView sono
   * secondi. `caricamento` nasceva `true` e non tornava mai `true`; e anche
   * rimettendolo non sarebbe bastato, perché `decidiStatoElenco` risponde
   * `'pronto'` appena `mostrati > 0`, PRIMA di guardare `caricamento`.
   *
   * È la stessa frase del commento sulla guardia di sequenza — «un elenco che non
   * è quello che si sta guardando, e niente addosso che lo dica» — raggiunta
   * dall'altra porta: quella guardia chiude l'atterraggio FUORI ORDINE, non la
   * finestra IN VOLO.
   *
   * La chiusura non è un `set` in più da ricordare: è il periodo scritto DENTRO
   * la lettura. Se non è quello premuto, non è roba di questa schermata, punto —
   * e la pagina mostra lo stato in cui si trova davvero, che è «sto leggendo».
   * Una correzione a colpi di `setVoci([])` si sarebbe dovuta ripetere identica
   * in ogni futuro punto che cambia periodo; questa non si può dimenticare.
   *
   * ⚠️ E vale SOLO per il cambio di periodo. La pagina SUCCESSIVA dello stesso
   * periodo non azzera niente: le righe già lette restano a schermo mentre il
   * seguito è in volo (`caricandoAltri`), che è tutto il punto di una
   * paginazione.
   */
  const vista: Lettura =
    lettura.periodo === periodo ? lettura : { periodo, ...LETTURA_VUOTA };

  /**
   * IL NUMERO DELLA LETTURA IN CORSO: la risposta in RITARDO non sovrascrive la
   * più recente.
   *
   * Due click rapidi («Ultimi 90 giorni» e poi «Anno scolastico») sono due fetch
   * in volo insieme, e non tornano per forza nell'ordine in cui sono partite.
   * Misurato: senza guardia, la risposta dei 90 giorni atterrata per ultima
   * resta a schermo con la pastiglia «Anno scolastico» premuta — un elenco che
   * non è quello che si sta guardando, e niente addosso che lo dica. Ogni
   * lettura prende un numero, e solo l'ultima scrive; è la stessa guardia (lì si
   * chiama `vivo`) della bacheca del genitore.
   *
   * Copre anche «Carica altri»: un seguito partito prima di un cambio di periodo
   * ha un numero vecchio e non attacca le sue righe all'elenco nuovo.
   */
  const letturaCorrente = useRef(0);

  /**
   * LA LETTURA, in una funzione sola per le due direzioni.
   *
   * `cursoreIniziale === null` → la PRIMA pagina di questo periodo (montaggio,
   * cambio di pastiglia, «Riprova»). Con un cursore → il SEGUITO: le righe già
   * a schermo restano, quelle nuove si accodano.
   */
  const leggi = useCallback(
    async (cursoreIniziale: string | null) => {
      const mia = ++letturaCorrente.current;
      const seguito = cursoreIniziale !== null;
      // ⚠️ QUI DENTRO NON C'È NESSUN `setLettura` PRIMA DEL PRIMO `await`, e non
      // è uno scrupolo di stile: questa funzione la chiama anche l'effetto di
      // montaggio, e `react-hooks/set-state-in-effect` (severità `error` in
      // questo repo) rifiuta qualunque setter raggiungibile sincronicamente da
      // lì. Le spie che vanno accese PRIMA della fetch stanno nei gestori di
      // evento che chiamano questa funzione — `caricaAltri` e `riprova` — dove
      // la regola non si applica e dove, per giunta, è il posto giusto: è il
      // click che deve rispondere subito.
      // `dataDaDelPeriodo` legge l'orologio: si chiama QUI, non nel corpo del
      // render.
      const dataDa = dataDaDelPeriodo(periodo);
      const raccolte: VoceCompito[] = [];
      let cursore = cursoreIniziale;
      // Si parte da «guasto» e lo si smentisce solo uscendo bene dal giro: così
      // un'eccezione inattesa lascia la lettura dichiarata fallita invece di far
      // passare per completo un elenco a metà.
      let guasto = true;
      let pagine = 0;
      try {
        for (;;) {
          pagine += 1;
          const q = new URLSearchParams({ sectionId, dataDa });
          // `?userId=` solo se c'è: la stringa «null» non è un'identità, e senza
          // quella locale la risolve comunque la sessione (`resolveIdentity`).
          if (userId) q.set('userId', userId);
          // Il cursore si rimanda IDENTICO: è opaco, e non lo si tocca.
          if (cursore !== null) q.set('cursore', cursore);
          // Nessun `dataA`: i compiti con consegna futura sono esattamente quelli
          // che questa linguetta deve mostrare, e la route lascia aperto l'estremo
          // superiore quando non lo si dichiara.
          const esito = await chiediCompiti(`/api/primaria/compiti?${q.toString()}`);
          // Un'altra lettura è partita nel frattempo: questa è vecchia e si butta,
          // intera — compreso lo stato d'errore, che riferito a un periodo che
          // nessuno sta più guardando è solo un allarme falso.
          if (mia !== letturaCorrente.current) return;
          if (esito.voci === null) break;
          raccolte.push(...esito.voci);
          cursore = esito.prossimoCursore;
          if (cursore === null) {
            guasto = false;
            break;
          }
          if (raccolte.length > 0) {
            guasto = false;
            break;
          }
          if (pagine >= PAGINE_DI_SEGUITO_MASSIME) {
            // Non è «nessun compito»: è una lettura che non è arrivata in fondo.
            // A `error` perché un cursore che non avanza è un guasto del
            // contratto, e questa riga è l'unico posto da cui lo si saprebbe.
            logClient({
              livello: 'error',
              evento: 'fetch',
              messaggio: 'compiti-classe-troppe-pagine-vuote',
              route: ROTTA,
              stato: 200,
            });
            break;
          }
        }
      } finally {
        // Il commit sta nel `finally` per la stessa ragione per cui ci stava il
        // vecchio `setCaricamento(false)`: se qualcosa lancia — `chiediCompiti`
        // non lancia mai, ma questo giro non è più una riga sola — le spie si
        // spengono lo stesso, invece di lasciare uno spinner che non finisce. E
        // siccome `guasto` parte da `true`, un'uscita per eccezione si dichiara
        // fallita: non c'è nessuno stato in cui un elenco a metà passi per
        // completo.
        if (mia === letturaCorrente.current) {
          setLettura((prec) => ({
            periodo,
            // Un seguito fallito NON butta via le righe già lette; una prima
            // pagina fallita non ne ha nessuna da tenere.
            voci: seguito ? [...prec.voci, ...raccolte] : raccolte,
            // 🔴 L'INVARIANTE: si esce dal giro solo con righe in mano, col
            // cursore finito, o con un guasto. Quindi «zero righe, non sto
            // leggendo, nessun errore» implica `cursore === null` — cioè lo
            // stato vuoto («non ci sono compiti») non può convivere con un
            // cursore ancora vivo. Su un guasto del seguito il cursore si
            // CONSERVA, altrimenti un errore di rete cancellerebbe il resto
            // dell'elenco fingendo che sia finito.
            cursore: guasto ? (seguito ? prec.cursore : null) : cursore,
            caricando: false,
            caricandoAltri: false,
            errore: guasto && !seguito,
            erroreAltri: guasto && seguito,
          }));
        }
      }
    },
    [sectionId, periodo, userId],
  );

  useEffect(() => {
    leggi(null);
  }, [leggi]);

  /**
   * «Carica altri»: accende la spia del seguito e poi legge.
   *
   * Le righe già a schermo NON si toccano — è tutto il punto — e lo stato
   * d'errore del seguito precedente sì: un avviso che resta acceso mentre si sta
   * ritentando dice la cosa sbagliata per tutto il tempo del tentativo.
   */
  const caricaAltri = useCallback(
    (daQui: string) => {
      setLettura((prec) => ({ ...prec, caricandoAltri: true, erroreAltri: false }));
      leggi(daQui);
    },
    [leggi],
  );

  /**
   * «Riprova» dopo un guasto della prima pagina: si torna allo spinner e si
   * rilegge da capo. Senza l'azzeramento il messaggio d'errore resterebbe a
   * schermo per tutta la durata del nuovo tentativo, cioè proprio mentre non è
   * più vero.
   */
  const riprova = useCallback(() => {
    setLettura({ periodo, ...LETTURA_VUOTA });
    leggi(null);
  }, [leggi, periodo]);

  /**
   * L'ORDINE, e perché si riordina qui invece di fidarsi della route.
   *
   * La GET ordina già (`data` discendente, `ora_lezione` crescente), ma l'ordine
   * è ciò che questa pagina PROMETTE — «i compiti dal più recente» — e una
   * promessa che dipende da un `.order()` in un altro file si rompe in silenzio
   * il giorno in cui quella query cambia per un altro motivo. Dentro lo stesso
   * giorno le ore salgono: è la sequenza della giornata, non il suo contrario.
   *
   * Con la paginazione l'ordinamento serve DI PIÙ, non di meno: le pagine si
   * accodano, e un riordino che valesse solo dentro la singola pagina lascerebbe
   * una lista a gradini.
   */
  const ordinate = useMemo(
    () =>
      [...vista.voci].sort((a, b) =>
        a.data === b.data ? a.ora_lezione - b.ora_lezione : b.data.localeCompare(a.data),
      ),
    [vista.voci],
  );

  /**
   * ─── LO STATO VUOTO NOMINA IL PERIODO, E IL PERIODO NON È UN FILTRO ─────────
   *
   * La regola 1 di `StatoElenco` («`vuoto` non nomina i filtri») vieta di
   * incolpare un filtro che l'utente non ha messo. Il periodo non è quello: è la
   * CORNICE della richiesta — c'è sempre, anche al valore predefinito — e non
   * dirlo lascia «Nessun compito assegnato» senza la sola informazione che
   * serve a decidere il passo dopo, cioè su quanti giorni. È la stessa decisione
   * già presa, con la stessa motivazione, nella bacheca del genitore.
   *
   * Di conseguenza il periodo NON compare fra i chip e non esiste nessun
   * «Pulisci filtri» che lo tocchi. Misurato prima della correzione: con «Anno
   * in corso» attivo, «Pulisci filtri» portava `dataDa` dal 1° gennaio al 19
   * agosto — toglieva righe invece di restituirle, proprio nel momento in cui si
   * chiede di rivedere tutto.
   */
  const testi = {
    ...testiStatoElenco(t),
    vuotoTitolo:
      periodo === 'anno'
        ? t('classeCompitiVuotoAnno')
        : t('classeCompitiVuotoPeriodo', { giorni: Number(periodo) }),
    vuotoCorpo:
      periodo === 'anno' ? t('classeCompitiVuotoAnnoInvito') : t('classeCompitiVuotoPeriodoInvito'),
    erroreTitolo: t('classeCompitiErroreTitolo'),
  };

  /**
   * `totale` per `decidiStatoElenco` significa «quante righe esistono SENZA
   * filtri»: qui coincide con quelle mostrate, perché filtri non ce ne sono —
   * il periodo è la cornice, non una restrizione aggiunta.
   *
   * Quindi lo stato `senzaRisultati` non si raggiunge mai, ed è giusto così:
   * «nessun risultato con questi filtri» manderebbe a togliere una cosa che non
   * si può togliere. Zero righe è sempre «vuoto», e il vuoto dice SU QUALE
   * PERIODO. (Prima qui c'era `totale: periodoAttivo ? 1 : 0`: una finzione che
   * serviva solo a far comparire il chip e «Pulisci filtri».)
   *
   * ⚠️ `errore` è SOLO quello della prima pagina. Un seguito fallito non può
   * cancellare l'elenco già letto per sostituirlo con «Non è stato possibile
   * leggere i compiti»: quei compiti sono stati letti, sono veri, e si vedono.
   * Il suo avviso sta accanto al bottone, non al posto della lista.
   */
  const stato = decidiStatoElenco({
    caricamento: vista.caricando,
    errore: vista.errore,
    totale: ordinate.length,
    mostrati: ordinate.length,
  });

  /**
   * Il cursore in una costante PRIMA della guardia: dentro una closure TypeScript
   * non conserva il restringimento su una proprietà, e `leggi(vista.cursore)`
   * tornerebbe `string | null` proprio dove si è appena dimostrato che non è
   * `null`.
   */
  const cursore = vista.cursore;

  /** La marca dell'AMBITO, o `null` quando l'allegato è davvero dei compiti. */
  const marcaAmbito = (ambito: string | null): string | null => {
    if (ambito === 'compiti') return null;
    // `'argomento'` si nomina; qualunque altra cosa (compreso `null`) dice solo
    // che non si sa — affermare «dell'argomento» su un valore sconosciuto
    // sarebbe inventare il dato invece di dichiararne l'assenza.
    return ambito === 'argomento'
      ? t('classeCompitiAllegatoArgomento')
      : t('classeCompitiAllegatoAmbitoIgnoto');
  };

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span id="compiti-periodo" className="font-maven mr-1 text-xs text-kidville-sub">
          {t('classeCompitiPeriodo')}
        </span>
        <div role="group" aria-labelledby="compiti-periodo" className="flex flex-wrap gap-1.5">
          {PERIODI.map(({ valore, chiave }) => (
            <button
              key={valore}
              type="button"
              aria-pressed={periodo === valore}
              onClick={() => setPeriodo(valore)}
              className={`${CHIP} ${
                periodo === valore
                  ? 'bg-kidville-green text-kidville-yellow'
                  : 'bg-kidville-cream text-kidville-ink hover:bg-kidville-cream-dark'
              }`}
            >
              {t(chiave)}
            </button>
          ))}
        </div>
      </div>

      {stato !== 'pronto' ? (
        // Niente `attivi` e niente `onPulisci`: il periodo non è un filtro, e
        // non esiste un comando che lo riporti indietro — vedi il blocco sui
        // testi qui sopra.
        <StatoElenco stato={stato} testi={testi} onRiprova={riprova} />
      ) : (
        <ul className="space-y-2.5" aria-busy={vista.caricandoAltri || undefined}>
          {ordinate.map((voce) => {
            // La data FORMATTATA, non quella grezza: `isoToIt` risponde `''` a
            // tutto ciò che non è `YYYY-MM-DD`, e una pastiglia verde vuota non
            // è una data — vedi il commento di `vocePulita`.
            const giorno = isoToIt(voce.data);
            const consegna = isoToIt(voce.data_consegna_compiti ?? '');
            return (
              <li key={voce.id} className="rounded-card border border-kidville-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`font-barlow rounded-pill px-2.5 py-0.5 text-[12px] font-bold ${
                      giorno
                        ? 'bg-kidville-green text-white'
                        : 'bg-kidville-cream text-kidville-sub'
                    }`}
                  >
                    {giorno || t('classeCompitiDataAssente')}
                  </span>
                  <span className="font-barlow text-sm font-bold text-kidville-green">
                    {t('classeCompitiOra', { ora: voce.ora_lezione })}
                  </span>
                  <span
                    className={`font-maven text-sm ${voce.materia ? 'text-kidville-ink' : 'italic text-kidville-sub'}`}
                  >
                    · {voce.materia || t('classeCompitiMateriaAssente')}
                  </span>
                </div>

                {/* `whitespace-pre-line` perché i compiti si scrivono in una
                    `<textarea>`: gli a capo che l'insegnante ha battuto sono
                    reali, e senza questa classe «1) pag. 12 ⏎ 2) pag. 13»
                    diventa una riga sola. `break-words` è l'altra metà: il campo
                    non ha tetto di lunghezza, e 4.000 caratteri senza spazi
                    (un indirizzo incollato) sfonderebbero la scheda. */}
                {voce.compiti && (
                  <p className="mt-1.5 whitespace-pre-line break-words rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-sm text-kidville-ink">
                    {voce.compiti}
                  </p>
                )}

                {/* La scadenza compare solo se c'è ED È UNA DATA: un «Consegna
                    entro —» su una riga che non ne ha è una scadenza inventata,
                    e un «Consegna entro il » con la pastiglia vuota è la stessa
                    cosa scritta peggio. */}
                {consegna && (
                  <p className="mt-1 font-maven text-[11.5px] font-semibold text-kidville-yellow-dark">
                    {t('classeCompitiConsegnaEntro', { data: consegna })}
                  </p>
                )}

                {/* Il testo individualizzato e QUANTI bambini. Mai chi: i nomi non
                    escono nemmeno dalla route, e questa è una vista d'elenco. */}
                {voce.individualizzati.map((ind, i) => (
                  <div key={`${voce.id}-ind-${i}`} className="mt-1.5 rounded-card bg-kidville-info-soft px-2.5 py-1.5">
                    <p className="font-barlow flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-kidville-info">
                      <Users size={11} aria-hidden="true" />
                      {/* ZERO DESTINATARI NON SI SCRIVE «0 alunni». Il compito
                          c'è (la route lascia passare solo le assegnazioni mirate
                          con un testo dentro), ma nessun bambino risulta
                          collegato: è un dato che MANCA, non una quantità, e
                          «Individualizzato · 0 alunni» afferma che quel compito
                          non è di nessuno. Nascondere la scheda sarebbe peggio:
                          toglierebbe dall'elenco un compito che un insegnante ha
                          scritto davvero. */}
                      {ind.destinatari > 0
                        ? t('classeCompitiIndividualizzato', { n: ind.destinatari })
                        : t('classeCompitiIndividualizzatoSenzaDestinatari')}
                    </p>
                    {/* Stessa origine, stesso trattamento del compito di classe:
                        anche `compiti_propri` è una `<textarea>`. */}
                    {ind.compiti && (
                      <p className="whitespace-pre-line break-words font-maven text-sm text-kidville-ink">
                        {ind.compiti}
                      </p>
                    )}
                  </div>
                ))}

                {voce.allegati.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {voce.allegati.map((a) => {
                      const marca = marcaAmbito(a.ambito);
                      return a.file_url ? (
                        <a
                          key={a.id}
                          href={a.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`${ALLEGATO} bg-kidville-cream text-kidville-ink hover:bg-kidville-cream-dark`}
                        >
                          {iconaAllegato(a.tipo)}
                          {a.file_name || t('classeCompitiAllegato')}
                          {/* La marca dell'ambito sta DENTRO la pastiglia, non
                              accanto: dev'essere leggibile insieme al nome del
                              file, altrimenti torna a essere un allegato
                              dell'argomento presentato come compito. */}
                          {marca && <em className="not-italic text-[10px]">({marca})</em>}
                        </a>
                      ) : (
                        // Niente `<a>`: un collegamento che non porta da nessuna
                        // parte è peggio di nessun collegamento — si clicca, si
                        // arriva a una 404 e sembra che il file non ci sia più.
                        //
                        // E niente `title`: diceva la stessa identica frase che si
                        // legge due caratteri più in là. A schermo è un doppione
                        // invisibile, ma uno screen reader li pronuncia tutti e
                        // due — «allegato non apribile adesso» due volte di fila
                        // su ogni allegato rotto.
                        <span key={a.id} className={`${ALLEGATO} bg-kidville-cream/60 text-kidville-sub`}>
                          <Paperclip size={11} aria-hidden="true" />
                          {a.file_name || t('classeCompitiAllegato')}
                          {marca && <em className="not-italic text-[10px]">({marca})</em>}
                          <em className="not-italic text-[10px]">({t('classeCompitiAllegatoNonApribile')})</em>
                        </span>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ─── «CARICA ALTRI», E PERCHÉ NON È IL CARICAMENTO ALLO SCORRIMENTO ────
          Il bottone si vede se e solo se il cursore è ancora vivo: la sua ASSENZA
          è l'unica frase con cui questa pagina dice «non c'è altro», e per
          costruzione non può comparire mentre qualcosa resta da leggere (vedi
          l'invariante nel commit di `leggi`).
          Sta FUORI dal ramo `pronto` apposta: se un giorno l'invariante si
          rompesse, lo stato vuoto e questo bottone comparirebbero insieme invece
          di nascondersi a vicenda — un difetto che si vede è un difetto che si
          corregge.
          Sul perché non si carica da solo scorrendo: lì il seguito lo innesca il
          movimento della pagina, e una pagina che torna VUOTA (la route pagina
          righe di registro e ne restituisce solo quelle con compiti) non aggiunge
          altezza — niente nuovo scorrimento, niente richiesta successiva, e il
          docente resta fermo davanti a un elenco che tace con il cursore ancora
          in mano. Un comando esplicito non dipende dal fatto che la pagina si
          allunghi. */}
      {cursore !== null && (
        <div className="mt-3 flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={() => caricaAltri(cursore)}
            disabled={vista.caricandoAltri}
            aria-busy={vista.caricandoAltri || undefined}
            className={CARICA_ALTRI}
          >
            {vista.caricandoAltri ? (
              <>
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                {t('caricamentoInCorso')}
              </>
            ) : (
              t('classeCompitiCaricaAltri')
            )}
          </button>
          {/* Distinto dal vuoto e distinto dal guasto della prima pagina: le
              righe già lette sono ancora tutte lì sopra, e quello che non è
              riuscito è soltanto il seguito. Nessuna riprova automatica: il
              bottone qui sopra è già il modo di riprovare. */}
          {vista.erroreAltri && (
            <p role="alert" className="text-center font-maven text-xs text-kidville-error-strong">
              {t('classeCompitiErroreAltri')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ⚠️ IL CONFINE DI SOSPENSIONE, e perché c'è anche se il lock non lo pretende.
 *
 * `__tests__/architecture/use-search-params-con-suspense.test.ts` esonera le rotte
 * con un segmento dinamico (`[sectionId]`): statiche non sono mai, quindi il
 * bailout `missing-suspense-with-csr-bailout` lì non scatta — ed è il motivo per
 * cui la pagina del registro, accanto a questa, non ce l'ha. L'esonero però
 * riguarda la POSIZIONE del file, non `useSearchParams()`: un domani questa vista
 * può essere montata altrove (una schermata di riepilogo per la segreteria è già
 * stata chiesta), e il confine costa un componente e zero comportamento. Si mette
 * adesso, che è gratis, invece di scoprirlo da una build rossa.
 */
export default function CompitiClassePage() {
  return (
    <Suspense fallback={null}>
      <CompitiClasse />
    </Suspense>
  );
}
