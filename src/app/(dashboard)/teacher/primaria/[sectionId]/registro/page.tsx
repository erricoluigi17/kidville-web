'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PenLine, BookOpen, Check, Paperclip, AlertTriangle, Trash2 } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalRegistro, syncPendingRegistro } from '@/lib/offline/syncEngine';
import { nomeCompleto } from '@/lib/format/nome';
import { isoToIt } from '@/lib/format/data';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { DateField } from '@/components/ui/DateField';
import { NavigatoreData } from '@/components/ui/NavigatoreData';
import { Modal } from '@/components/ui/Modal';
import { btnClass } from '@/components/ui/Btn';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';
import { BottoneSblocca, puoSbloccare, type BersaglioSblocco } from '@/components/features/primaria/BottoneSblocca';
import {
  AvvisoVoceBloccata,
  ModaleEliminaRegistro,
  bersaglioDi,
  giorniLimiteDa,
  puoEliminareLezione,
  type Eliminazione,
} from '@/components/features/primaria/AzioniRegistroLezione';
import { AllegatiLezione } from '@/components/features/primaria/AllegatiRegistro';
import { CestinoAllegatiRegistro } from '@/components/features/primaria/CestinoAllegatiRegistro';

/** La rotta della PAGINA: è il luogo dell'incidente, non l'URL della fetch. */
const ROTTA = '/teacher/primaria/[sectionId]/registro';

interface Campanella { id: string; ordine: number; ora_inizio: string; ora_fine: string; tipo: string }
interface OrarioCella { campanella_id: string; materia_id: string | null; materie?: { nome: string } | null }
interface Firma {
  id: string; maestra_id: string; tipo_compresenza: string; argomento_proprio: string | null; compiti_propri: string | null;
  utenti?: { nome: string; cognome: string } | null;
  /** Oltre il termine e senza sblocco (dalla GET, `statoVoci`). Assente = il server non lo dichiara. */
  bloccata?: boolean;
}
interface Allegato { id: string; ambito: string; tipo: string; file_url: string; file_name: string | null }
/** Chi riceve i contenuti «propri» di UNA firma (assegnazione mirata). */
interface Destinatario { id: string; firma_id: string; alunno_id: string }
/**
 * La riga di registro come la RESTITUISCE la GET (`primaria/registro:GET`, select
 * alla riga 82 della route). Fino al 2026-09-09 questa interfaccia ne dichiarava
 * meno della metà: `materia_id`, `data_consegna_compiti` e `registro_destinatari`
 * arrivavano dal server a ogni caricamento e non esistevano per TypeScript, quindi
 * non esistevano per la pagina. La data di consegna dei compiti, in particolare, il
 * docente non l'ha mai vista da nessuna parte — né in elenco né riaprendo la modale.
 */
interface Riga {
  id: string;
  ora_lezione: number;
  materia: string | null;
  materia_id: string | null;
  argomento: string | null;
  compiti: string | null;
  data_consegna_compiti: string | null;
  materie?: { nome: string } | null;
  firme_docenti?: Firma[];
  registro_destinatari?: Destinatario[];
  allegati_registro?: Allegato[];
  /** La lezione è oltre il termine e senza sblocco (dalla GET). Assente = non dichiarato. */
  bloccata?: boolean;
}
/**
 * Il termine della GIORNATA, come lo dichiara la GET (`statoTermineGiornata` nella
 * route): serve alle ore MAI firmate, che non hanno una riga su cui dirlo, e a
 * «Sblocca il giorno», che ha senso solo su una data davvero oltre il termine.
 */
interface TermineGiornata {
  letto: boolean;
  oltreTermine: boolean;
  giorniLimite: number | null;
  giornoSbloccato: boolean;
  oreSbloccate: number[];
}
interface Materia { id: string; nome: string }
interface Alunno { id: string; nome: string; cognome: string }
/**
 * Un docente proponibile come TITOLARE della firma. `ruolo` non è decorazione:
 * `admin/sections/[id]/teachers` restituisce TUTTO il personale legato alla sezione
 * (`RUOLI_PERSONALE`: admin, coordinator, segreteria, cuoca compresi), e senza quel
 * campo la tendina «Docente titolare» proporrebbe la Segreteria a sé stessa.
 */
interface Docente { id: string; nome: string; cognome: string; ruolo: string }

/**
 * L'UNICO ruolo che può firmare il registro come titolare.
 *
 * Misurato in produzione il 2026-09-09, non dedotto: i ruoli esistenti su
 * `utenti_sezioni` sono `educator` (60 utenti, 92 legami), `segreteria` (2 utenti,
 * 6 legami) e `admin` (1 utente, 1 legame); su tutta `utenti` esistono solo
 * educator/segreteria/admin/coordinator/cuoca/genitore, e i nomi storici
 * (`maestra`, `insegnante`) che `RUOLI_PERSONALE` tiene in vita a scopo di elenco
 * non hanno NESSUNA riga. `AppRole` (`@/lib/auth/predicati-ruolo`) conosce un solo
 * ruolo docente, ed è questo.
 */
const RUOLO_DOCENTE = 'educator';

/**
 * L'assegnazione è MIRATA se la firma porta CONTENUTI individualizzati — non se ha
 * dei destinatari.
 *
 * ─── perché non i destinatari ───────────────────────────────────────────────
 * Il server cancella `registro_destinatari` unicamente dentro `if (haDestinatari)`
 * (`route.ts:573`): tornando a «Tutta la classe» (`destinatariIds: []`) azzera i
 * propri (`route.ts:527-528`) ma lascia le righe dei destinatari APPESE. Fidandosi
 * di quelle, la modale ripartirebbe da «Alunni selezionati» su una firma che di
 * individualizzato non ha più niente — e i due riquadri di CLASSE, che in quella
 * modalità non sono disegnati, renderebbero l'argomento mostrato in elenco
 * invisibile e non più modificabile da nessuna interfaccia. È lo stesso difetto (a)
 * che questa pagina ha appena finito di correggere, ricreato dalla porta accanto.
 *
 * ─── e perché nemmeno «destinatari E contenuti» ─────────────────────────────
 * Perché il verso opposto è RAGGIUNGIBILE, non teorico:
 * `registro_destinatari.alunno_id` ha una FK `ON DELETE CASCADE` verso `alunni`
 * (misurato il 2026-09-09: `confdeltype = 'c'`), quindi cancellare un alunno —
 * l'oblio GDPR, il ciclo alunno — porta via le sue righe di destinatario e lascia la
 * firma con i propri PIENI e zero destinatari. Pretendere entrambi aprirebbe quella
 * firma su «Tutta la classe», dove i riquadri dei propri non esistono: testo
 * invisibile, azzerato al primo salvataggio e in silenzio. Guardando il CONTENUTO,
 * invece, la modale si apre mirata e il bottone resta bloccato con
 * `firmaModalNessunDestinatario`: si sceglie un alunno, oppure si passa a «Tutta la
 * classe» e i propri si cancellano APPOSTA (`proprio()`).
 *
 * ⚠️ In produzione oggi le due regole coincidono: 18 firme, 1 assegnazione mirata
 * coerente, zero righe in entrambi i casi anomali. Si sceglie quella che non
 * nasconde niente, non quella che oggi basterebbe.
 */
function assegnazioneMirata(firma: Firma | null): boolean {
  return !!(firma?.argomento_proprio || firma?.compiti_propri);
}

type TipoFirma = 'principale' | 'compresenza' | 'cofirma' | 'sostegno';
const TIPI_FIRMA: TipoFirma[] = ['principale', 'compresenza', 'cofirma', 'sostegno'];
/** `firme_docenti.tipo_compresenza` è testo libero a DB: si normalizza, non si castà. */
function tipoFirmaDa(valore: string | null | undefined): TipoFirma {
  return TIPI_FIRMA.includes(valore as TipoFirma) ? (valore as TipoFirma) : 'principale';
}

/**
 * La FORMA `yyyy-mm-dd`, e nient'altro: il PRIMO dei due controlli, mai l'unico.
 *
 * Da sola non basta a nessuno dei due chiamanti — `2026-02-30` ha questa forma e
 * non esiste — ed è esattamente l'errore che `dataDaUrl` ha commesso fino al
 * 2026-09-19. Chi la usa direttamente rilegga il riquadro «PERCHÉ
 * `dataInterrogabile`» qui sotto prima di fidarsene.
 */
const FORMA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * La data che l'API del registro accetterebbe: forma giusta E giorno che esiste
 * nel calendario.
 *
 * È la stessa domanda che `zDataYMD` (`@/lib/validation/common`) fa sul server —
 * regex più `dataCalendarioValida` — riproposta qui perché la richiesta che il
 * server respingerebbe con un 400 non deve nemmeno partire: quel 400 finiva in
 * `setErroreCaricamento`, cioè in un banner rosso a video, su una schermata dove
 * chi legge non ha ancora sbagliato niente (bastava un `?data=` vuoto, o una
 * battuta intermedia del campo mascherato).
 *
 * ⚠️ Il round-trip non è ornamentale e non si sostituisce con `Date.parse`:
 * `Date.parse('2026-02-30T12:00:00Z')` in V8 **non** è `NaN` — vale
 * `2026-03-02T12:00:00Z`. Il 30 febbraio passerebbe, che è il caso per cui
 * questa funzione esiste. (Misurato il 2026-09-19; lo stesso errore era finito
 * nella rete finta del lock, sotto un commento che dichiarava il contrario.)
 */
function dataInterrogabile(iso: string): boolean {
  if (!FORMA_ISO.test(iso)) return false;
  const [anno, mese, giorno] = iso.split('-').map(Number);
  const d = new Date(`${iso}T12:00:00`);
  return !Number.isNaN(d.getTime())
    && d.getFullYear() === anno && d.getMonth() + 1 === mese && d.getDate() === giorno;
}

/**
 * La data su cui si apre il registro: quella dell'URL, se c'è ed è un giorno
 * VERO, altrimenti OGGI NEL FUSO DELL'ISTITUTO.
 *
 * ─── PERCHÉ DALL'URL ─────────────────────────────────────────────────────────
 * Fino al 2026-09-19 il giorno viveva solo in `useState`: un F5, il pulsante
 * «indietro» del browser o un re-mount della pagina riportavano a oggi. Dal di
 * fuori sembrava che il registro «non restasse indietro» — cioè esattamente il
 * difetto segnalato — anche dopo aver scelto un altro giorno.
 *
 * ⚠️ IL GIRO SULLE ALTRE LINGUETTE ERA IL BUCO DI QUESTA CORREZIONE, E NON LO È
 * PIÙ. Fino al 2026-09-19 gli href dei tab portavano il solo `?userId=`
 * (`withUser`), quindi Registro → Appello → Registro riapriva su oggi, e qui
 * stava scritto che serviva «un intervento su quel componente»: l'intervento
 * c'è. `ClasseShell` rilegge `?data=` dall'URL filtrandolo con un controllo di
 * calendario (`giornoDaUrl` in `ClasseShell.tsx`) e lo riapplica a TUTTE le voci di
 * `NAV` con `conGiorno(withUser(…))` (`:196`); lock:
 * `__tests__/ui/classe-shell-data.test.tsx`. Da qui non si aggiunge niente: una
 * seconda propagazione scriverebbe `?data=` due volte nello stesso href.
 *
 * ─── PERCHÉ `dataInterrogabile` E NON LA SOLA FORMA ──────────────────────────
 * Qui c'era `FORMA_ISO.test(scritta)`, cioè la forma e basta, mentre la guardia
 * sulla fetch quindici righe più in là pretendeva forma E calendario: due
 * domande diverse sulla stessa data. Con `?data=2026-02-30` — forma giusta,
 * giorno inesistente — la pagina si apriva in un vicolo cieco MISURATO: campo
 * `30/02/2026`, ENTRAMBE le frecce disabilitate (`giornoNavigabile` di
 * `NavigatoreData` rifiuta un giorno che non c'è), zero chiamate, nessun banner,
 * e a schermo «Nessun'ora prevista dall'orario in questo giorno» — una frase
 * FALSA su un giorno che non esiste, senza via d'uscita se non «Oggi». Le due
 * domande sulla stessa data ora sono la stessa domanda.
 *
 * ─── PERCHÉ NON `toISOString()` ──────────────────────────────────────────────
 * Qui c'era `new Date().toISOString().slice(0, 10)`, cioè UTC: fra mezzanotte e
 * l'una (le due d'estate) italiane il registro apriva GIÀ SU IERI. È lo stesso
 * difetto misurato alle 01:2x dell'8 agosto sulla pagina gemella dell'appello
 * (`../appello/page.tsx:54-70`), dove è documentato per esteso: qui pesa meno che
 * là — il registro non salva sul giorno mostrato senza che l'insegnante apra una
 * modale — ma l'ora firmata ieri notte risultava comunque non firmata, e le ore
 * di oggi sparivano. Una sola idea di «oggi», e non è quella di UTC.
 * Lock: `__tests__/pages/teacher-registro-date.test.tsx`.
 */
