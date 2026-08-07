import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock: i flow Maestro non toccano un'etichetta AMBIGUA per solo testo.
 *
 * ─── IL DIFETTO CHE QUESTO TEST RENDE IMPOSSIBILE ──────────────────────────
 * Collaudo Android del 2026-07-31, `android-percorso-segreteria.yaml`:
 * `tapOn: "Mensa"` non navigava. L'app era sana. Nell'albero di accessibilità
 * della WebView Capacitor «Mensa» esiste DUE volte sulla dashboard del cockpit:
 *   1) la tile della griglia «Tutti i moduli» (fondo pagina, misurata FUORI
 *      viewport, schiacciata a y=1857 con ALTEZZA 0);
 *   2) il tab vero della bottom-nav.
 * Maestro prende la PRIMA corrispondenza: il tap finiva su un'area morta.
 * Identica causa sul tap «Anagrafica» dentro il bottom-sheet, dove la tile
 * omonima resta nell'albero DIETRO il foglio modale.
 *
 * ─── PERCHÉ UN LOCK, E NON «basta ricordarsene» ────────────────────────────
 * Questa classe di difetto ha due facce, e la seconda è peggiore della prima:
 *  - faccia rumorosa: il passo dopo il tap va in timeout e il flow fallisce
 *    (è così che l'abbiamo scoperto);
 *  - faccia SILENZIOSA: se il testo atteso dopo il tap esiste anche nella
 *    pagina di partenza, l'asserzione passa lo stesso e il flow dichiara PASS
 *    senza essersi mai mosso. È già successo — la trappola 1 in
 *    `android-screenshot-playstore.yaml` la descrive per esteso.
 * Da qui la regola R3: un tap a coordinate deve provare di essere atterrato
 * (asserzione POSITIVA sulla destinazione) e di aver lasciato la pagina di
 * partenza (asserzione NEGATIVA). Una sola delle due non basta.
 *
 * Il test è STATICO di proposito: la prova sul device richiede emulatore,
 * server e credenziali degli account TEST, che non stanno nel repo. Questo lock
 * gira in ogni `vitest run`, non solo quando qualcuno ha un emulatore acceso.
 *
 * ─── IL SECONDO DIFETTO: IL SELETTORE MORTO ────────────────────────────────
 * Collaudo Android del 2026-07-31, flow del GENITORE e del DOCENTE: entrambi si
 * fermavano al primo passo sulla bottom-nav con
 *   `Assertion is false: "MENU" is visible`.
 * L'app era sana: il testo «MENU» non è MAI stato nell'albero. Il dump della home
 * genitore espone `HOME`, `DIARIO`, `AVVISI`, `CHAT` e — per il quinto tab —
 * `Menu · tutte le sezioni` [834,1664][1039,1824].
 * La ragione è ARIA, non la WebView: i primi quattro tab sono `<Link>` senza
 * `aria-label`, quindi il loro nome accessibile viene dal contenuto (lo `<span>`);
 * il quinto è un `<button aria-label="Menu · tutte le sezioni">`, e `aria-label`
 * SOSTITUISCE il contenuto. Il commento nei flow («la WebView collassa il button
 * col suo <span> ed espone solo il testo visibile MENU») affermava l'opposto ed è
 * rimasto lì per mesi, facendo accusare l'app di un difetto che non aveva.
 *
 * ─── COSA IMPEDISCE QUESTO LOCK, E COSA NO ─────────────────────────────────
 * Impedisce: (R1-R3) che un'etichetta ambigua o un tap cieco passino senza prova
 * di aver navigato; (R4) che un selettore GIÀ MISURATO come assente rientri in un
 * flow; (R5) che un selettore vivo si scolli dal catalogo i18n che lo genera — se
 * qualcuno rinomina `ariaMenu`, il lock diventa rosso e il flow viene aggiornato
 * nello stesso lavoro; (R6) che R4 resti verde per cancellazione dei passi;
 * (R7) che si tocchi un nodo noto come non-toccabile (alto 0 px o coperto da un
 * overlay) senza portarlo prima nel viewport — centrandolo, quando serve — e
 * senza provare di aver lasciato la pagina di partenza; (R8) che si cerchi un
 * testo che un `aria-label` SOSTITUISCE, ed è l'unica regola che legge `src/`,
 * quindi l'unica che ferma il difetto anche su un tab nuovo mai misurato;
 * (R9) che un flow dipenda da un insieme di selettori mai eseguito verde su un
 * dispositivo; (R10) che un commento ripeta una teoria già smentita da una misura.
 *
 * NON può: scoprire un selettore morto MAI misurato (R9 lo rende però VISIBILE,
 * non lo impedisce), accorgersi che la WebView cambia comportamento con una nuova
 * versione di Android, né sapere se il testo del catalogo è davvero quello che
 * l'albero espone. E non può impedire a nessuno di aggiornare a mano una firma di
 * R9 senza aver eseguito niente: nessun test statico può. Il registro qui sotto
 * vale quanto la misura che lo ha riempito: ogni riga porta data e schermata.
 */

const DIR_FLOWS = path.join(process.cwd(), '.claude', 'maestro-flows');

/**
 * Etichette che sul cockpit `/admin` esistono in DUE posti (bottom-nav / griglia
 * «Tutti i moduli» di `src/app/(dashboard)/admin/page.tsx`), quindi non possono
 * essere il selettore di un `tapOn`. Sono elencate come stringhe ESATTE e nella
 * loro forma regex non ancorata: entrambe le scritture matchano i due nodi.
 */
const ETICHETTE_AMBIGUE_COCKPIT = ['Mensa', '.*Mensa.*', 'Anagrafica', '.*Anagrafica.*'];

/** I flow che navigano il cockpit Direzione/Segreteria. */
const FLOWS_COCKPIT = ['android-percorso-segreteria.yaml', 'ios-percorso-segreteria.yaml'];

/**
 * REGISTRO DEI SELETTORI MISURATI SULL'ALBERO REALE.
 *
 * Ogni riga è una MISURA (`adb shell uiautomator dump` / `maestro hierarchy`),
 * non un'opinione: porta la data e la schermata su cui è stata presa. Un flow
 * può dipendere solo da ciò che qui risulta `vivo`.
 *
 * `sorgente` è il punto del codice da cui quel nome accessibile NASCE: se cambia
 * lì, R5 diventa rosso e il flow va aggiornato nello stesso lavoro. È l'unica
 * parte del lock che segue l'app invece di fotografarla.
 */
type SelettoreMisurato = {
  /** Il testo esatto passato a Maestro. */
  selettore: string;
  /** `morto` = misurato ASSENTE dall'albero di accessibilità. */
  esito: 'vivo' | 'morto';
  /** Schermata su cui è stata presa la misura. */
  dove: string;
  /** Data della misura (ISO). */
  misurato: string;
  /** Per i morti: cosa usare al suo posto. */
  sostituto?: string;
  /** Per i vivi: il catalogo i18n che produce quel nome accessibile. */
  sorgente?: { file: string; chiave: string };
  /** Perché è morto / perché è vivo. */
  nota: string;
};

const SELETTORI_MISURATI: SelettoreMisurato[] = [
  {
    selettore: 'MENU',
    esito: 'morto',
    dove: 'home genitore e dashboard docente, quinto tab della bottom-nav',
    misurato: '2026-07-31',
    sostituto: 'Menu · tutte le sezioni',
    nota:
      'Il quinto tab è un <button> con aria-label: il nome accessibile è l\'aria-label, ' +
      'non il testo dello <span>. Sulla home genitore il dump non contiene «MENU» affatto ' +
      '(2026-07-31); col foglio aperto (2026-08-01) esiste un nodo «MENU» [94,63][322,63] ' +
      'nella topbar, ALTO 0 px — cioè inservibile in entrambi i casi, ma per due ragioni ' +
      'diverse. Precisione voluta: è un lock sulle affermazioni non verificate.',
  },
  {
    selettore: 'Menu',
    esito: 'morto',
    dove: 'bottom-nav genitore / docente / cockpit',
    misurato: '2026-07-31',
    sostituto: 'Menu · tutte le sezioni',
    nota:
      'Stessa causa di «MENU»: è il testo dello <span>, che l\'aria-label sostituisce. ' +
      'Vietato come selettore ESATTO; «Menu e ticket pasto» resta legittimo perché è ' +
      'un\'altra stringa, non questa.',
  },
  {
    selettore: 'Menu · tutte le sezioni',
    esito: 'vivo',
    dove: 'bottom-nav genitore, docente e cockpit (quinto tab)',
    misurato: '2026-07-31',
    sorgente: { file: 'messages/it/nav.json', chiave: 'ariaMenu' },
    nota: 'Misurato a [834,1664][1039,1824] sulla home genitore. Stesso valore nei tre cataloghi.',
  },
  {
    selettore: 'Menu · tutte le sezioni',
    esito: 'vivo',
    dove: 'bottom-nav docente',
    misurato: '2026-07-31',
    sorgente: { file: 'messages/it/teacherNav.json', chiave: 'ariaMenu' },
    nota: 'La bottom-nav del docente è un componente diverso: il catalogo va tenuto allineato.',
  },
  {
    selettore: 'Menu · tutte le sezioni',
    esito: 'vivo',
    dove: 'bottom-nav cockpit Direzione/Segreteria',
    misurato: '2026-07-31',
    sorgente: { file: 'messages/it/adminNav.json', chiave: 'menuAria' },
    nota: 'Flow segreteria: 39/39 sul device con questo selettore.',
  },
  {
    selettore: 'Alunni, famiglie e personale',
    esito: 'vivo',
    dove: 'bottom-sheet «Menu» del cockpit, voce Anagrafica',
    misurato: '2026-07-31',
    sorgente: { file: 'messages/it/adminNav.json', chiave: 'anagraficaSub' },
    nota: 'Sottotitolo univoco: la label «Anagrafica» è ambigua (vedi R1).',
  },
  {
    selettore: 'Assenze e giustifiche',
    esito: 'vivo',
    dove: 'bottom-sheet «Menu» del genitore, voce Presenze',
    misurato: '2026-07-31',
    sorgente: { file: 'messages/it/nav.json', chiave: 'vocePresenzeSub' },
    nota: 'Sottotitolo univoco: «Presenze» collide con le scorciatoie della home.',
  },
];

/**
 * Nodi che ci sono, che Maestro considera «visibili», e che **non si possono
 * toccare**. Il tap risulta `COMPLETED` e il tocco va altrove: il flow prosegue
 * e fallisce più avanti, dando la colpa all'app.
 *
 * Due cause misurate, sintomo identico:
 *  - `altezza-0`  — la CTA è fuori dal viewport e la WebView la proietta a fondo
 *    pagina schiacciata (dashboard docente: `[438,1857][643,1857]`, alta 0);
 *  - `coperto`    — la voce è dentro il viewport ma **sotto la bottom-nav
 *    flottante** (foglio «Menu» del genitore: `[254,1727][553,1782]` dentro
 *    `Navigazione principale [31,1664][1047,1824]`). Il tap è andato al tab
 *    «Diario», il foglio è rimasto aperto e il flow ha accusato l'app di non
 *    mostrare la sezione biometrica — che invece c'era.
 *
 * `provaDiPartenza` è il testo dell'asserzione NEGATIVA dopo il tap, e non è
 * sempre il selettore: «PROFILO E DELEGHE» è anche il TITOLO della pagina di
 * destinazione, quindi userebbe un testo presente in entrambe le schermate e
 * sarebbe rosso anche a navigazione riuscita.
 *
 * Nota di portata: misure prese sulla WebView **Android**; su iOS la proiezione
 * dei nodi fuori schermo è diversa e non è stata misurata, quindi la regola si
 * applica ai flow `android-*`.
 */
const CTA_SOTTO_LA_PIEGA = [
  {
    selettore: 'Apri la bacheca',
    dove: 'dashboard docente, dopo il ritorno dall\'appello',
    misurato: '2026-07-31',
    causa: 'altezza-0' as const,
    bounds: '[438,1857][643,1857] → larghezza 205, ALTEZZA 0',
    provaDiPartenza: 'Apri la bacheca',
  },
  {
    selettore: 'PROFILO E DELEGHE',
    dove: 'foglio «Menu» del genitore, ultima voce della lista',
    misurato: '2026-08-01',
    causa: 'coperto' as const,
    bounds:
      '[254,1727][553,1782] dentro «Navigazione principale» [31,1664][1047,1824] ' +
      '→ il tap è finito sul tab «Diario»',
    provaDiPartenza: 'TUTTE LE SEZIONI',
  },
  {
    selettore: 'Avvisi e comunicazioni',
    dove: 'foglio «Menu» del docente, voce Bacheca',
    misurato: '2026-08-01',
    causa: 'coperto' as const,
    bounds:
      '[254,1632][580,1672]: nell\'albero sembra LIBERA (la nav è data a y≥1664), ma ' +
      '`document.elementFromPoint` restituisce il <a href="/teacher/diary"> e il ' +
      'contenitore della bottom-nav parte a y=1605 device — l\'albero mostra il <nav> ' +
      'interno, non il suo padding. Il tap si perde anche con `adb shell input tap`.',
    provaDiPartenza: 'TUTTE LE SEZIONI',
  },
];

/**
 * ─── R11 · I TESTI CHE DIPENDONO DALL'ORA DEL GIORNO ───────────────────────
 *
 * Collaudo mobile-ios del 2026-07-31, `ios-percorso-docente.yaml`:
 *   `Assert that "Buongiorno!" is visible... FAILED` — alle 22:07.
 * L'app era sana: alle 22:07 la dashboard dice «Buonasera!». Il flow non
 * collaudava il docente, collaudava l'orologio — e per tre quarti della giornata
 * dava FAIL su un'app che funziona.
 *
 * È lo stesso vizio di «MENU», cambiata la fonte: là il selettore descriveva un
 * albero che non esisteva, qui descrive uno stato che dura quattro ore. In
 * entrambi i casi il flow è rosso e la colpa cade sull'app.
 *
 * La regola NON contiene la lista dei saluti: la legge da `greetingByHour()`.
 * Così, se domani qualcuno aggiunge «Buonanotte», il divieto lo copre da subito
 * senza che nessuno se ne ricordi; e se la funzione sparisce, il primo controllo
 * diventa rosso e chiede di rimisurare invece di restare verde per inerzia.
 */
const SORGENTE_SALUTI = 'src/lib/ui/greeting.ts';

function salutiOrari(): string[] {
  const sorgente = fs.readFileSync(path.join(process.cwd(), SORGENTE_SALUTI), 'utf8');
  return [...sorgente.matchAll(/return\s+'([^']+)'/g)].map((m) => m[1]);
}

/** Il saluto è reso come `${greeting}!`: il confronto ignora la punteggiatura finale. */
function normalizzaSelettore(s: string): string {
  return s.trim().replace(/[!.\s]+$/, '').toLowerCase();
}

/**
 * ─── R12 · LE ETICHETTE CHE CAMBIANO CON LO STATO DEI DATI ─────────────────
 *
 * Stesso collaudo, passo successivo: `No visible element found: "Modifica
 * appello"`. Quel bottone si chiama «Modifica appello» **solo se l'appello è già
 * registrato**; finché non lo è, si chiama «Fai l'appello ora». Il flow iOS
 * conosceva una sola delle due facce, e quale delle due si vedesse dipendeva da
 * cosa avesse fatto la maestra quella mattina.
 *
 * Su Android la stessa CTA era già stata corretta con un selettore che accetta
 * entrambe le varianti (`"Fai l'appello ora|Modifica appello"`): la conoscenza
 * c'era, non è stata propagata al file accanto. Da qui il lock — che è l'unica
 * forma di propagazione che non dipende dalla memoria di chi scrive.
 *
 * `chiavi` sono le due (o più) chiavi del catalogo che nominano lo STESSO
 * comando in stati diversi. Chi cerca una variante deve cercarle tutte.
 */
const ETICHETTE_STATO_DIPENDENTE = [
  {
    catalogo: 'messages/it/teacherNav.json',
    chiavi: ['appelloCtaFai', 'appelloCtaModifica'],
    componente: 'src/app/(dashboard)/teacher/page.tsx',
    dove: 'CTA dell\'appello sulla dashboard docente',
    misurato: '2026-07-31',
    nota:
      'Misurato sul simulatore alle 22:07: l\'appello del giorno non era registrato e la ' +
      'CTA diceva «Fai l\'appello ora». Il flow cercava «Modifica appello» e non trovava nulla.',
  },
];

/**
 * ─── R13 · LE CTA CHE ESISTONO SOLO SE CI SONO I DATI ──────────────────────
 *
 * «Apri la bacheca» non è sempre a schermo: la sezione COMUNICAZIONI della
 * dashboard docente è resa solo se `avvisiRecenti.length > 0`. Misurato il
 * 2026-08-01 su Android: c'era alle 00:27 e non c'era alle 00:45 — stessa app,
 * stesso account, dati diversi.
 *
 * Un flow che la dà per scontata fallisce con «No visible element found» e
 * sembra una regressione dell'app. La forma corretta è quella già adottata dal
 * flow Android: il passo sta dentro un `runFlow when:`, e c'è una seconda strada
 * che arriva alla stessa destinazione quando la CTA non c'è.
 *
 * Perché vale anche su iOS, dove non è stata misurata: la condizione non è
 * grafica, sta nel componente React che le due piattaforme condividono
 * (`src/app/(dashboard)/teacher/page.tsx`). Le misure sui bounds restano
 * specifiche per piattaforma (vedi R7); questa no.
 */
const CTA_CONDIZIONATE_DAI_DATI = [
  {
    selettore: 'Apri la bacheca',
    componente: 'src/app/(dashboard)/teacher/page.tsx',
    condizione: 'avvisiRecenti.length > 0',
    destinazione: 'Circolari e avvisi alle famiglie',
    misurato: '2026-08-01',
    nota:
      'Presente alle 00:27, assente alle 00:45 dello stesso giorno sull\'emulatore ' +
      'KV-play-phone: dipende dagli avvisi recenti della sezione, non dall\'app.',
  },
];

/**
 * ─── R14 · IL DIALOG NATIVO DEI PERMESSI (solo iOS) ────────────────────────
 *
 * Collaudo mobile-ios del 2026-07-31: il ramo `runFlow when: visible "Non
 * consentire"` risultava **sempre SKIPPED**, e subito dopo il dialog nativo
 * compariva e copriva la UI, facendo fallire l'asserzione successiva.
 *
 * `runFlow when:` valuta la condizione **una volta sola, subito**: non aspetta.
 * Su iOS il permesso notifiche viene chiesto dal codice web dopo il login, e fra
 * il tap e il dialog passano centinaia di ms — abbastanza perché la condizione
 * sia falsa quando viene guardata. Serve un'attesa esplicita e `optional: true`
 * davanti al ramo: è l'unico modo di dire «può darsi che compaia, dagli tempo».
 *
 * E ne servono DUE, non una: se il dialog resta in coda perché il flow è finito
 * prima, ricompare **al lancio successivo**, cioè PRIMA del login del giro dopo.
 * Un flow che lo gestisce solo dopo il login funziona una volta su due — e la
 * volta che fallisce sembra un difetto dell'app.
 *
 * Portata: la regola vale sui flow `ios-*`, dove il comportamento è stato
 * misurato. Su Android il permesso POST_NOTIFICATIONS è chiesto in un altro
 * momento e i flow passano 27/27 e 30/30 con la forma attuale: cambiarli senza
 * una misura significherebbe ripetere l'errore in senso opposto.
 */
const TESTO_DIALOG_PERMESSI = 'Non consentire';

/**
 * ─── R15 · IL SUBMIT DEL LOGIN SU iOS ──────────────────────────────────────
 *
 * Misurato il 2026-07-31 su iPhone 17 Pro Max / iOS 26.2: `tapOn: "Accedi"` con
 * la tastiera aperta risulta `COMPLETED` e **il form non parte**. Il passo che
 * dovrebbe chiudere la tastiera (`tapOn: "Benvenuto/a!"`) non la chiude, e
 * `hideKeyboard` su WebView iOS fallisce con «Couldn't hide the keyboard».
 * Con `pressKey: Enter` il login riesce **sempre**: l'app risponde, era il flow
 * a non premere il bottone.
 *
 * È la faccia peggiore della classe: il tap è COMPLETED, quindi il flow non
 * fallisce lì — fallisce tre passi dopo, sull'asserzione della dashboard, e il
 * verdetto scritto è «la dashboard non compare». Tre collaudi iOS di fila hanno
 * accusato l'app per questo.
 */
const SUBMIT_LOGIN_VIETATO_IOS = 'Accedi';

/**
 * ─── R8 · I TESTI CHE L'`aria-label` SOSTITUISCE ───────────────────────────
 *
 * La causa radice di «MENU» non è la WebView: è ARIA. Il calcolo del nome
 * accessibile (accname, passo 2C) dice che un `aria-label` **sostituisce** il
 * contenuto dell'elemento. Il quinto tab è
 *   `<button aria-label={t('ariaMenu')}> <Icon/> <span>{t('tabMenu')}</span> </button>`
 * → il suo nome accessibile è l'`aria-label`, e il testo dello `<span>` non
 * compare NEL MODO PIÙ ASSOLUTO nell'albero. (In più «MENU» non è nemmeno la
 * stringa del catalogo: `tabMenu` vale «Menu», la maiuscola è `uppercase` CSS.)
 *
 * Questa regola è l'unica del file che **guarda il codice sorgente**, e per
 * questo è quella che avrebbe fermato il difetto il giorno in cui è nato: chi
 * scrive un selettore uguale al testo coperto dall'aria-label viene fermato dal
 * gate, senza emulatore e senza aspettare il collaudo mobile.
 *
 * Il registro **scade da solo**: se qualcuno toglie l'`aria-label` dal bottone,
 * il primo controllo diventa rosso e dice di rimisurare — perché in quel caso il
 * nome accessibile tornerebbe a essere il contenuto, e «Menu» tornerebbe vivo.
 */
const TESTI_COPERTI_DA_ARIA_LABEL = [
  {
    componente: 'src/components/features/parent/BottomNav.tsx',
    catalogo: 'messages/it/nav.json',
    chiaveTesto: 'tabMenu',
    chiaveAria: 'ariaMenu',
    dove: 'quinto tab della bottom-nav del genitore',
  },
  {
    componente: 'src/components/features/teacher/TeacherBottomNav.tsx',
    catalogo: 'messages/it/teacherNav.json',
    chiaveTesto: 'tabMenu',
    chiaveAria: 'ariaMenu',
    dove: 'quinto tab della bottom-nav del docente',
  },
  {
    componente: 'src/components/features/admin/AdminBottomNav.tsx',
    catalogo: 'messages/it/adminNav.json',
    chiaveTesto: 'tabMenu',
    chiaveAria: 'menuAria',
    dove: 'quinto tab della bottom-nav del cockpit Direzione/Segreteria',
  },
];

/**
 * ─── R10 · LE AFFERMAZIONI SMENTITE DA UNA MISURA ──────────────────────────
 *
 * Il selettore morto è durato mesi non perché nessuno lo eseguisse, ma perché
 * accanto c'era un **commento che spiegava perché doveva essere così**. Una
 * teoria sbagliata scritta con sicurezza costa più del codice sbagliato: chi
 * indaga la legge, ci crede e va a cercare il difetto nell'app.
 *
 * Ogni voce è una frase MISURATA falsa, con la misura che la smentisce. Le
 * `deroghe` sono i file in cui la frase è ancora presente e che NON erano nel
 * perimetro dello step che ha scritto questa regola: sono debito dichiarato, e
 * il tetto qui sotto fa in modo che possa solo scendere.
 *
 * LIMITE, dichiarato: la regola non distingue una CITAZIONE da un'affermazione.
 * Chi vuole raccontare l'errore lo riformuli — la frase originale, testuale, vive
 * qui dentro (`pattern` + `smentitaDa`), che è il posto giusto: il registro non è
 * cancellazione della memoria, è l'archivio della memoria.
 */
const AFFERMAZIONI_SMENTITE = [
  {
    id: 'aria-label-non-diventa-contentdescription',
    pattern: /non diventa contentDescription/i,
    smentitaDa:
      'dump `uiautomator` del 2026-07-31 sulla home genitore: il quinto tab è ' +
      '«Menu · tutte le sezioni» [834,1664][1039,1824]; «MENU» non compare.',
    verita:
      'L\'aria-label È il nome accessibile (accname 2C: sostituisce il contenuto) ed è ' +
      'esattamente ciò che la WebView espone.',
    deroghe: [] as string[],
  },
  {
    id: 'bottom-nav-genitore-non-espone-aria-label',
    pattern: /bottom-nav del genitore.{0,40}non espone l.{0,2}aria-label/i,
    smentitaDa:
      'stesso dump del 2026-07-31: la bottom-nav del genitore espone l\'aria-label ' +
      'del quinto tab, esattamente come quella del cockpit.',
    verita:
      'Le due bottom-nav si comportano allo stesso modo: i primi quattro tab sono ' +
      '<Link> senza aria-label (nome = contenuto), il quinto è un <button> con aria-label.',
    // Debito: il flow della segreteria non era nel perimetro dello step S15 (2026-07-31),
    // dove questa regola è nata. Chi tocca quel file corregga la frase e tolga la deroga.
    deroghe: ['android-percorso-segreteria.yaml'],
  },
  {
    id: 'bottom-nav-non-nell-albero',
    pattern: /(NON È RAGGIUNGIBILE PER TESTO|non compaiono nell.albero di accessibilit)/i,
    smentitaDa:
      'dump del 2026-07-31: «HOME», «DIARIO», «AVVISI», «CHAT» SONO nell\'albero ' +
      '(Chromium applica il `text-transform` al nome accessibile); il flow genitore ' +
      'corretto passa 22/22 toccando «Avvisi» per testo.',
    verita:
      'Non raggiungibili per testo sono le etichette AMBIGUE (Mensa, Anagrafica: due nodi) ' +
      'e quelle coperte da aria-label (Menu). Le altre si toccano per testo.',
    // Debito: `android-screenshot-playstore.yaml` è fuori dal perimetro di S15.
    deroghe: ['android-screenshot-playstore.yaml'],
  },
];

/** Il debito dichiarato può solo scendere: nessuno lo allarga per comodità. */
const TETTO_DEROGHE_STORICHE = 2;

/**
 * ─── R9 · NESSUN FLOW DIPENDE DA SELETTORI MAI ESEGUITI ────────────────────
 *
 * La domanda a cui risponde: «questo insieme di selettori è mai stato verde su un
 * dispositivo vero, o è la teoria di qualcuno?». Con «MENU» la risposta era la
 * seconda, e nessuno poteva accorgersene leggendo il file — anzi, il commento
 * accanto rassicurava.
 *
 * L'unità di misura è il FLOW, non il singolo selettore: un flow che arriva in
 * fondo ha dimostrato **tutti** i suoi selettori in un colpo solo. La `firma` è
 * l'impronta dell'insieme ordinato dei selettori al momento dell'esecuzione: se
 * qualcuno ne cambia anche uno, la firma non torna e il lock dice che il flow non
 * è più quello che è stato provato.
 *
 * COSA NON PUÒ FARE, detto chiaro: non impedisce di aggiornare la firma senza
 * aver eseguito niente. Nessun test statico può. Quello che ottiene è che
 * l'assunzione non verificata diventi una RIGA IN DIFF — data, device, esito —
 * invece di un commento persuasivo dentro un file che nessuno rilegge.
 */
type EsecuzioneMisurata = {
  flow: string;
  /** Data ISO dell'esecuzione. */
  data: string;
  /** Dispositivo/simulatore su cui è stata fatta. */
  device: string;
  /** Esito riportato da Maestro (es. «22/22 step ok»). */
  esito: string;
  /** Impronta dell'insieme dei selettori ALLORA (vedi firmaSelettori()). */
  firma: string;
};

const ESECUZIONI_VERDI: EsecuzioneMisurata[] = [
  // ─── ANDROID, 2026-08-02: LA WEBVIEW È CAMBIATA SOTTO AI FLOW ──────────────
  // La riga del genitore del 01/08 dichiarava 27 COMPLETED su KV-play-phone. Il
  // 02/08, sullo STESSO emulatore e con lo stesso APK, il flow è rosso al 16°
  // comando: «Menu · tutte le sezioni» non è più nell'albero. Non è cambiato il
  // repo — è cambiato il motore. KV-play-phone è l'immagine col Play Store e la
  // WebView si aggiorna da sé: oggi è la 150.0.7871.181, e per un <button> con
  // aria-label E testo interno visibile passa ad Android il testo interno come
  // `text`, lasciando vuota la content-desc (misurato: `text="MENU"
  // class=android.widget.Button content-desc="" [834,1695][1036,1855]`). Su
  // KV-api33 (WebView 109) lo stesso nodo espone ancora la desc.
  //
  // È il limite che questo registro dichiarava da sé — «non può accorgersi che
  // la WebView cambia comportamento con una nuova versione» — visto succedere:
  // la `firma` è l'impronta del FILE, quindi resta valida mentre l'ambiente si
  // muove. Da qui la versione della WebView dentro `device`: una riga che non
  // dice su quale motore è stata presa non è ripetibile. (Un campo dedicato
  // sarebbe meglio di una stringa libera: vedi il report dello step.)
  // ⚠️ `android-percorso-genitore.yaml` STAVA QUI con la firma aa404640c8ce (27
  // COMPLETED su KV-play-phone il 2026-08-02). Il 2026-08-07 il flow è stato
  // riscritto e la riga è scesa in FLOW_SENZA_ESECUZIONE_VERDE, dove il motivo
  // conserva per intero anche la lezione di quel giorno (il server :3100 che
  // serviva una build sostituita). Stessa sorte per `ios-percorso-genitore.yaml`,
  // che stava qui con la firma cfd3e836a2f5.
  {
    flow: 'android-percorso-docente.yaml',
    data: '2026-08-02',
    device:
      'emulatore KV-play-phone · Android 16 (API 36) · WebView com.google.android.webview ' +
      '150.0.7871.181 · APK su http://10.0.2.2:3100 (`next start`, build di produzione, ' +
      'server RIAVVIATO sulla build corrente)',
    esito:
      '31 COMPLETED, 0 FAILED, DUE esecuzioni su due. Stesso selettore alternato del ' +
      'genitore, e stessa storia: quattro esecuzioni erano fallite prima, tutte sul gate ' +
      '«Dashboard», per il server che serviva una build sostituita. Porta anche ' +
      '`assertVisible: "Benvenuto/a!"` prima di digitare — non è decorativa: è il respiro ' +
      'che serve all\'idratazione, e il gemello del genitore ce l\'aveva per caso (un ' +
      'assert e uno screenshot che facevano passare il tempo senza che nessuno li avesse ' +
      'messi lì per quello).',
    firma: '94b31f09846a',
  },
  {
    flow: 'android-biometria-loop.yaml',
    data: '2026-08-01',
    device: 'emulatore KV-play-phone · Android 16 (senza impronte registrate)',
    esito:
      '18 COMPLETED, 0 FAILED fino al Profilo, due esecuzioni di fila. Il flow si ferma lì '
      + 'per costruzione: ' +
      'la parte «attiva lo sblocco e riavvia» non è ancora scritta, e su questo AVD ' +
      '«SBLOCCO CON FACE ID / IMPRONTA» dice «Non disponibile su questo dispositivo».',
    firma: '184afcbc1656',
  },
  {
    flow: 'android-percorso-segreteria.yaml',
    data: '2026-07-31',
    device: 'emulatore KV-play-phone · Android 16',
    esito:
      '39/39 step ok — misura del collaudo mobile-android del 2026-07-31, non ripetuta ' +
      'qui: il file non è stato toccato da allora (la firma lo dimostra).',
    firma: '668fd9771f28',
  },
  // ─── I TRE FLOW iOS, 2026-08-02 ────────────────────────────────────────────
  // Erano tutti e tre in FLOW_SENZA_ESECUZIONE_VERDE, e il gate era verde perché
  // il debito era dichiarato: il verde certificava l'ASSENZA della prova, non la
  // sua presenza. Questa parte resta vera, ed è il motivo per cui il registro
  // esiste.
  //
  // ⚠️ DUE AFFERMAZIONI DI QUESTO BLOCCO ERANO FALSE, e sono state scritte qui il
  // 2026-08-02 prima che il collaudo le smontasse. Restano scritte perché il
  // registro è l'archivio della memoria, non la sua cancellazione:
  //
  //   1. «i selettori erano stati corretti il 01/08 e NESSUNO li aveva più
  //      lanciati». FALSO: sotto ~/.maestro/tests ci sono SETTE esecuzioni iOS del
  //      2026-08-01 fra le 12:51 e le 13:32, tutte con 0 FAILED (genitore 24 e 30,
  //      docente 30, segreteria 36). I flow erano già verdi undici ore dopo la
  //      correzione. `FLOW_SENZA_ESECUZIONE_VERDE` registra ciò che qualcuno ha
  //      scritto nel file, NON ciò che è stato eseguito sulla macchina: il debito
  //      era stato iscritto alle 01:10 del 01/08 e nessuno l'ha tolto quando le
  //      esecuzioni sono arrivate. È lo stesso difetto che il registro combatte,
  //      nella direzione opposta.
  //   2. «senza toccare un solo selettore». FALSO rispetto al rosso del 31/07:
  //      fra quel rosso e questo verde sono cambiate DUE variabili, non una. Il
  //      commit 462630c del 01/08 ha riscritto i selettori dei tre flow (175
  //      righe aggiunte, 54 tolte): «Buongiorno!» → «Dashboard», «Modifica
  //      appello» → «Fai l'appello ora|Modifica appello», «Apri la bacheca» →
  //      «Menu · tutte le sezioni», più la gestione dei dialoghi dei permessi.
  //      Attribuire il verde al solo cambio di server era una conclusione più
  //      forte della misura.
  //
  // COSA DICONO DAVVERO LE MISURE, senza aggiungerci niente:
  //   · con i selettori di oggi e l'app servita da `next start`, i tre flow
  //     passano — due esecuzioni su due ciascuno (misura del 02/08);
  //   · con gli stessi selettori, il 01/08 passavano già (sette esecuzioni);
  //   · il rosso del 31/07 aveva selettori DIVERSI e un server diverso, quindi
  //     non è isolabile su una sola causa da questi dati.
  // Che `next dev` sia inadatto resta documentato per Android da una misura
  // propria (PRD 2026-07-17, «l'emulatore non idrata `next dev`»); su iOS è una
  // raccomandazione prudenziale, non un esperimento controllato.
  {
    flow: 'ios-percorso-segreteria.yaml',
    data: '2026-08-02',
    device:
      'simulatore iPhone 17 Pro · iOS 26.2 · App.app con CAP_SERVER_URL=http://localhost:3100 ' +
      '(`next start`, build di produzione)',
    esito:
      '33 COMPLETED, 0 FAILED, DUE esecuzioni su due. Include il tap CIECO a coordinate ' +
      '`point: "68%,93%"` per il tab «Mensa»: la coordinata è misurata su Android e su iPhone ' +
      'è dedotta dalla geometria, e qui funziona — il controllo negativo ' +
      '`assertNotVisible: "Tutti i moduli"` dimostra che lo schermo si è mosso davvero invece ' +
      'di restare sulla dashboard. NON è la prima volta che gira su iOS: lo stesso flow era ' +
      'passato 36/36 il 2026-08-01 (~/.maestro/tests/2026-08-01_125354 e _133024). La prima ' +
      'versione di questa riga diceva «su iOS non era mai stato provato»: era falsa.',
    firma: '46bf862d8936',
  },
  // ⚠️ `ios-percorso-genitore.yaml` STAVA QUI con la firma cfd3e836a2f5 — vedi la
  // nota gemella più sopra e il motivo in FLOW_SENZA_ESECUZIONE_VERDE.
  {
    flow: 'ios-percorso-docente.yaml',
    data: '2026-08-02',
    device:
      'simulatore iPhone 17 Pro · iOS 26.2 · App.app con CAP_SERVER_URL=http://localhost:3100 ' +
      '(`next start`, build di produzione)',
    esito:
      '27 COMPLETED, 0 FAILED, DUE esecuzioni su due, di POMERIGGIO. Conta perché il rosso ' +
      'del 31/07 era su «Buongiorno!», il saluto ORARIO che alle 22:07 diventa «Buonasera!»: ' +
      'l\'ancora è ora la tab «Dashboard», che non cambia mai, e il flow non collauda più ' +
      'l\'orologio. Attenzione a non trarne una causa certa: il selettore fragile ERA lì e ' +
      'ora non c\'è più, ma le due esecuzioni verdi di oggi non lo dimostrano da sole — sono ' +
      'di pomeriggio, quando anche «Buongiorno!» sarebbe passato. La prova che quell\'ancora ' +
      'rompeva è del 31/07 (rosso alle 22:07); quella che ora non rompe più la darà una ' +
      'esecuzione verde DI SERA, che nessuno ha ancora fatto. Già verde 30/30 il 2026-08-01 (~/.maestro/tests/2026-08-01_125234 e _132906).',
    firma: 'e5f33aae091d',
  },
];

/**
 * Flow che oggi NON hanno un'esecuzione verde da esibire. È debito, ed è
 * dichiarato: il tetto può solo scendere.
 */
const FLOW_SENZA_ESECUZIONE_VERDE: { flow: string; motivo: string }[] = [
  // I TRE FLOW iOS SONO USCITI DA QUI il 2026-08-02: eseguiti due volte ciascuno su
  // iPhone 17 Pro / iOS 26.2 con l'app servita da `next start`, tutti verdi. Le loro
  // righe sono in ESECUZIONI_VERDI, con data, device, esito e firma.
  // I DUE PERCORSI GENITORE CI SONO RIENTRATI il 2026-08-07: riscritti, non rieseguiti.
  {
    flow: 'android-screenshot-playstore.yaml',
    motivo:
      'Ultima esecuzione nota 2026-07-28; non ri-misurato né nel ciclo del 2026-07-31/08-01 ' +
      'né in quello del 2026-08-02, che era un collaudo iOS + tastiera Android e non lo ' +
      'toccava. Contiene anche una spiegazione oggi smentita (vedi la deroga in ' +
      'AFFERMAZIONI_SMENTITE): chi lo riesegue corregga entrambe le cose e tolga questa riga.',
  },
  {
    flow: 'android-percorso-genitore.yaml',
    motivo:
      // ─── 2026-08-08 · SECONDA RISCRITTURA, SECONDA VOLTA SENZA ESECUZIONE ───
      'RISCRITTO UNA SECONDA VOLTA il 2026-08-08 e di nuovo NON eseguito. Questa volta però ' +
      'la riscrittura NON è una teoria: parte dai fallimenti MISURATI del collaudo del ' +
      '2026-08-07 su questo stesso file — il gate «Prossimi appuntamenti» che scade sempre ' +
      '(nodo [0,0][0,0]), le asserzioni dell\'elenco eseguite prima di scrollarci sopra, e le ' +
      'due prove negative vacue (17/17 COMPLETED di /tmp/kv-and-vacuita.yaml SENZA che fosse ' +
      'successo niente). Le correzioni sono ancorate a nodi con bounds misurati quel giorno. ' +
      'PERCHÉ NON È STATO ESEGUITO, e sono due ragioni indipendenti, entrambe d\'ambiente: ' +
      '(1) il server di collaudo :3100 era APPESO — processo `next-server` al 100% di CPU per ' +
      '34 minuti dentro un ciclo di eccezioni non catturate (`sample`: uv__run_check → ' +
      'CheckImmediate → TriggerUncaughtException in loop), 30 connessioni ESTABLISHED e mai ' +
      'una risposta, `curl -m 20 /api/health` → HTTP 000; fermare quel processo non è ' +
      'nel perimetro dell\'esecutore. (2) `KV_TEST_PASSWORD` non è nell\'ambiente e non sta in ' +
      'nessun file del repo (docs/env.md: sta nel gestore di credenziali del titolare), quindi ' +
      '`esegui.sh` esce prima di toccare il device. Nessuna delle due si aggira scrivendo un ' +
      'numero in questo registro. ' +
      'Per farlo scendere di qui: riavviare :3100 (`npx next start -p 3100`, `curl -s ' +
      'localhost:3100/api/health` deve rispondere), poi `export KV_TEST_PASSWORD=…; ' +
      '.claude/maestro-flows/esegui.sh android-percorso-genitore.yaml` con l\'emulatore ' +
      'KV-play-phone acceso. ' +
      '─── Storia precedente, che resta vera e utile ─── ' +
      'RISCRITTO il 2026-08-07 e NON rieseguito: la firma era aa404640c8ce (27 COMPLETED, 0 ' +
      'FAILED, due esecuzioni su due su KV-play-phone · Android 16 API 36 · WebView ' +
      '150.0.7871.181 · APK su http://10.0.2.2:3100, il 2026-08-02). Quella misura non vale ' +
      'più: la tappa «Comunicazioni» è stata rifatta (il tap ora porta la guardia ' +
      'width/height, l\'arrivo si prova su un testo della sola pagina di destinazione e la ' +
      'partenza su un testo della sola home) e sono nate le tappe 4-5, che INVIANO e ' +
      'ANNULLANO una comunicazione d\'assenza. Perché non è stato rieseguito: il server di ' +
      'collaudo :3100 non parla col database (SUPABASE_SERVICE_ROLE_KEY non registrata sul ' +
      'progetto, «Unregistered API key», /api/health 503) e NESSUN account supera il login — ' +
      'guasto d\'ambiente, non del flow. Per farlo scendere di qui: sistemare la chiave, ' +
      'riavviare il server (`curl -s localhost:3100/api/health` deve dire "ok"), poi ' +
      '`export KV_TEST_PASSWORD=…; .claude/maestro-flows/esegui.sh ' +
      'android-percorso-genitore.yaml`. ' +
      'Vale la pena tenere anche la lezione del 2026-08-02, che sta in agguato a ogni ' +
      'riesecuzione: quel giorno il flow era rosso sulla LOGIN perché :3100 girava da ore su ' +
      'una build sostituita e serviva HTML con chunk non più su disco → niente CSS → React ' +
      'non idrata → i campi restano vuoti e «Accedi» risulta COMPLETED senza inviare niente. ' +
      'Un `next build` NON lo ripara: serve il RIAVVIO del server.',
  },
  {
    flow: 'ios-percorso-genitore.yaml',
    motivo:
      // ─── 2026-08-08 · SECONDA RISCRITTURA, SECONDA VOLTA SENZA ESECUZIONE ───
      'RISCRITTO UNA SECONDA VOLTA il 2026-08-08 e di nuovo NON eseguito, per le stesse due ' +
      'ragioni d\'ambiente del gemello Android (server :3100 appeso al 100% di CPU in un ciclo ' +
      'di eccezioni non catturate, HTTP 000 per 34 minuti; `KV_TEST_PASSWORD` fuori ' +
      'dall\'ambiente e fuori dal repo). Le correzioni partono dai fallimenti MISURATI del ' +
      '2026-08-07 su questo file: l\'`assertNotVisible ".*Tutte le sezioni.*"` che combaciava ' +
      'con l\'aria-label del quinto tab e non poteva essere vera su nessuna pagina (17.033 ms, ' +
      'l\'intera finestra di ritentativo); il gate «Prossimi appuntamenti» passato 1 volta su ' +
      '3 perché su iOS l\'albero espone SOLO il viewport; la conferma cercata con ' +
      '«.*Assenza comunicata.*», soddisfatta dall\'aria-label del bottone ANNULLA (COMPLETED a ' +
      '174 ms, con lo schermo ancora su «INVIO…»); le asserzioni dell\'elenco a scroll zero, ' +
      'dove quei nodi non esistono. Il simulatore iPhone 17 Pro (B9FA2E7A-…) era acceso e ' +
      'raggiungibile: ciò che mancava era l\'app servita, non il device. ' +
      'Per farlo scendere di qui: riavviare :3100, poi `export KV_TEST_PASSWORD=…; ' +
      'KV_DEVICE=<udid> .claude/maestro-flows/esegui.sh ios-percorso-genitore.yaml`. ' +
      '─── Storia precedente, che resta vera e utile ─── ' +
      'RISCRITTO il 2026-08-07 e NON rieseguito: la firma era cfd3e836a2f5 (27 COMPLETED, 0 ' +
      'FAILED, due esecuzioni su due su iPhone 17 Pro · iOS 26.2 · CAP_SERVER_URL=' +
      'http://localhost:3100, il 2026-08-02; già verde il 2026-08-01 con tre esecuzioni). ' +
      'Stessa riscrittura del gemello Android — arrivo e partenza provati su testi univoci, ' +
      'più le tappe che inviano e annullano la comunicazione d\'assenza — con una differenza ' +
      'dichiarata: su iOS il tap sul tab resta per solo testo, perché i bounds dei nodi fuori ' +
      'schermo non sono mai stati misurati e una guardia width/height inventata sarebbe una ' +
      'difesa finta. Non rieseguito per lo stesso guasto d\'ambiente (:3100 senza database, ' +
      'login impossibile). Per farlo scendere di qui: `export KV_TEST_PASSWORD=…; ' +
      'KV_DEVICE=<udid> .claude/maestro-flows/esegui.sh ios-percorso-genitore.yaml`.',
  },
];

// 2026-08-02: sceso da 4 a 1. I tre flow iOS erano qui dentro perché i selettori erano
// stati corretti il 01/08 e nessuno li aveva più lanciati — il gate era verde proprio
// perché la prova MANCAVA, ed era dichiarata. Ora la prova c'è.
//
// 2026-08-07: RISALITO da 1 a 3, ed è la prima volta che questo numero sale. Va detto
// per esteso, perché il commento qui sopra dice che il tetto «può solo scendere» e
// alzarlo è esattamente la mossa che il registro esiste per rendere difficile.
// Cosa è successo: i due percorsi genitore sono stati riscritti per chiudere il difetto
// «il flow dichiara COMPLETED una tappa che non ha aperto» e per collaudare davvero
// «Comunica un'assenza». Riscritti, NON rieseguiti — e non per pigrizia: il server di
// collaudo :3100 non ha accesso al database (chiave Supabase non registrata,
// /api/health 503) e nessun account supera il login, quindi nessun flow che faccia
// login può arrivare in fondo. Le alternative erano due, e nessuna delle due è questa:
//   · lasciare le righe in ESECUZIONI_VERDI aggiornando le firme a mano — cioè
//     dichiarare provato ciò che non lo è, che è LETTERALMENTE il difetto che questo
//     registro è nato per impedire;
//   · non toccare i flow, e tenersi un collaudo che mente.
// Il tetto torna a 1 quando i due percorsi girano verdi su device: comandi esatti nel
// `motivo` di ciascuno. Chi li riesegue tolga la sua riga e rimetta questo numero.
const TETTO_FLOW_SENZA_ESECUZIONE_VERDE = 3;

function leggiFlow(nome: string): string {
  return fs.readFileSync(path.join(DIR_FLOWS, nome), 'utf8');
}

function leggiCatalogo(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), file), 'utf8'));
}

