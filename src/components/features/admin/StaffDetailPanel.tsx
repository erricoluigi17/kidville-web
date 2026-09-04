'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  X, Pencil, Check, KeyRound, Loader2, ShieldCheck, AlertTriangle, Clock,
  FileQuestion, FileText, ExternalLink, Copy, CheckCircle2, Mail, IdCard,
  ClipboardList, UserCog, Plus, Upload, RefreshCw,
} from 'lucide-react';
import { RUOLI_ASSEGNABILI, useLabelRuolo } from '@/lib/auth/ruoli';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { puoRigenerareCredenzialiStaff } from '@/lib/auth/credenziali-staff';
import { RUOLI_DIREZIONE, type AppRole } from '@/lib/auth/predicati-ruolo';
import { useDateFormat } from '@/lib/i18n/date';
import { dataCivile } from '@/i18n/config';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Tabs } from '@/components/ui/cockpit';
import { PERSONALE_FIELDS, PERSONALE_LIMITI } from '@/lib/forms/personale-template';
import { caricaFile } from '@/lib/upload/carica-file';
import { messaggioDaCorpo, messaggioSoloCatalogo } from '@/lib/ui/esito-fetch';
import { useDestinazioniSede, altreSedi, nomeSede, stessaSede } from './destinazioni-sede';
import { giorniResidui, sogliaRaggiunta } from '@/lib/anagrafica/scadenze';
import { AVVISO_FINESTRA_BLOCCATA, apriDocumentoFirmato } from '@/lib/ui/apri-documento-firmato';
import { FUOCO_ESITO } from '@/lib/ui/fuoco';
import { logClient } from '@/lib/logging/client';

// Scheda dedicata di un membro dello STAFF (elenco reale da `utenti`, tab Staff
// dell'anagrafica). Si auto-carica da GET /api/admin/staff e seleziona il membro.
// Sola lettura per la Segreteria; modifica ruolo/sede/classi + rigenera credenziali
// riservate alla Direzione (affordance nascoste, gate applicato dal server).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  IL PERIMETRO, DICHIARATO: I DATI ANAGRAFICI NON SI DIGITANO DA QUI      ║
// ║  — ma la SCANSIONE del documento si carica, ed è un'altra cosa           ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ⚠️ FINO AL 12/08/2026 QUESTA TESTATA DICEVA «QUI L'ANAGRAFICA È IN SOLA
// LETTURA», e da quel giorno la frase sarebbe diventata FALSA per due colonne. È
// riscritta invece che cancellata perché l'argomento che portava resta valido:
// cambia il suo perimetro, non la sua sostanza.
//
// ── 1. I VENTI `<input>` NON ARRIVANO, E LA RAGIONE È QUELLA DI SEMPRE ──────
//
// Da qui non si CORREGGE nessun dato anagrafico. La data di nascita, il codice
// fiscale e la residenza entrano per una strada sola — la persona compila
// `/anagrafica-personale`, la Segreteria APPROVA la pratica — e si aggiornano
// dalla stessa, oppure dal cruscotto delle scadenze quando è la scadenza a
// cambiare. Venti `<input>` aggiunti a questa scheda sarebbero un SECONDO modulo
// di raccolta, con la propria validazione da tenere allineata a
// `PERSONALE_FIELDS`, il proprio `consents_log` da non scrivere e la propria
// strada per infilare in `anagrafica_personale` un codice fiscale che nessuno ha
// verificato. Il costo non si vede il giorno in cui si aggiungono: si vede il
// primo giorno in cui le due strade divergono — «una regola valida per due strade
// deve vivere in un posto solo».
//
// ── 2. LA SCANSIONE NON È UN DATO DIGITATO ─────────────────────────────────
//
// È un FILE, e il suo percorso lo scrive il SERVER: chi carica non digita niente,
// non dichiara niente e non sceglie dove il file finisce. Non c'è nessuna
// validazione da duplicare (i cinque tipi ammessi vivono già in
// `@/lib/upload/allegati-pubblici`, che è il gate del bucket) e nessun consenso da
// registrare (quello della copia del documento è già stato dato con la pratica, e
// qui è la Scuola che archivia un documento che le è stato consegnato). Cioè
// esattamente nessuno dei tre costi del punto 1.
//
// ── 3. È LA PORTA CHE LA ROUTE GEMELLA PROMETTEVA ──────────────────────────
//
// `admin/anagrafica-personale/route.ts:169-178` tiene `documento_fronte_path` e
// `documento_retro_path` FUORI dalla whitelist della PATCH, e chiude così: «la
// scansione si sostituisce caricandone una nuova, che è un'altra porta e ha il suo
// gate». Quella porta è `admin/anagrafica-personale/scansione:POST`, e questo tab
// è la sua interfaccia. Il percorso continua a non arrivare mai dal client.
//
// ⚠️ IL CONTROLLO DI CARICAMENTO NON STA DIETRO `canEdit`. `canEdit` è
// `admin`/`coordinator` ed è il gate del tab INCARICO (ruolo, sede, classi: le
// decide la Direzione). La scansione la consegna chi sta al banco, cioè la
// SEGRETERIA — è la stessa ragione scritta nella testata della route gemella, e in
// produzione i tre account `segreteria` sono quelli che questo gesto lo faranno
// davvero. Il server, comunque, ha il suo gate e non si fida di questa riga.
//
// Il tab Incarico resta modificabile: ruolo, sede e classi NON sono anagrafica —
// vivono in `utenti` e in `class_teachers`, li decide la Direzione, e il modulo
// pubblico non li tocca mai (`personale-template.ts`, requisito 7).

interface StaffMember {
  id: string;
  nome?: string;
  cognome?: string;
  email?: string | null;
  ruolo: string;
  scuola_id?: string | null;
  gradi?: string[];
}
interface School { id: string; nome: string }
interface Section { id: string; name: string; scuola_id: string; school_type?: string }
interface Assegnazione { utente_id: string; section_id: string }

interface Props {
  staffId: string;
  onClose: () => void;
}

/** Il modulo pubblico che alimenta l'anagrafica: un solo link, senza sede. */
const PERCORSO_MODULO = '/anagrafica-personale';
const API_ANAGRAFICA = '/api/admin/anagrafica-personale';
const ROUTE_LOG = '/admin/students';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  I COMANDI DI QUESTA SCHEDA SONO ALTI 44px, E NON È UN GUSTO            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * MISURATO in Chrome sul DOM vero del pannello, prima di questa riga:
 * «Copia il link del modulo» 195×**40**, «Invia per email» 144×43, «Apri la
 * scansione» 172×**39**, «Riprova» 75×**39**. Il più piccolo era il comando
 * PRINCIPALE dello stato vuoto — cioè la schermata che la segreteria vedrà dieci
 * volte su dieci la prima settimana (dieci insegnanti con un account, zero
 * anagrafiche). Per confronto, i due comandi del piede «Incarico», scritti mesi
 * fa, stanno a 828×44 (`h-11`).
 *
 * 44×44 è la soglia raccomandata di WCAG §2.5.5, e qui non è teorica: questa
 * scheda si apre da `/admin/students/[id]` anche dentro la WebView Capacitor,
 * cioè da un telefono, con un dito. Un comando mancato su «Apri la scansione»
 * non è un fastidio: o non apre niente, o apre il documento d'identità di
 * qualcun altro.
 *
 * L'altezza viene da `min-h-[44px]` e NON da `py-*`: il padding verticale la
 * fissa a un valore che dipende dall'interlinea del testo tradotto, e in inglese
 * o in tedesco le stesse etichette cambiano. `min-h` è un PAVIMENTO — se la
 * frase va a capo il bottone cresce, e non scende mai sotto la soglia. È lo
 * stesso idioma già usato in `StudentTable`, `AdminMenuSheet` e `AdminBottomNav`.
 *
 * RIMISURATO DOPO, in **WebKit** a 390×844 — cioè nel motore della WebView
 * Capacitor, non in quello che sta più comodo: copia 236×**44**, email
 * 155,5×**44**, scansione 180,8×**44**, riprova 98,4×**44**. Il numero che
 * conta è il secondo, e sono quattro su quattro.
 *
 * ⚠️ Le due costanti stanno qui e non nei quattro punti d'uso perché la stessa
 * stringa era già ribattuta quattro volte: la prossima pillola scritta a mano
 * nascerebbe di nuovo a 39px, e nessun test la vedrebbe. Lock:
 * `StaffDetailPanel-anagrafica.test.tsx`, «i comandi nuovi hanno un bersaglio da
 * 44px».
 */
const CMD_BASE =
  'inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-pill px-4 font-barlow text-sm font-bold uppercase transition-colors';
/** Il comando principale: pieno, verde. Uno solo per schermata. */
export const CMD_PRIMARIO = `${CMD_BASE} bg-kidville-green tracking-[0.03em] text-kidville-white hover:bg-kidville-green-dark`;
/** Il comando di contorno: contornato, sullo stesso verde. */
export const CMD_SECONDARIO = `${CMD_BASE} border-[1.5px] border-kidville-green/40 tracking-[0.02em] text-kidville-green hover:bg-kidville-green-soft`;

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LA MISURA DELLA RIGA: 448px, E IL NUMERO NON È SPERATO — È MISURATO    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * MISURATO in Chrome (canale `chrome`, non headless-shell) su una replica di
 * questa scheda col CSS vero e i font veri serviti da `:3100`, con un `Range`
 * carattere per carattere sui nodi di testo — non in unità `ch`. Larghezza VERA
 * della pagina: `CockpitPage max={960}` (`admin/students/[id]`) + `sm:px-8` →
 * card **896 px**, `md:p-6` → contenuto **848 px**. Caratteri della riga più
 * lunga, PRIMA di questa costante:
 *
 *   «Richiedi l'aggiornamento», il corpo ......................... **127**
 *   banner «documento scaduto» .................................. **118**
 *   banner «documento mancante» ................................. **114**
 *   banner «in scadenza» ........................................ **106**
 *   «Sola lettura» ..............................................  **95**
 *
 * Contro le ~75 oltre cui l'occhio perde il rientro fra una riga e la successiva
 * e si rilegge la stessa riga o se ne salta una. Non è una raffinatezza: sono le
 * frasi che portano l'unico fatto nuovo del modulo — «il documento è scaduto»,
 * «nessun avviso automatico partirà» — e il banner dello scaduto, che è la sola
 * riga della scheda da leggere fino in fondo, era anche la più lunga.
 *
 * ── PERCHÉ PROPRIO 28rem ────────────────────────────────────────────────────
 * Non è un numero nuovo: è quello che lo STATO VUOTO di questa stessa card già
 * portava (`max-w-md` = 28rem = 448 px) e che lì misurava **73** caratteri. La
 * regola era nota e applicata in un punto solo; qui diventa una costante e lo
 * stato vuoto la adotta al posto del suo `max-w-md` — stesso valore, quindi
 * stessa resa, ma una definizione sola invece di cinque punti indipendenti.
 * RIMISURATO dopo: banner 66 · 69 · 69 · 71, stato vuoto 73. Quattro su quattro.
 *
 * ⚠️ E UNA SOLA COSTANTE NON BASTA, ed è la parte che la prima misura ha
 * smentito. Il tetto vero è in CARATTERI, e i caratteri per pixel dipendono dal
 * CORPO: misurati su questi testi, Maven Pro sta a **6,37 px** per carattere a
 * 14 px e a **5,46 px** a 12 px. Applicando 28rem a tutti e cinque, le due righe
 * `text-xs` scendevano da 127 e 95 a **82 e 81** — cioè restavano sopra il
 * limite, con un vincolo che sembrava messo. Un numero solo per due corpi
 * diversi è di nuovo un vincolo che dichiara una cosa e ne produce un'altra:
 * perciò le costanti sono DUE, e portano il corpo nel nome.
 *
 * ⚠️ NON SI SCRIVE IN `ch`. `1ch` è la larghezza dello ZERO, e in Maven Pro lo
 * zero è più largo della minuscola media: `max-w-[60ch]` vale 542 px e in 542 px
 * ci stanno 87 caratteri — un vincolo che dichiara un numero e ne produce un
 * altro. La misura è già stata pagata in questo repo (`FieldRenderer.tsx`,
 * 11/08/2026, «60ch prometteva sotto gli 80 e produceva 87»).
 *
 * ⚠️ NON SI APPLICA A UN `inline`. `max-width` non ha effetto sugli elementi
 * inline non rimpiazzati: nei banner e in «Sola lettura» il testo sta dentro uno
 * `<span>` che è FIGLIO DIRETTO di un contenitore `flex`, cioè un flex item, cioè
 * blockified — e lì morde. Uno `<span>` messo dentro un `<p>` normale non farebbe
 * assolutamente niente, e nessun test in jsdom potrebbe accorgersene (jsdom non
 * impagina: `getBoundingClientRect()` restituisce zeri).
 */
const MISURA_PROSA = 'max-w-[28rem]';

/**
 * La stessa misura per il corpo `text-xs` (12 px): 25rem = 400 px → **74**
 * caratteri misurati su «Richiedi l'aggiornamento» (erano 127) e **74** su «Sola
 * lettura» (erano 95). Il numero è più piccolo perché a 12 px in un pixel ci sta
 * più testo, non perché queste due righe contino meno: la prima è quella che
 * spiega COME si rimedia a un documento scaduto.
 */
const MISURA_PROSA_XS = 'max-w-[25rem]';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LE LINGUETTE SONO IL COMANDO CHE SI PREME PRIMA DI TUTTI GLI ALTRI     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * MISURATO con `getBoundingClientRect()` in Chrome, coi font veri: «Incarico»
 * 103,7×**36**, «Anagrafica» 121,3×**36**, «Documento» 117,8×**36**. L'altezza è
 * deterministica e non dipende dalla lingua (`py-2` = 16 px + interlinea
 * `text-sm` = 20 px), quindi il 36 vale anche in inglese e in tedesco.
 *
 * Nello stesso file i quattro comandi nuovi stanno a 44 px esatti (vedi
 * `CMD_BASE`), e il motivo scritto là vale identico qui: questa scheda si apre da
 * `/admin/students/[id]` anche dentro la WebView Capacitor, cioè da un telefono,
 * con un dito. Ma le linguette sono l'UNICO modo di raggiungere i due tab nuovi:
 * sono il bersaglio che si preme PRIMA di tutti gli altri. Alzare i quattro
 * comandi in fondo al percorso e lasciare a 36 px quello all'inizio annulla il
 * motivo per cui si sono alzati.
 *
 * ⚠️ PERCHÉ UNA VARIANTE E NON UNA MODIFICA A `Tabs`. `Tabs` (`cockpit.tsx`) è
 * condiviso da sette schermate e il suo `className` finisce sul CONTENITORE, non
 * sui bottoni: non offre nessuna via per alzarli. `[&>button]:` è la sola forma
 * che alza i bersagli SOLO qui, senza cambiare sotto i piedi alle altre sei
 * schermate — che andrebbero misurate una per una, e non è questo il lavoro. Se
 * un giorno si decide che i 44 px valgono per tutte, il posto è `cockpit.tsx`.
 */
