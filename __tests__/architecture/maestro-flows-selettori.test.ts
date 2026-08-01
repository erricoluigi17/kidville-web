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
  {
    flow: 'android-percorso-genitore.yaml',
    data: '2026-08-01',
    device: 'emulatore KV-play-phone · Android 16 · APK su http://10.0.2.2:3100',
    esito:
      '27 COMPLETED, 0 FAILED, tre esecuzioni di fila (login → Menu → Presenze → Avvisi → Indietro)',
    firma: '84e3a3884c01',
  },
  {
    flow: 'android-percorso-docente.yaml',
    data: '2026-08-01',
    device: 'emulatore KV-play-phone · Android 16 · APK su http://10.0.2.2:3100',
    esito:
      '30 COMPLETED, 0 FAILED, due esecuzioni di fila. La bacheca è stata raggiunta dal ' +
      'ramo B (foglio «Menu»): quel giorno la CTA della dashboard non c\'era, perché ' +
      'dipende da `avvisiRecenti.length > 0`. Il ramo A resta e va riprovato quando ci ' +
      'sono avvisi recenti.',
    firma: '3991f3768c74',
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
];

/**
 * Flow che oggi NON hanno un'esecuzione verde da esibire. È debito, ed è
 * dichiarato: il tetto può solo scendere.
 */
const FLOW_SENZA_ESECUZIONE_VERDE: { flow: string; motivo: string }[] = [
  {
    flow: 'ios-percorso-genitore.yaml',
    motivo:
      'Collaudo mobile-ios del 2026-07-31: ROSSO al 13° comando («Avvisi» non visibile) ' +
      'su iPhone 17 Pro Max/iOS 26.2 servito da `next dev`. Un flow equivalente scritto ' +
      'al momento è passato 27/27: il sospetto è l\'ambiente (dev server che ricarica la ' +
      'WebView), non i selettori. Va rifatto con una build di produzione.',
  },
  {
    flow: 'ios-percorso-docente.yaml',
    motivo:
      'Stesso collaudo: ROSSO su «Buongiorno!», che è un saluto ORARIO — alle 22:07 la ' +
      'pagina dice «Buonasera!». È un selettore fragile per costruzione, non una misura ' +
      'mancante: va sostituito con un ancoraggio stabile e poi rieseguito.',
  },
  {
    flow: 'ios-percorso-segreteria.yaml',
    motivo:
      'Stesso collaudo: ROSSO al 13° comando («Dashboard Direzione» non visibile), due ' +
      'esecuzioni su due. Da rifare su build di produzione prima di dire se è l\'app o il flow.',
  },
  {
    flow: 'android-screenshot-playstore.yaml',
    motivo:
      'Ultima esecuzione nota 2026-07-28; non ri-misurato nel ciclo del 2026-07-31/08-01. ' +
      'Contiene anche una spiegazione oggi smentita (vedi la deroga in AFFERMAZIONI_SMENTITE): ' +
      'chi lo riesegue corregga entrambe le cose e tolga questa riga.',
  },
];

const TETTO_FLOW_SENZA_ESECUZIONE_VERDE = 4;

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
      expect(
        tuttiISelettori(leggiFlow(f)),
        `${f}: nessun riferimento al tab «Menu» della bottom-nav. Il selettore vivo è ` +
          'l\'aria-label «Menu · tutte le sezioni» (messages/it/nav.json → ariaMenu).',
      ).toContain('Menu · tutte le sezioni');
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