/**
 * Prosa normalizzata: una riga sola, senza i segni che spezzano una frase a metà
 * (`#` dei commenti YAML, backtick e pipe del Markdown, a capo). Senza questo, una
 * teoria falsa sfugge alla ricerca **solo perché è andata a capo** — che è
 * esattamente il modo in cui è sopravvissuta finora.
 */
function normalizzaProsa(testo: string): string {
  return testo
    .replace(/[#`*>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Solo le PARTI COMMENTATE di un flow (righe `#` e code di riga), più il README
 * per intero: è lì che vivono le teorie, ed è lì che una teoria falsa fa danno.
 */
function commentiDi(testo: string): string {
  return normalizzaProsa(
    testo
      .split('\n')
      .map((r) => {
        const i = r.search(/(^|\s)#/);
        return i < 0 ? '' : r.slice(i);
      })
      .join('\n'),
  );
}

function tuttiIFlow(): string[] {
  return fs
    .readdirSync(DIR_FLOWS)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
}

/**
 * Corpo del flow (dopo il separatore `---`), senza commenti.
 * Il `#` si toglie solo se non è dentro una stringa fra virgolette — altrimenti
 * un selettore che contenesse `#` verrebbe mutilato in silenzio.
 */
function corpoSenzaCommenti(testo: string): string[] {
  const righe = testo.split('\n');
  const sep = righe.findIndex((r) => r.trim() === '---');
  if (sep < 0) return [];
  return righe
    .slice(sep + 1)
    .map((r) => {
      const i = r.search(/\s#/);
      if (i < 0) return r;
      const prima = r.slice(0, i);
      const virgolette = (prima.match(/"/g) ?? []).length;
      return virgolette % 2 === 0 ? prima.trimEnd() : r;
    })
    .filter((r) => !/^\s*#/.test(r))
    .filter((r) => r.trim() !== '');
}

function senzaVirgolette(v: string): string {
  const t = v.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Selettori di TUTTI i `tapOn` del flow, anche quelli annidati dentro `runFlow`.
 * Restituisce il testo del selettore (forma inline `- tapOn: "X"` oppure campo
 * `text:` del blocco) o `@point` quando il tap è a coordinate.
 */
function selettoriDeiTap(testo: string): string[] {
  const righe = corpoSenzaCommenti(testo);
  const fuori: string[] = [];
  for (let i = 0; i < righe.length; i++) {
    const m = righe[i].match(/^(\s*)-\s+tapOn:\s*(.*)$/);
    if (!m) continue;
    const indentDash = m[1].length;
    const inline = m[2].trim();
    if (inline !== '') {
      fuori.push(senzaVirgolette(inline));
      continue;
    }
    // blocco: righe più indentate del trattino
    for (let j = i + 1; j < righe.length; j++) {
      const ind = righe[j].search(/\S/);
      if (ind <= indentDash) break;
      const t = righe[j].match(/^\s*text:\s*(.+)$/);
      if (t) fuori.push(senzaVirgolette(t[1]));
      if (/^\s*point:\s*/.test(righe[j])) fuori.push('@point');
    }
  }
  return fuori;
}

/** Comandi che prendono un SELETTORE come argomento inline. */
const COMANDI_CON_SELETTORE = [
  'tapOn',
  'longPressOn',
  'doubleTapOn',
  'assertVisible',
  'assertNotVisible',
  'scrollUntilVisible',
];

/** Campi che, dentro un blocco, contengono un TESTO da cercare nell'albero. */
const CAMPI_SELETTORE = [
  'text',
  'visible',
  'notVisible',
  'element',
  'below',
  'above',
  'leftOf',
  'rightOf',
];

/**
 * TUTTI i testi che il flow cerca nell'albero di accessibilità, non solo quelli
 * dei `tapOn`: i tre fallimenti su «MENU» erano due `assertVisible` e un `tapOn`.
 * Un lock che guardasse i soli tap ne avrebbe lasciati passare due su tre.
 */
function tuttiISelettori(testo: string): string[] {
  const fuori: string[] = [];
  for (const riga of corpoSenzaCommenti(testo)) {
    const inline = riga.match(/^\s*-\s+([A-Za-z]+):\s*(.+)$/);
    if (inline && COMANDI_CON_SELETTORE.includes(inline[1])) {
      fuori.push(senzaVirgolette(inline[2]));
      continue;
    }
    const campo = riga.match(/^\s*-?\s*([A-Za-z]+):\s*(.+)$/);
    if (campo && CAMPI_SELETTORE.includes(campo[1])) {
      const v = senzaVirgolette(campo[2]);
      if (v !== '') fuori.push(v);
    }
  }
  return fuori;
}

/**
 * Comandi in ordine: `[{ nome, corpo }]`.
 *
 * Con `annidati: true` entra anche nei `runFlow: commands:` e restituisce la
 * sequenza APPIATTITA. Serve, e non è un dettaglio: spostare un `tapOn` dentro un
 * ramo condizionale è il modo più naturale per sfuggire a una regola che guarda
 * solo il primo livello — e il flow del docente ha esattamente quella forma.
 */
function passi(testo: string, opzioni: { annidati?: boolean } = {}): { nome: string; corpo: string }[] {
  const righe = corpoSenzaCommenti(testo);
  const indentBase = Math.min(
    ...righe.filter((r) => /^\s*-\s+/.test(r)).map((r) => r.search(/\S/)),
  );
  const fuori: { nome: string; corpo: string }[] = [];
  for (const r of righe) {
    const ind = r.search(/\S/);
    // `- back` e `- hideKeyboard` non hanno argomenti: niente due punti obbligatori.
    const m = r.match(/^\s*-\s+([A-Za-z]+)/);
    const eComando = m && (ind === indentBase || (opzioni.annidati === true && ind > indentBase));
    if (eComando) {
      fuori.push({ nome: m[1], corpo: r });
    } else if (fuori.length > 0) {
      fuori[fuori.length - 1].corpo += `\n${r}`;
    }
  }
  return fuori;
}

describe('lock: selettori dei flow Maestro (nodi duplicati)', () => {
  it('ogni flow ha il separatore --- e almeno un comando', () => {
    const flows = tuttiIFlow();
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) {
      const p = passi(leggiFlow(f));
      expect(p.length, `${f}: nessun comando dopo il separatore ---`).toBeGreaterThan(0);
    }
  });

  it('R1 · i flow del cockpit non toccano «Mensa»/«Anagrafica» per solo testo', () => {
    const colpevoli: string[] = [];
    for (const f of FLOWS_COCKPIT) {
      for (const s of selettoriDeiTap(leggiFlow(f))) {
        if (ETICHETTE_AMBIGUE_COCKPIT.includes(s)) colpevoli.push(`${f} → tapOn "${s}"`);
      }
    }
    expect(
      colpevoli,
      'Etichetta ambigua sul cockpit: esiste sia nella bottom-nav sia nella griglia ' +
        '«Tutti i moduli». Maestro prende la prima corrispondenza (la tile fuori ' +
        'viewport, altezza 0) e tocca un\'area morta. Vedi .claude/maestro-flows/README.md.',
    ).toEqual([]);
  });

  it('R2 · il tab Mensa e la voce Anagrafica sono raggiunti con selettori disambiguati', () => {
    // Controllo POSITIVO: senza, R1 tornerebbe verde anche cancellando i passi.
    for (const f of FLOWS_COCKPIT) {
      const sel = selettoriDeiTap(leggiFlow(f));
      expect(sel, `${f}: manca il tap a coordinate sul tab «Mensa» della bottom-nav`).toContain(
        '@point',
      );
      expect(
        sel.some((s) => s.includes('Alunni, famiglie e personale')),
        `${f}: la voce «Anagrafica» del bottom-sheet va toccata sul sottotitolo univoco ` +
          '«Alunni, famiglie e personale» (messages/it/adminNav.json → anagraficaSub)',
      ).toBe(true);
    }
  });

  it('R3 · nessun tap a coordinate senza prova di essere atterrato e di essersi mosso', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      const p = passi(leggiFlow(f), { annidati: true });
      p.forEach((passo, i) => {
        if (passo.nome !== 'tapOn' || !/point:/.test(passo.corpo)) return;
        const seguito = p.slice(i + 1, i + 7).map((x) => x.nome);
        if (!seguito.includes('extendedWaitUntil')) {
          colpevoli.push(`${f} · tap #${i}: manca l'asserzione POSITIVA sulla destinazione`);
        }
        if (!seguito.includes('assertNotVisible')) {
          colpevoli.push(`${f} · tap #${i}: manca l'asserzione NEGATIVA (aver lasciato la pagina)`);
        }
      });
    }
    expect(
      colpevoli,
      'Un tap a coordinate è cieco: se il layout si sposta, il tap cade nel vuoto. Senza ' +
        'un controllo positivo (sono arrivato) E uno negativo (non sono più dov\'ero) il ' +
        'flow può dichiarare PASS senza essersi mosso.',
    ).toEqual([]);
  });
});

describe('lock: selettori dei flow Maestro (selettori morti e CTA sotto la piega)', () => {
  const MORTI = SELETTORI_MISURATI.filter((s) => s.esito === 'morto');
  const VIVI = SELETTORI_MISURATI.filter((s) => s.esito === 'vivo');

  it('R4 · nessun flow dipende da un selettore MISURATO come assente', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      for (const sel of tuttiISelettori(leggiFlow(f))) {
        const morto = MORTI.find(
          (m) => m.selettore.toLowerCase() === sel.trim().toLowerCase(),
        );
        if (morto) {
          colpevoli.push(
            `${f} → "${sel}" (misurato assente il ${morto.misurato} su ${morto.dove}) ` +
              `· usa "${morto.sostituto}"`,
          );
        }
      }
    }
    expect(
      colpevoli,
      'Selettore morto: un testo che l\'albero di accessibilità NON contiene. Il flow ' +
        'fallisce al primo passo e il collaudo accusa l\'app di un difetto che non ha. ' +
        'Il match di Maestro è case-insensitive: «MENU» e «Menu» sono lo stesso selettore.',
    ).toEqual([]);
  });

  it('R5 · ogni selettore vivo esiste ancora, con quel valore, nel catalogo che lo genera', () => {
    // È la regola che segue l'app: se qualcuno rinomina l'etichetta in messages/,
    // il flow che la cerca diventa un test che mente — e questo lock lo dice subito.
    const colpevoli: string[] = [];
    for (const s of VIVI) {
      if (!s.sorgente) continue;
      const p = path.join(process.cwd(), s.sorgente.file);
      if (!fs.existsSync(p)) {
        colpevoli.push(`${s.sorgente.file}: catalogo sparito (chiave ${s.sorgente.chiave})`);
        continue;
      }
      const catalogo = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      const valore = catalogo[s.sorgente.chiave];
      if (valore !== s.selettore) {
        colpevoli.push(
          `${s.sorgente.file} → ${s.sorgente.chiave} = ${JSON.stringify(valore)}, ` +
            `i flow cercano ${JSON.stringify(s.selettore)}`,
        );
      }
    }
    expect(
      colpevoli,
      'Il selettore di un flow si è scollato dal testo che l\'app produce. O si aggiorna ' +
        'il flow nello stesso lavoro, o il collaudo mobile mente al prossimo giro.',
    ).toEqual([]);
  });

  it('R6 · i flow che aprono il foglio «Menu» usano davvero il selettore vivo', () => {
    // Controllo POSITIVO: senza, R4 tornerebbe verde cancellando i passi.
    const FLOWS_CON_FOGLIO_MENU = [
      'android-percorso-genitore.yaml',
      'android-percorso-docente.yaml',
      'android-biometria-loop.yaml',
      'android-percorso-segreteria.yaml',
      'ios-percorso-genitore.yaml',
      'ios-percorso-docente.yaml',
      'ios-percorso-segreteria.yaml',
    ];
    for (const f of FLOWS_CON_FOGLIO_MENU) {
      // `some(includes)` e non `toContain`: dal 2026-08-02 alcuni flow Android usano
      // un'ALTERNATIVA — «Menu · tutte le sezioni|^MENU$» — perché la WebView si è
      // aggiornata da sé (109 → 150) e sul motore nuovo il nome accessibile del quinto
      // tab non è più solo l'aria-label. L'alternativa regge entrambi i motori.
      //
      // La regola NON si ammorbidisce: il selettore vivo deve comunque comparire nel
      // pattern. Quello che cade è l'uguaglianza esatta, che pretendeva che il flow non
      // potesse difendersi da un cambio di runtime — e un lock che vieta di difendersi
      // è un lock che qualcuno spegne.
      expect(
        tuttiISelettori(leggiFlow(f)).some((s) => s.includes('Menu · tutte le sezioni')),
        `${f}: nessun riferimento al tab «Menu» della bottom-nav. Il selettore vivo è ` +
          'l\'aria-label «Menu · tutte le sezioni» (messages/it/nav.json → ariaMenu); ' +
          'può stare dentro un\'alternativa, non può mancare.',
      ).toBe(true);
    }
  });

  it('R7 · le CTA misurate sotto la piega si portano nel viewport prima del tap', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow().filter((x) => x.startsWith('android-'))) {
      const p = passi(leggiFlow(f), { annidati: true });
      for (const cta of CTA_SOTTO_LA_PIEGA) {
        p.forEach((passo, i) => {
          if (passo.nome !== 'tapOn' || !passo.corpo.includes(cta.selettore)) return;
          const prima = p.slice(Math.max(0, i - 3), i);
          const scroll = prima.find(
            (x) => x.nome === 'scrollUntilVisible' && x.corpo.includes(cta.selettore),
          );
          if (!scroll) {
            colpevoli.push(
              `${f} · tapOn "${cta.selettore}": manca lo scrollUntilVisible prima ` +
                `(misurato ${cta.misurato}: ${cta.bounds})`,
            );
          } else if (cta.causa === 'coperto' && !/centerElement:\s*true/.test(scroll.corpo)) {
            colpevoli.push(
              `${f} · scrollUntilVisible "${cta.selettore}": manca centerElement: true. ` +
                'Portare il nodo «dentro il viewport» non basta: lì sotto c\'è la bottom-nav ' +
                `flottante e il tap va a lei (${cta.bounds}).`,
            );
          }
          const dopo = p.slice(i + 1, i + 5);
          if (
            !dopo.some(
              (x) => x.nome === 'assertNotVisible' && x.corpo.includes(cta.provaDiPartenza),
            )
          ) {
            colpevoli.push(
              `${f} · tapOn "${cta.selettore}": manca l'asserzione NEGATIVA dopo il tap su ` +
                `"${cta.provaDiPartenza}" (un testo che esiste SOLO nella pagina di partenza)`,
            );
          }
        });
      }
    }
    expect(
      colpevoli,
      '`extendedWaitUntil: visible` NON prova che il nodo sia toccabile: passa anche per un ' +
        'nodo alto 0 px fuori viewport. Il tap risulta COMPLETED e non naviga.',
    ).toEqual([]);
  });
});

describe('lock: selettori dei flow Maestro (il testo che l\'aria-label sostituisce)', () => {
  it('R8a · il registro dei testi coperti da aria-label è ancora vero nel codice', () => {
    // Controllo di SCADENZA: senza, R8b resterebbe verde anche dopo che qualcuno
    // ha tolto l'aria-label — cioè proprio quando la regola smette di valere.
    const scaduti: string[] = [];
    for (const v of TESTI_COPERTI_DA_ARIA_LABEL) {
      const sorgente = fs.readFileSync(path.join(process.cwd(), v.componente), 'utf8');
      const atteso = new RegExp(`aria-label=\\{t\\('${v.chiaveAria}'\\)\\}`);
      if (!atteso.test(sorgente)) {
        scaduti.push(
          `${v.componente}: non contiene più aria-label={t('${v.chiaveAria}')} → il nome ` +
            `accessibile torna a essere il contenuto e «${v.chiaveTesto}» potrebbe essere ` +
            'di nuovo un selettore valido. RIMISURARE sull\'albero prima di fidarsi.',
        );
        continue;
      }
      const catalogo = leggiCatalogo(v.catalogo);
      if (typeof catalogo[v.chiaveTesto] !== 'string') {
        scaduti.push(`${v.catalogo}: la chiave ${v.chiaveTesto} non esiste più`);
      }
      if (typeof catalogo[v.chiaveAria] !== 'string') {
        scaduti.push(`${v.catalogo}: la chiave ${v.chiaveAria} non esiste più`);
      }
      if (!sorgente.includes(`t('${v.chiaveTesto}')`)) {
        scaduti.push(
          `${v.componente}: non rende più t('${v.chiaveTesto}') dentro il bottone del Menu`,
        );
      }
    }
    expect(scaduti, 'Registro R8 scaduto: la regola non descrive più il codice.').toEqual([]);
  });

  it('R8b · nessun flow cerca un testo che l\'aria-label sostituisce', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      for (const sel of tuttiISelettori(leggiFlow(f))) {
        for (const v of TESTI_COPERTI_DA_ARIA_LABEL) {
          const testo = String(leggiCatalogo(v.catalogo)[v.chiaveTesto]);
          // Il match di Maestro è case-insensitive: «MENU» e «Menu» sono lo stesso selettore.
          if (sel.trim().toLowerCase() !== testo.toLowerCase()) continue;
          colpevoli.push(
            `${f} → "${sel}" = ${v.catalogo}:${v.chiaveTesto} (${v.dove}), ma quel nodo ha ` +
              `aria-label ${v.catalogo}:${v.chiaveAria} → usa "${leggiCatalogo(v.catalogo)[v.chiaveAria]}"`,
          );
        }
      }
    }
    expect(
      colpevoli,
      'ARIA, non la WebView: un aria-label SOSTITUISCE il contenuto dell\'elemento ' +
        '(accname, passo 2C). Il testo dello <span> dentro un <button aria-label> non è ' +
        'MAI nel nome accessibile, quindi non è un selettore: il flow fallirebbe al primo ' +
        'passo e il collaudo accuserebbe l\'app di un difetto che non ha.',
    ).toEqual([]);
  });
});