const LINGUETTE_44 = '[&>button]:min-h-[44px]';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  E LE DUE TENDINE SONO IL COMANDO PIÙ COSTOSO DA SBAGLIARE DI TUTTI     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * MISURATO con `getBoundingClientRect()` sul pannello vivo a 1440 px, DOPO che
 * questo lavoro aveva alzato tutto il resto: `<select>` Ruolo **418×34,5**,
 * `<select>` Sede **418×34,5**. Nella STESSA schermata, nello stesso momento:
 * pillole 81,5×**44**, linguette 103,7/121,3/117,8×**44**, «Salva» 422×**44**,
 * «Annulla» 426×**44**, «Copia il link del modulo» 195,2×**44**.
 *
 * Cioè: sei pillole, tre linguette e quattro comandi alzati a 44 px con due
 * riquadri di commento che spiegano perché — e lasciate indietro proprio le due
 * tendine che decidono RUOLO e SEDE. Un principio applicato dove non costava e
 * sospeso dove costava non è un principio: è una rifinitura. E la sede è il
 * campo su cui questo repo ha già pagato il conto più caro — «una route che
 * indovina la sede archivia i dati nel plesso sbagliato in silenzio»: un tocco
 * mancato su una tendina da 34,5 px, in una WebView Capacitor, o non apre niente
 * o apre l'elenco e ne fa scegliere una a caso col pollice.
 *
 * `min-h-[44px]` e non `py-*`, per la stessa ragione scritta su `CMD_BASE`: il
 * padding fissa l'altezza a un valore che dipende dall'interlinea del testo
 * tradotto, `min-h` è un pavimento. Il `py-2` resta perché non tutti i motori
 * centrano verticalmente il testo di un `<select>`: con 44 px di pavimento non
 * cambia l'altezza, ma tiene il testo staccato dal bordo dove serve.
 */
const TENDINA_44 =
  'w-full min-h-[44px] rounded-lg border-2 border-kidville-line px-3 py-2 text-sm text-kidville-green focus:border-kidville-green focus:outline-none';

/**
 * I GRUPPI DEL TAB ANAGRAFICA — l'ordine e la ripartizione dei campi.
 *
 * Portano gli `id` e NON le etichette: le etichette stanno in `PERSONALE_FIELDS`,
 * che è il contratto del modulo pubblico. Ribatterle qui significherebbe che il
 * giorno in cui una domanda cambia formulazione la scheda della segreteria
 * continua a mostrare la vecchia — cioè due nomi per lo stesso dato, uno dei
 * quali sbagliato.
 *
 * ⚠️ SONO CINQUE E NON QUATTRO, di proposito. I quattro chiesti (dati, residenza,
 * recapiti, documento) non contengono il titolo di studio, e un campo che non sta
 * in nessun gruppo semplicemente NON SI VEDE: è la stessa omissione invisibile
 * che la riga «Non indicato» esiste per impedire, un livello più su. Il lock
 * `StaffDetailPanel-anagrafica.test.tsx` verifica che ogni colonna che
 * `anagrafica_personale` archivia stia in ESATTAMENTE un gruppo.
 *
 * `email` e `telefono` sono in «Recapiti» ma NON sono colonne dell'anagrafica:
 * vivono in `utenti` (lo dice il commento della tabella, ed è una scelta —
 * «due verità sulla stessa persona divergono al primo aggiornamento»). Arrivano
 * dall'elenco staff già caricato e dalla proiezione della route.
 */
export const GRUPPI_ANAGRAFICA_PERSONALE: { titolo: string; campi: string[] }[] = [
  {
    titolo: 'staffAnaGruppoDati',
    // ⚠️ `birth_place` NON manca: è la SORGENTE della riga «Comune di nascita»,
    // che qui è una sola. Vedi `RIGHE_FUSE` subito sotto.
    campi: [
      'gender', 'birth_date', 'codice_belfiore_nascita', 'birth_province',
      'birth_nation', 'fiscal_code', 'citizenship',
    ],
  },
  {
    titolo: 'staffAnaGruppoResidenza',
    campi: [
      'address', 'residence_street_number', 'residence_city', 'residence_province', 'zip_code',
      'domicilio_address', 'domicilio_street_number', 'domicilio_city',
      'domicilio_province', 'domicilio_zip_code',
    ],
  },
  {
    titolo: 'staffAnaGruppoRecapiti',
    campi: ['email', 'telefono', 'emergenza_nome', 'emergenza_telefono', 'emergenza_relazione'],
  },
  {
    titolo: 'staffAnaGruppoDocumento',
    campi: ['document_type', 'document_number', 'document_expiry'],
  },
  {
    titolo: 'staffAnaGruppoProfessione',
    campi: ['titolo_studio', 'titolo_dettaglio'],
  },
];

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  UN FATTO, UNA RIGA: «COMUNE DI NASCITA» NON SI SCRIVE DUE VOLTE        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * chiave = il campo che dà l'ETICHETTA (e il codice) · valore = il campo che dà
 * il TESTO LEGGIBILE.
 *
 * IL DIFETTO, MISURATO. Il gruppo «Dati anagrafici» mostrava DUE righe sullo
 * stesso fatto, e quella dall'etichetta più corta e più autorevole portava un
 * codice: `rendi()` traduce in italiano solo i valori da elenco chiuso
 * (`campo.options`) e le date, mentre `codice_belfiore_nascita` è un `text` con
 * `pattern: '^[A-Z][0-9]{3}$'` e nessuna `options` — quindi si stampava grezzo.
 * Le etichette vengono da `PERSONALE_FIELDS`: «Comune di nascita (per esteso)»
 * → «Giugliano in Campania», e tre righe più giù «Comune di nascita» →
 * **«H501»**, con «Provincia di nascita» in mezzo a separarle. Nel banco di prova
 * `birth_place` è `null`, quindi ciò che si leggeva era «Comune di nascita (per
 * esteso): Non indicato» sopra «Comune di nascita: H501» — e 54 test su 54
 * verdi.
 *
 * È esattamente il difetto che il commento di `rendi()` dichiara di impedire
 * («`CI` e `laurea_magistrale` sono codici di colonna, non italiano») e che
 * `personale-template.ts` dice di aver già risolto a monte: `birth_place` esiste
 * «perché il pannello dev'essere leggibile senza risolvere un codice catastale».
 * Il pannello mostrava il codice comunque, sotto il nome più breve e più credibile
 * dei due — e chi legge un dato apparentemente sbagliato accanto a uno
 * apparentemente mancante fa la cosa ragionevole: chiede alla persona di
 * ricompilare il modulo per un dato che ha già consegnato. Che è la bugia contro
 * cui è scritto il perimetro in testa a questo file.
 *
 * ── COSA SI VEDE ORA, E PERCHÉ IL CODICE NON SPARISCE ──────────────────────
 * Una riga sola, «Comune di nascita», con dentro il nome per esteso e accanto il
 * Belfiore come CODICE — pillola piccola, con un prefisso `sr-only` che dice
 * cos'è, perché letto ad alta voce «H501» non significa niente. Il codice resta
 * perché non è decorazione: sono i quattro caratteri che finiscono dentro il
 * codice fiscale, e chi verifica un CF li vuole vedere. Quando il nome per esteso
 * manca, la riga dice «Non indicato» — l'assenza è la notizia, com'è per tutte le
 * altre — e la pillola col codice resta lì: nessun dato archiviato si perde, ma
 * un codice catastale non viene più spacciato per il nome di un comune.
 */
export const RIGHE_FUSE: Record<string, string> = {
  codice_belfiore_nascita: 'birth_place',
};

/**
 * I campi del documento, letti dal gruppo invece che ribattuti: il tab
 * «Documento» disegna le stesse righe del gruppo omonimo, e un elenco scritto
 * due volte diverge alla prima colonna aggiunta. Se il gruppo sparisse resta un
 * array vuoto e non un `undefined` che rompe il tab.
 */
const CAMPI_DOCUMENTO: string[] =
  GRUPPI_ANAGRAFICA_PERSONALE.find((g) => g.titolo === 'staffAnaGruppoDocumento')?.campi ?? [];

/**
 * I campi del modulo che questa scheda mostra ALTROVE, non nei gruppi.
 *
 * ⚠️ QUI C'ERA `documento_path`, E QUELLA COLONNA NON ESISTE PIÙ: la migrazione
 * `20260812194501` l'ha rinominata in `documento_fronte_path` e ne ha aggiunta una
 * seconda. Le due voci non sono un raddoppio cosmetico — ciascuna dichiara il
 * proprio POSTO, e sono due posti diversi nella stessa schermata, perché fronte e
 * retro si aprono e si sostituiscono uno per volta.
 *
 * Il lock `StaffDetailPanel-anagrafica.test.tsx` pretende che ogni campo di
 * `PERSONALE_FIELDS` stia in esattamente un gruppo o sia dichiarato qui: finché
 * questa mappa nominava il vecchio nome, le due colonne nuove risultavano campi
 * «che questa scheda non mostrerebbe da nessuna parte».
 */
export const CAMPI_MOSTRATI_FUORI_DAI_GRUPPI: Record<string, string> = {
  nome: 'testata della scheda',
  cognome: 'testata della scheda',
  gradi: 'tab Incarico',
  documento_fronte_path: 'tab Documento, blocco «Fronte»: apri, carica, sostituisci',
  documento_retro_path: 'tab Documento, blocco «Retro»: apri, carica, sostituisci',
};

const CAMPO_PER_ID = new Map(PERSONALE_FIELDS.map((c) => [c.id, c]));

type ValoriAnagrafica = Record<string, unknown>;