function dataDaUrl(search: URLSearchParams | null): string {
  const scritta = search?.get('data');
  return scritta && dataInterrogabile(scritta) ? scritta : oggiFiscaleISO();
}

/** L'esito di una GET applicativa: mai un'eccezione, sempre qualcosa da mostrare. */
interface Esito<T> { dati: T | null; errore: string | null }

/**
 * Una GET che non può sparire in silenzio.
 *
 * Tre modi di fallire, tre rami, e nessuno di loro è muto:
 *  · la fetch che non parte (rete giù, WebView in background) → `stato: 0`;
 *  · una risposta non-JSON (413/502 rispondono HTML: il `json()` LANCIA);
 *  · un `success: false` con status 200, che è la forma normale di questo repo.
 * Il livello dell'evento lo decide `logClient` in base allo `stato` (401/403/404
 * il server li vede e li logga già lui): qui si dichiara `error` e si lascia fare.
 */
async function chiediJson<T>(url: string, cosa: string): Promise<Esito<T>> {
  const res = await fetch(url).catch((e: unknown) => {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${cosa}: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
    return null;
  });
  if (!res) return { dati: null, errore: '' };
  const corpo = await res.json().catch(() => null) as { success?: boolean; data?: T; error?: string } | null;
  if (res.ok && corpo?.success) return { dati: corpo.data ?? null, errore: null };
  logClient({ livello: 'error', evento: 'fetch', messaggio: cosa, route: ROTTA, stato: res.status });
  return { dati: null, errore: corpo?.error ?? '' };
}