/** I flow che guidano il simulatore iOS. */
function flowIOS(): string[] {
  return tuttiIFlow().filter((f) => f.startsWith('ios-'));
}

describe('lock: flow Maestro (ancore che dipendono dall\'ora e dai dati)', () => {
  it('R11a · il registro dei saluti orari descrive ancora il codice', () => {
    // Controllo di SCADENZA, sullo stampo di R8a: se `greetingByHour()` cambia forma,
    // R11b non deve restare verde per il semplice fatto di non trovare più niente.
    const saluti = salutiOrari();
    expect(
      saluti.length,
      `${SORGENTE_SALUTI}: non espone più i saluti come stringhe di return. Il registro R11 ` +
        'non descrive più il codice: rileggerlo prima di fidarsi di R11b.',
    ).toBeGreaterThanOrEqual(3);
    for (const s of saluti) {
      expect(s.length, `${SORGENTE_SALUTI}: saluto vuoto nel registro`).toBeGreaterThan(3);
    }
  });

  it('R11b · nessun flow si àncora a un saluto, che dipende dall\'ora', () => {
    const saluti = salutiOrari().map(normalizzaSelettore);
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      for (const sel of tuttiISelettori(leggiFlow(f))) {
        if (saluti.includes(normalizzaSelettore(sel))) {
          colpevoli.push(
            `${f} → "${sel}": è il saluto di ${SORGENTE_SALUTI}, vero solo in una fascia ` +
              'oraria. Àncorati a un testo che non cambia (la tab della bottom-nav, il ' +
              'titolo della sezione).',
          );
        }
      }
    }
    expect(
      colpevoli,
      'Un flow ancorato al saluto non collauda l\'app, collauda l\'orologio: alle 22:07 la ' +
        'dashboard dice «Buonasera!» e il collaudo scrive FAIL su un\'app che funziona ' +
        '(mobile-ios, 2026-07-31).',
    ).toEqual([]);
  });

  it('R12a · il registro delle etichette stato-dipendenti è ancora vero', () => {
    const scaduti: string[] = [];
    for (const e of ETICHETTE_STATO_DIPENDENTE) {
      const catalogo = leggiCatalogo(e.catalogo);
      const sorgente = fs.readFileSync(path.join(process.cwd(), e.componente), 'utf8');
      for (const k of e.chiavi) {
        if (typeof catalogo[k] !== 'string') {
          scaduti.push(`${e.catalogo}: la chiave ${k} non esiste più`);
          continue;
        }
        if (!sorgente.includes(`'${k}'`)) {
          scaduti.push(
            `${e.componente}: non rende più t('${k}') → le varianti dell'etichetta sono ` +
              'cambiate, RIMISURARE prima di fidarsi di R12b.',
          );
        }
      }
    }
    expect(scaduti, 'Registro R12 scaduto: la regola non descrive più il codice.').toEqual([]);
  });

  it('R12b · chi cerca una variante di un\'etichetta stato-dipendente le cerca tutte', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      for (const sel of tuttiISelettori(leggiFlow(f))) {
        for (const e of ETICHETTE_STATO_DIPENDENTE) {
          const varianti = e.chiavi.map((k) => String(leggiCatalogo(e.catalogo)[k]));
          if (!varianti.some((v) => sel.includes(v))) continue;
          const mancanti = varianti.filter((v) => !sel.includes(v));
          if (mancanti.length > 0) {
            colpevoli.push(
              `${f} → "${sel}" (${e.dove}): conosce una sola faccia del bottone. Mancano ` +
                `${mancanti.map((v) => `"${v}"`).join(', ')} — usa il selettore alternato ` +
                `"${varianti.join('|')}".`,
            );
          }
        }
      }
    }
    expect(
      colpevoli,
      'L\'etichetta cambia con lo stato dei dati: quale delle due si vede dipende da cosa ha ' +
        'fatto la maestra quella mattina. Un flow che ne conosce una sola è rosso a giorni ' +
        'alterni, e la colpa cade sull\'app (mobile-ios, 2026-07-31).',
    ).toEqual([]);
  });

  it('R13a · il registro delle CTA condizionate dai dati è ancora vero', () => {
    const scaduti: string[] = [];
    for (const c of CTA_CONDIZIONATE_DAI_DATI) {
      const sorgente = fs.readFileSync(path.join(process.cwd(), c.componente), 'utf8');
      if (!sorgente.includes(c.condizione)) {
        scaduti.push(
          `${c.componente}: non contiene più la condizione \`${c.condizione}\` → la CTA ` +
            `«${c.selettore}» potrebbe essere diventata sempre presente. RIMISURARE.`,
        );
      }
    }
    expect(scaduti, 'Registro R13 scaduto: la regola non descrive più il codice.').toEqual([]);
  });

  it('R13b · le CTA che esistono solo con certi dati si cercano dentro un ramo condizionale', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      // Livello BASE soltanto: quello che sta dentro un `runFlow` è già condizionato.
      for (const passo of passi(leggiFlow(f))) {
        for (const c of CTA_CONDIZIONATE_DAI_DATI) {
          if (!passo.corpo.includes(c.selettore)) continue;
          if (passo.nome === 'runFlow' && /when:/.test(passo.corpo)) continue;
          if (/optional:\s*true/.test(passo.corpo)) continue;
          colpevoli.push(
            `${f} · ${passo.nome} "${c.selettore}": la CTA è resa solo se ` +
              `\`${c.condizione}\` (${c.componente}). Va dentro un \`runFlow when:\`, con ` +
              `una seconda strada verso «${c.destinazione}».`,
          );
        }
      }
    }
    expect(
      colpevoli,
      'Misurato il 2026-08-01: la CTA c\'era alle 00:27 e non c\'era alle 00:45, stessa app e ' +
        'stesso account. Un flow che la dà per scontata fallisce con «No visible element ' +
        'found» e sembra una regressione.',
    ).toEqual([]);
  });

  it('R13c · esiste davvero la strada alternativa verso la destinazione', () => {
    // Controllo POSITIVO: senza, R13b si chiuderebbe cancellando il passo — e il flow
    // smetterebbe di collaudare la bacheca invece di collaudarla in entrambi gli stati.
    for (const f of ['android-percorso-docente.yaml', 'ios-percorso-docente.yaml']) {
      const testo = leggiFlow(f);
      for (const c of CTA_CONDIZIONATE_DAI_DATI) {
        if (!testo.includes(c.selettore)) continue;
        const rami = passi(testo).filter((p) => p.nome === 'runFlow');
        expect(
          rami.some((p) => p.corpo.includes(`notVisible: "${c.destinazione}"`)),
          `${f}: manca il ramo alternativo. Quando «${c.selettore}» non c'è, il flow deve ` +
            `arrivare a «${c.destinazione}» per un'altra strada (il foglio «Menu»), non ` +
            'saltare il passo.',
        ).toBe(true);
        expect(
          tuttiISelettori(testo),
          `${f}: il flow non asserisce più di essere arrivato a «${c.destinazione}»`,
        ).toContain(c.destinazione);
      }
    }
  });
});