/** Il valore grezzo di un campo, come stringa non vuota — oppure `null`. */
function valoreTesto(valori: ValoriAnagrafica, id: string): string | null {
  const v = valori[id];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * LO STATO DEL DOCUMENTO — la sola cosa nuova che si deve vedere senza scorrere.
 *
 * Non ricalcola niente: `giorniResidui` e `sogliaRaggiunta` sono le stesse due
 * funzioni che il cron notturno usa per decidere se mandare un avviso. Due
 * definizioni della parola «in scadenza» — una per l'email e una per il badge —
 * darebbero a chi guarda la scheda una risposta e a chi riceve la notifica
 * l'altra, con la seconda che arriva di notte e non si può confrontare.
 *
 * `cessato` viene PRIMA di tutto il resto, e vale la pena dire perché: il
 * documento scaduto di chi non lavora più qui non è una non conformità, è una
 * riga vecchia. Dipingerla di rosso insieme a quelle vere è il modo in cui una
 * segreteria impara a ignorare il rosso.
 */
export type StatoDocumento = 'cessato' | 'mancante' | 'scaduto' | 'inScadenza' | 'inRegola';

export function statoDocumento(
  scadenza: string | null,
  cessatoIl: string | null,
  oggi: string,
): { stato: StatoDocumento; giorni: number | null } {
  if (cessatoIl) {
    const daCessazione = giorniResidui(cessatoIl, oggi);
    // `<= 0`: cessato oggi è già cessato. Una data FUTURA di cessazione (preavviso
    // già registrato) lascia la persona in servizio, e il documento le serve ancora.
    if (!Number.isNaN(daCessazione) && daCessazione <= 0) return { stato: 'cessato', giorni: null };
  }
  if (!scadenza) return { stato: 'mancante', giorni: null };
  const giorni = giorniResidui(scadenza, oggi);
  // Una data illeggibile NON è «in regola»: è un dato che non si sa leggere, e
  // «mancante» è la sola risposta che manda qualcuno a guardare.
  if (Number.isNaN(giorni)) return { stato: 'mancante', giorni: null };
  if (giorni < 0) return { stato: 'scaduto', giorni };
  if (sogliaRaggiunta(giorni) !== null) return { stato: 'inScadenza', giorni };
  return { stato: 'inRegola', giorni };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  QUANTE FACCE CI SONO — e perché NON è un ramo di `statoDocumento`       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `statoDocumento` risponde a «la SCADENZA è a posto?» e lo fa con le stesse due
 * funzioni del cron notturno: due definizioni della parola «in scadenza» — una per
 * il badge e una per l'email — darebbero a chi guarda la scheda una risposta e a
 * chi riceve la notifica l'altra. Quella funzione quindi **non si tocca**, e non
 * guadagna un quinto stato.
 *
 * Questa risponde a un'altra domanda, che nessuno stava facendo: «l'archivio ha
 * tutte e due le facce?». È una domanda nuova dal 12/08/2026, quando il documento
 * ha smesso di essere una scansione sola, e il caso che conta è quello di MEZZO —
 * una faccia sola archiviata. Fino a ieri quel caso non esisteva; da oggi è quello
 * che la Segreteria produce più spesso, perché carica una faccia per volta.
 *
 * ⚠️ NON È UN ALLARME, ED È PER QUESTO CHE LA RIGA È `role="status"` E NON
 * `role="alert"`. «Manca il retro» è un'incompletezza da chiudere, non un guasto
 * da interrompere: `alert` è assertivo, taglia la parola a uno screen reader e in
 * questa scheda è già speso per le cose che sono davvero rotte (la fascia rossa,
 * l'errore di apertura). Spenderlo anche qui significa insegnare a ignorarlo.
 *
 * PURA e ESPORTATA: la si prova con quattro chiamate, senza montare niente.
 */
export type StatoScansioni = 'complete' | 'soloFronte' | 'soloRetro' | 'assenti';

export function statoScansioni(fronte: string | null, retro: string | null): StatoScansioni {
  // La stringa vuota è «non c'è», non «c'è ed è vuota»: in colonna un percorso
  // cancellato può restare `''` (il CHECK di lunghezza lo ammette), e trattarlo
  // come presente farebbe dire alla scheda che la faccia è archiviata mentre il
  // pulsante «Apri» chiederebbe la firma del nulla.
  const c = (v: string | null) => typeof v === 'string' && v.trim() !== '';
  if (c(fronte) && c(retro)) return 'complete';
  if (c(fronte)) return 'soloFronte';
  if (c(retro)) return 'soloRetro';
  return 'assenti';
}

/** Le due facce, nell'ordine in cui si consegnano. */
const LATI = ['fronte', 'retro'] as const;
type LatoScansione = (typeof LATI)[number];

/**
 * La colonna che tiene ogni faccia — gli stessi due nomi che la rotta di
 * caricamento conosce, e che il template dichiara (`PERSONALE_FIELDS[].id` **è** il
 * nome della colonna). Scritti per esteso e non pescati per indice da un array: un
 * riordino del template non deve poter scambiare fronte e retro in silenzio.
 */
const COLONNA_DI: Record<LatoScansione, string> = {
  fronte: 'documento_fronte_path',
  retro: 'documento_retro_path',
};

/** La chiave di catalogo dello stato delle due facce. */
const CHIAVE_STATO_SCANSIONI: Record<StatoScansioni, string> = {
  complete: 'staffDocScansioniComplete',
  soloFronte: 'staffDocScansioniSoloFronte',
  soloRetro: 'staffDocScansioniSoloRetro',
  assenti: 'staffDocScansioniAssenti',
};

const TONO_DOCUMENTO: Record<StatoDocumento, BadgeTone> = {
  cessato: 'neutral',
  mancante: 'neutral',
  scaduto: 'error',
  inScadenza: 'warn',
  inRegola: 'success',
};

export function StaffDetailPanel({ staffId, onClose }: Props) {
  const t = useTranslations('adminStudents');
  const ts = useTranslations('shared');
  const labelRuolo = useLabelRuolo();
  const f = useDateFormat();
  const { userId, role, ready } = useSessionIdentity();
  /**
   * DUE POTERI, non uno. Fino al 2026-09-03 `canEdit` governava insieme la
   * modifica di ruolo/sede/classi e la rigenerazione delle credenziali: sono
   * cose diverse, e tenerle sotto lo stesso interruttore significava che
   * concederne una concedeva l'altra.
   *
   * La modifica del ruolo resta della Direzione, ed è ciò che rende non
   * aggirabile la riserva sulle credenziali: se la Segreteria potesse cambiare
   * il ruolo di un collega, lo promuoverebbe ad `admin` e otterrebbe per via
   * indiretta ciò che il server le nega.
   */
  const canEdit = role === 'admin' || role === 'coordinator';


  const [loading, setLoading] = useState(true);
  const [errore, setErrore] = useState<string | null>(null);
  const [member, setMember] = useState<StaffMember | null>(null);
  const [schools, setSchools] = useState<School[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [asseg, setAsseg] = useState<Assegnazione[]>([]);

  /**
   * IL SECONDO POTERE, che dipende da CHI è aperto nella scheda e non solo da
   * chi guarda: la Segreteria rigenera le credenziali di una maestra ma non
   * quelle della Direzione, perché il PDF che riceve chi preme il pulsante
   * contiene la password in chiaro.
   *
   * `member` è `null` finché la scheda carica → nessun pulsante, che è la
   * risposta giusta: non si offre un comando su una persona che non si conosce
   * ancora. Nascondere è comunque una CORTESIA — niente comandi destinati a
   * finire in un 403 — non una difesa: il gate vero è
   * `admin/regenerate-credentials`, e usa questo stesso predicato.
   */
  const canRigenerare = puoRigenerareCredenzialiStaff(role as AppRole, member?.ruolo ?? null);

  /* ═══ IL TERZO POTERE: SPOSTARE DI SEDE ═════════════════════════════════════
   *
   * Dal 2026-09-04 `admin/staff:PATCH` ammette anche la Segreteria, ma le concede
   * la SOLA sede: ruolo, fasce d'età, classi e qualunque modifica a un account di
   * Direzione restano riservati (`INCARICO_STAFF_RISERVATO`). Fino a questo lavoro
   * quel permesso era irraggiungibile — «Modifica» dipendeva da `canEdit`, e la
   * Segreteria non vedeva nemmeno il pulsante — cioè un permesso concesso lato
   * server che nella pratica non esisteva, con la `UPDATE` a mano come unica strada.
   *
   * ⚠️ NON SI ALLARGA `canEdit`, e la ragione è doppia.
   *
   *  1. Sarebbe una TRAPPOLA. Il server calcola i cambi per DIFFERENZA rispetto a
   *     com'è messo il bersaglio: una segretaria che aprisse la scheda intera e
   *     toccasse anche una classe si vedrebbe rifiutare il salvataggio INTERO —
   *     sede compresa — con un 403 che parla di un campo che non voleva cambiare.
   *     Un comando che si può premere ma non si può usare è peggio di un comando
   *     assente.
   *  2. `canEdit` governa anche il RUOLO, ed è la riserva che tiene in piedi
   *     l'altra: chi può cambiare il ruolo di una collega la promuove ad `admin` e
   *     da lì ne rigenera le credenziali, ottenendo per via indiretta ciò che il
   *     server le nega (vedi `puoRigenerareCredenzialiStaff`).
   *
   * Perciò la Segreteria ha un comando SUO, che apre la sola tendina della sede.
   *
   * ⚠️ E IL PERMESSO DIPENDE DAL BERSAGLIO, non solo da chi guarda — stessa forma
   * di `canRigenerare` qui sotto, e per una ragione precisa:
   * `puoModificareIncaricoStaff` nega alla Segreteria QUALUNQUE modifica a un
   * account di Direzione (`bersaglio-direzione`), sede compresa. Senza questa
   * metà, una segretaria che apre la scheda della direttrice vedrebbe un comando
   * destinato a un 403 — cioè la trappola che questo blocco esiste per evitare.
   * `member === null` (scheda in caricamento) ⇒ nessun comando: non si offre
   * un'azione su una persona che ancora non si conosce.
   *
   * Nascondere resta una CORTESIA, non una difesa: il gate vero è la rotta.
   */
  const bersaglioDirezione = member != null && (RUOLI_DIREZIONE as readonly string[]).includes(member.ruolo);
  const canSpostareSede = canEdit || (role === 'segreteria' && member != null && !bersaglioDirezione);

  const [editMode, setEditMode] = useState(false);
  /**
   * `true` quando la modifica aperta è la SOLA sede: è la modalità della
   * Segreteria. Non è un vezzo di presentazione — decide anche il CORPO che parte
   * (`{ id, scuola_id }` e nient'altro), perché mandare `ruolo` e `section_ids`
   * identici a quelli in archivio significherebbe far dipendere il permesso dal
   * fatto che il confronto lato server torni pari. Se `asseg` fosse arrivato
   * incompleto — una lettura fallita, un ritardo — `stessoInsieme` direbbe di no e
   * la segretaria si vedrebbe un 403 su un campo che non ha toccato.
   */
  const [soloSede, setSoloSede] = useState(false);
  const [draft, setDraft] = useState<{ ruolo: string; scuola_id: string; section_ids: string[] }>({ ruolo: '', scuola_id: '', section_ids: [] });
  const [saving, setSaving] = useState(false);
  /** Il rifiuto del server, IN PAGINA. Vedi `salva()` per il perché non è più un `alert()`. */
  const [erroreIncarico, setErroreIncarico] = useState<string | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);

  const [tab, setTab] = useState<'incarico' | 'anagrafica' | 'documento'>('incarico');
  /**
   * Gli `id` delle due tendine di «Modifica», per legarci sopra le `<label>`.
   * `useId()` e non due stringhe fisse: la scheda è montata una volta sola oggi,
   * ma un `id` cablato è un `id` duplicato il giorno in cui due schede stanno
   * nella stessa pagina — e un `id` duplicato non rompe niente a schermo, rompe
   * soltanto il legame etichetta/campo, cioè proprio la cosa che si sta mettendo.
   */
  const idBase = useId();
  const idRuolo = `${idBase}-ruolo`;
  const idSede = `${idBase}-sede`;

  /**
   * LE SEDI DELLA TENDINA, e perché non sono più `j.schools`.
   *
   * ⚠️ Fino al 2026-09-04 la tendina si riempiva con le sedi che
   * `admin/staff:GET` restituisce, cioè quelle in cui l'utente LAVORA. Per una
   * direttrice di Giugliano sono due sedi su tre, e la terza — l'unica che serve,
   * perché un trasferimento è per definizione verso un plesso in cui la persona
   * NON è ancora — semplicemente non compariva. Nessun errore, nessun log: una
   * voce assente non fa rumore.
   *
   * `ready` nella condizione, non solo il permesso: prima che l'identità di
   * sessione sia risolta l'intestazione `x-user-id` non c'è, e la lettura
   * partirebbe due volte — una anonima e una buona.
   */
  const destinazioni = useDestinazioniSede({
    intestazioni: userId ? { 'x-user-id': userId } : undefined,
    abilitato: canSpostareSede && ready,
  });
  /**
   * Il ricovero del fuoco quando «Riprova» smonta se stesso, e la bandierina che
   * dice che il gesto c'è stato davvero. Il perché sta su `riprovaAnagrafica`.
   */
  const ricoveroTab = useRef<HTMLDivElement | null>(null);
  const daRicoverare = useRef(false);
  /**
   * LA LETTURA DELL'ANAGRAFICA, con dentro DI CHI è.
   *
   * Tre esiti e non un `anagrafica | null`, perché «non l'ho ancora letta»,
   * «non esiste» e «non sono riuscito a leggerla» sono tre schermate diverse — e
   * confonderle significa mostrare «Anagrafica non ancora compilata» a una
   * persona che ce l'ha, solo perché la rete è caduta.
   *
   * ⚠️ `per` NON è ridondante con `staffId`, ed è la ragione per cui l'esito è un
   * oggetto solo invece di tre stati separati. Questo pannello NON si rimonta
   * quando la scheda cambia persona (stessa rotta, `[id]` diverso): senza il
   * nome del proprietario del dato, per il tempo della fetch la scheda di chi si
   * è appena aperto mostrerebbe il fascicolo di chi si stava guardando prima —
   * codice fiscale e residenza compresi. Il confronto `per === staffId` è ciò che
   * rende quello stato semplicemente NON ANCORA LETTO.
   */
  const [lettura, setLettura] = useState<{
    per: string;
    stato: 'pronta' | 'assente' | 'errore';
    dati: ValoriAnagrafica | null;
    telefono: string | null;
  } | null>(null);
  const [copiato, setCopiato] = useState(false);
  const [docBloccato, setDocBloccato] = useState<string | null>(null);
  const [erroreDoc, setErroreDoc] = useState<string | null>(null);
  /** La faccia il cui caricamento è in volo: al massimo una per volta. */
  const [inVolo, setInVolo] = useState<LatoScansione | null>(null);
  /**
   * La faccia per cui si sta CHIEDENDO conferma alla sostituzione.
   *
   * ⚠️ In pagina, mai `confirm()` nativo: in questo repo è vietato e per un motivo
   * che qui morde davvero — dentro la WebView Capacitor una finestra di sistema
   * interrompe il gesto e su iOS può non tornare mai. E il primo caricamento NON
   * chiede niente: non c'è nessuna copia da distruggere.
   */
  const [conferma, setConferma] = useState<LatoScansione | null>(null);
  /** L'esito dell'ultimo caricamento, per faccia. */
  const [esitoCaricamento, setEsitoCaricamento] = useState<
    { lato: LatoScansione; testo: string; guasto: boolean } | null
  >(null);
  /**
   * IL RICOVERO DEL FUOCO DELLE DUE FACCE.
   *
   * Un caricamento riuscito SMONTA il comando che l'ha lanciato: «Carica» — che è
   * una `<label>` con dentro l'`<input type="file">` — diventa «Apri» +
   * «Sostituisci». Chi ha scelto il file da tastiera si ritroverebbe il fuoco su
   * `<body>`, cioè all'inizio della scheda (WCAG 2.4.3). È lo stesso difetto già
   * misurato su «Riprova», trenta righe più su, e si ripara allo stesso modo: il
   * fuoco va sul blocco della faccia, che è l'unico nodo che sopravvive a tutte le
   * transizioni.
   */
  const ricoveroFaccia = useRef<Record<LatoScansione, HTMLElement | null>>({ fronte: null, retro: null });
  const facciaDaRicoverare = useRef<LatoScansione | null>(null);

  const load = useCallback(async () => {
    try {
      // fetch(...).catch(() => null): un reject di rete non deve né restare
      // unhandled né finire in un not-found fuorviante ("Membro non trovato").
      // NB: convenzione del repo — niente blocco catch attorno all'await in una
      // fetch chiamata da useEffect (react-hooks/set-state-in-effect): try/finally.
      const res = await fetch('/api/admin/staff', { headers: userId ? { 'x-user-id': userId } : undefined }).catch(() => null);
      if (!res) {
        setErrore(t('staffDErrRete'));
        setMember(null);
        return;
      }
      const j = await res.json().catch(() => null);
      /**
       * ╔══════════════════════════════════════════════════════════════════════╗
       * ║  LA FASCIA ROSSA PARLA LA LINGUA DELLA SEGRETERIA, NON QUELLA DEL DB ║
       * ╚══════════════════════════════════════════════════════════════════════╝
       *
       * Qui c'era `setErrore(j?.error || t('staffErrCaricamento'))`, e il ripiego
       * tradotto non si vedeva quasi mai: `admin/staff:GET` su 500 risponde
       * `{ error: error.message }` (`route.ts:81`), cioè la prosa TESTUALE di
       * PostgREST. Il primo ramo vinceva sempre, e finiva a schermo intero —
       * questa fascia SOSTITUISCE l'intera scheda — in una fascia che questo
       * stesso lavoro ha appena portato a 4,92:1 e dotato di `role="alert"`.
       * Risultato: il messaggio del database si leggeva meglio di prima e ora si
       * sentiva anche a voce.
       *
       * ⚠️ E non è un caso di laboratorio: sul DB E2E della CI, che non è migrato,
       * un `42703` NOMINA tabella e colonna. La segreteria si sarebbe trovata a
       * schermo il nome di una colonna al posto di «riprova». In inglese, poi, la
       * fascia restava comunque nella lingua del database: sui 555+555 messaggi
       * dei due cataloghi non esiste — né può esistere — una chiave per quel testo.
       *
       * Il motivo non si BUTTA: si logga. Ma si logga lo STATO e non il corpo —
       * un vincolo violato può citare il VALORE che l'ha violato (un'email, un
       * codice fiscale), e i log di questo repo non vedono PII.
       */
      if (!res.ok || !j?.success) {
        setErrore(t('staffErrCaricamento'));
        setMember(null);
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: 'staff-scheda-non-letta',
          route: ROUTE_LOG,
          stato: res.status,
        });
        return;
      }
      setErrore(null);
      setSchools(j.schools ?? []);
      setSections(j.sections ?? []);
      setAsseg(j.assegnazioni ?? []);
      setMember((j.data ?? []).find((u: StaffMember) => u.id === staffId) ?? null);
    } finally {
      setLoading(false);
    }
  }, [staffId, userId, t]);

  /**
   * L'anagrafica del personale. Fetch SEPARATA da quella dell'elenco staff, e
   * non annidata: l'elenco serve comunque — nome, ruolo, sede, classi — anche
   * quando l'anagrafica non c'è o la sua route non risponde. Legarle avrebbe
   * fatto sparire l'intera scheda per un dato che il primo giorno manca a tutti.
   *
   * ⚠️ 404 = ANAGRAFICA ASSENTE, non errore. È la decisione più importante di
   * questa funzione. In produzione ci sono dieci insegnanti con un account e
   * nessuna anagrafica: se il 404 diventasse la schermata rossa, dieci schede su
   * dieci si aprirebbero su un guasto che non c'è, e lo stato che DEVE portare
   * all'azione («ecco il link del modulo») non si vedrebbe mai. Il caso «utente
   * inesistente o fuori dalle mie sedi» è già coperto un livello sopra: senza la
   * riga nell'elenco staff, la scheda mostra «Membro dello staff non trovato» e
   * qui non si arriva nemmeno.
   */
  const caricaAnagrafica = useCallback(async () => {
    // ⚠️ DUE VINCOLI DI FORMA, ed è la trappola già pagata in questo repo.
    //
    //  1. Nessuno `setState` PRIMA del primo `await`: questa funzione la chiama
    //     un effetto, e `react-hooks/set-state-in-effect` (ERRORE nel gate) vieta
    //     la scrittura sincrona. Lo stato «sto caricando» non serve scriverlo —
    //     è ciò che `lettura` significa quando è `null` o quando parla di
    //     un'altra persona (vedi `statoAna` più sotto).
    //  2. `try`/`finally` e non `try`/`catch`: la regola accetta la prima forma
    //     e non la seconda. MISURATO su questo file l'11/08/2026, con una sonda
    //     che differiva solo per l'involucro. Togliendo il `finally` il gate
    //     torna rosso — quindi non è decorazione, anche se non spegne niente.
    try {
      const res = await fetch(`${API_ANAGRAFICA}?utenteId=${encodeURIComponent(staffId)}`, {
        headers: userId ? { 'x-user-id': userId } : undefined,
      }).catch(() => null);
      if (!res) {
        setLettura({ per: staffId, stato: 'errore', dati: null, telefono: null });
        logClient({ livello: 'warn', evento: 'react', messaggio: 'anagrafica-personale-rete-caduta', route: ROUTE_LOG });
        return;
      }
      if (res.status === 404) {
        setLettura({ per: staffId, stato: 'assente', dati: null, telefono: null });
        return;
      }
      const j = await res.json().catch(() => null);
      if (!res.ok || j?.success === false) {
        setLettura({ per: staffId, stato: 'errore', dati: null, telefono: null });
        logClient({
          livello: 'warn',
          evento: 'react',
          messaggio: 'anagrafica-personale-non-letta',
          route: ROUTE_LOG,
          stato: res.status,
        });
        return;
      }
      /**
       * L'involucro della risposta, e il perché di questa riga.
       *
       * La route la scrive un altro flusso di lavoro; l'unica cosa su cui due
       * mani possono divergere è un LIVELLO di annidamento. Se divergesse, un
       * `j.data.anagrafica` letto su una risposta piatta darebbe `undefined` —
       * cioè «Anagrafica non ancora compilata» su una scheda PIENA: il modo
       * peggiore in cui questo pannello possa mentire, perché manderebbe la
       * segreteria a richiedere dati che ha già. Perciò si accettano due forme
       * e nessuna terza, e la seconda si riconosce dalla chiave primaria.
       */
      const corpo = (j?.data ?? j) as Record<string, unknown> | null;
      const dati = (corpo?.anagrafica ?? (corpo && 'utente_id' in corpo ? corpo : null)) as ValoriAnagrafica | null;
      const utente = (corpo?.utente ?? null) as Record<string, unknown> | null;
      /**
       * IL NUMERO DI CELLULARE, e perché si guardano DUE nomi.
       *
       * ⚠️ MISURATO sullo schema di produzione l'11/08/2026: su `utenti` la
       * colonna si chiama **`cellulare`**, non `telefono` — e `telefono` è il
       * nome che il campo ha nel MODULO (`PERSONALE_FIELDS`) e in
       * `pratiche_personale`. Due nomi per lo stesso dato lungo il percorso
       * modulo → pratica → account, ed è esattamente il punto in cui un
       * `utente.telefono` scritto d'istinto legge `undefined` per sempre senza
       * che niente diventi rosso.
       *
       * ⚠️ QUESTO PARAGRAFO DICEVA IL FALSO FINO AL 12/08/2026, ed è la ragione
       * per cui resta scritto invece di essere cancellato. Sosteneva che «la riga
       * dirà Non indicato finché la route non proietterà il campo» e chiamava la
       * cosa «il verso giusto: una riga che lo dice è la notizia». La misura ha
       * detto il contrario: `admin/anagrafica-personale:GET` proiettava
       * `id, nome, cognome, ruolo, scuola_id, email` e basta, mentre
       * l'approvazione della pratica SCRIVEVA già `utenti.cellulare`
       * (`admin/pratiche-personale`, `cellulare: testo(riga.telefono)`). Cioè: dal
       * primo «Approva» il numero ESISTEVA, e la scheda continuava a dire che non
       * c'era — per chiunque e per sempre. Non era «l'assenza è la notizia»: era
       * la bugia che il perimetro in testa a questo file dichiara di voler
       * evitare, mandare qualcuno a richiedere un dato già consegnato, solo su un
       * campo invece che sull'intera anagrafica. Un `undefined` non è mai una
       * notizia: è indistinguibile da «vuoto», e nessun test poteva vederlo.
       *
       * Dal 12/08/2026 la route proietta `cellulare` (rilievo del critico visivo,
       * giro 1). Il secondo nome resta come rete: se un giorno la risposta
       * cambiasse forma, «Non indicato» tornerebbe a essere una bugia silenziosa.
       */
      const cellulare = utente?.cellulare ?? utente?.telefono;
      setLettura({
        per: staffId,
        stato: dati ? 'pronta' : 'assente',
        dati,
        telefono: cellulare ? String(cellulare) : null,
      });
    } finally {
      /* Niente da spegnere: `lettura` è il proprio interruttore. Vedi il punto 2. */
    }
  }, [staffId, userId]);

  useEffect(() => {
    // Attendo la risoluzione dell'identità (per l'header x-user-id) prima di caricare:
    // un solo fetch, con l'utente già risolto.
    if (!ready) return;
    void load();
    void caricaAnagrafica();
  }, [ready, load, caricaAnagrafica]);

  /** Apre la modifica dell'incarico intero (Direzione). */
  const apri = (soloLaSede = false) => {
    if (!member) return;
    setDraft({
      ruolo: member.ruolo,
      scuola_id: member.scuola_id ?? '',
      section_ids: asseg.filter((a) => a.utente_id === staffId).map((a) => a.section_id),
    });
    setErroreIncarico(null);
    setSoloSede(soloLaSede);
    setEditMode(true);
  };

  const salva = async () => {
    setSaving(true);
    setErroreIncarico(null);
    try {
      /* ⚠️ DUE CORPI, e la differenza non è cosmetica.
       *
       * In modalità «solo sede» parte il MINIMO — `{ id, scuola_id }` — perché
       * mandare `ruolo` e `section_ids` uguali a quelli in archivio farebbe
       * dipendere il permesso della Segreteria dal fatto che il confronto lato
       * server torni pari: `asseg` arriva da una lettura che può fallire o
       * arrivare tardi, e un elenco di classi incompleto diventerebbe un 403 su
       * un campo che nessuno ha toccato. Non mandare un dato è più solido che
       * sperare che risulti identico. */
      const corpo = soloSede
        ? { id: staffId, scuola_id: draft.scuola_id || undefined }
        : { id: staffId, ruolo: draft.ruolo, scuola_id: draft.scuola_id || undefined, section_ids: draft.section_ids };
      const res = await fetch('/api/admin/staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
        body: JSON.stringify(corpo),
      });
      /* ⚠️ IL RIFIUTO NON STA PIÙ IN UN `alert()`, e il motivo non è lo stile.
       *
       * Qui c'erano due `alert()`: uno con la frase «azione riservata» per ogni
       * 403 e uno generico per tutto il resto. Il primo buttava via il CODICE che
       * il server manda apposta — `INCARICO_STAFF_RISERVATO` e
       * `SEDE_NON_ACCESSIBILE` dicono due cose diverse a chi ha appena premuto — e
       * il secondo, quando la rotta rispondeva con la prosa di PostgREST, poteva
       * mettere il nome di una colonna dentro una finestra modale. Adesso il testo
       * viene dal CATALOGO (quindi esiste anche in inglese) e resta in pagina,
       * sotto gli occhi di chi ha premuto, dentro un `role="alert"`.
       *
       * Lo STATO va nel log, il corpo no: un rifiuto può nominare una sede o una
       * persona, e nei log di questo repo non entrano. */
      if (!res.ok) {
        logClient({ livello: 'warn', evento: 'react', messaggio: 'staff-salvataggio-non-riuscito', route: ROUTE_LOG, stato: res.status });
        /* ⚠️ `messaggioSoloCatalogo` e NON `messaggioErrore`, ed è la differenza
         * fra le due che conta: la seconda, quando il corpo non porta un codice,
         * ripiega sulla PROSA DEL SERVER — e la prosa di questa rotta è
         * `{ error: error.message }`, cioè il testo di PostgREST
         * («null value in column "scuola_id" violates not-null constraint»).
         * Quel testo è documentazione interna, è italiano per costruzione e può
         * nominare una colonna: è esattamente ciò che i due `alert()` di prima
         * NON mostravano mai, ed è misurato in
         * `StaffDetailPanel-anagrafica.test.tsx` («la Direzione non legge
         * PostgREST»). Il codice dichiarato continua a vincere: è il solo modo
         * che ha il server di farsi capire anche in inglese. */
        setErroreIncarico(await messaggioSoloCatalogo(res, res.status === 403 ? t('staffDAzioneRiservata') : t('erroreSalvataggio')));
        return;
      }
      setEditMode(false);
      setSoloSede(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const rigenera = async () => {
    if (!member) return;
    if (!confirm(t('staffDConfermaRigenera', { nome: `${member.cognome ?? ''} ${member.nome ?? ''}`.trim() }))) return;
    setRegenBusy(true);
    try {
      const res = await fetch('/api/admin/regenerate-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) },
        body: JSON.stringify({ targetKind: 'staff', targetId: staffId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(t('errore'));
        logClient({ livello: 'warn', evento: 'react', messaggio: 'staff-credenziali-non-rigenerate', route: ROUTE_LOG, stato: res.status });
        return;
      }
      const b = body as { pdf_notifica?: boolean; email_inviata?: boolean; warning?: string };
      /**
       * ⚠️ IL QUARTO ESITO ERA L'UNICO SCRITTO DAL SERVER, e non era nell'elenco
       * del critico: `b.warning` è la frase di `regenerate-credentials/route.ts:272`,
       * che INTERPOLA il messaggio grezzo del provider email
       * («Email non inviata: ${invio.error}…»). Tre esiti su quattro passavano già
       * dal catalogo, il quarto no — ed è proprio quello che si legge quando
       * qualcosa è andato storto. In inglese l'alert restava in italiano, e la
       * riga poteva finire con la risposta letterale di un servizio terzo.
       *
       * L'informazione NON si perde, ed è il punto: «l'email non è partita» resta
       * scritta, con il rimedio accanto. Il MOTIVO tecnico non sparisce nemmeno —
       * lo registra `externalFetch` server-side, che è dove AGENTS.md §3 vuole il
       * corpo dell'errore di un provider. Qui si logga solo che il caso è occorso:
       * il testo del provider può contenere l'indirizzo del destinatario.
       */
      if (b.warning) {
        logClient({ livello: 'warn', evento: 'react', messaggio: 'staff-credenziali-email-non-inviata', route: ROUTE_LOG });
      }
      alert(b.pdf_notifica
        ? t('credEmailPdf')
        : b.email_inviata ? t('credEmailInviata') : b.warning ? t('credEmailNonInviata') : t('credRigenerate'));
    } finally {
      setRegenBusy(false);
    }
  };

  const toggleSezione = (sid: string) => {
    setDraft((d) => ({ ...d, section_ids: d.section_ids.includes(sid) ? d.section_ids.filter((x) => x !== sid) : [...d.section_ids, sid] }));
  };

  /**
   * DI CHI PARLA `lettura`. Finché non parla di QUESTA persona, lo stato è
   * «non ancora letta» — vedi l'avvertenza su `per` là dove è dichiarato.
   */
  const letturaMia = lettura?.per === staffId ? lettura : null;
  const statoAna: 'caricamento' | 'pronta' | 'assente' | 'errore' = letturaMia?.stato ?? 'caricamento';
  const anagrafica = letturaMia?.dati ?? null;

  /**
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  «RIPROVA» È L'UNICO COMANDO DELLA SCHEDA CHE DISTRUGGE IL PROPRIO       ║
   * ║  CONTENITORE — e quindi l'unico che deve dire al fuoco dove andare      ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * MISURATO in jsdom prima di questa riga: `riprova.focus()` →
   * `document.activeElement === riprova`; dopo il clic e la rilettura riuscita,
   * `document.activeElement.tagName === 'BODY'`. Il pannello d'errore si smonta
   * portandosi via il bottone che ha appena ricevuto il clic, e chi naviga da
   * tastiera riparte dall'inizio della scheda per tornare dove già era: il
   * percorso «errore → riprova → leggo i dati» semplicemente non si chiude.
   *
   * Il ricovero è il CONTENITORE del tab, non l'`h3` del primo gruppo: la
   * rilettura può finire in tre modi diversi — dati, «anagrafica non ancora
   * compilata», oppure di nuovo errore — e un ricovero legato a uno solo dei tre
   * lascerebbe il fuoco su `<body>` negli altri due, cioè proprio nel caso in cui
   * è più facile che qualcuno prema quel bottone una seconda volta. Quel `<div>`
   * è l'unico nodo che sopravvive a tutte e tre le transizioni.
   *
   * `daRicoverare` è un ref e non uno stato di proposito: il fuoco si sposta SOLO
   * dopo un gesto esplicito. Muoverlo a ogni arrivo di dati significherebbe
   * rubarlo a chi sta scorrendo la scheda mentre la prima fetch atterra.
   */
  const riprovaAnagrafica = () => {
    daRicoverare.current = true;
    setLettura(null);
    void caricaAnagrafica();
  };

  useEffect(() => {
    if (!daRicoverare.current) return;
    // «caricamento» è di passaggio: si aspetta l'esito, altrimenti il fuoco
    // atterrerebbe sullo spinner e verrebbe perso di nuovo mezzo secondo dopo.
    if (statoAna === 'caricamento') return;
    daRicoverare.current = false;
    ricoveroTab.current?.focus();
  }, [statoAna]);

  /** Il link del modulo, assoluto: è fatto per essere incollato in un messaggio. */
  const linkModulo = `${typeof window !== 'undefined' ? window.location.origin : ''}${PERCORSO_MODULO}`;

  const copiaLink = async () => {
    try {
      await navigator.clipboard.writeText(linkModulo);
      setCopiato(true);
      setTimeout(() => setCopiato(false), 2000);
    } catch {
      // `navigator.clipboard` negato (contesto non sicuro, permesso rifiutato):
      // non è un guasto del prodotto, ma non si ingoia in silenzio — il pulsante
      // non darebbe nessun segno e la segreteria incollerebbe il nulla.
      logClient({
        livello: 'warn',
        evento: 'js',
        messaggio: 'anagrafica-personale-link-non-copiato',
        route: ROUTE_LOG,
      });
    }
  };

  /**
   * ╔══════════════════════════════════════════════════════════════════════════╗
   * ║  IL CARICAMENTO DI UNA FACCIA — e le tre cose che NON si scrivono qui    ║
   * ╚══════════════════════════════════════════════════════════════════════════╝
   *
   * `caricaFile` fa il controllo di taglia PRIMA di spedire (sopra il tetto della
   * piattaforma la richiesta non arriva mai alla nostra route: Vercel risponde 413
   * da sé, e nessun messaggio nostro può uscire), guarda `res.ok` PRIMA di
   * `res.json()` (il corpo di quel 413 è `text/plain`: il parse LANCIA, e chi
   * caricava leggeva «Riprova» — l'invito a rifare l'unica cosa che non poteva
   * funzionare) e mette un tetto di tempo sulla richiesta. Sono tre guasti già
   * pagati in produzione, e riscriverli a mano qui significherebbe ricrearli.
   *
   * ⚠️ NON SI INDOVINA LO STATO DOPO. Il percorso NON torna dalla risposta — il
   * server lo scrive da sé nella colonna, e una chiave che apre un documento
   * d'identità non viaggia senza motivo — quindi la scheda RILEGGE il fascicolo.
   * Scrivere in stato un valore inventato farebbe apparire «Apri la scansione» su
   * un percorso che il client non conosce, cioè un pulsante che non può funzionare.
   */
  const caricaScansione = async (lato: LatoScansione, file: File) => {
    // ── UNA RICHIESTA PER VOLTA, E LA REGOLA VIVE QUI — in un posto solo ──────
    //
    // ⚠️ NON SU `disabled`: disabilitare un controllo che ha il fuoco lo fa cadere su
    // `<body>`, e colpirebbe esattamente chi ha appena scelto il file da tastiera.
    // Che stia lavorando lo dicono il testo, la rotellina e `aria-busy`.
    //
    // ⚠️ E NON ANCHE SULL'`onChange` DI `BloccoFaccia`, dove fino al 13/08/2026 stava
    // una seconda copia (`if (!file || inVolo || bloccato) return`). Era una copia in
    // senso stretto: `inVolo` qui è lo STATO (`null | 'fronte' | 'retro'`), quindi
    // questa riga ferma già sia il secondo gesto sulla stessa faccia sia quello
    // sull'altra — cioè tutto ciò che il `bloccato` del figlio prometteva. Misurato, e
    // non dedotto: togliendo la copia dal figlio la suite resta **verde su 123 test**,
    // togliendo QUESTA riga diventano **rossi due test** in
    // `__tests__/components/StaffDetailPanel-anagrafica.test.tsx` («una richiesta per
    // volta»). Una difesa che nessun test può distinguere dalla propria copia è una
    // difesa scritta due volte, non due difese: e finché erano due, il commento che
    // le annunciava descriveva un presidio che il codice non era tenuto ad avere.
    //
    // Sta nel GESTORE anche perché è il punto di passaggio OBBLIGATO: un domani un
    // trascinamento o un pulsante «riprova» chiamerebbero questa funzione, non
    // quell'`onChange`.
    if (inVolo) return;
    setInVolo(lato);
    setConferma(null);
    setEsitoCaricamento(null);
    try {
      const esito = await caricaFile({
        // Gli identificativi stanno in QUERY e non nel multipart, e non è una
        // preferenza: con `utenteId` nel corpo il server dovrebbe bufferizzare fino
        // a 4 MB PRIMA di poter dire «questa persona non è della tua sede». Vedi la
        // testata di `admin/anagrafica-personale/scansione:POST`.
        endpoint: `${API_ANAGRAFICA}/scansione?utenteId=${encodeURIComponent(staffId)}&lato=${lato}`,
        file,
        maxSizeMb: PERSONALE_LIMITI.maxDocMb,
        headers: userId ? { 'x-user-id': userId } : undefined,
      });
      if (esito.esito === 'ok') {
        setEsitoCaricamento({ lato, testo: t('staffDocCaricata'), guasto: false });
        facciaDaRicoverare.current = lato;
        // Si RILEGGE: è il fascicolo la fonte di verità, non questa funzione.
        await caricaAnagrafica();
        return;
      }
      if (esito.esito === 'troppo-grande') {
        setEsitoCaricamento({ lato, testo: t('staffDocTroppoGrande', { mb: esito.limiteMb }), guasto: true });
        return;
      }
      // Il messaggio del SERVER quando c'è — è già tradotto dal catalogo tramite il
      // codice, e dice cose che il ripiego non può sapere («questa scansione è stata
      // sostituita da qualcun altro»). Il ripiego non è mai la stringa vuota, che a
      // schermo è indistinguibile dal silenzio.
      setEsitoCaricamento({
        lato,
        testo: messaggioDaCorpo(
          { error: esito.messaggioServer, codice: esito.codice },
          t('staffDocErroreCaricamento'),
        ),
        guasto: true,
      });
      logClient({
        livello: 'warn',
        evento: 'react',
        messaggio: 'anagrafica-personale-scansione-non-caricata',
        route: ROUTE_LOG,
        stato: esito.stato ?? undefined,
      });
    } finally {
      setInVolo(null);
    }
  };

  useEffect(() => {
    const lato = facciaDaRicoverare.current;
    if (!lato) return;
    facciaDaRicoverare.current = null;
    ricoveroFaccia.current[lato]?.focus();
  }, [lettura]);

  const apriScansione = async (path: string) => {
    setDocBloccato(null);
    setErroreDoc(null);
    const esito = await apriDocumentoFirmato({
      endpoint: API_ANAGRAFICA,
      path,
      headers: userId ? { 'x-user-id': userId } : undefined,
      route: ROUTE_LOG,
      etichetta: 'anagrafica-documento',
    });
    if (esito.esito === 'bloccato') setDocBloccato(esito.url);
    else if (esito.esito === 'errore') setErroreDoc(t('staffDocErroreApertura'));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="animate-spin text-kidville-green" size={32} />
      </div>
    );
  }

  if (errore) {
    return (
      <div className="rounded-card bg-kidville-white p-6 shadow-sm">
        {/* ⚠️ `error-strong` E `role="alert"`, e non è una rifinitura: questa fascia
            SOSTITUISCE l'intera scheda — è la sola riga che dice alla segreteria che
            il fascicolo non si è caricato, e nasconde tutto il resto. Con l'inchiostro
            debole (`error` su `error-soft`) misurava **3,70:1** — axe-core sul DOM
            vero, «insufficient color contrast of 3.7», sotto i 4,5:1 di AA; il forte
            misura 4,92:1, ed è il numero che `contrasto-token.test.ts:157-158`
            asserisce da mesi. Senza `role="alert"` era anche MUTA per uno screen
            reader, che è il modo in cui un guasto diventa un silenzio.
            Trenta righe più giù `StatoLettura` faceva già la cosa giusta: due rossi
            diversi nella stessa card, e quello rimasto indietro era l'unico a schermo
            intero. Lock: `contrasto-token.test.ts` → `CON_FASCIA`, che ora elenca
            anche questo file. */}
        <div role="alert" className="rounded-xl border border-kidville-error/30 bg-kidville-error-soft p-4 font-maven text-sm text-kidville-error-strong">{errore}</div>
      </div>
    );
  }

  if (!member) {
    return (
      <div className="rounded-card bg-kidville-white p-10 text-center shadow-sm">
        <h2 className="font-barlow text-lg font-bold uppercase text-kidville-green">{t('staffDMembroNonTrovato')}</h2>
        <p className="mt-1 font-maven text-sm text-kidville-sub">{t('staffDMembroNonTrovatoHint')}</p>
      </div>
    );
  }

  const initials = `${member.nome?.[0] ?? ''}${member.cognome?.[0] ?? ''}`.toUpperCase() || '—';
  /**
   * Il nome della sede in cui la persona sta ADESSO. Si guarda prima l'elenco
   * delle destinazioni (che per la Direzione copre tutte le sedi reali) e solo
   * dopo `schools`, che porta le sole sedi dell'utente: senza il primo, la sede
   * di un collega di un plesso che non è il tuo si leggerebbe «—» anche quando la
   * riga in archivio ce l'ha eccome.
   */
  const sedeNome = nomeSede(destinazioni.sedi, member.scuola_id)
    ?? (member.scuola_id ? (schools.find((s) => s.id === member.scuola_id)?.nome ?? '—') : '—');
  /** L'elenco della tendina: TUTTE le destinazioni, sede attuale compresa —
   *  toglierla farebbe partire un salvataggio senza sede a chi apre e salva. */
  const sediDoveSpostare = destinazioni.sedi;
  /** Le destinazioni DIVERSE da quella attuale: se sono zero non c'è dove spostare. */
  const altroveDaQui = altreSedi(destinazioni.sedi, member.scuola_id);
  /**
   * ⚠️ NON C'È DOVE SPOSTARE, E L'ELENCO L'HA GIÀ DETTO.
   *
   * Misurato il 2026-09-04 con una segreteria a UNA SOLA SEDE — cioè il caso
   * ordinario, non un limite: nessuna segreteria risulta associata a più di una
   * sede. Il comando «Sposta di sede» compariva lo stesso e apriva una modalità
   * la cui unica sostanza era la spiegazione «da qui non c'è nessun'altra sede»,
   * con accanto un pulsante **Salva** che mandava `{ id, scuola_id: <la sede in
   * cui la persona già sta> }` — un PATCH che il server accetta come no-op. Un
   * vicolo cieco con dentro un Salva: si preme, non succede niente, e non
   * succede niente anche quando ha funzionato.
   *
   * La scheda del BAMBINO risolveva già bene lo stesso caso — spiega, e il
   * comando non lo mostra. Qui si fa lo stesso, con una differenza che conta:
   * la spiegazione PRENDE IL POSTO del comando, non sparisce con lui. Togliere
   * un vicolo cieco e togliere una risposta sono due cose diverse.
   *
   * `'ok'` **e** `'nessuna'`: sono due divieti diversi (una sola sede in elenco
   * contro nessuna sede in elenco) e la spiegazione infatti cambia, ma il fatto
   * è lo stesso — non c'è dove andare. `'caricamento'` e `'guasto'` NO: lì non
   * si sa ancora, e il comando resta (il guasto porta con sé il «Riprova» che
   * solo la modalità di modifica mostra). Quella finestra la copre il secondo
   * presidio, sul Salva.
   */
  const nessunAltroPlesso =
    (destinazioni.stato === 'ok' || destinazioni.stato === 'nessuna') && altroveDaQui.length === 0;
  /**
   * ⚠️ IL SECONDO PRESIDIO: in modalità «solo sede» il salvataggio ha UN mestiere
   * solo, e senza un cambio di sede non ne ha nessuno. Serve alla finestra in cui
   * il comando si offre legittimamente (elenco in lettura, o non letto) e la
   * tendina non c'è ancora: senza, «Salva» resterebbe premibile e manderebbe il
   * PATCH a vuoto. Non vale per la Direzione, il cui salvataggio porta anche
   * ruolo e classi e quindi ha da fare pure a sede ferma.
   */
  const spostamentoSenzaCambio =
    soloSede && (draft.scuola_id === '' || stessaSede(draft.scuola_id, member.scuola_id));
  const classiAssegnate = asseg
    .filter((a) => a.utente_id === staffId)
    .map((a) => sections.find((s) => s.id === a.section_id)?.name)
    .filter((n): n is string => Boolean(n));
  const sezioniPerSede = sections.filter((s) => !draft.scuola_id || s.scuola_id === draft.scuola_id);

  // I recapiti dell'account NON stanno in `anagrafica_personale`: si uniscono qui
  // per la sola lettura, così i gruppi restano una descrizione della schermata e
  // non della tabella.
  const valori: ValoriAnagrafica = {
    ...(anagrafica ?? {}),
    email: member.email ?? null,
    telefono: letturaMia?.telefono ?? null,
  };

  const scadenza = anagrafica ? valoreTesto(anagrafica, 'document_expiry') : null;
  const cessatoIl = anagrafica ? valoreTesto(anagrafica, 'cessato_il') : null;
  // ⚠️ QUI SI LEGGEVA `documento_path`, e quella colonna non esiste più (migrazione
  // `20260812194501`, applicata in produzione). `valoreTesto` non lancia su una
  // chiave assente: restituisce `null` — cioè il pulsante «Apri la scansione»
  // sarebbe sparito per TUTTI, con la frase «Nessuna scansione allegata» sotto, e
  // nessun test poteva vederlo perché `undefined` è indistinguibile da «vuoto».
  const percorsoDi = (lato: LatoScansione) =>
    anagrafica ? valoreTesto(anagrafica, COLONNA_DI[lato]) : null;
  const scansioni: Record<LatoScansione, string | null> = {
    fronte: percorsoDi('fronte'),
    retro: percorsoDi('retro'),
  };
  const statoFacce = statoScansioni(scansioni.fronte, scansioni.retro);
  const { stato: statoDoc, giorni } = statoDocumento(scadenza, cessatoIl, dataCivile());

  const OPZIONI_TAB = [
    { id: 'incarico', label: t('staffTabIncarico'), icon: UserCog },
    { id: 'anagrafica', label: t('staffTabAnagrafica'), icon: ClipboardList },
    { id: 'documento', label: t('staffTabDocumento'), icon: IdCard },
  ];

  return (
    <div className="flex w-full flex-col rounded-card bg-kidville-white shadow-sm">
      {/* Header: avatar iniziali + nome + ruolo + STATO DEL DOCUMENTO */}
      <div className="flex items-center gap-4 border-b border-kidville-line p-5">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-kidville-green/10 font-barlow text-lg font-black text-kidville-green">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-barlow text-xl font-black uppercase tracking-wide text-kidville-green">
            {member.cognome} {member.nome}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="inline-block rounded-full bg-kidville-cream px-2.5 py-0.5 font-maven text-[11px] font-bold text-kidville-green">
              {labelRuolo(member.ruolo)}
            </span>
            {/* Finché la lettura è in volo NON si disegna nessun badge: fra
                «non lo so ancora» e «in regola» la differenza è tutta, e un
                verde che diventa rosso mezzo secondo dopo è peggio di
                un'attesa — chi ha già distolto lo sguardo ha letto il verde. */}
            {statoAna !== 'caricamento' && statoAna !== 'errore' && (
              <BadgeDocumento stato={statoDoc} giorni={giorni} />
            )}
          </div>
        </div>
        {/* ⚠️ LA X ERA 32×32 E IL SUO NOME STAVA SOLO NEL `title`.
            MISURATO sul pannello vivo a 1440 px: **32×32**, cioè il comando più
            piccolo rimasto in una scheda che dichiara i 44 px come proprio
            pavimento (`CMD_BASE`) — ed è il comando che si preme per USCIRE dal
            fascicolo di una persona, con dentro il codice fiscale e la
            residenza. Su un telefono, mancarlo significa restare dentro.
            E il nome: `title` non compare MAI su un touch, non è un'etichetta
            visibile e come nome accessibile è l'ultimo ripiego dell'algoritmo.
            Il repo ha già un lock che lo dice — `nome-bottoni-icona.test.tsx`
            respinge un bottone di sola icona senza `aria-label`/testo — solo che
            questa scheda non era nel suo elenco. `aria-label` per chi ascolta,
            `title` lasciato per il suggerimento col mouse. */}
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-kidville-line text-kidville-sub hover:text-kidville-ink"
          aria-label={t('chiudi')}
          title={t('chiudi')}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="p-5 md:p-6">
        {/* `Tabs` del cockpit: bottoni con `aria-pressed`, non un widget ARIA
            «tabs» — quindi niente roving tabindex da implementare e niente
            promessa di navigazione con le frecce che poi non c'è. */}
        <Tabs value={tab} options={OPZIONI_TAB} onChange={(id) => setTab(id as typeof tab)} className={LINGUETTE_44} />

        {tab === 'incarico' && (
          <div className="space-y-5">
            {/* Contatti */}
            <section>
              <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{t('staffDContatti')}</h3>
              {/* `<span>` e non `<label>`: qui sotto non c'è nessun campo da
                  etichettare, e un `<label>` orfano promette a uno screen reader un
                  controllo che non esiste. La resa a schermo è identica (`block`). */}
              <span className="mb-1 block font-maven text-xs text-kidville-sub">{t('campoEmail')}</span>
              <p className="break-all font-maven text-sm text-kidville-green">{member.email || '—'}</p>
            </section>

            {/* Ruolo e Sede */}
            <section>
              <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{t('staffDRuoloSede')}</h3>
              {!editMode ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="mb-1 block font-maven text-xs text-kidville-sub">{t('campoRuolo')}</span>
                    <span className="inline-block rounded-full bg-kidville-cream px-2.5 py-1 font-maven text-xs font-bold text-kidville-green">{labelRuolo(member.ruolo)}</span>
                  </div>
                  <div>
                    <span className="mb-1 block font-maven text-xs text-kidville-sub">{t('campoSede')}</span>
                    <p className="font-maven text-sm text-kidville-green">{sedeNome}</p>
                  </div>
                </div>
              ) : (
                /* ⚠️ LE DUE TENDINE HANNO UN NOME, e fino a qui non l'avevano.
                   Le `<label>` erano elementi FRATELLI senza `for`, i `<select>`
                   senza `id` e senza `aria-label`: axe-core misurava `label`,
                   impatto **critical**, 2 nodi — «Form element does not have an
                   explicit <label>». Uno screen reader li annunciava tutti e due
                   «menu», cioè due comandi indistinguibili all'ascolto di cui uno
                   cambia il RUOLO e l'altro la SEDE — e sbagliare la sede è il
                   difetto che questo repo ha già pagato: «una route che indovina la
                   sede archivia i dati nel plesso sbagliato in silenzio».
                   `htmlFor`+`id` e non `aria-label`, perché così l'etichetta resta
                   anche CLICCABILE: sposta il fuoco sulla tendina, che su un
                   telefono raddoppia un bersaglio piccolo. */
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    {/* ⚠️ IL RUOLO RESTA IN SOLA LETTURA PER LA SEGRETERIA, e non
                        è una limitazione di cortesia: il server rifiuterebbe il
                        cambio (`INCARICO_STAFF_RISERVATO`) insieme alla sede, e
                        chi può cambiare un ruolo può promuovere una collega ad
                        `admin` e da lì rigenerarne le credenziali. La stessa
                        pillola di `!editMode`, non un `<select>` disabilitato: un
                        controllo spento continua a promettere che un giorno si
                        accenda. */}
                    {soloSede ? (
                      <>
                        <span className="mb-1 block font-maven text-xs text-kidville-sub">{t('campoRuolo')}</span>
                        <span className="inline-block rounded-full bg-kidville-cream px-2.5 py-1 font-maven text-xs font-bold text-kidville-green">{labelRuolo(member.ruolo)}</span>
                      </>
                    ) : (
                      <>
                        <label htmlFor={idRuolo} className="mb-1 block font-maven text-xs text-kidville-sub">{t('campoRuolo')}</label>
                        <select id={idRuolo} name="incarico_ruolo" value={draft.ruolo} onChange={(e) => setDraft({ ...draft, ruolo: e.target.value })}
                          className={TENDINA_44}>
                          {/* `labelRuolo(r.value)` e non `r.label`: `RUOLI_ASSEGNABILI`
                              porta le etichette ITALIANE cablate, e sono le stesse cinque
                              parole che la pillola in sola lettura di due righe più su
                              traduce già con `useLabelRuolo`. Lasciare `r.label` qui
                              significava che in inglese la tendina mostrava «Docente»
                              mentre il pannello accanto mostrava «Teacher» per lo stesso
                              ruolo: non una schermata mezza tradotta, una schermata che
                              si contraddice. Il ripiego resta l'italiano, mai la chiave. */}
                          {RUOLI_ASSEGNABILI.map((r) => <option key={r.value} value={r.value}>{labelRuolo(r.value)}</option>)}
                        </select>
                      </>
                    )}
                  </div>
                  <div>
                    {/* ⚠️ TRE ESITI DI LETTURA, E NON SI RIDUCONO A DUE. Una
                        tendina vuota davanti a un guasto direbbe «non ci sono
                        sedi», che è una bugia con l'aria di un fatto — la rotta
                        distingue apposta `nessuna-destinazione` da
                        `LETTURA_FALLITA`. E una tendina con la sola sede attuale è
                        un comando che non può fare niente: è il caso ordinario
                        della Segreteria, e si SPIEGA. */}
                    <label htmlFor={idSede} className="mb-1 block font-maven text-xs text-kidville-sub">{t('campoSede')}</label>
                    {destinazioni.stato === 'caricamento' ? (
                      <p className="font-maven text-xs text-kidville-sub">{t('trasferimentoCaricamento')}</p>
                    ) : destinazioni.stato === 'guasto' ? (
                      <div data-testid="staff-sede-guasto" role="status" className="space-y-2">
                        <p className="font-maven text-xs text-kidville-warn-strong">{t('trasferimentoGuasto')}</p>
                        <button type="button" data-testid="staff-sede-riprova" onClick={destinazioni.ricarica}
                          className="min-h-[44px] rounded-pill border-2 border-kidville-green/40 px-4 font-barlow text-xs font-bold uppercase text-kidville-green hover:bg-kidville-green/5">
                          {t('trasferimentoRiprova')}
                        </button>
                      </div>
                    ) : altroveDaQui.length === 0 ? (
                      <p data-testid="staff-sede-spiegazione" className="font-maven text-xs text-kidville-sub">
                        {destinazioni.stato === 'nessuna' ? t('staffDSedeNessunaDestinazione') : t('staffDSedeUnicaDestinazione')}
                      </p>
                    ) : (
                      <select id={idSede} name="incarico_sede" value={draft.scuola_id} onChange={(e) => setDraft({ ...draft, scuola_id: e.target.value })}
                        className={TENDINA_44}>
                        <option value="">—</option>
                        {sediDoveSpostare.map((s) => <option key={s.id} value={s.id}>{s.nome}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Gradi (sola lettura, se presenti) */}
            {member.gradi && member.gradi.length > 0 && (
              <section>
                <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{t('staffDGradi')}</h3>
                <div className="flex flex-wrap gap-1.5">
                  {member.gradi.map((g) => (
                    <span key={g} className="rounded-full border border-kidville-line bg-kidville-white px-2 py-1 font-maven text-[11px] font-bold capitalize text-kidville-sub">{g}</span>
                  ))}
                </div>
              </section>
            )}

            {/* Classi assegnate */}
            <section>
              <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{t('staffDClassiAssegnate')}</h3>
              {/* ⚠️ `!editMode || soloSede`: in modalità «solo sede» le classi
                  restano PILLOLE, non bottoni. Non è coerenza estetica — il
                  server rifiuta il cambio di classi alla Segreteria, e siccome
                  calcola i permessi sul corpo INTERO, una classe toccata per
                  sbaglio farebbe fallire anche lo spostamento di sede con un 403
                  che parla d'altro. E c'è la metà che conta di più: quando lo
                  spostamento riesce, `admin/staff:PATCH` SGANCIA da solo le
                  classi del plesso lasciato. Offrire di sceglierle prima di
                  partire sarebbe offrire un lavoro che il server sta per buttare. */}
              {!editMode || soloSede ? (
                classiAssegnate.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {classiAssegnate.map((n) => (
                      <span key={n} className="rounded-full bg-kidville-green/10 px-2.5 py-1 font-maven text-[11px] font-bold text-kidville-green">{n}</span>
                    ))}
                  </div>
                ) : (
                  <p className="font-maven text-sm text-kidville-sub">{t('staffDNessunaClasse')}</p>
                )
              ) : (
                /* ╔════════════════════════════════════════════════════════════╗
                   ║  QUESTE PILLOLE DECIDONO CHI ENTRA IN QUALE CLASSE        ║
                   ╚════════════════════════════════════════════════════════════╝
                   Portavano il proprio stato nel SOLO riempimento: nessun
                   `aria-pressed`, nessuna icona, testo identico fra assegnata e non
                   assegnata (misurato sul DOM: attributi ARIA presenti **0**, e le
                   due classi differivano solo per i colori). Chi non distingue i
                   colori — o chi ascolta — non aveva modo di sapere quali classi
                   fossero assegnate MENTRE le stava cambiando. WCAG 1.4.1 (il colore
                   non porta l'informazione da solo) e 4.1.2 (stato non esposto).
                   Ora l'informazione è tripla, come nel resto della scheda: colore ·
                   ICONA (spunta / più: due forme diverse, non due tinte) ·
                   `aria-pressed`, che è anche ciò che rende il difetto misurabile per
                   sempre invece che a occhio.
                   ⚠️ E il bersaglio sale a 44px, con la stessa motivazione scritta su
                   `CMD_BASE`: erano **54,5×26,5** px, cioè il comando più piccolo
                   dell'intera scheda, su un pannello che si apre anche dentro la
                   WebView Capacitor, con un dito. Alzare i quattro comandi in fondo
                   al percorso e lasciare a 26 px quello che assegna una classe
                   sarebbe stato un principio applicato dove non costava. */
                <div className="flex flex-wrap gap-1.5">
                  {sezioniPerSede.length === 0 && <span className="font-maven text-xs text-kidville-sub">{t('staffDNessunaClassePerSede')}</span>}
                  {sezioniPerSede.map((s) => {
                    const on = draft.section_ids.includes(s.id);
                    return (
                      <button key={s.id} type="button" aria-pressed={on} onClick={() => toggleSezione(s.id)}
                        className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3 font-maven text-[11px] font-bold ${on ? 'border-kidville-green bg-kidville-green text-kidville-white' : 'border-kidville-line bg-kidville-white text-kidville-sub hover:border-kidville-green'}`}>
                        {on ? <Check size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" className="opacity-70" />}
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}

        {/* IL RICOVERO DEL FUOCO — un solo `<div>` per i due tab che leggono
            l'anagrafica, e non uno per tab. È il nodo che sopravvive sia al
            cambio di tab sia alle tre transizioni di «Riprova» (caricamento →
            dati · vuoto · errore di nuovo): un ricovero che si smonta insieme
            al contenuto non è un ricovero. `tabIndex={-1}` lo rende
            raggiungibile dal codice e MAI dal Tab — non si aggiunge una tappa
            alla navigazione di chi non ha premuto niente. L'anello e il suo
            gancio d'Alto Contrasto vengono da `FUOCO_ESITO`, che è dove questa
            decisione vive già per le due schermate delle assenze. */}
        {(tab === 'anagrafica' || tab === 'documento') && (
          <div ref={ricoveroTab} tabIndex={-1} className={`rounded-card ${FUOCO_ESITO}`}>
            {tab === 'anagrafica' && (
              <StatoLettura
                stato={statoAna}
                onRiprova={riprovaAnagrafica}
                vuoto={<AnagraficaAssente link={linkModulo} email={member.email ?? null} copiato={copiato} onCopia={copiaLink} />}
              >
                <div className="space-y-5">
                  <p className="flex items-start gap-1.5 rounded-xl bg-kidville-green-soft px-3 py-2 font-maven text-xs text-kidville-green">
                    <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {/* Lo `<span>` NON è decorativo: è flex item, quindi
                        blockified, quindi `max-width` morde. Corpo 12 px →
                        `MISURA_PROSA_XS` (95 caratteri per riga prima, 74 dopo). */}
                    <span className={MISURA_PROSA_XS}>{t('staffAnaSolaLettura')}</span>
                  </p>
                  {GRUPPI_ANAGRAFICA_PERSONALE.map((g) => (
                    <GruppoDati key={g.titolo} titolo={t(g.titolo)} campi={g.campi} valori={valori} />
                  ))}
                  {anagrafica?.aggiornata_il != null && (
                    <p className="font-maven text-xs text-kidville-sub">
                      {t('staffAnaAggiornata', { data: f.dataLunga(String(anagrafica.aggiornata_il)) })}
                    </p>
                  )}
                </div>
              </StatoLettura>
            )}

            {tab === 'documento' && (
              <StatoLettura
                stato={statoAna}
                onRiprova={riprovaAnagrafica}
                vuoto={<AnagraficaAssente link={linkModulo} email={member.email ?? null} copiato={copiato} onCopia={copiaLink} />}
              >
                <div className="space-y-4">
                  <BannerDocumento stato={statoDoc} scadenza={scadenza} />

                  {/* Le stesse righe del gruppo «Documento» del tab Anagrafica, e
                      NON una seconda copia: la definizione dei campi è una sola.
                      Compaiono in due posti perché rispondono a due domande diverse
                      — «l'anagrafica è completa?» e «questo documento è valido?» —
                      e chi apre il tab Documento non deve tornare indietro per
                      leggere il numero che sta guardando. */}
                  <GruppoDati titolo={t('staffAnaGruppoDocumento')} campi={CAMPI_DOCUMENTO} valori={valori} />

                  <div className="space-y-3">
                    {/* LA RIGA CHE DICE QUANTE FACCE CI SONO — `role="status"` e non
                        `alert`: «manca il retro» è un'incompletezza da chiudere, non
                        un guasto che deve interrompere chi ascolta. Vedi
                        `statoScansioni`. Sta SOPRA i due blocchi perché è la sintesi
                        che risponde alla domanda con cui si apre questo tab. */}
                    <p
                      role="status"
                      className={`flex items-start gap-1.5 rounded-xl px-3 py-2 font-maven text-xs ${
                        statoFacce === 'complete'
                          ? 'bg-kidville-success-soft text-kidville-success-strong'
                          : 'bg-kidville-cream text-kidville-sub'
                      }`}
                    >
                      {statoFacce === 'complete'
                        ? <ShieldCheck size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                        : <FileQuestion size={13} className="mt-0.5 shrink-0" aria-hidden="true" />}
                      <span className={MISURA_PROSA_XS}>{t(CHIAVE_STATO_SCANSIONI[statoFacce])}</span>
                    </p>

                    {LATI.map((lato) => (
                      <BloccoFaccia
                        key={lato}
                        lato={lato}
                        percorso={scansioni[lato]}
                        inVolo={inVolo === lato}
                        conferma={conferma === lato}
                        esito={esitoCaricamento?.lato === lato ? esitoCaricamento : null}
                        ricovero={(nodo) => { ricoveroFaccia.current[lato] = nodo; }}
                        onApri={() => { if (scansioni[lato]) void apriScansione(scansioni[lato] as string); }}
                        onChiediConferma={() => { setEsitoCaricamento(null); setConferma(lato); }}
                        onAnnullaConferma={() => setConferma(null)}
                        onFile={(file) => void caricaScansione(lato, file)}
                      />
                    ))}

                    {erroreDoc && (
                      <p role="alert" className="font-maven text-xs text-kidville-error-strong">{erroreDoc}</p>
                    )}
                    {docBloccato && (
                      <p role="alert" className={AVVISO_FINESTRA_BLOCCATA}>
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        {ts('docFinestraBloccata')}{' '}
                        <a href={docBloccato} target="_blank" rel="noopener noreferrer" className="font-bold text-kidville-green underline">
                          {ts('docApriManuale')}
                        </a>
                      </p>
                    )}
                  </div>

                  <section className="rounded-card border border-kidville-line bg-kidville-cream/50 p-4">
                    <h3 className="font-barlow text-sm font-extrabold uppercase tracking-[0.02em] text-kidville-green">
                      {t('staffDocRichiediAggiornamento')}
                    </h3>
                    <p className={`mt-1 font-maven text-xs leading-relaxed text-kidville-sub ${MISURA_PROSA_XS}`}>{t('staffDocRichiediHint')}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <BottoneCopiaLink copiato={copiato} onCopia={copiaLink} />
                      <BottoneInviaEmail link={linkModulo} email={member.email ?? null} />
                    </div>
                  </section>
                </div>
              </StatoLettura>
            )}
          </div>
        )}
      </div>

      {/* Footer azioni — DUE poteri distinti, e solo sul tab INCARICO: «Modifica»
          apre ruolo, sede e classi, cioè i campi di quel tab. Offrirlo mentre si
          guarda l'anagrafica sarebbe un comando che agisce su ciò che non si sta
          guardando — e su questa scheda l'anagrafica NON si modifica affatto
          (vedi il perimetro in testa al file).

          «Modifica» è della Direzione. «Rigenera credenziali» segue il BERSAGLIO:
          dal 2026-09-03 la Segreteria ce l'ha sullo staff del proprio plesso, non
          sugli account di Direzione. La fascia «riservate» qui sotto compare
          quando non resta NESSUNO dei due, che è l'unico caso in cui dire
          «riservate» è vero.

          ⚠️ E DAL 2026-09-04 I POTERI SONO TRE. La Segreteria sposta di SEDE — il
          server glielo concede e le nega tutto il resto — e fino a qui quel
          permesso era irraggiungibile: senza `canEdit` non vedeva nemmeno il
          pulsante, e l'unica strada rimasta era una `UPDATE` a mano sul database.
          Il suo comando è SEPARATO da «Modifica» e non un allargamento di quello:
          il server calcola i permessi sul corpo intero, quindi una scheda che le
          aprisse anche ruolo e classi le farebbe rifiutare il salvataggio —
          spostamento compreso — per un campo che non voleva toccare. */}
      {tab === 'incarico' && (canEdit || canSpostareSede || canRigenerare ? (
        <div className="space-y-2 border-t border-kidville-line p-5">
          {!editMode ? (
            <>
              {canEdit && (
                <button onClick={() => apri(false)}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-pill bg-kidville-green font-barlow text-sm font-black uppercase tracking-wide text-kidville-yellow transition-all hover:opacity-90 active:scale-[0.98]">
                  <Pencil size={15} /> {t('staffDModifica')}
                </button>
              )}
              {/* O IL COMANDO, O LA RAGIONE PER CUI NON C'È — mai un comando che
                  apre un vicolo cieco, e mai un silenzio al posto di una
                  risposta. Vedi `nessunAltroPlesso`. */}
              {!canEdit && canSpostareSede && (nessunAltroPlesso ? (
                <p data-testid="staff-sposta-sede-spiegazione" className="font-maven text-xs leading-relaxed text-kidville-sub">
                  {destinazioni.stato === 'nessuna' ? t('staffDSedeNessunaDestinazione') : t('staffDSedeUnicaDestinazione')}
                </p>
              ) : (
                <button onClick={() => apri(true)} data-testid="staff-sposta-sede"
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-pill bg-kidville-green font-barlow text-sm font-black uppercase tracking-wide text-kidville-yellow transition-all hover:opacity-90 active:scale-[0.98]">
                  <Pencil size={15} /> {t('staffDSpostaSede')}
                </button>
              ))}
              {canRigenerare && (
                <button onClick={rigenera} disabled={regenBusy}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-pill border-2 border-kidville-green/40 font-barlow text-sm font-bold uppercase text-kidville-green transition-all hover:bg-kidville-green/5 disabled:opacity-50">
                  {regenBusy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />} {t('rigeneraCredenziali')}
                </button>
              )}
            </>
          ) : (
            <div className="flex gap-2">
              <button onClick={salva} disabled={saving || spostamentoSenzaCambio} data-testid="staff-sede-salva"
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-pill bg-kidville-green font-barlow text-sm font-black uppercase tracking-wide text-kidville-yellow transition-all hover:opacity-90 disabled:opacity-50">
                {saving ? <Loader2 size={16} className="animate-spin" /> : <><Check size={16} /> {t('salva')}</>}
              </button>
              {/* IL TERZO ROSSO. Cercando i due della fascia se n'è trovato un
                  altro: qui il `hover` portava l'inchiostro `error` DEBOLE, che su
                  bianco misura **4,23:1** (calcolo WCAG su `getComputedStyle`,
                  col CSS vero servito da
                  `:3100`), sotto i 4,5:1 di AA — e proprio nello STATO in cui il
                  bottone si sta per premere. `error-strong` misura 5,62:1. Il
                  bordo resta `error`: per un contorno la soglia è 3:1 (WCAG 1.4.11)
                  e 4,23 la supera. Così i rossi della scheda tornano a essere uno
                  solo, che è la stessa cura già fatta sui due grigi. */}
              <button onClick={() => { setEditMode(false); setSoloSede(false); setErroreIncarico(null); }} disabled={saving}
                className="flex h-11 flex-1 items-center justify-center gap-2 rounded-pill border-2 border-kidville-line font-barlow text-sm font-bold uppercase text-kidville-sub transition-all hover:border-kidville-error hover:text-kidville-error-strong disabled:opacity-50">
                <X size={16} /> {t('annulla')}
              </button>
            </div>
          )}
          {/* ⚠️ SPAZIO RISERVATO, non guadagnato al bisogno: un messaggio che
              compare sopra o accanto a un bottone lo fa muovere, e su WebKit è
              così che il dito che stava per premere «Salva» finisce su
              «Annulla». Il riquadro sta SOTTO i comandi e l'altezza minima è già
              lì prima che serva. */}
          <div className="min-h-[1.25rem]">
            {erroreIncarico && (
              <p data-testid="staff-sede-errore" role="alert"
                className="rounded-card border border-kidville-error/40 bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
                {erroreIncarico}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 border-t border-kidville-line px-5 py-3 font-maven text-[11px] text-kidville-sub">
          <ShieldCheck size={12} /> {t('staffDRiservate')}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * I PEZZI
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * IL BADGE DELLO STATO DEL DOCUMENTO — icona E testo, mai icona sola.
 *
 * Il colore non porta informazione da solo (WCAG 1.4.1): rosso, arancio, verde e
 * grigio dicono la stessa cosa che dice la parola accanto. La parola c'è perché
 * il colore da solo non basta; l'icona c'è perché a colpo d'occhio la si trova
 * prima della parola. Il prefisso `sr-only` dice di CHE COSA si sta parlando —
 * senza, uno screen reader annuncia «scaduto» accanto a un nome di persona.
 */
function BadgeDocumento({ stato, giorni }: { stato: StatoDocumento; giorni: number | null }) {
  const t = useTranslations('adminStudents');
  const Icona = stato === 'inRegola' ? ShieldCheck
    : stato === 'inScadenza' ? Clock
      : stato === 'scaduto' ? AlertTriangle
        : FileQuestion;
  const testo = stato === 'inRegola' ? t('staffDocInRegola')
    : stato === 'inScadenza' ? t('staffDocInScadenza', { giorni: giorni ?? 0 })
      : stato === 'scaduto' ? t('staffDocScaduto')
        : stato === 'cessato' ? t('staffDocCessato')
          : t('staffDocMancante');
  return (
    <Badge tone={TONO_DOCUMENTO[stato]} data-stato-documento={stato}>
      <Icona size={12} aria-hidden="true" />
      <span className="sr-only">{t('staffDocEtichetta')} </span>
      {testo}
    </Badge>
  );
}

/** Il banner del tab Documento: gli stessi toni del badge, con la data per esteso. */
function BannerDocumento({ stato, scadenza }: { stato: StatoDocumento; scadenza: string | null }) {
  const t = useTranslations('adminStudents');
  const f = useDateFormat();
  const data = scadenza ? f.dataLunga(scadenza) : '';
  const testo = stato === 'mancante' ? t('staffDocBannerMancante')
    : stato === 'cessato' ? t('staffDocBannerCessato')
      : stato === 'scaduto' ? t('staffDocBannerScaduto', { data })
        : stato === 'inScadenza' ? t('staffDocBannerInScadenza', { data })
          : t('staffDocBannerInRegola', { data });
  const classi = stato === 'scaduto'
    ? 'border-kidville-error/40 bg-kidville-error-soft text-kidville-error-strong'
    : stato === 'inScadenza'
      ? 'border-kidville-warn/40 bg-kidville-warn-soft text-kidville-warn-strong'
      : stato === 'inRegola'
        ? 'border-kidville-success/40 bg-kidville-success-soft text-kidville-success-strong'
        : 'border-kidville-line bg-kidville-neutral-soft text-kidville-sub';
  const Icona = stato === 'inRegola' ? ShieldCheck
    : stato === 'inScadenza' ? Clock
      : stato === 'scaduto' ? AlertTriangle
        : FileQuestion;
  return (
    <p className={`flex items-start gap-2 rounded-card border px-4 py-3 font-maven text-sm leading-relaxed ${classi}`}>
      <Icona size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      {/* Flex item → blockified → `max-width` morde. Vedi `MISURA_PROSA`: qui
          stavano le due righe più lunghe della scheda (118 e 114 caratteri), e
          quella dello scaduto è la sola che va letta fino in fondo. */}
      <span className={MISURA_PROSA}>{testo}</span>
    </p>
  );
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LE 27 RIGHE DEL FASCICOLO PARLANO LA LINGUA DELL'INTERFACCIA            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * IL DIFETTO, MISURATO. Con l'interfaccia in inglese questa scheda usciva
 * BILINGUE A METÀ: **27 `<dt>` su 27 in italiano** («Sesso», «Data di nascita»,
 * «Che rapporto ha con te») dentro titoli di gruppo inglesi («Personal details»,
 * «Residence»), con l'avviso di sola lettura, i badge, i banner, i comandi, il
 * ruolo e perfino le date tradotti. Italiani anche i valori a elenco: «Femmina»,
 * «Carta d'identità», «Laurea magistrale». Cioè restava in italiano l'unica cosa
 * per cui il tab esiste. La lingua è raggiungibile davvero — `LOCALES = ['it','en']`
 * e il selettore sta sulla pagina di login — quindi chi entra in inglese resta in
 * inglese in tutto il cockpit.
 *
 * ⚠️ E IL LOCK DELLA PARITÀ NON POTEVA VEDERLO: le 39 chiavi nuove del contorno
 * erano state aggiunte in tutte e due le lingue, quindi `adminStudents` risultava
 * 555/555 — verde — proprio perché le 27 stringhe che mancavano non erano mai
 * diventate chiavi. Un lock che confronta due cataloghi non sa nulla del testo che
 * un catalogo non contiene.
 *
 * ── PERCHÉ NON BASTAVA LEGGERE `PERSONALE_FIELDS`, E PERCHÉ SI CONTINUA A FARLO ─
 *
 * `GRUPPI_ANAGRAFICA_PERSONALE` porta gli `id` e non le etichette proprio per non
 * ribattere il contratto del modulo pubblico: «il giorno in cui una domanda cambia
 * formulazione la scheda continua a mostrare la vecchia — cioè due nomi per lo
 * stesso dato, uno dei quali sbagliato». Quel timore resta giusto, e portare le
 * etichette in catalogo lo riapre: ora la stessa frase esiste in due file.
 *
 * La duplicazione quindi c'è, ma NON PUÒ DIVERGERE: il lock
 * `StaffDetailPanel-anagrafica.test.tsx` («le 27 righe esistono anche in inglese»)
 * verifica che per ogni campo mostrato la voce ITALIANA del catalogo coincida
 * carattere per carattere con la `label` di `PERSONALE_FIELDS`, e che la chiave
 * esista anche in `en`. Riformulare una domanda del modulo senza toccare il
 * catalogo fa rosso, e il rosso dice quale chiave. È la stessa disciplina con cui
 * `FORMA_CF` vive in tre posti che un test confronta.
 *
 * ── COSA RESTA FUORI, DICHIARATO ────────────────────────────────────────────
 * Il MODULO PUBBLICO `/anagrafica-personale` continua a mostrare le etichette
 * italiane di `PERSONALE_FIELDS`: è il debito che quel file dichiara in testa
 * («si chiude portando le etichette a chiavi di messaggio, e il giorno in cui si
 * fa si fa per TUTTI E TRE»), e non si chiude di sponda da qui — toccare
 * `personale-template.ts` cambierebbe sotto i piedi anche `/iscrizione` e
 * `/lavora-con-noi`. Le chiavi però nascono nel namespace `etichette`, che è il
 * vocabolario condiviso (`ruolo_*`, `allergene_*`, `umore_*`): quando quel lavoro
 * si farà, i tre moduli avranno già dove leggere invece di doverle inventare.
 *
 * Il ripiego `te.has(...)` è lo stesso idioma di `useLabelRuolo`: se un giorno un
 * campo nuovo arrivasse in `PERSONALE_FIELDS` prima della sua chiave, la scheda
 * mostrerebbe l'etichetta italiana del contratto — mai il nome della chiave, che
 * è ciò che next-intl fa di suo e che a schermo si legge `etichette.campoX`.
 */
type TraduttoreEtichette = ReturnType<typeof useTranslations>;

function etichettaCampo(te: TraduttoreEtichette) {
  return (id: string): string => {
    const chiave = `campoPersonale_${id}`;
    return te.has(chiave) ? te(chiave) : (CAMPO_PER_ID.get(id)?.label ?? id);
  };
}

/**
 * Un gruppo di coppie etichetta/valore, in griglia a due colonne da `sm` in su.
 *
 * ⚠️ UNA RIGA NON SI OMETTE MAI. «Non indicato» in grigio è più lungo da
 * scrivere del nulla, ed è tutto il punto: l'assenza di un dato è la notizia che
 * questa schermata deve dare. Nascondere le righe vuote produrrebbe una scheda
 * che sembra completa a chiunque non abbia in mente l'elenco dei 32 campi — cioè
 * a chiunque. È la stessa misura pagata in questo repo sui codici fiscali: 18
 * alunni su 33 e 27 genitori su 50 non ne avevano nessuno, e «mancante» non è
 * «sbagliato» ma è comunque l'unica cosa che qualcuno deve andare a chiedere.
 */
function GruppoDati({ titolo, campi, valori }: { titolo: string; campi: string[]; valori: ValoriAnagrafica }) {
  const t = useTranslations('adminStudents');
  const te = useTranslations('etichette');
  const f = useDateFormat();
  const etichetta = etichettaCampo(te);

  const rendi = (id: string): string | null => {
    const grezzo = valoreTesto(valori, id);
    if (grezzo === null) return null;
    const campo = CAMPO_PER_ID.get(id);
    // Un valore da elenco chiuso si mostra con la sua ETICHETTA: `CI` e
    // `laurea_magistrale` sono codici di colonna, non italiano. E l'etichetta
    // passa dal catalogo: vedi `etichettaCampo`, che vale identico qui sotto.
    if (campo?.options?.length) {
      const scelta = campo.options.find((o) => o.value === grezzo);
      if (!scelta) return grezzo;
      const chiave = `opzPersonale_${id}_${grezzo}`;
      return te.has(chiave) ? te(chiave) : scelta.label;
    }
    if (campo?.type === 'date') return f.dataLunga(grezzo) || grezzo;
    return grezzo;
  };

  return (
    <section>
      <h3 className="mb-2 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{titolo}</h3>
      <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        {campi.map((id) => {
          // Una riga FUSA prende l'etichetta da `id` e il testo dal campo
          // sorgente: «Comune di nascita» → il nome per esteso, mai il codice.
          const sorgente = RIGHE_FUSE[id];
          const valore = rendi(sorgente ?? id);
          const codice = sorgente ? valoreTesto(valori, id) : null;
          return (
            <div key={id} className="min-w-0">
              <dt className="font-maven text-xs text-kidville-sub">{etichetta(id)}</dt>
              <dd className={`break-words font-maven text-sm ${valore === null ? 'italic text-kidville-sub' : 'text-kidville-ink'}`}>
                {valore ?? t('staffAnaNonIndicato')}
                {/* Il codice ACCANTO al nome, mai al posto suo. `not-italic`
                    perché quando il nome manca la riga è in corsivo grigio, e un
                    codice in corsivo si legge peggio di quanto già non si legga. */}
                {codice && (
                  <span className="ml-1.5 inline-block whitespace-nowrap rounded-pill bg-kidville-cream px-1.5 py-0.5 align-[1px] font-barlow text-[11px] font-bold not-italic tracking-[0.04em] text-kidville-green">
                    {/* Lo spazio DAVANTI non è un refuso: fra il nome del comune
                        e questo `<span>` non c'è nessun nodo di testo, e senza
                        uno screen reader può leggere «CampaniaCodice». */}
                    <span className="sr-only">{` ${t('staffAnaCodiceCatastale')}: `}</span>{codice}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  UNA FACCIA DEL DOCUMENTO: aprila, caricala, sostituiscila               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Due blocchi identici — Fronte e Retro — e non uno solo con due pulsanti dentro:
 * le due facce si aprono una per volta, si caricano una per volta e si sostituiscono
 * una per volta, quindi ognuna ha il proprio stato e il proprio esito. Un blocco
 * solo costringerebbe chi carica il retro a leggere un messaggio che sta accanto al
 * fronte.
 *
 * ── ⚠️ TRE COSE CHE SEMBRANO DETTAGLI E NON LO SONO ────────────────────────
 *
 *  1. **`<input type="file">` è `sr-only`, MAI `hidden`.** Con `display:none` non è
 *     focalizzabile, non entra nel Tab e NON ESISTE nell'albero di accessibilità: la
 *     `<label>` che lo avvolge sembra un bottone e non lo è, e il campo diventa
 *     irraggiungibile senza mouse. `jest-axe` non lo vede (dà 0 violazioni). È la
 *     lezione già scritta in `carica-file.ts`, e vale identica qui.
 *  2. **La guardia contro il doppio invio NON sta qui**, e nemmeno su `disabled`.
 *     Vive nel gestore `caricaScansione` del componente padre, in un posto solo, ed
 *     è lì che la sua testata la spiega. Questo blocco ne mostra soltanto lo stato:
 *     testo, rotellina e `aria-busy` quando `inVolo`. Fino al 13/08/2026 la stessa
 *     guardia era ricopiata anche sull'`onChange` qui sotto (`inVolo || bloccato`) —
 *     e la copia era invisibile a ogni test, perché non c'è comportamento che la
 *     distingua dall'originale. Restava solo un commento che prometteva un presidio
 *     che il codice non era tenuto ad avere.
 *
 *     ⚠️ `e.target.value = ''` invece RESTA e non è ridondante: senza, riscegliere lo
 *     STESSO file dopo un errore non emette nessun `change` (il valore non cambia) e
 *     il comando sembra rotto. È misurato: toglierlo rende rosso un test.
 *  3. **I nomi dei comandi sono DISTINTI fra le due facce.** «Apri la scansione»
 *     ripetuto due volte è, per chi ascolta, due comandi identici che fanno cose
 *     diverse — e la cosa diversa è aprire il documento d'identità sbagliato. Il
 *     `<span className="sr-only">` aggiunge la faccia al nome accessibile senza
 *     toccare l'etichetta visibile, quindi il nome CONTIENE il testo visibile
 *     (WCAG 2.5.3, «Label in Name») invece di sostituirlo come farebbe un
 *     `aria-label`.
 *
 * ── PERCHÉ «SOSTITUISCI» CHIEDE CONFERMA E «CARICA» NO ─────────────────────
 *
 * Perché sostituire CANCELLA irreversibilmente la copia precedente dall'archivio
 * (lo fa il server, al passo 13 della sua sequenza), e la copia precedente è la
 * fotografia del documento d'identità di una persona. Il primo caricamento non
 * distrugge niente, quindi non chiede niente: una conferma chiesta anche quando non
 * serve è il modo più efficace di far premere «sì» senza leggere.
 *
 * La conferma è IN PAGINA e non `confirm()`: il repo lo vieta, e qui il divieto ha
 * un morso — dentro la WebView Capacitor una finestra di sistema interrompe il
 * gesto, e su iOS può non tornare mai.
 */
function BloccoFaccia({
  lato, percorso, inVolo, conferma, esito, ricovero,
  onApri, onChiediConferma, onAnnullaConferma, onFile,
}: {
  lato: LatoScansione;
  percorso: string | null;
  /** Questa faccia sta caricando: serve a MOSTRARLO, non a impedire il secondo gesto. */
  inVolo: boolean;
  conferma: boolean;
  esito: { testo: string; guasto: boolean } | null;
  ricovero: (nodo: HTMLElement | null) => void;
  onApri: () => void;
  onChiediConferma: () => void;
  onAnnullaConferma: () => void;
  onFile: (file: File) => void;
}) {
  const t = useTranslations('adminStudents');
  const nomeLato = t(lato === 'fronte' ? 'staffDocFronte' : 'staffDocRetro');
  const accetta = PERSONALE_FIELDS.find((c) => c.id === COLONNA_DI[lato])?.accept ?? undefined;

  /**
   * Il campo di scelta del file, vestito da comando. `key` sul valore di `conferma`
   * NON serve: l'input si smonta comunque quando il blocco passa da «Carica» a
   * «Sostituisci». Il `value = ''` in coda sì — senza, ricaricare DUE VOLTE lo
   * stesso file non emette il secondo `change` (il valore non cambia), cioè il
   * secondo tentativo dopo un errore non partirebbe e il pulsante sembrerebbe rotto.
   * Non è una supposizione: toglierlo rende rosso «il campo si AZZERA a ogni scelta».
   *
   * `if (!file) return` è l'unica guardia rimasta qui, e non è quella del doppio
   * invio: copre il caso in cui il selettore di sistema venga chiuso senza scegliere
   * niente. La regola «una richiesta per volta» sta in `caricaScansione` (punto 2).
   */
  const scegliFile = (etichetta: string, classi: string, Icona: typeof Upload) => (
    <label className={`${classi} cursor-pointer`} aria-busy={inVolo || undefined}>
      {inVolo ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Icona size={15} aria-hidden="true" />}
      {inVolo ? t('staffDocCaricamentoInCorso') : etichetta}{' '}
      {/* ⚠️ `{' '}` E NON UNO SPAZIO NEL JSX. Fra il testo visibile e questo
          `<span>` ci vuole un NODO DI TESTO: JSX mangia lo spazio che contiene un
          a capo, e il calcolo del nome accessibile non ne aggiunge uno suo fra due
          figli. MISURATO su questo pannello: senza, il nome del comando è
          «Apri la scansioneFronte» — una parola sola, letta così ad alta voce. È
          la stessa correzione già scritta su `GruppoDati` («CampaniaCodice»). */}
      <span className="sr-only">{nomeLato}</span>
      <input
        type="file"
        className="sr-only"
        accept={accetta}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          onFile(file);
        }}
      />
    </label>
  );

  return (
    <section
      ref={ricovero}
      tabIndex={-1}
      className={`rounded-card border border-kidville-line p-4 ${FUOCO_ESITO}`}
    >
      <h4 className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">{nomeLato}</h4>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {percorso ? (
          <>
            <button type="button" onClick={onApri} className={CMD_SECONDARIO}>
              <FileText size={15} aria-hidden="true" /> {t('staffDocApriScansione')}{' '}
              <span className="sr-only">{nomeLato}</span>
              <ExternalLink size={12} aria-hidden="true" />
            </button>
            {!conferma && (
              <button type="button" onClick={onChiediConferma} className={CMD_SECONDARIO}>
                <RefreshCw size={15} aria-hidden="true" /> {t('staffDocSostituisci')}{' '}
                <span className="sr-only">{nomeLato}</span>
              </button>
            )}
          </>
        ) : (
          <>
            <p className="font-maven text-sm text-kidville-sub">{t('staffDocNessunaScansione')}</p>
            {scegliFile(t('staffDocCarica'), CMD_PRIMARIO, Upload)}
          </>
        )}
      </div>

      {conferma && percorso && (
        /* La conferma è un `group`, non un `alertdialog`: non è modale, non
           intrappola il fuoco e non promette una gestione dell'Esc che non c'è.
           `aria-label` le dà un nome, così chi ascolta sa di che cosa sono i due
           comandi che ci trova dentro. */
        <div
          role="group"
          aria-label={`${t('staffDocSostituisci')} ${nomeLato}`}
          className="mt-3 rounded-xl border border-kidville-warn/40 bg-kidville-warn-soft p-3"
        >
          <p className={`font-maven text-xs leading-relaxed text-kidville-warn-strong ${MISURA_PROSA_XS}`}>
            {t('staffDocConfermaSostituzione')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {scegliFile(t('staffDocConfermaScegli'), CMD_PRIMARIO, Upload)}
            <button type="button" onClick={onAnnullaConferma} className={CMD_SECONDARIO}>
              {t('annulla')}{' '}
              <span className="sr-only">{nomeLato}</span>
            </button>
          </div>
        </div>
      )}

      {esito && (
        /* L'ERRORE si annuncia da solo (`alert`) perché dopo un guasto il fuoco NON
           si sposta: resta dov'era, e senza `alert` il messaggio sarebbe muto. Il
           SUCCESSO no: lì il fuoco viene portato su questo blocco (vedi
           `ricoveroFaccia`), che lo legge insieme al resto — un `status` in più
           farebbe annunciare due volte lo stesso fatto. */
        <p
          {...(esito.guasto ? { role: 'alert' as const } : {})}
          className={`mt-2 font-maven text-xs ${esito.guasto ? 'text-kidville-error-strong' : 'text-kidville-success-strong'}`}
        >
          {esito.testo}
        </p>
      )}
    </section>
  );
}

/** Caricamento · errore con riprova · vuoto · contenuto. In un posto solo. */
function StatoLettura({
  stato, onRiprova, vuoto, children,
}: {
  stato: 'caricamento' | 'pronta' | 'assente' | 'errore';
  onRiprova: () => void;
  vuoto: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useTranslations('adminStudents');
  if (stato === 'caricamento') {
    return (
      <div className="flex items-center justify-center gap-2 py-12 font-maven text-sm text-kidville-sub">
        <Loader2 className="animate-spin text-kidville-green" size={20} /> {t('staffAnaCaricamento')}
      </div>
    );
  }
  if (stato === 'errore') {
    return (
      /* L'inchiostro forte sta ANCHE sul nodo che porta `role="alert"`, e non solo
         sul `<p>` dentro: il rilevatore del lock legge le classi del tag che porta
         l'attributo, e una fascia corretta scritta un livello più sotto gli
         risulterebbe indistinguibile da una sbagliata. Qui il colore ereditato e
         quello dichiarato coincidono, quindi non c'è nessuna seconda verità. */
      <div role="alert" className="rounded-card border border-kidville-error/30 bg-kidville-error-soft p-4 text-kidville-error-strong">
        <p className="font-maven text-sm text-kidville-error-strong">{t('staffAnaErrore')}</p>
        <button
          type="button"
          onClick={onRiprova}
          className={`mt-3 ${CMD_SECONDARIO}`}
        >
          {t('staffAnaRiprova')}
        </button>
      </div>
    );
  }
  if (stato === 'assente') return <>{vuoto}</>;
  return <>{children}</>;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LO STATO VUOTO, CHE IL PRIMO GIORNO È LO STATO PIÙ COMUNE              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Misurato l'11/08/2026: in produzione ci sono DIECI insegnanti con un account e
 * ZERO anagrafiche. Cioè questa card — non la griglia dei campi — è la schermata
 * che la segreteria vedrà dieci volte su dieci la prima settimana, e la griglia è
 * quella che vedrà dopo. Un vuoto scritto «nessun dato» sarebbe stato un vicolo
 * cieco su dieci schede su dieci.
 *
 * Perciò il vuoto È l'azione: dice cosa manca, perché manca, e mette accanto i
 * due modi di rimediare — il link del modulo negli appunti e la stessa cosa in
 * un'email già scritta.
 *
 * ── PERCHÉ «INVIA PER EMAIL» È UN `mailto:` E NON UNA ROTTA ────────────────
 *
 * Un invio dal server avrebbe voluto una rotta nuova, un template, un mittente
 * verificato e un percorso d'errore in più (il repo ha già pagato mesi di email
 * di credenziali mai arrivate con un `403` loggato senza corpo). Il `mailto:`
 * apre il client di posta della segreteria con oggetto e testo già scritti: parte
 * dalla sua casella, resta nella sua posta inviata, e non aggiunge nessun canale
 * da sorvegliare. Il testo lo si può correggere prima di premere invio, che su un
 * messaggio a una collega è un pregio e non un ripiego.
 *
 * Senza email in archivio il comando NON è disabilitato in silenzio: dice perché.
 */
function AnagraficaAssente({
  link, email, copiato, onCopia,
}: {
  link: string;
  email: string | null;
  copiato: boolean;
  onCopia: () => void;
}) {
  const t = useTranslations('adminStudents');
  return (
    <div className="rounded-card border border-kidville-line bg-kidville-cream/60 p-6 text-center">
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-card bg-kidville-yellow">
        <ClipboardList className="h-6 w-6 text-kidville-green" aria-hidden="true" />
      </div>
      <h3 className="font-barlow text-lg font-black uppercase tracking-wide text-kidville-green">
        {t('staffAnaVuotaTitolo')}
      </h3>
      {/* Era `max-w-md`, cioè gli stessi 28rem: qui la regola c'era già ed è da
          qui che il numero di `MISURA_PROSA` è stato preso. Stesso valore, stessa
          resa (73 caratteri misurati), ma una definizione sola. */}
      <p className={`mx-auto mt-2 font-maven text-sm leading-relaxed text-kidville-sub ${MISURA_PROSA}`}>
        {t('staffAnaVuotaCorpo')}
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <BottoneCopiaLink copiato={copiato} onCopia={onCopia} />
        <BottoneInviaEmail link={link} email={email} />
      </div>
      <p className="mt-3 break-all font-maven text-xs text-kidville-sub">{link}</p>
    </div>
  );
}

function BottoneCopiaLink({ copiato, onCopia }: { copiato: boolean; onCopia: () => void }) {
  const t = useTranslations('adminStudents');
  return (
    <button
      type="button"
      onClick={onCopia}
      className={CMD_PRIMARIO}
    >
      {copiato ? <><CheckCircle2 size={15} /> {t('staffAnaCopiato')}</> : <><Copy size={15} /> {t('staffAnaCopiaLink')}</>}
    </button>
  );
}

function BottoneInviaEmail({ link, email }: { link: string; email: string | null }) {
  const t = useTranslations('adminStudents');
  if (!email) {
    return (
      <p className="font-maven text-xs text-kidville-sub">{t('staffAnaSenzaEmail')}</p>
    );
  }
  // Il link NON sta dentro la stringa di catalogo: ci si concatena. Un segnaposto
  // seguito da altro testo in un messaggio è la forma che il lock dei contatori
  // riconosce, e soprattutto una URL in mezzo a una frase tradotta è la cosa che
  // si rompe per prima quando la frase cambia.
  const corpo = `${t('staffAnaCorpoEmail')}\n\n${link}\n`;
  const href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(t('staffAnaOggettoEmail'))}&body=${encodeURIComponent(corpo)}`;
  return (
    <a
      href={href}
      className={CMD_SECONDARIO}
    >
      <Mail size={15} /> {t('staffAnaInviaEmail')}
    </a>
  );
}