export default function RegistroPage() {
  const t = useTranslations('teacherPrimaria');
  const params = useParams();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  // Inizializzatore PIGRO: la query si legge una volta sola, al montaggio, e non
  // a ogni render. Non è un `setState` dentro un effetto — la regola ESLint di
  // questo repo lo vieta, e qui non serve: il valore iniziale si deriva in fase
  // di costruzione dello stato.
  const [data, setData] = useState(() => dataDaUrl(search));
  const [campanelle, setCampanelle] = useState<Campanella[]>([]);
  const [orarioCelle, setOrarioCelle] = useState<OrarioCella[]>([]);
  const [righe, setRighe] = useState<Riga[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [sezioni, setSezioni] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  // `null` = nessun guasto. `''` = guasto senza messaggio dal server (si traduce a schermo).
  const [erroreCaricamento, setErroreCaricamento] = useState<string | null>(null);
  /**
   * Il ruolo applicativo, da `GET /api/primaria/me`. Serve a UNA cosa sola: sapere se
   * la firma può restare di chi è collegato (`educator`) o se va attribuita a un
   * docente titolare (`risolviValutatore`, 422 «Seleziona il docente titolare…»).
   * `null` finché la risposta non arriva: in quel caso non si mostra la tendina e
   * non si blocca il bottone — meglio il 422 del server che un'interfaccia che
   * blocca un docente per una GET che non ha ancora risposto.
   */
  const [ruolo, setRuolo] = useState<string | null>(null);
  const [modal, setModal] = useState<{ ordine: number; materiaId: string; riga: Riga | null } | null>(null);
  /** La conferma di «Elimina la mia firma» / «Elimina lezione» a schermo, se c'è. */
  const [eliminazione, setEliminazione] = useState<Eliminazione | null>(null);
  /**
   * Il termine della giornata, dalla GET: le ore bloccate si vedono AL CARICAMENTO,
   * per chiunque apra la pagina — la Direzione trova «Sblocca» sulla riga senza
   * dover provocare un 423. `null` = il server non l'ha detto (guasto o server
   * più vecchio): nessun blocco inventato, resta il ripiego qui sotto.
   */
  const [termine, setTermine] = useState<TermineGiornata | null>(null);
  /**
   * IL RIPIEGO: le ore scoperte bloccate AL GESTO (423 su firma o eliminazione),
   * per numero d'ora. Serve quando la GET non ha potuto dichiarare il termine, o
   * quando lo stato è cambiato dopo il caricamento. Ha la precedenza su quello
   * della GET (è più recente). Vale per il giorno a schermo: cambiando giorno si
   * azzera.
   */
  const [bloccate, setBloccate] = useState<Record<number, { bersaglio: BersaglioSblocco; giorniLimite: number | null }>>({});
  /** L'esito dell'ultima eliminazione o sblocco, sopra la griglia. */
  const [esito, setEsito] = useState<{ testo: string; tipo: 'ok' | 'errore' } | null>(null);
  /**
   * Cresce a ogni cambiamento degli allegati (rinomina, sostituzione, eliminazione,
   * ripristino, lezione eliminata coi suoi allegati): i permessi degli allegati e il
   * cestino si rileggono. Un contatore e non un «ricarica tutto»: il cestino è della
   * CLASSE, non del giorno, e non si rilegge a ogni cambio di data.
   */
  const [versioneAllegati, setVersioneAllegati] = useState(0);
  /** Il cestino degli allegati della classe, chiuso finché non lo si apre: niente richieste a vuoto. */
  const [cestinoAperto, setCestinoAperto] = useState(false);
  const cestinoId = useId();

  // Elenco di tutte le sezioni primaria, per la "firma in un'altra classe" (supplenza).
  // La route filtra già per plesso (`resolveScuoleAttive`): qui non si restringe altro.
  useEffect(() => {
    let vivo = true;
    chiediJson<{ id: string; name: string }[]>(`/api/primaria/sezioni?userId=${userId}`, 'registro-sezioni-non-caricate')
      .then((e) => { if (vivo && e.dati) setSezioni(e.dati); });
    return () => { vivo = false; };
  }, [userId]);

  // Il ruolo di chi è collegato: decide se serve il selettore del docente titolare.
  useEffect(() => {
    let vivo = true;
    chiediJson<{ ruolo: string | null }>(`/api/primaria/me?userId=${userId}`, 'registro-ruolo-non-risolto')
      .then((e) => { if (vivo && e.dati?.ruolo) setRuolo(e.dati.ruolo); });
    return () => { vivo = false; };
  }, [userId]);

  /**
   * Cambia giorno E lo scrive nell'URL, che è dove la data sopravvive a un F5 e
   * a un re-mount della pagina.
   *
   * ⚠️ Sul pulsante «indietro» del browser qui c'era scritto che la data
   * «sopravvive», e letto insieme al terzo trattino qui sotto suonava come il suo
   * contrario. La formulazione esatta è **duplice**, e va detta per intero:
   *  · i giorni **sfogliati** non si ripercorrono all'indietro — è lo scopo di
   *    `replace`, e si vede dieci righe più giù;
   *  · ma **tornando al registro da un'altra linguetta** la data c'è, perché
   *    `ClasseShell` usa `<Link>` (che è `push`) e al re-mount `dataDaUrl`
   *    rilegge `?data=`.
   * Due gesti diversi con lo stesso tasto, e una frase sola non li copriva.
   *
   * Sopravvive anche al giro sulle altre linguette della cornice di classe:
   * `ClasseShell` rilegge `?data=` e lo rimette negli href di tutti i tab
   * (`giornoDaUrl` e `conGiorno` in `ClasseShell.tsx` — si citano per NOME e non
   * per riga: i numeri sono già invecchiati una volta, e `:196` era arrivato a
   * puntare l'UNICO link a cui `conGiorno` di proposito non si applica, la
   * freccia «indietro»), quindi Registro → Appello → Registro
   * riapre sul giorno scelto. Non si propaga una seconda volta da qui — vedi il
   * riquadro di `dataDaUrl`.
   *
   * Tre dettagli che non sono dettagli:
   *  · si riscrive UNA chiave su quelle già presenti, così `?userId=` — che
   *    `ClasseShell` mette negli href di tutti i tab — non si perde per strada;
   *  · `replace` e non `push`: venti giorni sfogliati non devono diventare venti
   *    passi del pulsante «indietro» del browser prima di uscire dal registro;
   *  · `scroll: false`: cambiare giorno non deve riportare la pagina in cima.
   *
   * ─── QUANTO COSTA UN CAMBIO DI GIORNO ───────────────────────────────────────
   * Due `fetch` (`primaria/registro` + `primaria/classe/…`), e nient'altro: gli
   * effetti di `sezioni` e `me` dipendono dal solo `userId` e non ripartono.
   * Misurato, non stimato — il lock lo conta e fallisce se diventano tre.
   * A quelle due si aggiunge UNA soft navigation (`router.replace`), che in
   * produzione può valere un giro RSC sul segmento: in jsdom il router è finto e
   * quel giro NON è misurabile da qui, quindi è DICHIARATO e non contato. Questa
   * app ha già pagato un incidente da volume di richieste (2,23 M/giorno da
   * polling): se un domani il registro si sfoglia tenendo premuta la freccia, è
   * questo il numero da rimisurare, e sulla rete vera.
   */
  const cambiaData = useCallback((iso: string) => {
    setData(iso);
    // I blocchi, il termine e gli esiti sono del giorno lasciato: sull'altro giorno
    // direbbero il falso. Il termine soprattutto: finché la GET del giorno nuovo non
    // risponde, «Sblocca il giorno» e gli «Sblocca» delle voci userebbero la data
    // NUOVA con il termine VECCHIO, e creerebbero sblocchi che non autorizzano niente.
    setBloccate({});
    setTermine(null);
    setEsito(null);
    const q = new URLSearchParams(search?.toString() ?? '');
    q.set('data', iso);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [router, pathname, search]);

  /**
   * L'ordine d'ARRIVO delle risposte non è l'ordine di PARTENZA delle richieste.
   *
   * Ogni `load` prende un numero; dopo ogni `await` confronta il proprio numero
   * con l'ultimo emesso e, se è stata sorpassata, non scrive niente.
   *
   * ─── perché un contatore e non il solito `let vivo` ──────────────────────────
   * I due effetti qui sopra si difendono con un `let vivo` nella cleanup, e va
   * bene perché sono l'unico posto da cui partono. `load` no: la chiamano
   * l'effetto, il listener `online` (flush della coda offline) e
   * `uploadAllegato`. Gli ultimi due quella cleanup non la vedono nemmeno, e un
   * `let vivo` li lascerebbe scoperti. Il contatore vive quanto il componente e
   * copre tutti e tre.
   *
   * ─── e perché adesso, se la corsa c'era anche prima ──────────────────────────
   * Perché prima costava otto cifre da ridigitare in un campo mascherato, e ora
   * costa DUE CLICK sulla freccia `‹`. Misurato con la rete finta che ritarda la
   * risposta del penultimo giorno di 120 ms e quella dell'ultimo di 10 ms: senza
   * token il campo mostra il 16 e la griglia gli argomenti del 17 — e la modale
   * «Firma» salva sul giorno del CAMPO, cioè su un giorno diverso da quello che
   * la maestra sta leggendo. Lock: `__tests__/pages/teacher-registro-date.test.tsx`.
   */
  const richieste = useRef(0);

  const load = useCallback(async () => {
    const mio = ++richieste.current;
    // `try { … } finally { setLoading(false) }` e NIENTE blocco `catch`: il ramo
    // d'errore vive dentro `chiediJson`, che non lancia mai. Spostare il setter nel
    // corpo lineare fa scattare la regola sui setState dentro un effetto.
    try {
      // La richiesta che il server respingerebbe non parte: `data` deve essere una
      // data vera. Il bundle di classe invece parte comunque — non dipende dal
      // giorno, e senza di lui la modale «Firma» resterebbe senza materie né alunni.
      //
      // ⚠️ PRESIDIO SENZA DENTI, E SI DICHIARA. Da quando `dataDaUrl` filtra con
      // `dataInterrogabile` e `NavigatoreData` non lascia uscire un ISO incompleto,
      // `data` non può più essere un giorno inesistente: dall'interfaccia il ramo
      // `false` di questo ternario è IRRAGGIUNGIBILE, e nessun caso di test può
      // più coprirlo dalla pagina. Resta perché costa nulla ed è l'ultima rete se
      // un domani `data` tornasse a essere scritta da qualcun altro — ma va saputo
      // che sembra coperto e non lo è.
      type Giornata = { campanelle: Campanella[]; orarioCelle: OrarioCella[]; righe: Riga[]; termine?: TermineGiornata };
      const giornata: Promise<Esito<Giornata>> = dataInterrogabile(data)
        ? chiediJson<Giornata>(
            `/api/primaria/registro?sectionId=${sectionId}&data=${data}&userId=${userId}`,
            'registro-giornata-non-caricata',
          )
        : Promise.resolve({ dati: null, errore: null });
      const [reg, ctx] = await Promise.all([
        giornata,
        chiediJson<{ materie?: Materia[]; alunni?: Alunno[] }>(
          `/api/primaria/classe/${sectionId}?userId=${userId}`,
          'registro-bundle-classe-non-caricato',
        ),
      ]);
      // Sorpassata: nel frattempo è partito un altro `load`, su un altro giorno.
      // Scrivere qui vorrebbe dire rimettere a schermo la griglia di un giorno che
      // il campo data non mostra più.
      if (mio !== richieste.current) return;
      if (reg.dati) {
        // Teniamo TUTTE le campanelle (lezione + intervallo/mensa): le pause
        // vengono mostrate come righe non firmabili così la numerazione delle ore
        // non "salta" (lo slot escluso resta visibile). Firma/conteggi restano
        // sulle sole lezioni.
        setCampanelle(reg.dati.campanelle);
        setOrarioCelle(reg.dati.orarioCelle);
        setRighe(reg.dati.righe);
        // `letto: false` è un guasto dichiarato: vale quanto «non detto».
        setTermine(reg.dati.termine?.letto ? reg.dati.termine : null);
      } else {
        /*
         * LA GIORNATA CHE NON ARRIVA AZZERA LA GRIGLIA, e non è pulizia estetica.
         *
         * Fino al 2026-09-19 qui c'era il solo ramo `if`, che scrive in caso di
         * successo e non svuota niente in caso di fallimento: un 500, un 403 o la
         * rete giù mentre si cambia giorno lasciavano a video campanelle, orario e
         * righe del giorno PRECEDENTE, con il campo data già sul giorno NUOVO. È lo
         * stesso disallineamento campo↔griglia che il contatore di `load` chiude per
         * la corsa, raggiunto però SENZA corsa e con UN SOLO click di freccia — e in
         * una WebView sulla rete di una scuola una fetch fallisce senza chiedere
         * permesso.
         *
         * Il danno è misurato, non cosmetico: con il campo sul 17 e la griglia del
         * 18, «Allega» spediva il `registroId` della riga del 18 — l'allegato finiva
         * sulla riga di un altro giorno e spariva dalla vista al ricaricamento — e
         * «Firma» apriva `setModal({ riga })` su una riga del giorno sbagliato.
         * Meglio una griglia VUOTA sotto il banner rosso: il vuoto si vede, il giorno
         * sbagliato no.
         *
         * ⚠️ QUESTO RAMO COPRE ANCHE IL PRESIDIO SENZA DENTI qui sopra — con
         * `dataInterrogabile(data)` falsa la giornata vale `{ dati: null, errore:
         * null }` e si finisce qui, banner compreso a `null`, cioè griglia vuota e
         * nessun errore. È sicuro PROPRIO PERCHÉ quel ramo è irraggiungibile
         * dall'interfaccia (`dataDaUrl` filtra, `NavigatoreData` non lascia uscire un
         * ISO incompleto). Se un domani qualcuno lo rianimasse — rimettendo a `data`
         * l'ISO vuoto che `DateField` emette a ogni battuta intermedia — la griglia si
         * svuoterebbe mentre la maestra digita. Chi tocca quella guardia rilegga qui.
         * Lock: `__tests__/pages/teacher-registro-date.test.tsx`.
         */
        setCampanelle([]);
        setOrarioCelle([]);
        setRighe([]);
        setTermine(null);
      }
      if (ctx.dati) {
        setMaterie(ctx.dati.materie ?? []);
        setAlunni(ctx.dati.alunni ?? []);
      }
      // Un 403 sul bundle classe lasciava la modale SENZA materie né alunni, muta:
      // la maestra apriva «Firma», trovava due tendine vuote e non c'era niente,
      // da nessuna parte, che dicesse perché.
      setErroreCaricamento(reg.errore ?? ctx.errore ?? null);
    } finally {
      // PRESIDIO SENZA DENTI ANCHE QUESTO, e si dichiara com'è già stato fatto per
      // la guardia sulla fetch. Qui stava scritto che lo `false` di una richiesta
      // sorpassata spegnerebbe «Caricamento…» mentre quella buona è ancora in volo:
      // è vero solo nella finestra del PRIMO caricamento, perché `setLoading(true)`
      // non viene MAI più chiamato dopo il montaggio — `loading` parte `true` e va
      // `false` una volta sola. A giorno già cambiato non c'è nessuno spinner da
      // proteggere, e infatti nessun caso di test la copre: togliendo la guardia
      // (`setLoading(false)` nudo) la suite di `teacher-registro-date` resta tutta
      // verde. Resta perché costa nulla e perché il giorno in cui un cambio di
      // giorno tornasse ad accendere lo spinner sarebbe di nuovo l'unica cosa fra
      // una risposta sorpassata e un «Caricamento…» spento troppo presto.
      if (mio === richieste.current) setLoading(false);
    }
  }, [sectionId, data, userId]);

  useEffect(() => { load(); }, [load]);

  /** Un allegato è cambiato: si rileggono il registro, i permessi degli allegati e il cestino. */
  const allegatiCambiati = useCallback(() => {
    setVersioneAllegati((v) => v + 1);
    void load();
  }, [load]);
  const esitoAllegati = useCallback((testo: string, tipo: 'ok' | 'errore') => setEsito({ testo, tipo }), []);

  // Flush della coda registro al ritorno della connessione.
  useEffect(() => {
    const flush = () => syncPendingRegistro().then(load);
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [load]);

  const uploadAllegato = async (registroId: string, file: File) => {
    if (!userId) { alert(t('comuneIdentitaNonRisolta')); return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('registroId', registroId);
    fd.append('userId', userId);
    // La rete che cade qui non lanciava un errore visibile: la promise rifiutata
    // usciva dal gestore dell'`onChange` e finiva nel raccoglitore globale delle
    // `unhandledrejection`. Il docente vedeva l'allegato semplicemente non comparire.
    const r = await fetch(`/api/primaria/allegati?userId=${userId}`, { method: 'POST', headers: { 'x-user-id': userId }, body: fd }).catch((e: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `registro-allegato-non-inviato: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
      return null;
    });
    if (!r) { alert(t('comuneErroreRete')); return; }
    if (r.ok) load();
    // `.catch(() => ({}))`: un 413 (file troppo grande) risponde HTML, non JSON,
    // e senza questo il parse lanciava una promise rifiutata non gestita.
    else {
      const d = await r.json().catch(() => ({} as { error?: string }));
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-allegato-rifiutato', route: ROTTA, stato: r.status });
      alert(d.error || t('registroErroreUpload'));
    }
  };

  const rigaDi = (ora: number) => righe.find((r) => r.ora_lezione === ora);
  const plannedMateriaId = (camp: Campanella) =>
    orarioCelle.find((o) => o.campanella_id === camp.id)?.materia_id ?? '';
  // Solo le lezioni sono firmabili/contate; intervallo e mensa sono righe informative.
  const lezioni = campanelle.filter((c) => c.tipo === 'lezione');

  /**
   * L'ORA DI LEZIONE NON È IL NUMERO DELLA CAMPANELLA — e confonderli rendeva
   * NON FIRMABILI le ultime ore del tempo pieno.
   *
   * `campanelle.ordine` numera TUTTE le campanelle del giorno, pause comprese:
   * l'intervallo dopo la 2ª ora e, nel tempo pieno, la mensa a metà giornata.
   * `registro_orario.ora_lezione` numera invece le sole LEZIONI, e il database
   * lo impone: `CHECK (ora_lezione >= 1 AND ora_lezione <= 8)`.
   *
   * Misurato sulla sede Demo il 2026-09-09, non dedotto: con il modello a 40 ore
   * su 5 giorni le otto lezioni hanno `ordine` **1, 2, 4, 5, 7, 8, 9, 10**, e
   * firmando le ultime due la richiesta veniva respinta — prima con un 500 e il
   * messaggio Postgres in chiaro, poi (stretto lo zod) con un «Dati non validi».
   * L'insegnante premeva «Firma», leggeva un errore che non spiegava niente, e
   * quell'ora restava fuori dal registro per sempre.
   *
   * La correzione NON è allargare il CHECK: 1..8 è la verità (più di otto ore di
   * lezione in un giorno non esistono, e `MAX_LEZIONI_GIORNO` lo impone a monte).
   * È numerare le lezioni fra loro, che è ciò che «3ª ora» ha sempre voluto dire.
   * Con 27 ore su 5 giorni il risultato non cambia dove non c'è la mensa, quindi
   * la correzione si può verificare senza toccare le classi già configurate.
   */
  const oraDiLezione = (camp: Campanella) => lezioni.findIndex((c) => c.id === camp.id) + 1;

  const segnaBloccata = (ora: number, bersaglio: BersaglioSblocco, giorniLimite: number | null) =>
    setBloccate((prima) => ({ ...prima, [ora]: { bersaglio, giorniLimite } }));
  const togliBlocco = (ora: number) =>
    setBloccate((prima) => {
      if (!(ora in prima)) return prima;
      const dopo = { ...prima };
      delete dopo[ora];
      return dopo;
    });

  /** Il nome accessibile di «Sblocca» su una riga: QUALE voce di QUALE ora, non una fila di «Sblocca» uguali. */
  const descrizioneSblocco = (ora: number, b: BersaglioSblocco) => {
    const quando = { ora, data: isoToIt(data) };
    if (b.modo === 'voce' && b.entitaTipo === 'firma') return t('registroSbloccaFirmaNome', quando);
    if (b.modo === 'voce') return t('registroSbloccaLezioneNome', quando);
    return t('registroSbloccaOraNome', quando);
  };

  /**
   * Il blocco di un'ora da mostrare sulla riga: quello scoperto al gesto (423, più
   * recente) oppure quello dichiarato dalla GET.
   *  · ora SCRITTA  → la lezione come voce (`registro` + id). Lo sblocco della voce
   *    porta con sé anche le coordinate dello slot (`primaria/sblocca`), quindi
   *    copre la firma (POST), le firme (DELETE) e la lezione (DELETE);
   *  · ora MAI FIRMATA → per slot, che è l'unico modo di indicarla: niente uuid.
   *    Bloccata se la data è oltre il termine e né il giorno né lo slot sono
   *    sbloccati.
   */
  const bloccoDi = (ora: number, riga: Riga | undefined): { bersaglio: BersaglioSblocco; giorniLimite: number | null } | null => {
    if (bloccate[ora]) return bloccate[ora];
    if (!termine?.oltreTermine) return null;
    if (riga) {
      return riga.bloccata
        ? { bersaglio: { modo: 'voce', entitaTipo: 'registro', entitaId: riga.id }, giorniLimite: termine.giorniLimite }
        : null;
    }
    if (termine.giornoSbloccato || termine.oreSbloccate.includes(ora)) return null;
    return { bersaglio: { modo: 'slot', sectionId, data, oraLezione: ora }, giorniLimite: termine.giorniLimite };
  };

  /**
   * «Sblocca il giorno» nella testata: solo per la Direzione, e solo quando la GET
   * dice che la data è DAVVERO oltre il termine e non è già sbloccata. Con il
   * termine di 2 giorni ieri e l'altro ieri non sono bloccati: uno sblocco lì
   * sarebbe una riga d'audit che non autorizza niente. Termine non dichiarato
   * (guasto) = niente bottone: resta lo sblocco per riga, al 423.
   */
  const direzione = puoSbloccare(ruolo) && !!userId;
  const sbloccoGiornoVisibile = direzione && !!termine?.oltreTermine && !termine.giornoSbloccato;
  const giornoGiaSbloccato = direzione && !!termine?.oltreTermine && termine.giornoSbloccato;

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink">{t('registroTitolo')}</h2>
        {/* Niente `max` né `min`: dal registro si va sia indietro (la lezione di
            ieri da completare) sia AVANTI — l'orario è programmato, e una maestra
            può preparare la lezione di domani. Prima qui c'era un `DateField`
            nudo: per tornare a ieri bisognava ridigitare tutta la data. */}
        <NavigatoreData
          value={data}
          onChange={cambiaData}
          aria-label={t('registroDataAria')}
        />
      </div>

      {/* Lo sblocco della GIORNATA (spec 2026-09-24: «voce per voce E per
          classe+giorno»): tutte le voci di questa classe in questa data. */}
      {sbloccoGiornoVisibile && userId && (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-2" data-testid="registro-sblocca-giorno">
          <span className="font-maven text-[11px] text-kidville-sub">{t('registroSbloccaGiornoHint')}</span>
          <BottoneSblocca
            bersaglio={{ modo: 'giorno', sectionId, data }}
            userId={userId}
            ruolo={ruolo}
            onSbloccato={() => {
              setBloccate({});
              setEsito({ testo: t('registroGiornoSbloccato', { data: isoToIt(data) }), tipo: 'ok' });
              void load();
            }}
            descrizioneAccessibile={t('registroSbloccaGiornoNome', { data: isoToIt(data) })}
          />
        </div>
      )}
      {giornoGiaSbloccato && (
        <p data-testid="registro-giorno-gia-sbloccato" className="mb-4 text-right font-maven text-[11px] text-kidville-sub">
          {t('registroGiornoGiaSbloccato')}
        </p>
      )}

      {/* Il CESTINO degli allegati della classe (spec 2026-09-24, R4): eliminati o
          sostituiti, ripristinabili per GIORNI_CESTINO_REGISTRO giorni. */}
      {userId && (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            aria-expanded={cestinoAperto}
            aria-controls={cestinoId}
            aria-label={t('registroCestinoApriNome')}
            onClick={() => setCestinoAperto((a) => !a)}
            className="font-maven inline-flex min-h-6 items-center gap-1 rounded-pill border border-kidville-line px-3 py-1 text-xs text-kidville-ink hover:border-kidville-green"
          >
            <Trash2 size={12} aria-hidden="true" /> {t('registroCestinoApri')}
          </button>
        </div>
      )}
      {userId && cestinoAperto && (
        <div id={cestinoId}>
          <CestinoAllegatiRegistro
            sectionId={sectionId}
            userId={userId}
            versione={versioneAllegati}
            onRipristinato={allegatiCambiati}
            onEsito={esitoAllegati}
          />
        </div>
      )}

      {erroreCaricamento !== null && (
        <div role="alert" className="mb-4 rounded-card bg-kidville-error/10 px-3 py-2 font-maven text-sm text-kidville-error">
          {erroreCaricamento || t('registroErroreCaricamento')}
        </div>
      )}

      {esito && (
        <div
          role={esito.tipo === 'errore' ? 'alert' : 'status'}
          data-testid="registro-esito"
          className={`mb-4 rounded-card px-3 py-2 font-maven text-sm ${
            esito.tipo === 'errore' ? 'bg-kidville-error-soft text-kidville-error-strong' : 'bg-kidville-green/10 text-kidville-green'
          }`}
        >
          {esito.testo}
        </div>
      )}

      {!loading && lezioni.length > 0 && (() => {
        const firmate = lezioni.filter((c) => (rigaDi(oraDiLezione(c))?.firme_docenti?.length ?? 0) > 0).length;
        const tot = lezioni.length;
        return (
          <div className="mb-4 space-y-3">
            <div className="rounded-2xl bg-white p-4" style={{ boxShadow: 'inset 0 0 0 1.5px var(--color-kidville-line)' }}>
              <div className="flex items-end justify-between">
                <span className="font-barlow text-[11px] font-bold uppercase tracking-[0.1em] text-kidville-yellow-dark">{t('registroAvanzamentoFirme')}</span>
                <span className="font-barlow text-lg font-black text-kidville-green">
                  {firmate}<span className="text-kidville-muted">/{tot}</span>
                  <span className="ml-1 text-[11px] font-extrabold uppercase text-kidville-muted">{t('registroOreFirmate')}</span>
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-kidville-cream-dark">
                <div className="h-full rounded-full bg-kidville-green transition-all" style={{ width: `${tot ? (firmate / tot) * 100 : 0}%` }} />
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-xl border border-kidville-info/20 bg-kidville-info-soft px-3 py-2.5">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-kidville-info" />
              <span className="font-maven text-[11.5px] leading-snug text-kidville-info">
                {t('registroInfoFirme')}
              </span>
            </div>
          </div>
        );
      })()}

      {loading ? (
        <p className="font-maven text-kidville-muted text-sm">{t('comuneCaricamento')}</p>
      ) : lezioni.length === 0 ? (
        <p className="font-maven text-kidville-muted text-sm">{t('registroNessunaOra')}</p>
      ) : (
        <ul className="space-y-2">
          {campanelle.map((camp) => {
            // Intervallo/mensa: riga informativa non firmabile (spiega il salto di numerazione).
            if (camp.tipo !== 'lezione') {
              return (
                <li key={camp.id} className="rounded-card border border-dashed border-kidville-line bg-kidville-cream/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-barlow text-[11px] font-bold uppercase tracking-[0.1em] text-kidville-muted">
                      {camp.tipo === 'mensa' ? t('registroMensa') : t('registroIntervallo')}
                    </span>
                    <span className="text-xs text-kidville-muted">{camp.ora_inizio?.slice(0, 5)}–{camp.ora_fine?.slice(0, 5)}</span>
                  </div>
                </li>
              );
            }
            const ora = oraDiLezione(camp);
            const riga = rigaDi(ora);
            const plannedId = plannedMateriaId(camp);
            const plannedName = orarioCelle.find((o) => o.campanella_id === camp.id)?.materie?.nome;
            const materiaNome = riga?.materie?.nome || riga?.materia || plannedName;
            const firmata = (riga?.firme_docenti?.length ?? 0) > 0;
            const blocco = bloccoDi(ora, riga);
            // Il blocco della LEZIONE, da qualunque fonte: dichiarato dalla GET
            // (`riga.bloccata`) o scoperto al gesto (423 → `bloccate[ora]`). Governa solo
            // «Elimina lezione», che fallirebbe di nuovo con lo stesso 423.
            // La FIRMA ha un blocco suo (`f.bloccata`): il server, sulla DELETE di una
            // firma, decide sulla firma soltanto, anche quando è l'unica. Uno sblocco
            // della sola firma lascia la lezione bloccata (`riga.bloccata: true`) e la
            // firma libera: il gesto sulla firma deve tornare, quello sulla lezione no.
            // Dopo lo sblocco `togliBlocco(ora)` + `load()` rileggono entrambi.
            const bloccataOra = riga?.bloccata === true || !!bloccate[ora];
            return (
              <li key={camp.id} className="rounded-card border border-kidville-line p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-barlow text-sm font-bold text-kidville-green">{t('registroOra', { ora })}</span>
                      <span className="text-xs text-kidville-muted">{camp.ora_inizio?.slice(0, 5)}–{camp.ora_fine?.slice(0, 5)}</span>
                      <span className={`font-maven text-sm ${materiaNome ? 'text-kidville-ink' : 'italic text-kidville-muted'}`}>
                        · {materiaNome || t('registroOrarioDaCompletare')}
                      </span>
                    </div>
                    {riga?.argomento && <p className="mt-1 font-maven text-sm text-kidville-ink">{riga.argomento}</p>}
                    {riga?.compiti && (
                      <p className="mt-1 rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-xs text-kidville-ink">
                        {t('registroCompitiLabel')} {riga.compiti}
                      </p>
                    )}
                    {/* La data di consegna la GET la restituisce da sempre: fino al
                        2026-09-09 non compariva da nessuna parte, né qui né nella modale. */}
                    {riga?.data_consegna_compiti && (
                      <p className="mt-1 font-maven text-[11px] font-semibold text-kidville-yellow-dark">
                        {t('registroConsegnaEntro', { data: isoToIt(riga.data_consegna_compiti) })}
                      </p>
                    )}
                    {riga?.firme_docenti?.map((f) => (
                      <div key={f.id} className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-kidville-muted">
                        <span>
                          ✍ {f.utenti ? nomeCompleto(f.utenti.nome, f.utenti.cognome) : '—'} ({f.tipo_compresenza})
                          {f.argomento_proprio && <span className="ml-1 text-kidville-info">· {t('registroAttivitaIndividualizzata')}</span>}
                        </span>
                        {/* Solo sulla PROPRIA firma: quella dei colleghi è in sola lettura.
                            Conta il blocco della FIRMA, non quello della lezione: dichiarato
                            dalla GET (`f.bloccata`) o scoperto al 423 di un gesto sull'ora
                            (`bloccate[ora]`, il ripiego quando la GET non dichiara il termine).
                            Bloccata, il gesto non si offre: sulla riga c'è già il messaggio (e,
                            alla Direzione, «Sblocca»). La lezione bloccata con la firma libera
                            NON nasconde il gesto: il server decide solo sulla firma.
                            Area di tocco ≥ 24px (WCAG 2.5.8): la pagina si usa dal telefono. */}
                        {userId && f.maestra_id === userId && f.bloccata !== true && !bloccate[ora] && (
                          <button
                            type="button"
                            aria-haspopup="dialog"
                            aria-label={t('registroEliminaMiaFirmaNome', { ora })}
                            onClick={() => {
                              setEsito(null);
                              setEliminazione({
                                modo: 'firma',
                                firmaId: f.id,
                                ora,
                                unica: (riga?.firme_docenti?.length ?? 0) <= 1,
                                nAllegati: riga?.allegati_registro?.length ?? 0,
                              });
                            }}
                            className="-mx-1 inline-flex min-h-6 items-center gap-0.5 px-1 font-maven text-[11px] font-semibold text-kidville-error-strong underline-offset-2 hover:underline"
                          >
                            <Trash2 size={11} aria-hidden="true" /> {t('registroEliminaMiaFirma')}
                          </button>
                        )}
                      </div>
                    ))}
                    {blocco && userId && (
                      <AvvisoVoceBloccata
                        bersaglio={blocco.bersaglio}
                        giorniLimite={blocco.giorniLimite}
                        userId={userId}
                        ruolo={ruolo}
                        descrizioneAccessibile={descrizioneSblocco(ora, blocco.bersaglio)}
                        onSbloccato={() => {
                          togliBlocco(ora);
                          // Lo sblocco della sola FIRMA non copre la lezione
                          // (permesso-voce per slot accetta solo le righe
                          // `registro`): dire «ora sbloccata» sarebbe falso,
                          // perché la lezione resta bloccata sulla stessa riga.
                          const soloFirma = blocco.bersaglio.modo === 'voce' && blocco.bersaglio.entitaTipo === 'firma';
                          setEsito({
                            testo: soloFirma ? t('registroFirmaSbloccata', { ora }) : t('registroVoceSbloccata', { ora }),
                            tipo: 'ok',
                          });
                          void load();
                        }}
                      />
                    )}
                    {/* Gli allegati, con «Rinomina», «Sostituisci file» ed «Elimina»
                        secondo i permessi che dichiara il server (R4). */}
                    {riga && (riga.allegati_registro?.length ?? 0) > 0 && (
                      <AllegatiLezione
                        registroId={riga.id}
                        allegati={riga.allegati_registro ?? []}
                        userId={userId}
                        ruolo={ruolo}
                        versione={versioneAllegati}
                        onCambiato={allegatiCambiati}
                        onEsito={esitoAllegati}
                      />
                    )}
                    {riga && (
                      <div className="mt-1.5 flex items-center gap-3">
                        <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-kidville-green">
                          <Paperclip size={11} /> {t('registroAllega')}
                          <input
                            type="file"
                            accept="application/pdf,image/*"
                            className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAllegato(riga.id, f); }}
                          />
                        </label>
                        {/* Nativo: scatta la foto (compito/documento) come allegato. Su web non compare. */}
                        <ScattaFotoButton
                          onFile={(f) => uploadAllegato(riga.id, f)}
                          iconSize={11}
                          className="inline-flex items-center gap-1 text-[11px] text-kidville-green"
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <button
                      onClick={() => setModal({ ordine: ora, materiaId: plannedId, riga: riga ?? null })}
                      className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs ${
                        firmata ? 'bg-kidville-cream text-kidville-green' : 'bg-kidville-green text-kidville-yellow'
                      }`}
                    >
                      {firmata ? <Check size={13} /> : <PenLine size={13} />}
                      {firmata ? t('registroModifica') : t('registroFirma')}
                    </button>
                    {/* La lezione INTERA: Segreteria e Direzione (il server lo ribadisce, 403). */}
                    {riga && userId && puoEliminareLezione(ruolo) && !bloccataOra && (
                      <button
                        type="button"
                        aria-haspopup="dialog"
                        aria-label={t('registroEliminaLezioneNome', { ora })}
                        onClick={() => {
                          setEsito(null);
                          setEliminazione({
                            modo: 'lezione',
                            registroId: riga.id,
                            ora,
                            nFirme: riga.firme_docenti?.length ?? 0,
                            nAllegati: riga.allegati_registro?.length ?? 0,
                          });
                        }}
                        className="font-maven -mx-1 inline-flex min-h-6 items-center gap-1 px-1 text-[11px] font-semibold text-kidville-error-strong underline-offset-2 hover:underline"
                      >
                        <Trash2 size={12} aria-hidden="true" /> {t('registroEliminaLezione')}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {modal && userId && (
        <FirmaModal
          // La modale è una schermata sui dati di UNA riga: cambiare riga la
          // rimonta, e l'idratazione riparte pulita invece di trascinarsi lo
          // stato dell'ora precedente.
          key={`${modal.ordine}-${modal.riga?.id ?? 'nuova'}`}
          sectionId={sectionId}
          userId={userId}
          ruolo={ruolo}
          data={data}
          ordine={modal.ordine}
          materie={materie}
          alunni={alunni}
          sezioni={sezioni}
          riga={modal.riga}
          defaultMateriaId={modal.materiaId}
          onClose={() => setModal(null)}
          onSaved={() => {
            togliBlocco(modal.ordine);
            setModal(null);
            // Una lezione appena firmata può essere proprio quella che il cestino
            // chiedeva di rifirmare: se il cestino è aperto si rilegge, e l'avviso
            // «prima rifirma…» segue la nuova risposta del server.
            setVersioneAllegati((v) => v + 1);
            load();
          }}
          onBloccata={(giorniLimite) =>
            // Un'ora già scritta si sblocca come VOCE (la riga di registro); una
            // mai firmata non ha un uuid, e si sblocca per SLOT. Entrambe le
            // strade le legge `primaria/registro:POST`.
            segnaBloccata(
              modal.ordine,
              modal.riga
                ? { modo: 'voce', entitaTipo: 'registro', entitaId: modal.riga.id }
                : { modo: 'slot', sectionId, data, oraLezione: modal.ordine },
              giorniLimite,
            )
          }
        />
      )}

      {eliminazione && userId && (
        <ModaleEliminaRegistro
          // Una conferma per voce: cambiare voce la rimonta pulita.
          key={eliminazione.modo === 'firma' ? eliminazione.firmaId : eliminazione.registroId}
          eliminazione={eliminazione}
          userId={userId}
          onChiudi={() => setEliminazione(null)}
          onEliminata={({ eliminata, allegatiNelCestino }) => {
            const ora = eliminazione.ora;
            setEliminazione(null);
            togliBlocco(ora);
            // Il server dice che cosa è sparito davvero: la firma sola, oppure la
            // lezione (intera, o con la sua ultima firma).
            const testo = eliminata === 'firma'
              ? t('registroFirmaEliminata', { ora })
              : eliminazione.modo === 'firma'
                ? t('registroFirmaUnicaEliminata', { ora })
                : t('registroLezioneEliminata', { ora });
            setEsito({
              testo: allegatiNelCestino > 0
                ? `${testo} ${t('registroAllegatiNelCestino', { n: allegatiNelCestino })}`
                : testo,
              tipo: 'ok',
            });
            // Gli allegati della lezione sono finiti nel cestino: se è aperto, si rilegge.
            if (allegatiNelCestino > 0) setVersioneAllegati((v) => v + 1);
            void load();
          }}
          onBloccata={(giorniLimite) => {
            segnaBloccata(eliminazione.ora, bersaglioDi(eliminazione), giorniLimite);
            setEliminazione(null);
          }}
          onRifiutata={(messaggio) => {
            // Lo stato a schermo era vecchio: il messaggio va sopra la griglia e si rilegge.
            setEliminazione(null);
            setEsito({ testo: messaggio, tipo: 'errore' });
            void load();
          }}
        />
      )}
    </div>
  );
}

function FirmaModal({
  sectionId, userId, ruolo, data, ordine, materie, alunni, sezioni, riga, defaultMateriaId, onClose, onSaved, onBloccata,
}: {
  sectionId: string; userId: string; ruolo: string | null; data: string; ordine: number;
  materie: Materia[]; alunni: Alunno[]; sezioni: { id: string; name: string }[];
  riga: Riga | null; defaultMateriaId: string;
  onClose: () => void; onSaved: () => void;
  /**
   * 423 della firma, nella PROPRIA classe: la pagina segna l'ora come bloccata,
   * e alla chiusura la riga mostra il messaggio e, alla Direzione, «Sblocca».
   * `giorniLimite` = null quando il server non lo dichiara nel corpo.
   */
  onBloccata?: (giorniLimite: number | null) => void;
}) {
  const t = useTranslations('teacherPrimaria');
  const uid = useId();
  const campo = (nome: string) => `${uid}-${nome}`;

  // Classe in cui si firma: di default quella corrente, ma il docente può
  // sceglierne un'altra (supplenza — un docente può firmare in qualunque classe
  // primaria del proprio plesso). Cambiando classe si azzera la materia
  // (le materie sono per-sezione e non sono caricate per le altre classi).
  const [targetSectionId, setTargetSectionId] = useState(sectionId);
  const altraClasse = targetSectionId !== sectionId;

  /**
   * CHI FIRMA. `risolviValutatore` (`src/lib/audit/valutatore.ts`) impone che la
   * firma resti del DOCENTE: per l'educator è sé stesso, per Segreteria e Direzione
   * va indicato il titolare in `docenteId`, altrimenti 422. Fino al 2026-09-09 in
   * questa pagina non esisteva nessun selettore e la POST non mandava mai quel
   * campo: il messaggio del server arrivava a schermo verbatim e chiedeva una cosa
   * che l'interfaccia non permetteva di fare.
   * `ruolo === null` = risposta non ancora arrivata: non si mostra niente e non si
   * blocca nessuno.
   */
  const serveDocente = ruolo !== null && ruolo !== 'educator';
  const [docenteId, setDocenteId] = useState('');
  const [docenti, setDocenti] = useState<Docente[]>([]);
  const [statoDocenti, setStatoDocenti] = useState<'attesa' | 'ok' | 'errore'>('attesa');
  /** L'autore della firma che si sta guardando: l'educator sé stesso, altrimenti il titolare scelto. */
  const autoreId = serveDocente ? docenteId : userId;

  const firmaDi = useCallback(
    (id: string) => (id ? riga?.firme_docenti?.find((f) => f.maestra_id === id) ?? null : null),
    [riga],
  );
  const destinatariDi = useCallback(
    (firma: Firma | null) =>
      firma ? (riga?.registro_destinatari ?? []).filter((d) => d.firma_id === firma.id).map((d) => d.alunno_id) : [],
    [riga],
  );

  const firmaIniziale = firmaDi(autoreId);
  const destIniziali = destinatariDi(firmaIniziale);

  // ─── IDRATAZIONE ────────────────────────────────────────────────────────────
  // Il bottone si chiama «Modifica» proprio quando la riga È firmata, e fino al
  // 2026-09-09 la modale si apriva comunque VUOTA. Non era solo scomodo: salvare
  // da lì AZZERAVA `argomento_proprio`/`compiti_propri` e i destinatari della firma
  // (upsert su `registro_id,maestra_id`) e riportava il tipo a «principale»,
  // declassando una firma di sostegno. I contenuti di CLASSE si idratano una volta
  // sola (sono della riga, non cambiano); quelli PROPRI seguono l'autore.
  const [materiaId, setMateriaId] = useState(riga?.materia_id || defaultMateriaId);
  const [argomento, setArgomento] = useState(riga?.argomento ?? '');
  const [compiti, setCompiti] = useState(riga?.compiti ?? '');
  const [dataConsegnaCompiti, setDataConsegnaCompiti] = useState(riga?.data_consegna_compiti ?? '');
  const [tipo, setTipo] = useState<TipoFirma>(tipoFirmaDa(firmaIniziale?.tipo_compresenza));
  const [argomentoProprio, setArgomentoProprio] = useState(firmaIniziale?.argomento_proprio ?? '');
  const [compitiPropri, setCompitiPropri] = useState(firmaIniziale?.compiti_propri ?? '');
  const [destinatari, setDestinatari] = useState<string[]>(destIniziali);
  // Toggle «Tutta la classe / Alunni selezionati» (P7/B1). Il sostegno è per
  // definizione individualizzato → per quel tipo l'assegnazione è forzata sugli alunni
  // selezionati. In supplenza (altra classe) resta di classe: gli alunni della sezione
  // in cui si firma non sono caricati, quindi la selezione non è disponibile.
  const [perAlunniSel, setPerAlunniSel] = useState(assegnazioneMirata(firmaIniziale));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** L'ultima risposta è stata 423 (oltre il termine): sotto l'errore, dove si sblocca. */
  const [bloccata, setBloccata] = useState(false);

  /**
   * IL PROMEMORIA «argomento sì, compiti no»: se è a schermo, e se è già stato
   * sciolto una volta in questa modale. Il perché di entrambi sta più sotto,
   * accanto a `compitiDimenticati`, che è il posto dove si capiscono.
   *
   * STANNO QUI, in cima agli stati, per una ragione meccanica: le due
   * ri-idratazioni subito sotto (cambio di classe, cambio di docente titolare)
   * devono poter azzerare `promemoriaSciolto`, e girano DURANTE il render —
   * una `useState` dichiarata più in basso sarebbe ancora nella propria zona
   * morta temporale e il render esploderebbe con un ReferenceError.
   */
  const [promemoria, setPromemoria] = useState(false);
  /**
   * Chiesto e sciolto: dopo un «Salva lo stesso» in questa modale non si
   * ridomanda. Conta sul RITENTO dopo un rifiuto del server — il dialogo resta
   * aperto, il bottone si ripreme — dove una seconda domanda identica sarebbe
   * quel muro che il promemoria esiste apposta per non essere.
   */
  const [promemoriaSciolto, setPromemoriaSciolto] = useState(false);

  /**
   * Il riquadro dei compiti del modo CORRENTE — quello di classe o quello
   * «solo per gli alunni selezionati»: uno solo dei due è montato alla volta,
   * quindi la stessa ref li copre entrambi senza ambiguità. Serve a «Torna ai
   * compiti», che deve riportare il fuoco dove l'etichetta promette.
   */
  const compitiRef = useRef<HTMLTextAreaElement>(null);
  /**
   * «Torna ai compiti» è un'uscita diversa da Escape e dal tasto Indietro: quelle
   * due sono un annullamento, e il ripristino del fuoco al bottone «Firma» che fa
   * `Modal` è esattamente ciò che serve. Questa, invece, PROMETTE un riquadro.
   * Una ref e non uno stato: non deve ridisegnare niente.
   */
  const tornaAiCompiti = useRef(false);
  /*
   * IL FUOCO SI RIMETTE FUORI DAL CICLO DI SMONTAGGIO, e non è pignoleria.
   * La cleanup di `Modal` (`Modal.tsx:161-177`) restituisce il fuoco a
   * `previouslyFocused` — in un browser vero il bottone «Firma», in jsdom
   * `<body>` — e gira DOPO qualunque `focus()` sincrono chiamato dal gestore del
   * click: quel fuoco verrebbe sovrascritto. `returnFocusRef` non è la strada:
   * quella primitiva lo onora solo quando `previouslyFocused` è nullo o `<body>`
   * (`Modal.tsx:175`), cioè proprio non nel caso normale.
   * Questo effetto è PASSIVO come quello di `Modal`, e React esegue tutte le
   * cleanup passive di un commit prima di qualunque effetto passivo: quando
   * arriva qui, la modale del promemoria è smontata e il suo ripristino è già
   * avvenuto. L'ultimo a scrivere è questo.
   */
  useEffect(() => {
    if (promemoria || !tornaAiCompiti.current) return;
    tornaAiCompiti.current = false;
    compitiRef.current?.focus();
  }, [promemoria]);

  /**
   * Cambiare CLASSE cambia la RIGA di registro, e i contenuti condivisi sono di
   * quella riga: portarseli dietro scriverebbe l'argomento della 1ª A dentro la 2ª B.
   * Della classe altrui non sappiamo niente (la GET carica solo la propria), quindi si
   * riparte da vuoto — e `salva` non manda i campi vuoti, perché «non lo so» non è
   * «è vuoto» (vedi `condiviso`).
   */
  const [classeIdrata, setClasseIdrata] = useState(targetSectionId);
  if (classeIdrata !== targetSectionId) {
    setClasseIdrata(targetSectionId);
    const propria = targetSectionId === sectionId;
    setMateriaId(propria ? (riga?.materia_id || defaultMateriaId) : '');
    setArgomento(propria ? (riga?.argomento ?? '') : '');
    setCompiti(propria ? (riga?.compiti ?? '') : '');
    setDataConsegnaCompiti(propria ? (riga?.data_consegna_compiti ?? '') : '');
    // Il promemoria sciolto valeva per LA RIGA di prima. Cambiata la classe è
    // cambiata la riga, e i due riquadri sono appena stati riazzerati: tenerselo
    // vorrebbe dire salvare la riga NUOVA senza mai aver chiesto niente su di
    // lei. Percorso stretto ma reale: si arriva qui solo ritentando dopo un
    // rifiuto del server, che è l'unico modo in cui la modale resta aperta dopo
    // un «Salva lo stesso».
    setPromemoriaSciolto(false);
  }

  /**
   * Cambiare il docente titolare cambia LA FIRMA che si sta modificando, quindi i
   * campi «propri» vanno riletti dalla sua. Pattern «adjust state during render»
   * (lo stesso di `DateField`): niente setState dentro un effetto.
   */
  const [autoreIdrato, setAutoreIdrato] = useState(autoreId);
  if (autoreIdrato !== autoreId) {
    setAutoreIdrato(autoreId);
    const f = firmaDi(autoreId);
    const dest = destinatariDi(f);
    setTipo(tipoFirmaDa(f?.tipo_compresenza));
    setArgomentoProprio(f?.argomento_proprio ?? '');
    setCompitiPropri(f?.compiti_propri ?? '');
    setDestinatari(dest);
    setPerAlunniSel(assegnazioneMirata(f));
    // Come sopra: cambiato il titolare è cambiata LA FIRMA che si sta scrivendo,
    // e i due riquadri «propri» vengono riletti dalla sua. Un «Salva lo stesso»
    // dato sulla firma precedente non dice niente su questa.
    setPromemoriaSciolto(false);
  }

  /**
   * I docenti titolari della classe in cui si firma.
   *
   * Si riusa l'endpoint che ESISTE GIÀ (`admin/sections/[id]/teachers`) invece di
   * crearne un altro: il suo `assigned` viene da `docentiDiSezione`, che legge
   * `utenti_sezioni` — cioè esattamente la tabella su cui `isTitolareSezione`
   * valida il `docenteId` inviato. Due elenchi diversi vorrebbero dire una tendina
   * che propone nomi che il server poi rifiuta con 422.
   * Il gate è `requireStaff(admin|coordinator|segreteria)`: per un educator sarebbe
   * 403, e infatti la chiamata non parte nemmeno. La classe è `targetSectionId`,
   * non `sectionId`: in supplenza il titolare da cercare è quello dell'ALTRA classe.
   */
  const caricaDocenti = useCallback(async (classeId: string): Promise<{ elenco: Docente[]; ok: boolean }> => {
    const res = await fetch(`/api/admin/sections/${classeId}/teachers?userId=${userId}`).catch((e: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `registro-docenti-non-caricati: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
      return null;
    });
    if (!res) return { elenco: [], ok: false };
    const corpo = await res.json().catch(() => null) as { success?: boolean; assigned?: Docente[] } | null;
    if (!res.ok || !corpo?.success) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-docenti-non-caricati', route: ROTTA, stato: res.status });
      return { elenco: [], ok: false };
    }
    /*
     * SI FILTRA PER RUOLO, e il filtro è la sostanza di questa chiamata.
     *
     * `assigned` non è l'elenco dei docenti: è l'elenco del PERSONALE legato alla
     * sezione (`teachers/route.ts:60-64` → `RUOLI_PERSONALE`, che include admin,
     * coordinator, segreteria e cuoca). E poiché `isTitolareSezione`
     * (`valutatore.ts:24-43`) valida il `docenteId` sulla stessa `utenti_sezioni`,
     * il server ACCETTA la scelta: le due parti concordano, quindi nessuna delle
     * due ferma la firma forgiata. Senza questa riga la Segreteria potrebbe
     * attribuire a sé stessa — o alla Direzione, o alla cuoca — la firma che
     * `risolviValutatore` esiste per impedire («la firma resta del docente, non
     * della Segreteria», valutatore.ts:12-19), e per comparire in quella tendina le
     * basterebbe una POST sulla stessa route, che le è consentita.
     * Il ruolo assente vale come «non docente»: si esclude, mai il contrario.
     */
    const elenco = (corpo.assigned ?? []).filter((d) => d.ruolo === RUOLO_DOCENTE);
    return { elenco, ok: true };
  }, [userId]);

  useEffect(() => {
    if (!serveDocente) return;
    let vivo = true;
    caricaDocenti(targetSectionId).then(({ elenco, ok }) => {
      if (!vivo) return;
      setDocenti(elenco);
      setStatoDocenti(ok ? 'ok' : 'errore');
      // Cambiando classe il titolare scelto può non esserlo più: si azzera invece di
      // spedire un `docenteId` che il server rifiuterebbe con 422.
      setDocenteId((corrente) => (elenco.some((d) => d.id === corrente) ? corrente : ''));
    });
    return () => { vivo = false; };
  }, [serveDocente, targetSectionId, caricaDocenti]);

  const perAlunni = !altraClasse && (tipo === 'sostegno' ? true : perAlunniSel);
  /**
   * La firma VUOTA che si salvava con 200 e la spunta: con «Alunni selezionati» e
   * nessuna spunta il client mandava `argomento/compiti: undefined` e
   * `destinatariIds: []`, il server non scriveva niente e rispondeva 200. Per il
   * sostegno il toggle non è nemmeno disegnato, quindi era l'unica strada.
   */
  const senzaDestinatari = perAlunni && destinatari.length === 0;
  const senzaDocente = serveDocente && !docenteId;

  /**
   * ─── IL PROMEMORIA «ARGOMENTO SÌ, COMPITI NO» ───────────────────────────────
   *
   * Misurato sul database di produzione, ultimi 30 giorni: in II e III elementare
   * di Cesa 12 righe di registro su 12 portano l'ARGOMENTO e nessun COMPITO. Non
   * è un guasto del software: la bacheca del genitore mostra le lezioni che i
   * compiti ce li hanno davvero — `LezioniCompitiSections` filtra su
   * `l.compiti || l.individualizzate.some((i) => i.compiti)` — quindi quel testo
   * finisce in `/parent/lezioni` e in «Compiti» non arriva niente. È un campo
   * scambiato per un altro, dodici volte su dodici, e nessuno se n'è accorto
   * perché dalla parte del docente tutto sembrava salvato (e lo era).
   *
   * Qui NON cambia nessun dato: si chiede, e si prosegue con un clic.
   *
   * SI GUARDA LA COPPIA CHE PARTE DAVVERO, non due stati fissi. In assegnazione
   * mirata i condivisi non si inviano nemmeno (`perAlunni ? undefined : …`) e a
   * contare sono i «propri», che la bacheca legge eccome (`individualizzate`);
   * leggere i condivisi lì dentro farebbe scattare il promemoria su una riga già
   * idratata con l'argomento del titolare mentre i compiti mirati ci sono.
   *
   * Le esclusioni, e il perché di ciascuna:
   *  · COMPRESENZA — chi affianca non ha un argomento di classe da compilare:
   *    quello è del titolare. Chiederglielo sarebbe rumore su ogni sua ora, e il
   *    rumore è il modo più rapido per far ignorare un avviso che serve altrove.
   *  · COMPITI PIENI (condivisi o propri, secondo la modalità) — non c'è niente
   *    da ricordare.
   *  · ARGOMENTO VUOTO — non c'è nessuno scambio di campo in corso.
   *  · COMPITO TOLTO APPOSTA — la riga i compiti li AVEVA e il riquadro è stato
   *    svuotato qui dentro. Non è una dimenticanza: è il gesto esplicito per cui
   *    esiste metà di questo file (il patto `condivisiIdratati` col server nasce
   *    perché «un compito assegnato per errore non si poteva più togliere»).
   *    Chiedere «sicura? i genitori non vedranno nulla» a chi sta facendo
   *    esattamente quello sarebbe rumore sull'unica strada costruita apposta.
   *  · SUPPLENZA (`altraClasse`) — e questa è l'esclusione che costa di più
   *    spiegare, perché sembra il caso in cui l'avviso servirebbe di più.
   *    Il testo del promemoria dice «i genitori non vedranno nulla nella bacheca
   *    Compiti». In un'altra classe è un'affermazione che questa modale NON PUÒ
   *    FARE: la GET carica solo la propria sezione, quella riga non è mai stata
   *    letta, e i compiti del suo titolare possono esserci già. Peggio: il corpo
   *    della POST in supplenza non contiene nemmeno la chiave `compiti`, perché
   *    `condiviso()` la OMETTE — «non lo so» non è «è vuoto». Quindi la frase non
   *    descrive niente che stia per succedere.
   *    E chi le desse retta farebbe un danno: digitare i compiti in supplenza
   *    spedisce `compiti: "…"`, e un valore PIENO il server lo scrive sempre —
   *    SOVRASCRIVE il testo del titolare su una riga che il modulo non ha mai
   *    visto, cioè la regressione B1 dalla porta accanto.
   *    (Il nesso con `condivisiIdratati: false` qui è più debole di come è stato
   *    scritto fino al 2026-09-19: quella bandiera difende dall'AZZERAMENTO — il
   *    server rifiuta il `''` a chi non dichiara di aver letto — non da una
   *    sovrascrittura. A fare il danno è il valore pieno, da solo.)
   *    Un avviso che spinge verso una scrittura distruttiva è peggio di nessun
   *    avviso.
   *    Il prezzo è dichiarato: chi firma in un'altra classe e scambia i due campi
   *    non viene avvisato. È lo stesso prezzo della compresenza, e per lo stesso
   *    motivo — non si può dire il vero, quindi si tace.
   *    QUANTO COSTA, misurato: 0 firme fuori sezione su 83 negli ultimi 60 giorni,
   *    e 0 su 17 nel sottoinsieme delle righe da cui è partito tutto. Ma la misura
   *    va letta per intero, perché dimostra meno di quanto sembri: `altraClasse`
   *    non significa «supplenza», significa «una classe DIVERSA da quella della
   *    pagina». E i firmatari del caso d'origine sono 17 su 17 assegnati a più di
   *    una sezione: la tendina «Classe» era disponibile a tutti loro, quindi una
   *    maestra di II che compili la III dal registro della II finisce in questo
   *    ramo silenzioso pur essendone titolare. A database le due strade sono
   *    indistinguibili: lo zero dice che finora non è successo, non che non possa.
   *    La guardia sta QUI e non dentro `compitiPrima`: una condizione sola, in un
   *    posto solo, e un test che la toglie diventa rosso.
   *  · COMPITI DI CLASSE GIÀ SULLA RIGA, in assegnazione MIRATA — e qui non è
   *    «non possiamo saperlo»: è che la frase sarebbe FALSA.
   *    In mirata i condivisi non si spediscono (`perAlunni ? undefined : …`),
   *    quindi ciò che le famiglie vedranno non è il textarea ma la riga a
   *    DATABASE, `riga.compiti`. E se quei compiti di classe ci sono,
   *    `api/parent/primaria` serve `compiti: r.compiti` senza
   *    filtrare i destinatari — solo `individualizzate` è filtrato per
   *    `alunno_id` (si cita per NOME: quel file è cresciuto di ~290 righe
   *    mentre questo lavoro era in corso) — quindi arrivano anche alle famiglie degli alunni
   *    selezionati, e «i genitori non vedranno nulla nella bacheca Compiti» dice
   *    esattamente il contrario del vero.
   *    È lo stesso criterio della supplenza, applicato dove la modale SA: lì non
   *    poteva sapere e taceva; qui sa, e parlando direbbe il falso.
   *    Misurato in produzione: 1 firma in 180 giorni ha questa forma (compiti di
   *    classe pieni + argomento «proprio» pieno + compiti «propri» vuoti). Rara,
   *    ma reale — e costa una clausola.
   *
   * `.trim()`: uno spazio battuto per sbaglio non è un compito assegnato.
   *
   * NON si distingue la FIRMA dalla MODIFICA, ed è una decisione: «Modifica» è
   * la strada da cui si riparano proprio le righe già a database con l'argomento
   * e senza compiti, cioè le dodici da cui è partito tutto. Tacere lì
   * silenzierebbe il promemoria esattamente dove serve di più. Il prezzo del
   * falso positivo — la maestra che quel giorno compiti non ne ha dati e riapre
   * l'ora per correggere la materia — è un clic; quello del falso negativo è un
   * compito che le famiglie non vedono mai.
   */
  const argomentoInUso = perAlunni ? argomentoProprio : argomento;
  const compitiInUso = perAlunni ? compitiPropri : compiti;
  /** Che cosa c'era nel riquadro dei compiti quando la modale si è aperta. */
  const compitiPrima = perAlunni ? (firmaIniziale?.compiti_propri ?? '') : (riga?.compiti ?? '');
  /**
   * La sesta esclusione, e si legge sulla riga A DATABASE apposta: in mirata i
   * condivisi non partono, quindi ciò che le famiglie vedranno è `riga.compiti`,
   * non il textarea di classe (che qui non è nemmeno disegnato). Il perché — e la
   * misura — stanno nell'elenco delle esclusioni, sopra.
   */
  const compitiDiClasseGiaPresenti = perAlunni && (riga?.compiti ?? '').trim() !== '';
  const compitiDimenticati =
    !altraClasse &&
    tipo !== 'compresenza' &&
    argomentoInUso.trim() !== '' &&
    compitiInUso.trim() === '' &&
    compitiPrima.trim() === '' &&
    !compitiDiClasseGiaPresenti;

  const toggleDest = (id: string) =>
    setDestinatari((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Torna a "tutta la classe": azzera la selezione, così il submit non invia mai
  // destinatari residui quando l'assegnazione ridiventa di classe. I due riquadri
  // «propri» restano invece com'erano — un click sbagliato non deve cancellare il
  // testo — ma NON partono: chi lo impedisce è `proprio()`, sotto, che copre anche
  // le altre due uscite dalla modalità mirata (cambio tipo firma, supplenza).
  const scegliClasse = () => { setPerAlunniSel(false); setDestinatari([]); };
  const scegliAlunni = () => setPerAlunniSel(true);

  /**
   * Il valore di un campo CONDIVISO da mettere nel corpo, o `undefined` per non mandarlo.
   *
   * In supplenza la riga dell'ALTRA classe non è caricata: il textarea parte vuoto e NON
   * rappresenta il suo contenuto. Da quando il server scrive `'' → null` invece di ignorare
   * la stringa vuota, mandarlo CANCELLEREBBE l'argomento e i compiti scritti dal titolare di
   * quella classe — la regressione B1, riaperta dalla porta accanto. Nella PROPRIA classe il
   * campo è idratato, quindi un textarea vuoto vuole davvero dire «cancella» e si manda.
   */
  const condiviso = (valore: string) => (altraClasse && !valore ? undefined : valore);

  /**
   * Il valore di un campo PROPRIO (individualizzato) da mettere nel corpo.
   *
   * Simmetrico a `condiviso`, e per lo stesso motivo: **i propri viaggiano solo con
   * l'assegnazione MIRATA**, come i condivisi viaggiano solo con quella di classe.
   * Da quando i due riquadri sono IDRATATI dalla firma esistente, il loro stato
   * sopravvive a ogni uscita dalla modalità mirata — «Tutta la classe», il cambio di
   * tipo firma, la supplenza — e in tutti quei casi non sono nemmeno disegnati.
   * Spedirli pieni con `destinatariIds: []` è la richiesta che il server rifiuta con
   * 400 «Nessun alunno selezionato… oppure passa a "Tutta la classe"»
   * (`route.ts:386-393`): un errore che chiede una cosa che a schermo non c'è, sulla
   * stessa pagina che ha appena finito di correggerne uno identico.
   *
   * Tre casi, non due:
   *  · mirata            → il valore, così com'è;
   *  · di classe, QUI    → `''`, che il server (`route.ts:527-528`) scrive NULL.
   *    Ometterlo lascerebbe i propri a database, invisibili e non più modificabili;
   *  · di classe, ALTROVE (supplenza) → **niente**. Della firma del docente in
   *    quell'altra classe non sappiamo nulla: mandare `''` cancellerebbe la SUA
   *    attività individualizzata. «Non lo so» non è «è vuoto» — vedi `condiviso`.
   *
   * Sta nel corpo della richiesta e non nei setter di stato apposta: le strade che
   * escono dall'assegnazione mirata sono almeno tre, e una regola valida per più
   * strade vive in un posto solo. In cambio, un click sbagliato su «Tutta la classe»
   * non cancella il testo appena scritto: torna al click successivo.
   */
  const proprio = (valore: string) => (perAlunni ? valore : altraClasse ? undefined : '');

  const salva = async () => {
    if (senzaDestinatari || senzaDocente) return;
    setSaving(true);
    setError('');
    // Offline-first: senza rete si accoda SOLO la firma di classe (no destinatari): la
    // selezione degli alunni richiede la connessione (validazione + oscuramento lato server).
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (perAlunni) {
        setSaving(false);
        setError(t('firmaModalSelezioneOffline'));
        return;
      }
      // La coda offline non trasporta `docenteId` (`syncPendingRegistro`): una firma
      // di Segreteria accodata qui verrebbe rifiutata con 422 al primo flush, per
      // sempre e in silenzio. Meglio dirlo adesso.
      if (serveDocente) {
        setSaving(false);
        setError(t('firmaModalDocenteOffline'));
        return;
      }
      /*
       * LA SUPPLENZA OFFLINE SI RIFIUTA, e non è prudenza: è che la coda non sa dire
       * «questo campo non mandarlo».
       *
       * Due difetti in un colpo solo, misurati. (1) La riga accodata portava
       * `section_id: sectionId` — la classe della PAGINA, non quella firmata: la lezione
       * fatta in 2ª B finiva nel registro della 1ª A, con un «salvato» tranquillo.
       * `syncPendingRegistro` è scritto proprio per NON reinterpretare la sezione, quindi
       * nessuno a valle rimediava. (2) `LocalPrimariaRegistro.argomento` è
       * `string | null`, e `syncPendingRegistro` lo spedisce sempre: da quando il server
       * scrive `'' → null` invece di ignorare il vuoto, una supplenza accodata con i
       * campi vuoti — che è il caso NORMALE, perché della riga altrui non sappiamo niente —
       * CANCELLA argomento e compiti scritti dal titolare di quella classe.
       * Online il problema non si pone: lì il campo si OMETTE (vedi `condiviso`).
       */
      if (altraClasse) {
        setSaving(false);
        setError(t('firmaModalSupplenzaOffline'));
        return;
      }
      await saveLocalRegistro({
        // `targetSectionId` e non `sectionId`: in supplenza sono classi diverse, e la
        // sezione che si accoda dev'essere quella che si sta FIRMANDO. Qui le due
        // coincidono per forza (il ramo `altraClasse` è già uscito), ma scriverlo giusto
        // è ciò che impedisce al difetto di tornare se un domani il rifiuto cade.
        id: crypto.randomUUID(), section_id: targetSectionId, data, ora_lezione: ordine,
        materia_id: materiaId || null, argomento, compiti,
        // La data di consegna viaggia anche OFFLINE: il ramo online la spedisce da
        // sempre, questo la lasciava fuori dall'oggetto in coda e il docente vedeva
        // «salvato» mentre la scadenza spariva fra il telefono e il server.
        data_consegna_compiti: dataConsegnaCompiti || null,
        tipo_compresenza: tipo,
        creato_il: new Date().toISOString(),
      });
      setSaving(false);
      onSaved();
      return;
    }
    const r = await fetch(`/api/primaria/registro?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        sectionId: targetSectionId, data, oraLezione: ordine, materiaId: altraClasse ? null : (materiaId || null),
        // Argomento/compiti/consegna sono i contenuti CONDIVISI di classe: si inviano SOLO per
        // l'assegnazione a tutta la classe. In modalità «Alunni selezionati» (perAlunni) i
        // textarea condivisi non sono nemmeno mostrati e i loro stati restano vuoti: inviarli
        // sovrascriverebbe con stringhe vuote i contenuti scritti dal titolare sulla riga
        // condivisa (regressione B1). Coerente con la label «(solo per gli alunni selezionati)».
        argomento: perAlunni ? undefined : condiviso(argomento),
        compiti: perAlunni ? undefined : condiviso(compiti),
        dataConsegnaCompiti: perAlunni ? undefined : (altraClasse && !dataConsegnaCompiti ? undefined : (dataConsegnaCompiti || null)),
        tipoCompresenza: tipo,
        // I contenuti PROPRI: solo con l'assegnazione mirata, vuoti quando l'ora torna
        // di classe, ASSENTI in supplenza. I tre casi, e il perché, stanno in `proprio()`.
        argomentoProprio: proprio(argomentoProprio), compitiPropri: proprio(compitiPropri),
        // Destinatari inviati quando l'assegnazione è mirata e siamo nella classe corrente.
        destinatariIds: perAlunni && !altraClasse ? destinatari : [],
        // Segreteria/Direzione: la firma resta del docente titolare indicato.
        docenteId: serveDocente ? docenteId : undefined,
        // ── IL PATTO COL SERVER, e senza di lui metà della correzione non arriva ──
        // Un riquadro condiviso lasciato VUOTO vale «svuota» soltanto se chi lo manda
        // ha davvero letto ciò che c'era: altrimenti è «non lo so», e scriverlo
        // cancellerebbe il testo di un collega. Il server rifiuta l'azzeramento a chi
        // non lo dichiara (`condivisiIdratati`) — ed è la difesa che protegge dalla
        // coda offline, che i tre condivisi li spedisce sempre senza averli letti.
        // Qui la dichiarazione è VERA: dal 2026-09-09 gli stati nascono da `riga`.
        // Ma SOLO nella propria classe: in supplenza la GET non carica la riga
        // dell'altra sezione (`classeIdrata` riazzera i campi), e dichiararlo lì
        // significherebbe cancellare l'argomento di un'altra classe con un modulo
        // che non l'ha mai visto. Senza questa riga il compito assegnato per errore
        // resterebbe per sempre — cioè il difetto da cui è partito tutto.
        condivisiIdratati: !altraClasse,
      }),
    }).catch((e: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `registro-firma-non-inviata: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
      return null;
    });
    if (!r) { setSaving(false); setError(t('comuneErroreRete')); return; }
    // `.catch(() => ({}))`: 413 e 502 rispondono HTML, non JSON. Senza questo il
    // `json()` LANCIAVA prima di `setSaving(false)` e il bottone restava disabilitato
    // per sempre — la stessa lezione già imparata dieci righe più su, sugli allegati.
    const d = await r.json().catch(() => ({} as { error?: string; success?: boolean }));
    setSaving(false);
    // Oltre il termine: la riga dell'ora, fuori da questa modale, mostrerà
    // «Sblocca» alla Direzione. Solo nella PROPRIA classe: in supplenza il 423
    // riguarda l'ora di un'altra classe, che su questa griglia non c'è.
    const oltreTermine = r.status === 423;
    setBloccata(oltreTermine && !altraClasse);
    if (oltreTermine && !altraClasse) onBloccata?.(giorniLimiteDa(d));
    if (!r.ok || d.success === false) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-firma-rifiutata', route: ROTTA, stato: r.status });
      // Codice → catalogo nella lingua dell'interfaccia (il 423 porta `VOCE_BLOCCATA`):
      // la prosa del server è italiana, e resta solo come ripiego senza codice.
      setError(messaggioDaCorpo(d, t('comuneErrore')));
    } else onSaved();
  };

  /**
   * IL GESTO «Firma», con il promemoria interposto QUI e non dentro `salva`.
   *
   * Così la conferma richiama `salva` così com'è — nessun parametro «ignora il
   * promemoria» da ricordarsi di passare, e nessuna guardia scavalcata: le due
   * che fermano davvero il salvataggio (`senzaDestinatari`, `senzaDocente`)
   * restano dove sono e vengono prima. Il corpo della POST non cambia di un
   * campo: è la garanzia che un avviso non tocchi i dati.
   */
  const firma = () => {
    if (senzaDestinatari || senzaDocente) return;
    if (compitiDimenticati && !promemoriaSciolto) { setPromemoria(true); return; }
    void salva();
  };

  const salvaLoStesso = () => {
    setPromemoria(false);
    setPromemoriaSciolto(true);
    /*
     * ANCHE IL PROMEMORIA ACCETTATO LASCIA UNA RIGA. Senza, «quante volte si
     * firma sapendo di non aver messo compiti» non è misurabile, e fra un mese
     * nessuno saprebbe dire se l'aiuto ha funzionato o se è soltanto un clic in
     * più: è la stessa ambiguità del §5 di AGENTS.md, dove i soli errori non
     * distinguono «tutto bene» da «non è mai partito niente».
     * `warn` e non `info` perché `/api/logs` accetta solo `warn|error`.
     * `evento: 'fetch'` + `route`: la riga annota la POST che parte subito dopo,
     * ed è l'unico evento del catalogo che quel contesto ce l'ha. Nessun campo:
     * qui non c'è niente da contare che non sia il fatto stesso.
     */
    logClient({ livello: 'warn', evento: 'fetch', messaggio: 'registro-firma-senza-compiti-confermata', route: ROTTA });
    void salva();
  };

  return (
    <>
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-kidville-ink/40 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby={campo('titolo')} className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-card bg-white shadow-xl">
        <div className="flex items-center gap-2 rounded-t-card bg-kidville-green p-4 text-kidville-yellow">
          <BookOpen size={18} />
          <h3 id={campo('titolo')} className="font-barlow text-lg font-bold">{t('firmaModalTitolo', { ora: ordine })}</h3>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {error && <div role="alert" className="rounded-card bg-kidville-error/10 text-kidville-error px-3 py-2 text-sm font-maven">{error}</div>}
          {/* Lo sblocco NON sta qui dentro: questa modale ha il velo sfocato come
              antenato, e su Android la modale dello sblocco sparirebbe dall'albero
              di accessibilità. Sta sulla riga dell'ora, dopo la chiusura. */}
          {bloccata && (
            <p data-testid="firma-bloccata-hint" className="font-maven text-[11px] text-kidville-warn-strong">
              {puoSbloccare(ruolo) ? t('firmaModalBloccataDirezione') : t('firmaModalBloccataDocente')}
            </p>
          )}

          {/* Classe: di default la corrente, ma è possibile firmare in un'altra (supplenza). */}
          {sezioni.length > 1 && (
            <div>
              <label htmlFor={campo('classe')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalClasse')}</label>
              <select id={campo('classe')} value={targetSectionId} onChange={(e) => setTargetSectionId(e.target.value)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
                {sezioni.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === sectionId ? ` ${t('firmaModalQuestaClasse')}` : ''}</option>)}
              </select>
              {altraClasse && <p className="mt-1 font-maven text-[11px] text-kidville-warn">{t('firmaModalSupplenza')}</p>}
            </div>
          )}

          {/* Segreteria/Direzione: la firma è del docente, mai della Segreteria. */}
          {serveDocente && (
            <div>
              {/* `text-kidville-sub` e NON `muted`: quel token sta a 3,80:1 su bianco, sotto i
                  4,5:1 di WCAG AA, e il suo debito può solo calare (`__tests__/a11y/testo-muted-allowlist`).
                  (Qui c'è stato scritto 2,51:1 fino al 2026-09-19: era il vecchio `#9AA6A2`. Oggi
                  il token vale `#7B8582` — `globals.css:106`, e il 3,80:1 sta in `globals.css:633-634`.
                  La conclusione non cambia: resta sotto AA.)
                  Le etichette qui accanto lo usano perché sono più vecchie del lock, non perché vada bene. */}
              <label htmlFor={campo('docente')} className="block font-maven text-xs text-kidville-sub">{t('firmaModalDocenteTitolare')}</label>
              <select
                id={campo('docente')}
                required
                value={docenteId}
                onChange={(e) => setDocenteId(e.target.value)}
                className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
              >
                <option value="">{t('firmaModalSeleziona')}</option>
                {docenti.map((d) => (
                  <option key={d.id} value={d.id}>{nomeCompleto(d.nome, d.cognome, 'cognome-nome')}</option>
                ))}
              </select>
              <p className="mt-1 font-maven text-[11px] text-kidville-sub">
                {statoDocenti === 'errore'
                  ? t('firmaModalDocentiNonCaricati')
                  : statoDocenti === 'ok' && docenti.length === 0
                    ? t('firmaModalNessunDocente')
                    : t('firmaModalDocenteObbligatorio')}
              </p>
            </div>
          )}

          {!altraClasse && (
            <div>
              <label htmlFor={campo('materia')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalMateria')}</label>
              <select id={campo('materia')} value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
                <option value="">{t('firmaModalSeleziona')}</option>
                {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
              </select>
            </div>
          )}

          <div>
            <label htmlFor={campo('tipo')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalTipoFirma')}</label>
            <select id={campo('tipo')} value={tipo} onChange={(e) => setTipo(e.target.value as TipoFirma)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
              <option value="principale">{t('firmaModalTipoPrincipale')}</option>
              <option value="compresenza">{t('firmaModalTipoCompresenza')}</option>
              <option value="cofirma">{t('firmaModalTipoCofirma')}</option>
              <option value="sostegno">{t('firmaModalTipoSostegno')}</option>
            </select>
          </div>

          {/* Destinatari (P7/B1): compiti e argomento per TUTTA LA CLASSE o per ALUNNI
              SELEZIONATI. Il toggle vale per qualsiasi tipo di firma; per il sostegno è
              forzato (attività sempre individualizzata) e per questo non compare. In
              supplenza (altra classe) l'assegnazione resta di classe. */}
          {!altraClasse && tipo !== 'sostegno' && (
            <div>
              <label className="block font-maven text-xs text-kidville-muted">{t('firmaModalDestinatari')}</label>
              <div className="mt-1 inline-flex rounded-pill border border-kidville-line p-0.5" role="group" aria-label={t('firmaModalDestinatariAria')}>
                <button
                  type="button"
                  onClick={scegliClasse}
                  aria-pressed={!perAlunni}
                  className={`font-maven rounded-pill px-3 py-1 text-xs ${!perAlunni ? 'bg-kidville-green text-kidville-yellow' : 'text-kidville-ink'}`}
                >
                  {t('firmaModalTuttaClasse')}
                </button>
                <button
                  type="button"
                  onClick={scegliAlunni}
                  aria-pressed={perAlunni}
                  className={`font-maven rounded-pill px-3 py-1 text-xs ${perAlunni ? 'bg-kidville-green text-kidville-yellow' : 'text-kidville-ink'}`}
                >
                  {t('firmaModalAlunniSelezionati')}
                </button>
              </div>
            </div>
          )}

          {!perAlunni ? (
            <>
              <div>
                <label htmlFor={campo('argomento')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalArgomentoClasse')}</label>
                {/* `aria-describedby` su ENTRAMBI i riquadri e non sul solo «Compiti»:
                    l'aiuto spiega la DIFFERENZA fra i due, e chi legge con uno screen
                    reader arriva all'argomento per primo — è lì che la distinzione
                    serve, prima di scrivere, non dopo. */}
                <textarea id={campo('argomento')} aria-describedby={campo('aiuto')} value={argomento} onChange={(e) => setArgomento(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
              </div>
              <div>
                <label htmlFor={campo('compiti')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalCompitiClasse')}</label>
                <textarea ref={compitiRef} id={campo('compiti')} aria-describedby={campo('aiuto')} value={compiti} onChange={(e) => setCompiti(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
                {/* L'AIUTO: una riga, sotto i campi che riguarda, e non in cima a una
                    modale già densa — in cima sarebbe letto prima di sapere di cosa
                    parla, e soprattutto scorrerebbe via. La mezza frase che conta è
                    l'ultima: «solo i compiti arrivano alla bacheca delle famiglie».
                    `text-kidville-sub` (6,46:1) e non `muted`, che sta a 3,80:1 su
                    bianco — sotto i 4,5:1 di WCAG AA per il testo piccolo
                    (`__tests__/a11y/testo-muted-allowlist`, debito che può solo calare). */}
                <p id={campo('aiuto')} className="mt-1 font-maven text-[11px] leading-snug text-kidville-sub">
                  {t('firmaModalAiutoCompiti')}
                </p>
              </div>
            </>
          ) : (
            <div className="rounded-card bg-kidville-info-soft p-3">
              <p className="mb-2 font-maven text-xs text-kidville-info">
                {tipo === 'sostegno'
                  ? t('firmaModalInfoSostegno')
                  : t('firmaModalInfoSelezionati')}
              </p>
              <div className="mb-2 max-h-32 overflow-y-auto rounded bg-white p-2">
                {alunni.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 py-0.5 font-maven text-sm">
                    <input type="checkbox" checked={destinatari.includes(a.id)} onChange={() => toggleDest(a.id)} />
                    {nomeCompleto(a.nome, a.cognome, 'cognome-nome')}
                  </label>
                ))}
              </div>
              {senzaDestinatari && (
                <p role="status" className="mb-2 font-maven text-[11px] font-semibold text-kidville-error">
                  {t('firmaModalNessunDestinatario')}
                </p>
              )}
              {/* STESSO AIUTO, STESSO `aria-describedby`, anche qui — e non è una
                  copia per simmetria.
                  Per il SOSTEGNO `perAlunni` è forzato a `true` (vedi sopra): una
                  docente di sostegno non vede MAI il ramo di classe, quindi senza
                  i due `aria-describedby` e la riga d'aiuto in fondo a questo
                  riquadro riceverebbe il promemoria — che di qui scatta eccome —
                  senza aver mai letto la spiegazione, cioè metà dell'intervento e
                  proprio la metà che insegna qualcosa.
                  Il testo è LO STESSO, non una variante: la frase che conta
                  («solo i compiti arrivano alla bacheca delle famiglie») è vera
                  parola per parola anche qui, perché la bacheca filtra su
                  `l.compiti || l.individualizzate.some((i) => i.compiti)` —
                  i compiti mirati ci arrivano. Le due etichette dicono già «solo
                  per gli alunni selezionati»: ripeterlo nell'aiuto allungherebbe
                  la riga esattamente dove la modale è più densa (riquadro info +
                  elenco degli alunni) senza aggiungere un'informazione.
                  L'`id` è lo stesso perché i due rami sono ESCLUSIVI: non esiste
                  un render in cui entrambe le `<p>` siano montate. */}
              <label htmlFor={campo('argomento-propri')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalArgomentoSelezionati')}</label>
              <textarea id={campo('argomento-propri')} aria-describedby={campo('aiuto')} value={argomentoProprio} onChange={(e) => setArgomentoProprio(e.target.value)} rows={2} className="mb-2 font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
              <label htmlFor={campo('compiti-propri')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalCompitiSelezionati')}</label>
              <textarea ref={compitiRef} id={campo('compiti-propri')} aria-describedby={campo('aiuto')} value={compitiPropri} onChange={(e) => setCompitiPropri(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
              {/* `text-kidville-sub` su `bg-kidville-info-soft`: come nel ramo di
                  classe, e per la stessa ragione — `muted` non basta. */}
              <p id={campo('aiuto')} className="mt-1 font-maven text-[11px] leading-snug text-kidville-sub">
                {t('firmaModalAiutoCompiti')}
              </p>
            </div>
          )}

          {/* Data di consegna compiti (facoltativa): è un campo di CLASSE
              (registro_orario.data_consegna_compiti) → solo per l'assegnazione a tutta la
              classe. La consegna per i singoli destinatari (data_consegna_propri) è rinviata. */}
          {!perAlunni && (
            <div>
              <label htmlFor={campo('consegna')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalConsegnaCompiti')}</label>
              <DateField
                id={campo('consegna')}
                value={dataConsegnaCompiti}
                onChange={setDataConsegnaCompiti}
                aria-label={t('firmaModalConsegnaAria')}
                className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-kidville-line p-4">
          <button onClick={onClose} className="font-maven rounded-pill bg-kidville-cream px-4 py-2 text-sm text-kidville-ink">{t('firmaModalAnnulla')}</button>
          <button onClick={firma} disabled={saving || senzaDestinatari || senzaDocente} className="font-maven rounded-pill bg-kidville-green px-4 py-2 text-sm text-kidville-yellow disabled:opacity-50">
            {saving ? t('comuneSalvataggio') : t('registroFirma')}
          </button>
        </div>
      </div>
    </div>

    {/*
      IL PROMEMORIA, E PERCHÉ NON `confirm()`.
      Un dialogo nativo blocca il thread della WebView e l'automazione dei
      collaudi, e il repo non lo usa da nessuna parte: il modello è
      `DialogoEliminaMedia`, cioè la primitiva `Modal` (`@/components/ui/Modal`)
      più `btnClass` — focus-trap, Escape, tasto Indietro di Android e sfondo
      reso inerte compresi. Fratello della modale di firma e non figlio: lo
      stack di `Modal` regge i dialoghi annidati, e il velo che sfoca non deve
      finire ANTENATO del dialogo (su Android cancellerebbe il sottoalbero
      dall'albero di accessibilità).
      NON È UN MURO: «Salva lo stesso» salva, con un clic e con lo stesso
      identico corpo di richiesta. Chi quel giorno compiti non ne ha dati esce
      di lì immediatamente.
    */}
    {promemoria && (
      <Modal
        open
        onClose={() => setPromemoria(false)}
        title={t('firmaModalPromemoriaTitolo')}
        // `labelledBy` sull'`<h2>` che il titolo ce l'ha già a schermo: col solo
        // `title` la primitiva mette un `aria-label`, e uno screen reader
        // annuncerebbe «Compiti non compilati» due volte di fila — una come nome
        // del dialogo, una leggendo l'intestazione. `title` resta perché la prop
        // è obbligatoria, ma con `labelledBy` la primitiva non emette l'attributo.
        labelledBy={campo('promemoria-titolo')}
        // Come per la conferma di eliminazione: un click distratto sullo sfondo
        // non deve valere né come «salva» né come «annulla». Escape e Indietro
        // restano aperti — sono un annullamento esplicito.
        closeOnBackdrop={false}
        className="w-full max-w-md rounded-card bg-kidville-white p-5 shadow-xl"
      >
        <div className="mb-3 flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-warn-soft text-kidville-warn-strong">
            <AlertTriangle size={22} strokeWidth={1.9} aria-hidden="true" />
          </div>
          <h2 id={campo('promemoria-titolo')} className="font-barlow text-lg font-bold uppercase leading-tight text-kidville-green">
            {t('firmaModalPromemoriaTitolo')}
          </h2>
        </div>
        <p className="font-maven text-[13px] leading-snug text-kidville-ink">{t('firmaModalPromemoriaCorpo')}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {/*
            «TORNA AI COMPITI» DEVE PORTARE AI COMPITI, non solo chiudere.
            Misurato prima di questa riga: dopo il click `document.activeElement`
            era `<body>` in jsdom e il bottone «Firma» in un browser vero — mai il
            riquadro che l'etichetta nomina. Per chi naviga da tastiera o con uno
            screen reader quel bottone era un semplice «annulla» con un'altra
            etichetta. La ref alzata qui la legge l'effetto in cima a `FirmaModal`,
            DOPO che la cleanup della primitiva ha finito di spostare il fuoco.
          */}
          <button
            type="button"
            onClick={() => { tornaAiCompiti.current = true; setPromemoria(false); }}
            className={btnClass('ghost', 'sm')}
          >
            {t('firmaModalPromemoriaTorna')}
          </button>
          <button type="button" onClick={salvaLoStesso} className={btnClass('primary', 'sm')}>
            {t('firmaModalPromemoriaSalva')}
          </button>
        </div>
      </Modal>
    )}
    </>
  );
}