describe('lock: flow Maestro iOS (dialog dei permessi e submit del login)', () => {
  it('R14a · su iOS il ramo del dialog permessi ha un\'attesa esplicita davanti', () => {
    const colpevoli: string[] = [];
    for (const f of flowIOS()) {
      const p = passi(leggiFlow(f));
      p.forEach((passo, i) => {
        if (passo.nome !== 'runFlow' || !passo.corpo.includes(TESTO_DIALOG_PERMESSI)) return;
        const prima = p.slice(Math.max(0, i - 2), i);
        const attesa = prima.find(
          (x) =>
            x.nome === 'extendedWaitUntil' &&
            x.corpo.includes(TESTO_DIALOG_PERMESSI) &&
            /optional:\s*true/.test(x.corpo),
        );
        if (!attesa) {
          colpevoli.push(
            `${f} · runFlow "${TESTO_DIALOG_PERMESSI}" #${i}: manca ` +
              '`extendedWaitUntil: visible: "Non consentire"` con `optional: true` davanti.',
          );
        }
      });
    }
    expect(
      colpevoli,
      '`runFlow when:` guarda la condizione UNA VOLTA, subito: non aspetta. Su iOS il dialog ' +
        'nativo arriva dopo, il ramo risulta SKIPPED e poi il dialog copre la UI e fa fallire ' +
        'l\'asserzione seguente (mobile-ios, 2026-07-31).',
    ).toEqual([]);
  });

  it('R14b · ogni flow iOS gestisce il dialog PRIMA e DOPO il login', () => {
    // Il permesso rimasto in coda ricompare al LANCIO SUCCESSIVO, cioè prima del login
    // del giro dopo: un flow che lo gestisce solo dopo funziona una volta su due.
    for (const f of flowIOS()) {
      const p = passi(leggiFlow(f));
      const rami = p
        .map((passo, i) => ({ passo, i }))
        .filter((x) => x.passo.nome === 'runFlow' && x.passo.corpo.includes(TESTO_DIALOG_PERMESSI));
      expect(
        rami.length,
        `${f}: ${rami.length} gestione/i del dialog permessi. Ne servono due: una prima del ` +
          'login (il permesso in coda dal giro precedente) e una dopo (quello di questo giro).',
      ).toBeGreaterThanOrEqual(2);
      const submit = p.findIndex((x) => x.nome === 'pressKey');
      expect(submit, `${f}: nessun \`pressKey\` che invii il login`).toBeGreaterThan(-1);
      expect(
        rami.some((x) => x.i < submit),
        `${f}: nessuna gestione del dialog PRIMA del submit del login`,
      ).toBe(true);
      expect(
        rami.some((x) => x.i > submit),
        `${f}: nessuna gestione del dialog DOPO il submit del login`,
      ).toBe(true);
    }
  });

  it('R15a · nessun flow iOS invia il login toccando «Accedi»', () => {
    const colpevoli: string[] = [];
    for (const f of flowIOS()) {
      for (const sel of selettoriDeiTap(leggiFlow(f))) {
        if (sel.trim().toLowerCase() === SUBMIT_LOGIN_VIETATO_IOS.toLowerCase()) {
          colpevoli.push(`${f} → tapOn "${sel}"`);
        }
      }
    }
    expect(
      colpevoli,
      'Misurato su iPhone 17 Pro Max / iOS 26.2: con la tastiera aperta il tap risulta ' +
        'COMPLETED e il form NON parte; `hideKeyboard` fallisce sulla WebView iOS. Il flow ' +
        'non muore lì, muore tre passi dopo sull\'asserzione della dashboard — ed è così che ' +
        'tre collaudi di fila hanno accusato l\'app. Usa `pressKey: Enter`.',
    ).toEqual([]);
  });

  it('R15b · ogni flow iOS invia il login con pressKey: Enter', () => {
    // Controllo POSITIVO: senza, R15a resterebbe verde anche in un flow che non fa più login.
    for (const f of flowIOS()) {
      const p = passi(leggiFlow(f));
      expect(
        p.some((x) => x.nome === 'pressKey' && /Enter/.test(x.corpo)),
        `${f}: nessun \`pressKey: Enter\`. È l'unico invio del login misurato affidabile ` +
          'sulla WebView iOS.',
      ).toBe(true);
      expect(
        tuttiISelettori(leggiFlow(f)),
        `${f}: il flow non compila più il campo Password`,
      ).toContain('Password');
    }
  });
});

/**
 * Impronta stabile dell'insieme dei selettori di un flow: ordinati, deduplicati,
 * indipendenti dall'ordine dei passi e dai commenti.
 */
function firmaSelettori(nome: string): string {
  const unici = [...new Set(tuttiISelettori(leggiFlow(nome)))].sort();
  return crypto.createHash('sha256').update(JSON.stringify(unici)).digest('hex').slice(0, 12);
}

describe('lock: flow Maestro (esecuzione misurata su dispositivo)', () => {
  it('R9a · ogni flow o ha un\'esecuzione verde dichiarata, o è debito dichiarato', () => {
    const verdi = new Set(ESECUZIONI_VERDI.map((e) => e.flow));
    const debito = new Set(FLOW_SENZA_ESECUZIONE_VERDE.map((e) => e.flow));
    const problemi: string[] = [];
    for (const f of tuttiIFlow()) {
      if (verdi.has(f) && debito.has(f)) {
        problemi.push(`${f}: dichiarato sia verde sia in debito — decidi`);
      } else if (!verdi.has(f) && !debito.has(f)) {
        problemi.push(
          `${f}: nessuna esecuzione dichiarata. Lancialo su un device e aggiungilo a ` +
            `ESECUZIONI_VERDI (firma attuale: ${firmaSelettori(f)}), oppure mettilo in ` +
            'FLOW_SENZA_ESECUZIONE_VERDE con il motivo vero.',
        );
      }
    }
    for (const f of [...verdi, ...debito]) {
      if (!tuttiIFlow().includes(f)) problemi.push(`${f}: dichiarato ma il file non esiste più`);
    }
    expect(problemi, 'Un flow mai eseguito è una teoria, non un collaudo.').toEqual([]);
  });

  it('R9b · un flow modificato dopo l\'ultima esecuzione verde non conta come verde', () => {
    const scaduti: string[] = [];
    for (const e of ESECUZIONI_VERDI) {
      if (!tuttiIFlow().includes(e.flow)) continue;
      const ora = firmaSelettori(e.flow);
      if (ora !== e.firma) {
        scaduti.push(
          `${e.flow}: i selettori sono cambiati dopo l'esecuzione del ${e.data} ` +
            `(${e.device}, ${e.esito}). Firma dichiarata ${e.firma}, firma attuale ${ora}. ` +
            'Rilancia il flow sul device e aggiorna la riga, oppure spostalo nel debito.',
        );
      }
    }
    expect(
      scaduti,
      'Il flow non è più quello che è stato provato: cambiare un selettore senza rieseguire ' +
        'è esattamente il modo in cui «MENU» è rimasto in un flow per mesi.',
    ).toEqual([]);
  });

  it('R9c · il debito sui flow mai eseguiti non cresce', () => {
    expect(
      FLOW_SENZA_ESECUZIONE_VERDE.length,
      `${FLOW_SENZA_ESECUZIONE_VERDE.length} flow senza esecuzione verde contro un tetto di ` +
        `${TETTO_FLOW_SENZA_ESECUZIONE_VERDE}. Il tetto scende quando si collauda, non sale ` +
        'quando fa comodo.',
    ).toBeLessThanOrEqual(TETTO_FLOW_SENZA_ESECUZIONE_VERDE);
    for (const d of FLOW_SENZA_ESECUZIONE_VERDE) {
      expect(d.motivo.length, `${d.flow}: il motivo va scritto per esteso`).toBeGreaterThan(30);
    }
  });
});

describe('lock: flow Maestro (le teorie scritte nei commenti)', () => {
  it('R10 · nessun commento ripete un\'affermazione smentita da una misura', () => {
    const colpevoli: string[] = [];
    const testi: { nome: string; testo: string }[] = [
      ...tuttiIFlow().map((f) => ({ nome: f, testo: commentiDi(leggiFlow(f)) })),
      {
        nome: 'README.md',
        testo: normalizzaProsa(fs.readFileSync(path.join(DIR_FLOWS, 'README.md'), 'utf8')),
      },
    ];
    for (const { nome, testo } of testi) {
      for (const a of AFFERMAZIONI_SMENTITE) {
        if (!a.pattern.test(testo)) continue;
        if (a.deroghe.includes(nome)) continue;
        colpevoli.push(
          `${nome} ripete «${a.id}». Misura che la smentisce: ${a.smentitaDa} — ${a.verita}`,
        );
      }
    }
    expect(
      colpevoli,
      'Un commento che spiega con sicurezza una teoria falsa costa più del codice falso: ' +
        'chi indaga lo legge, ci crede e cerca il difetto nell\'app. Correggi la frase, non ' +
        'aggiungere una deroga.',
    ).toEqual([]);
  });

  it('R10 · le deroghe storiche esistono ancora e non crescono', () => {
    // Controllo POSITIVO: senza, si potrebbe «chiudere» R10 elencando deroghe a caso.
    const morte: string[] = [];
    for (const a of AFFERMAZIONI_SMENTITE) {
      for (const f of a.deroghe) {
        const testo = commentiDi(leggiFlow(f));
        if (!a.pattern.test(testo)) {
          morte.push(`${f}: la deroga «${a.id}» non serve più — toglila dal registro`);
        }
      }
    }
    expect(morte, 'Deroga inutile: la frase non c\'è più in quel file.').toEqual([]);
    const totale = AFFERMAZIONI_SMENTITE.reduce((n, a) => n + a.deroghe.length, 0);
    expect(
      totale,
      `Debito dichiarato in crescita: ${totale} deroghe contro un tetto di ` +
        `${TETTO_DEROGHE_STORICHE}. Il tetto si abbassa quando si bonifica un file, ` +
        'non si alza per farci stare una frase nuova.',
    ).toBeLessThanOrEqual(TETTO_DEROGHE_STORICHE);
  });
});

/**
 * ─── R16 · LE ETICHETTE CHE SULLA HOME DEL GENITORE ESISTONO DUE VOLTE ─────
 *
 * Collaudo mobile-android del 2026-08-07, `android-percorso-genitore.yaml`:
 *   Tap on "Avvisi"... COMPLETED
 *   Assert that "Comunicazioni" is visible... COMPLETED
 * e lo screenshot dello step mostra la HOME, con la pillola verde su HOME.
 * Il flow ha dichiarato superata una tappa che non ha mai aperto — ed è la faccia
 * SILENZIOSA già descritta in cima a questo file, vista succedere su un flow
 * committato.
 *
 * MISURA (`maestro hierarchy`, iPhone 17 Pro / iOS 26.2, Maestro 2.6.1, home
 * genitore, foglio Menu CHIUSO, 2026-08-08 — presa per verificare R21 e valida
 * anche qui): l'unico nodo che contiene «tutte le sezioni» è
 *   'Menu · tutte le sezioni'  [311,779][386,839]
 * cioè il quinto tab; col foglio APERTO se ne aggiunge un secondo, l'occhiello
 *   'TUTTE LE SEZIONI'         [37,162][123,175]
 * Da qui la doppia natura di quel testo: ancorato è l'occhiello del foglio, non
 * ancorato è anche il tab — che è su ogni pagina.
 *
 * MISURA (`adb shell uiautomator dump`, home genitore, foglio Menu CHIUSO):
 *   text="COMUNICAZIONI" bounds="[0,0][0,0]"
 *   text="AVVISI"        bounds="[0,0][0,0]"
 *   text="COMUNICAZIONI" bounds="[0,0][0,0]"
 *   text="AVVISI"        bounds="[506,1803][572,1834]"
 * `adb shell input tap 539 1818` (centro del nodo con bounds veri) apre davvero
 * la pagina: il tab funziona, il selettore no.
 *
 * DA DOVE VENGONO I DOPPIONI. Il rapporto del collaudo lo attribuiva al foglio
 * «tutte le sezioni» che «resta nel DOM anche da chiuso». Quella spiegazione non
 * regge il conto: il foglio porta UNA sola «Comunicazioni»
 * (`nav.json:gruppoComunicazioni`) e `BottomNav.tsx` lo smonta con
 * `<AnimatePresence>{showMenu && …}</AnimatePresence>`. I due nodi misurati
 * corrispondono invece esattamente ai DUE `SectionHeader` della Home
 * (`parent/page.tsx:145` e `:153`), che rendono entrambi
 * `home.json:eyebrowComunicazioni`; e la seconda «Avvisi» è il TITOLO di sezione
 * `home.json:titoloAvvisi`, identico all'etichetta del tab `nav.json:tabAvvisi`.
 * Le due sezioni stanno sotto la piega, ed è la causa `altezza-0` già registrata
 * in CTA_SOTTO_LA_PIEGA. ⚠️ Questa ricostruzione è DEDOTTA dai cataloghi e dal
 * componente, non da un dump che isoli i nodi: chi rimette le mani qui la
 * confermi con `uiautomator dump` prima di darla per certa. Ciò che è misurato
 * sono i quattro nodi qui sopra.
 *
 * È la stessa classe di ETICHETTE_AMBIGUE_COCKPIT (tile + tab per «Mensa» e
 * «Anagrafica»): la conoscenza c'era, non era mai stata portata sulla home del
 * genitore.
 *
 * `soloDestinazione` / `soloPartenza` sono la coppia che rende la tappa
 * INCAPACE di mentire: un testo che esiste solo dove si va, e uno che esiste
 * solo da dove si viene. Il secondo è la parte che conta.
 *
 * ⚠️ MA IL PERCHÉ SCRITTO QUI IL 2026-08-07 ERA FALSO, e va detto per esteso
 * perché è la trappola in cui questo stesso registro è caduto. Diceva: «se il
 * tap non è atterrato, il nodo FANTASMA della pagina di partenza è ancora lì e
 * fa FALLIRE l'assertNotVisible; lo stesso nodo che prima rendeva la tappa verde
 * a torto ora la rende rossa a ragione». Misurato il giorno dopo
 * (`/tmp/kv-and-vacuita.yaml`, 17/17 COMPLETED): **falso**. Un nodo fantasma è
 * fantasma proprio perché ha `bounds="[0,0][0,0]"`, e Maestro 2.6.1 non lo
 * considera visibile: `assertNotVisible` su di lui passa SEMPRE, anche restando
 * fermi sulla pagina di partenza. La proprietà che avrebbe dovuto far fallire
 * l'asserzione è esattamente quella che la rende vacua.
 *
 * La coppia resta giusta; ciò che era sbagliato è la scelta del testo. Il
 * marcatore di partenza deve essere VISIBILE sulla pagina di partenza — sopra la
 * piega, misurato lì — altrimenti la difesa non spara mai. Da qui i `Marcatore`
 * con i frammenti e la loro fonte, e la regola R22 che vieta di ancorarsi a ciò
 * che è stato misurato fuori dal viewport.
 */
/**
 * ⚠️ RETTIFICA DEL 2026-08-07 (secondo collaudo, entrambe le piattaforme).
 * `soloDestinazione` e `soloPartenza` erano due STRINGHE, ed erano **le due
 * peggiori possibili**: «Le prese visione vengono registrate automaticamente.»
 * (footer di /parent/avvisi) e «Prossimi appuntamenti» (ultima sezione della
 * home). Tutte e due stanno SOTTO LA PIEGA, cioè in nessuno dei due alberi di
 * accessibilità — e questo registro le IMPONEVA. Il risultato misurato:
 *   · la prova positiva falliva sempre (Android: `assertVisible "Le prese
 *     visione…"` FAILED col tap sul tab andato a buon fine);
 *   · la prova negativa era VACUA (Android: `assertNotVisible "Prossimi
 *     appuntamenti"` COMPLETED **stando sulla home**).
 * Cioè: la regola nata per rendere una tappa incapace di mentire prescriveva
 * un'ancora che mentiva sempre in un verso e un'ancora che mentiva sempre
 * nell'altro. Ora i marcatori sono LISTE di frammenti con la loro fonte nel
 * catalogo, e R16a verifica che ogni frammento sia ancora lì: il registro non
 * può più prescrivere un testo che nessuno ha misurato a schermo.
 *
 * Più d'un frammento significa ancora ALTERNATIVA: il testo cambia con lo stato
 * dei dati (il sottotitolo di /parent/avvisi ha tre facce — «N avvisi da
 * gestire», «Tutto in regola ✓», «Comunicazioni dalla scuola» durante il
 * caricamento) e chi ne conosce una sola è rosso a giorni alterni. È la stessa
 * lezione di R12, applicata alle prove di navigazione.
 */
type Marcatore = {
  frammenti: { testo: string; fonte: { file: string; chiave: string } }[];
  /** Perché è raggiungibile senza scroll: la misura, non l'intenzione. */
  nota: string;
};

type EtichettaAmbiguaHome = {
  /** Il testo, nella forma nuda che i flow non possono più usare. */
  selettore: string;
  misurato: string;
  /** `misurato` = visto sull'albero; `dedotto` = ricavato dai cataloghi. */
  esito: 'misurato' | 'dedotto';
  prova: string;
  /** I punti del catalogo che producono lo STESSO testo: due o più = ambiguo. */
  fonti: { file: string; chiave: string; normalizzato?: boolean }[];
  /** Testo che esiste SOLO sulla pagina di destinazione (prova POSITIVA). */
  soloDestinazione?: Marcatore;
  /** Testo che esiste SOLO sulla pagina di partenza (prova NEGATIVA). */
  soloPartenza?: Marcatore;
};

/**
 * L'hero della home genitore: la prova NEGATIVA di aver lasciato la home.
 *
 * Sta in cima alla pagina, quindi è nel viewport di entrambe le piattaforme —
 * ed è la differenza che conta rispetto a «Prossimi appuntamenti», che chiudeva
 * la home in fondo. Misurato su iOS a `[36,304][183,320]`, presente 3 volte su 3.
 * Nei flow si scrive `.*Ecco le novit.*`: il nodo porta l'accento e l'emoji
 * finale, e il match di Maestro è FULL-match (misurato: «Ecco le novità di oggi»
 * fallisce, «Ecco le novità di oggi.*» passa).
 */
const HERO_HOME_GENITORE: Marcatore = {
  frammenti: [{ testo: 'Ecco le novit', fonte: { file: 'messages/it/home.json', chiave: 'heroSottotitolo' } }],
  nota:
    'Sottotitolo dell\'hero, sopra la piega su entrambe le piattaforme (iOS: [36,304][183,320], ' +
    '3 dump su 3 il 2026-08-07). Reso solo quando il nome del figlio è risolto ' +
    '(`subtitle={firstName ? t(\'heroSottotitolo\') : undefined}`, parent/page.tsx:85): con un ' +
    'account TEST senza figli collegati non ci sarebbe, e il rosso sarebbe dell\'ambiente.',
};

const ETICHETTE_AMBIGUE_HOME_GENITORE: EtichettaAmbiguaHome[] = [
  {
    selettore: 'Avvisi',
    misurato: '2026-08-07',
    esito: 'misurato',
    prova:
      'due nodi text="AVVISI" sulla home genitore: [0,0][0,0] e [506,1803][572,1834]. ' +
      'Maestro prende il PRIMO, cioè quello a dimensione zero, e il tap finisce in (0,0).',
    fonti: [
      { file: 'messages/it/nav.json', chiave: 'tabAvvisi' },
      { file: 'messages/it/home.json', chiave: 'titoloAvvisi' },
    ],
    soloDestinazione: {
      frammenti: [
        { testo: 'da gestire', fonte: { file: 'messages/it/avvisi.json', chiave: 'sottotitoloDaGestire' } },
        { testo: 'Tutto in regola', fonte: { file: 'messages/it/avvisi.json', chiave: 'sottotitoloOk' } },
        {
          testo: 'Comunicazioni dalla scuola',
          fonte: { file: 'messages/it/avvisi.json', chiave: 'sottotitoloCaricamento' },
        },
      ],
      nota:
        'Sottotitolo della PageHeaderCard di /parent/avvisi: sta in cima alla pagina ed è ' +
        'l\'unico testo di quella schermata che sia insieme sopra la piega e univoco — ' +
        'l\'occhiello («Comunicazioni») e il titolo («Avvisi») sono entrambi ambigui con la ' +
        'home. Ha TRE facce a seconda dei dati (avvisi/page.tsx:119) e vanno coperte tutte, ' +
        'altrimenti il flow è rosso i giorni in cui non c\'è niente da gestire.',
    },
    soloPartenza: HERO_HOME_GENITORE,
  },
  {
    selettore: 'Comunicazioni',
    misurato: '2026-08-07',
    esito: 'misurato',
    prova:
      'due nodi text="COMUNICAZIONI" [0,0][0,0] sulla home genitore, più l\'eyebrow della ' +
      'pagina di destinazione: come asserzione di arrivo è soddisfatta SENZA essersi mossi.',
    fonti: [
      { file: 'messages/it/avvisi.json', chiave: 'pageEyebrow' },
      { file: 'messages/it/home.json', chiave: 'eyebrowComunicazioni' },
      { file: 'messages/it/nav.json', chiave: 'gruppoComunicazioni' },
    ],
  },
  {
    // Il testo è cambiato il 2026-08-08 — era «Segnala assenza» — perché l'azione
    // aveva QUATTRO nomi e questo era il fuori posto: il resto del prodotto (PRD,
    // card della primaria, pulsante) dice «comunicare». L'AMBIGUITÀ NON È SPARITA
    // col nome: `home.json:azioneAssenza` è stata cambiata insieme al titolo,
    // apposta — se la home dicesse «Comunica un'assenza» e la pagina un'altra cosa,
    // il genitore toccherebbe una cosa e ne aprirebbe un'altra. Le due fonti restano
    // due, e questa voce con loro.
    selettore: 'Comunica un’assenza',
    misurato: '2026-08-07',
    esito: 'dedotto',
    prova:
      'NON misurato sull\'albero: dedotto dai cataloghi. `home.json:azioneAssenza` vale ' +
      '«Comunica\\nun’assenza» ed è l\'azione rapida della Home; il nome accessibile ' +
      'appiattisce gli spazi interni (accname §4), quindi arriva identico al titolo della ' +
      'pagina `parentServizi.json:attendanceTitolo`. Finché non c\'è un dump che lo ' +
      'smentisca, un flow che prova di essere ARRIVATO su /parent/attendance con quel ' +
      'testo può essere soddisfatto dalla Home — che è dove si finisce quando il tap sul ' +
      'foglio Menu non atterra. Il testo univoco costa zero: si usa quello.',
    fonti: [
      { file: 'messages/it/parentServizi.json', chiave: 'attendanceTitolo' },
      { file: 'messages/it/home.json', chiave: 'azioneAssenza', normalizzato: true },
    ],
    soloDestinazione: {
      frammenti: [
        {
          testo: 'Avvisa gli insegnanti in anticipo',
          fonte: { file: 'messages/it/parentServizi.json', chiave: 'attendanceSottotitolo' },
        },
      ],
      nota:
        'Sottotitolo dell\'intestazione di /parent/attendance: in cima alla pagina, presente ' +
        'in entrambi gli alberi (Android e iOS, 2026-08-07). Era «Comunica un’assenza alla ' +
        'scuola», cioè il titolo ripetuto con tre parole in più: dal 2026-08-08 dice la cosa ' +
        'che il titolo non dice (QUANDO si può comunicare) ed è lo stesso testo della card ' +
        'della primaria — le due schermate della stessa funzione ora si somigliano. Vive su ' +
        'due pagine e non più su una: /parent/primaria/assenze porta la stessa frase, ma non ' +
        'è sul percorso di questo flow, e la pagina di PARTENZA (la home) non la contiene — ' +
        'che è l\'unica proprietà che serve a una prova d\'arrivo.',
    },
    soloPartenza: HERO_HOME_GENITORE,
  },
];

/** I due percorsi utente del genitore: sono loro a navigare la home di famiglia. */
const FLOWS_GENITORE = ['android-percorso-genitore.yaml', 'ios-percorso-genitore.yaml'];

/** Appiattisce gli spazi interni come fa il calcolo del nome accessibile. */
function comeAccname(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Il testo «nudo» di un selettore: senza ancore, alternative e punteggiatura regex. */
function seleNudo(s: string): string {
  return comeAccname(s.replace(/[\\^$*+?()[\]{}|.]/g, ' ')).toLowerCase();
}

/**
 * Confronto fra il testo del CATALOGO e quello scritto in un flow, indifferente
 * alla forma dell'apostrofo.
 *
 * I cataloghi usano l'apostrofo TIPOGRAFICO (U+2019: «Comunica un’assenza alla
 * scuola»); i flow scrivono `.`, cioè il metacarattere regex, proprio per non
 * dipendere da quale dei due caratteri arriva dall'albero di accessibilità. Un
 * `includes` letterale non li riconoscerebbe uguali, e le regole qui sotto
 * direbbero «manca la prova» a un flow che la prova ce l'ha. Il registro deve
 * poter contenere il testo VERO dell'app: è la forma del flow ad adattarsi.
 */
function contieneTesto(corpo: string, testo: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[’‘'´]/g, '.');
  return norm(corpo).includes(norm(testo));
}

describe('lock: flow Maestro (le etichette doppie della home genitore)', () => {
  it('R16a · il registro delle etichette ambigue è ancora vero nei cataloghi', () => {
    // Controllo di SCADENZA, sullo stampo di R8a: se qualcuno rinomina una delle due
    // fonti, l'ambiguità sparisce e la regola smette di descrivere l'app.
    const scaduti: string[] = [];
    for (const e of ETICHETTE_AMBIGUE_HOME_GENITORE) {
      const vive = e.fonti.filter((s) => {
        const v = leggiCatalogo(s.file)[s.chiave];
        if (typeof v !== 'string') return false;
        return (s.normalizzato ? comeAccname(v) : v) === e.selettore;
      });
      if (vive.length < 2) {
        scaduti.push(
          `«${e.selettore}»: ${vive.length} fonte/i su ${e.fonti.length} portano ancora quel ` +
            'valore. L\'ambiguità potrebbe non esserci più: RIMISURARE con `uiautomator dump` ' +
            'prima di fidarsi di R16b.',
        );
      }
      // E i marcatori che il registro PRESCRIVE devono esistere davvero nel catalogo.
      // Senza questo controllo il registro può imporre ai flow un testo che l'app non
      // produce più — che è esattamente com'è andata fino al 2026-08-07, quando
      // prescriveva un footer fuori viewport e una sezione in fondo alla home.
      for (const [ruolo, m] of [
        ['soloDestinazione', e.soloDestinazione],
        ['soloPartenza', e.soloPartenza],
      ] as const) {
        if (!m) continue;
        for (const fr of m.frammenti) {
          const valore = leggiCatalogo(fr.fonte.file)[fr.fonte.chiave];
          if (typeof valore !== 'string') {
            scaduti.push(`${fr.fonte.file}: la chiave ${fr.fonte.chiave} non esiste più`);
            continue;
          }
          if (!contieneTesto(valore, fr.testo)) {
            scaduti.push(
              `«${e.selettore}» · ${ruolo}: il frammento «${fr.testo}» non è più dentro ` +
                `${fr.fonte.file}:${fr.fonte.chiave} = ${JSON.stringify(valore)}. I flow ` +
                'cercherebbero un testo che l\'app non produce.',
            );
          }
        }
      }
    }
    expect(scaduti, 'Registro R16 scaduto: la regola non descrive più i cataloghi.').toEqual([]);
  });

  it('R16b · nessuna ASSERZIONE dei flow genitore si regge su un\'etichetta doppia', () => {
    // La regola guarda le ASSERZIONI, non i tap, e la distinzione è il cuore della
    // cosa. Un TAP su un'etichetta doppia produce un difetto RUMOROSO: il tocco va
    // sul nodo a dimensione zero, non si naviga, e la coppia positiva+negativa che
    // R17 pretende lo fa fallire. Un'ASSERZIONE su un'etichetta doppia produce il
    // difetto SILENZIOSO: risulta vera anche restando fermi, e il flow dichiara
    // superata una tappa che non ha aperto. Il primo si può gestire, il secondo no.
    // Vietare anche i tap costringerebbe a scrivere ancore che NON disambiguano
    // niente (Maestro fa già full-match) solo per far tacere il lock: una difesa
    // finta, che è peggio di nessuna difesa.
    const colpevoli: string[] = [];
    for (const f of FLOWS_GENITORE) {
      for (const passo of passi(leggiFlow(f), { annidati: true })) {
        if (passo.nome === 'tapOn') continue;
        for (const sel of tuttiISelettori(`---\n${passo.corpo}`)) {
          const amb = ETICHETTE_AMBIGUE_HOME_GENITORE.find(
            (e) => e.selettore.toLowerCase() === sel.trim().toLowerCase(),
          );
          if (!amb) continue;
          colpevoli.push(
            `${f} · ${passo.nome} → "${sel}": esiste in ${amb.fonti.length} punti del ` +
              `catalogo (${amb.fonti.map((s) => `${s.file}:${s.chiave}`).join(', ')}) e sulla ` +
              `home ${amb.esito === 'misurato' ? 'è stato MISURATO' : 'risulta'} come nodo ` +
              `doppio (${amb.misurato}). ` +
              (amb.soloDestinazione
                ? `Usa «${amb.soloDestinazione}» per provare l'arrivo.`
                : 'Usa un testo che esista SOLO sulla pagina di destinazione.'),
          );
        }
      }
    }
    expect(
      colpevoli,
      'Etichetta doppia sulla home del genitore usata come PROVA: è soddisfatta anche ' +
        'restando fermi, quindi il flow dichiara COMPLETED una tappa che non ha aperto ' +
        '(mobile-android, 2026-08-07).',
    ).toEqual([]);
  });

  it('R17 · chi tocca un tab ambiguo prova di essere arrivato E di essersi mosso', () => {
    const colpevoli: string[] = [];
    for (const f of FLOWS_GENITORE) {
      const p = passi(leggiFlow(f), { annidati: true });
      p.forEach((passo, i) => {
        if (passo.nome !== 'tapOn') return;
        for (const e of ETICHETTE_AMBIGUE_HOME_GENITORE) {
          if (!e.soloDestinazione || !e.soloPartenza) continue;
          // Il confronto è sul CORPO del passo, non sul solo selettore estratto: un
          // `tapOn` può essere inline (`- tapOn: "Avvisi"`) o a blocco con `text:` più
          // le chiavi di disambiguazione, e la regola deve valere per entrambe le forme.
          // Volutamente generoso: nel dubbio chiede più prove, non meno.
          if (!seleNudo(passo.corpo).includes(e.selettore.toLowerCase())) continue;
          const dopo = p.slice(i + 1, i + 7);
          // `every`, non `some`: quando il marcatore ha più frammenti è perché il testo
          // cambia con lo stato dei dati, e un'ancora che ne copre uno solo è rossa nei
          // giorni in cui a schermo c'è l'altro.
          const copre = (x: { corpo: string }, m: Marcatore) =>
            m.frammenti.every((fr) => contieneTesto(x.corpo, fr.testo));
          const elenco = (m: Marcatore) => m.frammenti.map((fr) => `«${fr.testo}»`).join(' + ');
          if (!dopo.some((x) => copre(x, e.soloDestinazione!))) {
            colpevoli.push(
              `${f} · tapOn «${e.selettore}» #${i}: manca la prova POSITIVA di arrivo su ` +
                `${elenco(e.soloDestinazione!)} (testo della sola pagina di destinazione; se ` +
                'sono più d\'uno vanno in UN\'UNICA ancora alternata, perché dipendono dai dati)',
            );
          }
          if (
            !dopo.some((x) => x.nome === 'assertNotVisible' && copre(x, e.soloPartenza!))
          ) {
            colpevoli.push(
              `${f} · tapOn «${e.selettore}» #${i}: manca la prova NEGATIVA ` +
                `\`assertNotVisible\` su ${elenco(e.soloPartenza!)} (testo della sola pagina ` +
                'di partenza)',
            );
          }
        }
      });
    }
    expect(
      colpevoli,
      'Senza la coppia positiva+negativa un tap che non atterra resta COMPLETED e la tappa ' +
        'successiva lo conferma sullo stesso nodo fantasma. La prova NEGATIVA è quella che ' +
        'conta: se non ci si è mossi, il fantasma della pagina di partenza è ancora lì e ' +
        'l\'asserzione FALLISCE.',
    ).toEqual([]);
  });
});

/**
 * ─── R18 · IL PERCORSO DEL GENITORE COLLAUDA DAVVERO «COMUNICA UN'ASSENZA» ──
 *
 * La funzione riaperta dal ciclo del 2026-08-07 — il genitore comunica
 * un'assenza, la maestra la riceve, il genitore la annulla — non era in nessun
 * flow: i percorsi mobile si fermavano a «Segnala assenza», cioè al titolo della
 * pagina, senza premere niente. Un percorso che apre il modulo e non lo invia
 * collauda l'esistenza di una schermata, non il funzionamento di una funzione.
 *
 * La sequenza qui sotto è ORDINATA di proposito, e l'ordine è il punto:
 * l'annullamento deve venire DOPO l'invio, perché il flow scrive su `presenze`
 * di un alunno vero (account TEST, database di produzione) e deve disfare ciò
 * che ha scritto. La prova che l'ha disfatto è l'ultimo marcatore: l'elenco
 * torna vuoto.
 *
 * `vuoto → pieno → vuoto` è anche l'unica forma che non si può soddisfare
 * stando fermi — **a una condizione che il primo giro aveva mancato**: che
 * l'asserzione NEGATIVA in mezzo («l'elenco NON è più vuoto») sia fatta DOVE
 * quell'elenco si vede. Misurato il 2026-08-07 su Android: fatta a scroll zero
 * passa con l'elenco VUOTO e nessuna assenza comunicata, perché il nodo è fuori
 * viewport e non è «visibile» in nessun caso. La forma resta giusta, il posto
 * dove si guarda no: prima si porta l'elenco nel viewport (R22), poi si asserisce.
 *
 * ⚠️ RETTIFICA DEL 2026-08-07 SUL MARCATORE DELLA CONFERMA. Era «Assenza
 * comunicata» (`attendanceInviataTitolo`), ed è la stessa forma di bugia che il
 * resto di questo file combatte: quel testo è INTERAMENTE CONTENUTO
 * nell'aria-label del bottone ANNULLA di una riga già in elenco («Annulla
 * l'assenza comunicata per il {data}»), e con il full-match case-insensitive i
 * due nodi sono indistinguibili. Misurato: il comando risulta COMPLETED **174 ms
 * dopo il tap**, mentre lo screenshot scattato 76 ms più tardi mostra il bottone
 * ancora in stato «INVIO…». Il flow dichiarava riuscito un invio ancora in volo.
 * Il marcatore è ora la CTA della schermata di conferma, «Comunica un'altra
 * assenza», che esiste SOLO lì — ed è anche il passo successivo del percorso.
 * La regola generale che lo impedisce da qui in avanti è R23.
 */
const TAPPE_COMUNICA_ASSENZA = [
  { marcatore: 'Non hai comunicato nessuna assenza per i prossimi giorni.', cosa: 'elenco VUOTO di partenza' },
  { marcatore: 'Comunica assenza', cosa: 'la CTA che invia la comunicazione' },
  { marcatore: 'Comunica un’altra assenza', cosa: 'la schermata di conferma' },
  { marcatore: 'Assenze già comunicate', cosa: 'il ritorno all\'elenco' },
  { marcatore: 'Assenza annullata.', cosa: 'l\'esito dell\'annullamento' },
];

describe('lock: flow Maestro (il percorso «Comunica un\'assenza»)', () => {
  it('R18a · i marcatori del percorso esistono ancora, con quel testo, nel catalogo', () => {
    const catalogo = leggiCatalogo('messages/it/parentServizi.json');
    const valori = new Set(Object.values(catalogo).filter((v): v is string => typeof v === 'string'));
    const scaduti = TAPPE_COMUNICA_ASSENZA.filter((t) => !valori.has(t.marcatore)).map(
      (t) => `«${t.marcatore}» (${t.cosa}) non è più in messages/it/parentServizi.json`,
    );
    expect(
      scaduti,
      'Registro R18 scaduto: i flow cercherebbero testi che l\'app non produce più.',
    ).toEqual([]);
  });

  it('R18b · i due percorsi genitore comunicano, verificano, annullano e riverificano', () => {
    for (const f of FLOWS_GENITORE) {
      const sel = tuttiISelettori(leggiFlow(f));
      let da = -1;
      for (const t of TAPPE_COMUNICA_ASSENZA) {
        const i = sel.findIndex((s, k) => k > da && contieneTesto(s, t.marcatore));
        expect(
          i,
          `${f}: manca (o è fuori ordine) la tappa «${t.cosa}» → cerca «${t.marcatore}». ` +
            'Il percorso deve INVIARE la comunicazione e poi ANNULLARLA: il flow scrive su ' +
            'dati veri, e la prova di aver disfatto la scrittura è l\'ultimo marcatore.',
        ).toBeGreaterThan(da);
        da = i;
      }
      // L'elenco deve tornare VUOTO alla fine: il marcatore del vuoto compare due volte,
      // prima dell'invio e dopo l'annullamento. Senza il secondo, il flow lascerebbe una
      // riga in `presenze` e nessuno se ne accorgerebbe.
      const vuoto = TAPPE_COMUNICA_ASSENZA[0].marcatore;
      expect(
        sel.filter((s) => contieneTesto(s, vuoto)).length,
        `${f}: «${vuoto}» compare una volta sola. Serve due volte — prima dell'invio e ` +
          'DOPO l\'annullamento — altrimenti nessuno prova che la riga scritta è sparita.',
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

/**
 * ─── R19 · IL LANCIATORE NON PARTE CON L'ACCOUNT DEL REVISORE APPLE ────────
 *
 * Collaudo mobile-ios del 2026-08-07: `esegui.sh` senza variabili usava come
 * genitore `test.inf.genitore1@kidville.test`, che dal 2026-07-28 ha una
 * password DEDICATA alla review Apple. Con il segreto comune del repo risponde
 *   HTTP 400 {"error_code":"invalid_credentials"}
 * (misurato contro Supabase; `test.inf.docente1@kidville.test` con la stessa
 * password risponde 200), e a schermo compare «Credenziali non valide. L'accesso
 * è solo su invito della Segreteria.» — lo stesso testo che la login userebbe per
 * un errore di rete. Il collaudo scrive «l'app non fa entrare» e la colpa cade
 * sull'app.
 *
 * È la stessa malattia dei selettori morti, spostata sulle credenziali: il
 * lanciatore parte con un valore che NON PUÒ funzionare, e il fallimento è
 * indistinguibile da un difetto vero.
 */
const ACCOUNT_CON_PASSWORD_DEDICATA = [
  'test.inf.genitore1@kidville.test',
  'test.pri.genitore1@kidville.test',
  // Aggiunto il 2026-08-08. Non è un account della review Apple: è un account
  // NORMALE la cui password è stata ruotata a mano durante il collaudo del
  // 2026-08-07 (`test.inf.genitore1`, `test.inf.docente1`, `test.segreteria`) e
  // la rotazione è stata sovrascritta da un altro attore entro una ventina di
  // minuti — la password con cui due flow avevano appena fatto login ha
  // ricominciato a rispondere `400 invalid_credentials` (report tester-15-ios).
  // La lezione che allarga la regola: un account esce dal segreto comune anche
  // SENZA che nessuno lo decida, e da quel momento il flow muore sulla login
  // mostrando lo stesso testo di un errore di rete. Il lanciatore partiva
  // proprio da qui, mentre il piano di collaudo indicava `test.pri.docente1`:
  // due fonti che dicevano cose diverse, e nessuna delle due lo diceva a chi
  // guardava il flow morire.
  'test.inf.docente1@kidville.test',
];

describe('lock: lanciatore Maestro (le credenziali di partenza)', () => {
  const esegui = () => fs.readFileSync(path.join(DIR_FLOWS, 'esegui.sh'), 'utf8');

  it('R19a · nessun default di esegui.sh è un account con password dedicata', () => {
    const testo = esegui();
    const colpevoli: string[] = [];
    for (const riga of testo.split('\n')) {
      const m = riga.match(/^export\s+(MAESTRO_KV_EMAIL_[A-Z]+)="\$\{[A-Z_]+:-([^"}]+)\}"/);
      if (!m) continue;
      if (ACCOUNT_CON_PASSWORD_DEDICATA.includes(m[2].trim())) {
        colpevoli.push(`esegui.sh → ${m[1]} parte da ${m[2].trim()}`);
      }
    }
    expect(
      colpevoli,
      'Account con password dedicata alla review Apple: con il segreto comune del repo NON ' +
        'autentica (HTTP 400 invalid_credentials, misurato il 2026-08-07). Il flow muore sulla ' +
        'login e il collaudo accusa l\'app.',
    ).toEqual([]);
  });

  it('R19b · esegui.sh dice a voce alta quando gli si passa quell\'account', () => {
    // Controllo POSITIVO: cambiare il default non basta, perché chi ha bisogno DAVVERO
    // dell'account del revisore lo passerà a mano e ricadrà nello stesso silenzio.
    const testo = esegui();
    for (const a of ACCOUNT_CON_PASSWORD_DEDICATA) {
      expect(
        testo.includes(a),
        `esegui.sh non nomina ${a}: senza una guardia esplicita, chi lo passa a mano rivede ` +
          '«Credenziali non valide» e non ha modo di sapere che è la password sbagliata.',
      ).toBe(true);
    }
  });
});

/**
 * ─── R20 · IL PREDICATO CHE NON GUARDA NIENTE ──────────────────────────────
 *
 * Collaudo mobile-ios del 2026-08-07, warning: il comando di cattura dei crash
 * scritto nelle istruzioni dei tester,
 *   xcrun simctl spawn booted log stream --predicate 'processImage CONTAINS "App"'
 * su iOS 26.2 esce con `log: invalid predicate: no such field: processImage` e
 * produce ZERO righe. Zero righe si legge «nessun crash»: il tester ha perso i
 * primi due lanci credendo di star guardando. È esattamente la malattia di
 * questo ciclo — qualcosa che dichiara successo senza verificare — nello
 * strumento che dovrebbe accorgersene.
 *
 * Il campo valido è `process` (oppure `processImagePath`), e con quello sono
 * state catturate 65.401 righe, 0 Error e 0 Fault.
 */
const PREDICATI_CRASH_INVALIDI = [
  {
    pattern: /processImage\s+(CONTAINS|==)/,
    dove: 'predicato di `log stream`',
    errore: 'log: invalid predicate: no such field: processImage',
    sostituto: 'process == "App"  (oppure processImagePath CONTAINS "App")',
  },
];

/** I file che dicono ai tester mobile come catturare i crash. */
const ISTRUZIONI_CATTURA_CRASH = [
  '.claude/agents/tester-opus-mobile-ios.md',
  '.codex/agents/tester-opus-mobile-ios.toml',
  'docs/collaudo/prompt/tester-15-ios.md',
];

describe('lock: collaudo mobile iOS (la cattura dei crash)', () => {
  it('R20 · nessuna istruzione usa un predicato che su iOS 26 non compila', () => {
    const colpevoli: string[] = [];
    for (const f of ISTRUZIONI_CATTURA_CRASH) {
      const p = path.join(process.cwd(), f);
      if (!fs.existsSync(p)) {
        colpevoli.push(`${f}: il file non esiste più — aggiorna ISTRUZIONI_CATTURA_CRASH`);
        continue;
      }
      const testo = fs.readFileSync(p, 'utf8');
      for (const pr of PREDICATI_CRASH_INVALIDI) {
        if (pr.pattern.test(testo)) {
          colpevoli.push(`${f}: ${pr.dove} invalido → «${pr.errore}» · usa \`${pr.sostituto}\``);
        }
      }
    }
    expect(
      colpevoli,
      'Un predicato invalido non fallisce rumorosamente: stampa una riga di errore e poi ' +
        'ZERO righe di log. Chi lo lancia in background legge «nessun crash» mentre non sta ' +
        'guardando niente (mobile-ios, 2026-08-07).',
    ).toEqual([]);
  });
});

/**
 * ─── R21 · L'ANCORA CHE COMBACIA CON UN'ETICHETTA PRESENTE SU OGNI PAGINA ───
 *
 * Collaudo mobile-ios del 2026-08-07, `ios-percorso-genitore.yaml`, 24° comando:
 *   Assertion is false: ".*Tutte le sezioni.*" is not visible
 *   (durata 17.033 ms, cioè l'intera finestra di ritentativo)
 * L'app era sana: il foglio Menu si era chiuso davvero e la pagina
 * `/parent/attendance` era a schermo, come mostra lo screenshot dello step.
 *
 * LA MISURA. Dump dell'albero su `/parent/attendance`: l'unico nodo che contiene
 * «sezioni» è `accessibilityText='Menu · tutte le sezioni'` a `[126,779][386,839]`
 * — il quinto tab della bottom-nav, che sta su OGNI pagina. L'occhiello del
 * foglio («TUTTE LE SEZIONI») non c'è più.
 *
 * PERCHÉ COMBACIA. Il match di Maestro è full-match sulla regex e
 * case-insensitive: `.*Tutte le sezioni.*` copre per intero «Menu · tutte le
 * sezioni». La prova NEGATIVA scelta per difendere la tappa era quindi una difesa
 * che spara sempre: **non può essere vera su nessuna pagina dell'app**.
 *
 * È la faccia opposta e simmetrica dell'asserzione VACUA di R22: là un
 * `assertNotVisible` sempre vero, qui uno sempre falso. Entrambi non guardano
 * niente; il primo dichiara COMPLETED senza aver aperto niente, il secondo
 * dichiara FAILED senza che l'app abbia niente che non va.
 *
 * La regola vale solo per le asserzioni NEGATIVE: `assertVisible: "Menu · tutte
 * le sezioni"` è legittimo — è il modo giusto di provare che la bottom-nav c'è.
 *
 * ⚠️ RIPRODOTTO DI PRIMA MANO il 2026-08-08 (iPhone 17 Pro / iOS 26.2, Maestro
 * 2.6.1), sulla home genitore col foglio CHIUSO e nello stesso istante:
 *   assertNotVisible ".*Tutte le sezioni.*"    → FAILED
 *   assertNotVisible ".*Scrivi alle maestre.*" → COMPLETED
 * e col foglio APERTO la seconda → FAILED. Cioè: l'ancora nuova morde quando
 * deve e tace quando deve, la vecchia non poteva fare né l'una né l'altra cosa.
 * Le due esecuzioni in versi opposti sono la ragione per cui la sostituta è
 * `voceChatSub` e non l'occhiello ancorato: dell'una si conosce il
 * comportamento in entrambi i sensi, dell'altro no.
 */
type AriaPersistente = {
  catalogo: string;
  chiave: string;
  /** Il componente che lo rende: se sparisce l'aria-label, il registro è scaduto. */
  componente: string;
  dove: string;
};

const ARIA_PERSISTENTI: AriaPersistente[] = [
  {
    catalogo: 'messages/it/nav.json',
    chiave: 'ariaMenu',
    componente: 'src/components/features/parent/BottomNav.tsx',
    dove: 'quinto tab della bottom-nav del genitore, su ogni schermata /parent/**',
  },
  {
    catalogo: 'messages/it/nav.json',
    chiave: 'ariaNavigazionePrincipale',
    componente: 'src/components/features/parent/BottomNav.tsx',
    dove: '<nav> della bottom-nav del genitore, su ogni schermata /parent/**',
  },
  {
    catalogo: 'messages/it/teacherNav.json',
    chiave: 'ariaMenu',
    componente: 'src/components/features/teacher/TeacherBottomNav.tsx',
    dove: 'quinto tab della bottom-nav del docente',
  },
  {
    catalogo: 'messages/it/teacherNav.json',
    chiave: 'ariaNavigazionePrincipale',
    componente: 'src/components/features/teacher/TeacherBottomNav.tsx',
    dove: '<nav> della bottom-nav del docente',
  },
  {
    catalogo: 'messages/it/adminNav.json',
    chiave: 'menuAria',
    componente: 'src/components/features/admin/AdminBottomNav.tsx',
    dove: 'quinto tab della bottom-nav del cockpit Direzione/Segreteria',
  },
  {
    catalogo: 'messages/it/adminNav.json',
    chiave: 'navAria',
    componente: 'src/components/features/admin/AdminBottomNav.tsx',
    dove: '<nav> della bottom-nav del cockpit Direzione/Segreteria',
  },
];

/**
 * Combacia come Maestro: **full-match** sulla regex e **case-insensitive**.
 *
 * Le due proprietà sono misurate, non dedotte dalla documentazione:
 *  · full-match — «Ecco le novità di oggi» FALLISCE e «Ecco le novità di oggi.*»
 *    passa, perché il nodo porta anche l'emoji finale (mobile-android, 2026-08-07);
 *  · case-insensitive — `.*Tutte le sezioni.*` combacia con «Menu · tutte le
 *    sezioni» (mobile-ios, stesso giorno).
 * Un selettore che non compila come regex non combacia con niente: qui vale
 * `false`, che è anche ciò che farebbe fallire il flow sul device.
 */
function combaciaComeMaestro(selettore: string, testo: string): boolean {
  try {
    return new RegExp(`^(?:${selettore})$`, 'i').test(testo);
  } catch {
    return false;
  }
}

/** I passi che asseriscono un'ASSENZA: `assertNotVisible` e `extendedWaitUntil: notVisible:`. */
function passiNegativi(testo: string): { nome: string; corpo: string }[] {
  return passi(testo, { annidati: true }).filter(
    (p) => p.nome === 'assertNotVisible' || /notVisible:/.test(p.corpo),
  );
}

describe('lock: flow Maestro (le ancore che stanno su OGNI pagina)', () => {
  it('R21a · il registro delle etichette persistenti è ancora vero nel codice', () => {
    // Controllo di SCADENZA, sullo stampo di R8a: se qualcuno toglie l'aria-label dalla
    // bottom-nav, quel testo smette di essere presente su ogni pagina e R21b starebbe
    // vietando un'ancora legittima.
    const scaduti: string[] = [];
    for (const a of ARIA_PERSISTENTI) {
      const valore = leggiCatalogo(a.catalogo)[a.chiave];
      if (typeof valore !== 'string' || valore.trim() === '') {
        scaduti.push(`${a.catalogo}: la chiave ${a.chiave} non esiste più`);
        continue;
      }
      const sorgente = fs.readFileSync(path.join(process.cwd(), a.componente), 'utf8');
      if (!new RegExp(`aria-label=\\{t\\('${a.chiave}'\\)\\}`).test(sorgente)) {
        scaduti.push(
          `${a.componente}: non contiene più aria-label={t('${a.chiave}')} → «${valore}» ` +
            'potrebbe non essere più su ogni pagina. RIMISURARE prima di fidarsi di R21b.',
        );
      }
    }
    expect(scaduti, 'Registro R21 scaduto: la regola non descrive più il codice.').toEqual([]);
  });

  it('R21b · nessuna asserzione NEGATIVA cade su un\'etichetta presente su ogni pagina', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      for (const passo of passiNegativi(leggiFlow(f))) {
        for (const sel of tuttiISelettori(`---\n${passo.corpo}`)) {
          for (const a of ARIA_PERSISTENTI) {
            const valore = String(leggiCatalogo(a.catalogo)[a.chiave]);
            if (!combaciaComeMaestro(sel, valore)) continue;
            colpevoli.push(
              `${f} · ${passo.nome} → "${sel}" combacia (full-match, case-insensitive) con ` +
                `«${valore}» = ${a.catalogo}:${a.chiave}, che è ${a.dove}. L'asserzione non ` +
                'può essere vera su NESSUNA pagina: usa un testo che esista solo dentro la ' +
                'schermata di partenza.',
            );
          }
        }
      }
    }
    expect(
      colpevoli,
      'Asserzione negativa che spara sempre: il flow dichiara FAILED senza che l\'app abbia ' +
        'niente che non va, e il collaudo scrive che la funzione non si raggiunge ' +
        '(mobile-ios, 2026-08-07).',
    ).toEqual([]);
  });
});

/**
 * ─── R22 · LE ANCORE MISURATE FUORI DAL VIEWPORT ───────────────────────────
 *
 * Collaudo mobile-android e mobile-ios del 2026-08-07, sullo STESSO errore e con
 * DUE cause diverse — ed è questa la conoscenza che è costata due cicli:
 *
 *  · **Android** — i nodi fuori schermo ci sono, ma la WebView li proietta con
 *    `bounds="[0,0][0,0]"` e Maestro 2.6.1 non considera visibile un nodo di
 *    dimensione zero. Misurato sulla home genitore: `text="PROSSIMI APPUNTAMENTI"
 *    bounds="[0,0][0,0]"`; su `/parent/attendance`: `text="ASSENZE GIÀ COMUNICATE"
 *    bounds="[0,0][0,0]"` senza scroll, `[105,1257][976,1336]` dopo uno swipe.
 *  · **iOS** — l'albero di accessibilità della WKWebView espone **solo i nodi
 *    dentro il viewport**: quei nodi non esistono affatto. Misurato con `maestro
 *    hierarchy` sulla home: 43 nodi di testo, l'ultimo «LA GIORNATA DI ALUNNO2» a
 *    `[20,860][200,882]` su uno schermo alto 874; «PROSSIMI APPUNTAMENTI» 0
 *    occorrenze in 3 dump consecutivi, e presente a `[20,630][199,652]` dopo lo
 *    scroll.
 *
 * DUE CONSEGUENZE OPPOSTE, e servono due regole:
 *  · **R22b** — un `assertNotVisible` su uno di questi testi è **VACUO**: è vero
 *    anche quando non è successo niente. Misurato (`/tmp/kv-and-vacuita.yaml`,
 *    17/17 COMPLETED): `assertNotVisible "Prossimi appuntamenti"` passa STANDO
 *    sulla home, e `assertNotVisible "Non hai comunicato nessuna assenza per i
 *    prossimi giorni."` passa con l'elenco VUOTO. Un'asserzione vera in ogni caso
 *    non è una difesa: è la stessa bugia dei nodi fantasma con un'altra faccia.
 *  · **R22c** — un'asserzione POSITIVA su uno di questi testi **fallisce sempre**
 *    (Android: `extendedWaitUntil` scade dopo 60 s; iOS: 1 volta su 3, e solo
 *    nella finestra di poche centinaia di ms in cui le card asincrone non hanno
 *    ancora allungato la pagina). Va preceduta da uno `scrollUntilVisible` che
 *    porti il nodo — o la sua zona — dentro il viewport.
 *
 * `regione` sono i testi che aprono la STESSA zona: portarne uno nel viewport ci
 * porta anche gli altri, ed è ciò che rende di nuovo SENSATA la prova negativa
 * sull'elenco vuoto. Non è una comodità di scrittura, è una misura: su iOS il
 * titolo dell'elenco e la sua riga di stato stanno dentro un solo contenitore,
 * «ASSENZE GIÀ COMUNICATE, zona» [16,786][386,964]. Senza `regione` la vacuità
 * non si cura scrollando: si cura cambiando ancora (vedi `rimedio`) — ed è il
 * caso della home, dove «Prossimi appuntamenti» chiude la pagina e non ha
 * nessun vicino sopra la piega.
 */
type AncoraFuoriViewport = {
  /** Il frammento come lo scrivono i flow (regex-compatibile, apostrofi come `.`). */
  frammento: string;
  /** Da dove nasce il testo: se cambia lì, il registro è scaduto. */
  fonte: { file: string; chiave: string };
  schermata: string;
  piattaforme: ('android' | 'ios')[];
  misurato: string;
  prova: string;
  /** Testi che, portati in viewport, portano anche questo (rendono non-vacua la negativa). */
  regione?: string[];
  rimedio: string;
};

const ANCORE_FUORI_VIEWPORT: AncoraFuoriViewport[] = [
  {
    frammento: 'Prossimi appuntamenti',
    fonte: { file: 'messages/it/home.json', chiave: 'titoloProssimiAppuntamenti' },
    schermata: 'home del genitore /parent (sezione CALENDARIO, l\'ULTIMA della pagina)',
    piattaforme: ['android', 'ios'],
    misurato: '2026-08-07',
    prova:
      'Android: `text="PROSSIMI APPUNTAMENTI" bounds="[0,0][0,0]"`; controprova sullo stesso ' +
      'blocco, «NESSUN APPUNTAMENTO IN PROGRAMMA» fallisce e «OGGI A SCUOLA» ([49,1241]' +
      '[328,1291]) passa. iOS: 0 occorrenze in 3 dump a scroll zero, presente dopo lo scroll ' +
      'a [20,630][199,652]. Come gate della dashboard è passato 1 volta su 3 su iOS e MAI su ' +
      'Android; come prova negativa di aver lasciato la home è vacuo su entrambe. ' +
      '⚠️ RIPRODOTTO DI PRIMA MANO il 2026-08-08 su iPhone 17 Pro / iOS 26.2, Maestro 2.6.1, ' +
      'STANDO SULLA HOME: `assertVisible ".*Prossimi appuntamenti.*"` → FAILED e ' +
      '`assertNotVisible ".*Prossimi appuntamenti.*"` → COMPLETED, cioè la stessa ancora è ' +
      'falsa in un verso e vacuamente vera nell\'altro. Il dump della home a scroll zero ' +
      'conta 70 nodi di testo, 0 occorrenze di «Prossimi appuntamenti» e 0 di «Nessun ' +
      'appuntamento», con l\'ultimo nodo «LA GIORNATA DI ALUNNO2» a [20,860][200,882] su uno ' +
      'schermo alto 874. E il RIMEDIO è verificato, non supposto: `scrollUntilVisible ' +
      'centerElement: true` seguito da `assertVisible` → COMPLETED entrambi.',
    rimedio:
      'Usare l\'hero della home, «Ecco le novità di oggi 🌈» (home.json → heroSottotitolo), ' +
      'che sta sopra la piega: misurato a [36,304][183,320] su iOS, 3 volte su 3. Nei flow si ' +
      'scrive `.*Ecco le novit.*` perché il nodo porta l\'accento e l\'emoji e il match è ' +
      'full-match.',
  },
  {
    frammento: 'Non hai comunicato nessuna assenza per i prossimi giorni.',
    fonte: { file: 'messages/it/parentServizi.json', chiave: 'attendanceElencoVuoto' },
    schermata: '/parent/attendance, elenco «Assenze già comunicate», a scroll zero',
    piattaforme: ['android', 'ios'],
    misurato: '2026-08-07',
    prova:
      'iOS: la zona esiste («ASSENZE GIÀ COMUNICATE, zona» [16,786][386,964] su uno schermo ' +
      'alto 874) ma la frase dell\'elenco vuoto NON è nell\'albero; dopo `- scroll` compare a ' +
      '[40,715][311,752]. Android: `assertNotVisible` su questo testo risulta COMPLETED con ' +
      'l\'elenco VUOTO e nessuna assenza comunicata (17/17 di /tmp/kv-and-vacuita.yaml).',
    regione: ['Assenze già comunicate', 'Non hai comunicato nessuna assenza per i prossimi giorni.'],
    rimedio:
      '`scrollUntilVisible` con `centerElement: true` sulla zona dell\'elenco PRIMA di ' +
      'asserire, sia in positivo sia in negativo.',
  },
  {
    frammento: 'Assenze già comunicate',
    fonte: { file: 'messages/it/parentServizi.json', chiave: 'attendanceElencoTitolo' },
    schermata: '/parent/attendance, titolo dell\'elenco, a scroll zero',
    piattaforme: ['android'],
    misurato: '2026-08-07',
    prova:
      'Android: `text="ASSENZE GIÀ COMUNICATE" bounds="[0,0][0,0]"` senza scroll, ' +
      '[105,1257][976,1336] dopo uno swipe; nel flow committato l\'asserzione falliva SEMPRE, ' +
      'con l\'app perfettamente funzionante. Su iOS NO: lì il titolo è nell\'albero già a ' +
      'scroll zero ([40,813][213,835]) — le due piattaforme non tagliano la pagina nello ' +
      'stesso punto, e per questo la riga vale solo per Android.',
    regione: ['Assenze già comunicate', 'Non hai comunicato nessuna assenza per i prossimi giorni.'],
    rimedio: '`scrollUntilVisible` sull\'elenco prima delle asserzioni della tappa.',
  },
  {
    frammento: 'Le prese visione vengono registrate automaticamente.',
    fonte: { file: 'messages/it/avvisi.json', chiave: 'footerRiga2' },
    schermata: '/parent/avvisi, footer in fondo alla pagina',
    piattaforme: ['android', 'ios'],
    misurato: '2026-08-07',
    prova:
      'Android: `text="📋 Gli avvisi restano visibili fino alla loro scadenza.&#10;Le prese ' +
      'visione vengono registrate automaticamente." bounds="[0,0][0,0]"`. DUE cause ' +
      'sovrapposte, e la seconda non si cura con lo scroll: `footerRiga1` e `footerRiga2` ' +
      'stanno nello STESSO paragrafo separate da <br/>, quindi il nodo porta il testo unito e ' +
      'il full-match sulla sola seconda riga non riuscirebbe nemmeno in viewport. Su iOS non è ' +
      'stato misurato, ma il footer è l\'ultimo elemento della pagina e su iOS l\'albero ' +
      'espone solo il viewport: fuori dalla piega non c\'è.',
    rimedio:
      'Ancorarsi al sottotitolo dell\'intestazione (avvisi.json → sottotitoloDaGestire / ' +
      'sottotitoloOk / sottotitoloCaricamento), che sta sopra la piega ed esiste solo su ' +
      'quella pagina — coprendo TUTTE le varianti, perché dipende dai dati.',
  },
];

/** La piattaforma di un flow, dal suo prefisso. */
function piattaformaDi(flow: string): 'android' | 'ios' | null {
  if (flow.startsWith('android-')) return 'android';
  if (flow.startsWith('ios-')) return 'ios';
  return null;
}

/** Quanti passi indietro si guarda per trovare lo scroll che apre la zona. */
const FINESTRA_SCROLL = 8;

describe('lock: flow Maestro (le ancore sotto la piega)', () => {
  it('R22a · il registro delle ancore fuori viewport è ancora vero nei cataloghi', () => {
    const scaduti: string[] = [];
    for (const a of ANCORE_FUORI_VIEWPORT) {
      const valore = leggiCatalogo(a.fonte.file)[a.fonte.chiave];
      if (typeof valore !== 'string') {
        scaduti.push(`${a.fonte.file}: la chiave ${a.fonte.chiave} non esiste più`);
        continue;
      }
      if (!contieneTesto(valore, a.frammento)) {
        scaduti.push(
          `${a.fonte.file}:${a.fonte.chiave} = ${JSON.stringify(valore)} non contiene più ` +
            `«${a.frammento}»: la misura del ${a.misurato} riguardava un altro testo. ` +
            'RIMISURARE prima di fidarsi di R22b/R22c.',
        );
      }
    }
    expect(scaduti, 'Registro R22 scaduto: la regola non descrive più i cataloghi.').toEqual([]);
  });

  it('R22b · nessuna asserzione NEGATIVA si regge su un\'ancora mai visibile (vacuità)', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      const piattaforma = piattaformaDi(f);
      if (!piattaforma) continue;
      const p = passi(leggiFlow(f), { annidati: true });
      p.forEach((passo, i) => {
        if (passo.nome !== 'assertNotVisible' && !/notVisible:/.test(passo.corpo)) return;
        for (const a of ANCORE_FUORI_VIEWPORT) {
          if (!a.piattaforme.includes(piattaforma)) continue;
          if (!contieneTesto(passo.corpo, a.frammento)) continue;
          // Unica assoluzione: la zona è stata appena portata in viewport, quindi lì
          // quel testo CI SAREBBE se ci fosse — e la negativa torna a dire qualcosa.
          const prima = p.slice(Math.max(0, i - FINESTRA_SCROLL), i);
          const apertaLaZona = prima.some(
            (x) =>
              x.nome === 'scrollUntilVisible' &&
              (contieneTesto(x.corpo, a.frammento) ||
                (a.regione ?? []).some((r) => contieneTesto(x.corpo, r))),
          );
          if (apertaLaZona) continue;
          colpevoli.push(
            `${f} · ${passo.nome} «${a.frammento}» #${i}: su ${piattaforma} quel nodo non è ` +
              `MAI visibile a scroll zero (${a.prova.slice(0, 120)}…), quindi l'asserzione è ` +
              `vera anche quando non è successo niente. ${a.rimedio}`,
          );
        }
      });
    }
    expect(
      colpevoli,
      'Asserzione VACUA: passa anche quando non è successo niente. È la stessa bugia dei nodi ' +
        'fantasma con un\'altra faccia — il flow dichiara superata una tappa che non ha ' +
        'aperto (mobile-android, 2026-08-07).',
    ).toEqual([]);
  });

  it('R22c · un\'asserzione POSITIVA sotto la piega è preceduta da uno scroll', () => {
    const colpevoli: string[] = [];
    for (const f of tuttiIFlow()) {
      const piattaforma = piattaformaDi(f);
      if (!piattaforma) continue;
      const p = passi(leggiFlow(f), { annidati: true });
      p.forEach((passo, i) => {
        // Lo `scrollUntilVisible` È il rimedio: non si accusa da solo.
        if (passo.nome === 'scrollUntilVisible') return;
        if (passo.nome === 'assertNotVisible' || /notVisible:/.test(passo.corpo)) return;
        if (!['assertVisible', 'extendedWaitUntil', 'tapOn'].includes(passo.nome)) return;
        for (const a of ANCORE_FUORI_VIEWPORT) {
          if (!a.piattaforme.includes(piattaforma)) continue;
          if (!contieneTesto(passo.corpo, a.frammento)) continue;
          const prima = p.slice(Math.max(0, i - FINESTRA_SCROLL), i);
          const scroll = prima.some(
            (x) =>
              x.nome === 'scrollUntilVisible' &&
              (contieneTesto(x.corpo, a.frammento) ||
                (a.regione ?? []).some((r) => contieneTesto(x.corpo, r))),
          );
          if (scroll) continue;
          colpevoli.push(
            `${f} · ${passo.nome} «${a.frammento}» #${i}: misurato fuori dal viewport su ` +
              `${piattaforma} il ${a.misurato}. Senza scroll l'asserzione fallisce SEMPRE, e ` +
              `il collaudo accusa l'app. ${a.rimedio}`,
          );
        }
      });
    }
    expect(
      colpevoli,
      '`extendedWaitUntil: visible` su un nodo fuori viewport scade e basta: su Android il ' +
        'nodo c\'è ma è [0,0][0,0], su iOS non è proprio nell\'albero. Due cause diverse, ' +
        'stesso rosso su un\'app sana (2026-08-07).',
    ).toEqual([]);
  });
});

/**
 * ─── R23 · L'ANCORA CHE COMBACIA CON DUE VOCI DELLO STESSO CATALOGO ────────
 *
 * Collaudo mobile-ios del 2026-08-07, tappa 4 di `ios-percorso-genitore.yaml`:
 * la conferma dell'invio era cercata con `.*Assenza comunicata.*` — e quel testo
 * è una sottostringa dell'`aria-label` del bottone ANNULLA di una riga già in
 * elenco: «Annulla l'assenza comunicata per il {data}»
 * (`parentServizi.json:attendanceAnnullaAria`).
 *
 * Non è un nodo fantasma: è un nodo OMONIMO. Il comando risulta
 * `('COMPLETED', 174, …)` — 174 ms dopo il tap — mentre lo screenshot scattato
 * 76 ms più tardi mostra il bottone ancora in stato «INVIO…»: il flow ha
 * dichiarato riuscito un invio che era ancora in volo.
 *
 * La regola è STATICA e non richiede un device: si compila il selettore come lo
 * compila Maestro (full-match, case-insensitive) e si contano quante voci DELLO
 * STESSO catalogo può soddisfare. Due o più = ancora ambigua.
 *
 * PERIMETRO: le ASSERZIONI, non i tap — la stessa distinzione di R16b, e per la
 * stessa ragione. Un tap su un'ancora omonima produce un difetto RUMOROSO (il
 * tocco va sul nodo sbagliato, non si naviga, e la coppia positiva+negativa che
 * R17 pretende lo fa fallire); un'ASSERZIONE su un'ancora omonima produce il
 * difetto SILENZIOSO — risulta vera sul nodo sbagliato, e il flow dichiara fatto
 * ciò che non è successo. Vietare anche i tap qui costringerebbe a smontare
 * selettori ALTERNATI misurati («Menu · tutte le sezioni|^MENU$», che regge due
 * versioni della WebView) per far tacere il lock: una difesa finta.
 *
 * LIMITI, dichiarati: (a) i segnaposto ICU vengono istanziati in modo grossolano
 * (`{x}` → `3`, del plurale si prende il ramo `other`), quindi una collisione che
 * dipende dal valore esatto può sfuggire; (b) il confronto è per CATALOGO, non per
 * schermata: due voci omonime che non compaiono mai insieme risultano comunque
 * ambigue — ed è voluto, perché quale delle due sia a schermo dipende dai dati.
 */
const CATALOGHI_R23 = [
  'messages/it/parentServizi.json',
  'messages/it/home.json',
  'messages/it/nav.json',
  'messages/it/avvisi.json',
];

/**
 * Le ALTERNATIVE di un selettore, valutate una per una.
 *
 * `A|B` in Maestro è un selettore che combacia con A **oppure** con B, e le due
 * rami vanno giudicati separatamente: «Menu · tutte le sezioni|^MENU$» è la difesa
 * MISURATA contro le due esposizioni della WebView (109 e 150), e giudicarla
 * come un blocco unico la farebbe risultare ambigua — un ramo pesca il testo
 * corto, l'altro quello lungo — spingendo a smontarla per far tacere il lock.
 * Le alternative che non compilano da sole (parentesi a cavallo del `|`) vengono
 * scartate dal `try/catch` di `combaciaComeMaestro`.
 */
function alternativeDi(selettore: string): string[] {
  return selettore.includes('|') ? selettore.split('|') : [selettore];
}

/** Il valore come lo vede l'albero: i segnaposto ICU istanziati alla buona. */
function comeARuntime(valore: string): string {
  const plurale = valore.match(/other\s*\{([^{}]*)\}/);
  const base = plurale ? plurale[1] : valore;
  return base.replace(/\{[^{}]*\}/g, '3').replace(/#/g, '3').trim();
}

describe('lock: flow Maestro (le ancore omonime dello stesso catalogo)', () => {
  it('R23 · nessuna ancora dei percorsi genitore combacia con due voci dello stesso catalogo', () => {
    const colpevoli: string[] = [];
    for (const f of FLOWS_GENITORE) {
      for (const passo of passi(leggiFlow(f), { annidati: true })) {
        if (passo.nome === 'tapOn') continue;
        for (const sel of tuttiISelettori(`---\n${passo.corpo}`).flatMap(alternativeDi)) {
          for (const file of CATALOGHI_R23) {
            const voci = Object.entries(leggiCatalogo(file))
              .filter((e): e is [string, string] => typeof e[1] === 'string')
              .filter(([, v]) => combaciaComeMaestro(sel, comeARuntime(v)));
            if (voci.length < 2) continue;
            // Il difetto ha una forma precisa: l'ancora è INGOIATA da una voce più lunga
            // dello stesso catalogo («Assenza comunicata» dentro «Annulla l'assenza
            // comunicata per il …»). Due voci IDENTICHE che combaciano — «Menu» del tab e
            // «Menu» del titolo del foglio — sono un'altra malattia, quella dei nodi
            // omonimi, e ha già i suoi lock (R4, R16): qui produrrebbe solo rumore, e il
            // rumore si paga smontando difese misurate per far tacere il gate.
            for (const [kCorto, vCorto] of voci) {
              const lungo = voci.find(
                ([k, v]) =>
                  k !== kCorto &&
                  v.length > vCorto.length &&
                  contieneTesto(comeARuntime(v), comeARuntime(vCorto)),
              );
              if (!lungo) continue;
              colpevoli.push(
                `${f} · ${passo.nome} → "${sel}" combacia con ${file}:${kCorto} = ` +
                  `${JSON.stringify(vCorto)}, che è CONTENUTO in ${file}:${lungo[0]} = ` +
                  `${JSON.stringify(lungo[1])}. Con il full-match case-insensitive i due nodi ` +
                  'sono indistinguibili: ancora l\'asserzione a un testo che solo la voce ' +
                  'attesa può produrre.',
              );
            }
          }
        }
      }
    }
    expect(
      colpevoli,
      'Ancora OMONIMA: il match di Maestro è full-match e case-insensitive, e un\'ancora che ' +
        'due voci dello stesso catalogo possono soddisfare non distingue la conferma di un ' +
        'invio dal bottone ANNULLA di una riga già in elenco (mobile-ios, 2026-08-07: ' +
        'COMPLETED a 174 ms con lo schermo che mostrava ancora «INVIO…»).',
    ).toEqual([]);
  });
});
