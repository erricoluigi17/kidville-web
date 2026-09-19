// @vitest-environment node
/**
 * LOCK · la scadenza di un AVVISO si confronta in UN POSTO SOLO.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * Fino al 2026-09-19 la domanda «questo avviso è scaduto?» aveva due risposte
 * diverse a due file di distanza:
 *
 *   · il feed dei genitori — `const oggi = new Date().toISOString().split('T')[0]`
 *     e poi `a.scadenza < oggi`, cioè un confronto **fra stringhe** contro il
 *     giorno **UTC**. Fra le 00:00 e le 02:00 italiane il server è ancora «ieri»,
 *     quindi un avviso scaduto restava in bacheca un giorno in più;
 *   · `AvvisoCard.tsx` — `new Date(avviso.scadenza) < new Date()`, cioè mezzanotte
 *     UTC misurata sull'**orologio del dispositivo**: dalle 02:00 in poi la card si
 *     dichiarava scaduta per ventidue ore su ventiquattro dell'ultimo giorno utile,
 *     e un tablet con la data sbagliata mostrava bottoni che il server rifiutava.
 *
 * Nessuna delle due era rotta *da sola*. Ed è il punto: una regola che vive in più
 * di un posto non si rompe, **diverge** — e la divergenza non ha un errore, ha un
 * millisecondo. Questo repo l'ha già pagata due volte sugli avvisi
 * (`classiMancantiNellaSede` nata nel POST e mai arrivata al PUT: 10 alunni, 10
 * genitori, **0 raggiunti**; il tetto del titolo chiuso sui promemoria e lasciato
 * aperto sugli avvisi).
 *
 * L'arbitro è `@/lib/avvisi/scadenze` — `avvisoScaduto`, `adesioniChiuse`,
 * `risolviScadenze` — e il suo riquadro «LA SCADENZA È L'ULTIMO ISTANTE VALIDO,
 * INCLUSO» elenca i quattro posti che devono usare lo stesso operatore. Oggi il
 * confronto a mano era in un posto; domani, senza questo file, sarebbe in cinque.
 *
 * ─── COSA VIETA, ESATTAMENTE ────────────────────────────────────────────────
 *
 * Su **tutto `src/`**, fuori da `@/lib/avvisi/scadenze`:
 *
 *  1. una scadenza di avviso — `scadenza_avviso`, `scadenza_adesione`,
 *     `scadenzaAvviso`, `scadenzaAdesione`, `scadenzaEffettiva` e i loro derivati —
 *     come operando di `<`, `>`, `<=`, `>=`;
 *  2. la stessa passata a `Date.parse(…)` o a `new Date(…)` per essere confrontata;
 *  3. dentro i file degli avvisi, anche la colonna STORICA `.scadenza` messa
 *     accanto a un operatore relazionale — che è la forma letterale del difetto
 *     di `AvvisoCard.tsx:91`.
 *
 * Non vieta i FILTRI del database (`.gte('scadenza_avviso', adesso)`): lì il
 * confronto lo fa Postgres, e l'operatore giusto è pinnato da
 * `__tests__/api/avvisi-feed-scadenza-istante.test.ts` e dal suo gemello sul
 * promemoria. Un `.gte(…)` è una stringa di metodo, non un operatore del
 * linguaggio, e non viene mai catturato da queste regole.
 *
 * ─── COME LEGGE ─────────────────────────────────────────────────────────────
 *
 * ⚠️ Un test che legge un file come TESTO legge anche i commenti, e questo repo
 * ne è pieno di scritti apposta: la testata di `scadenze.ts` cita per esteso
 * `new Date(avviso.scadenza) < new Date()` per spiegare il difetto che chiude, e
 * la route degli avvisi ribatte il vecchio `a.scadenza < oggi` dentro un commento.
 * Una `grep` per riga li scambierebbe per il difetto stesso. Perciò si passa da
 * `mascheraSorgente` (`__tests__/fixtures/sorgente.ts`), che spegne commenti e
 * stringhe **senza spostare un carattere**: gli indici restano quelli veri e il
 * messaggio d'errore può ancora nominare la riga.
 *
 * ─── L'ASSERZIONE DI AUTOINGANNO ────────────────────────────────────────────
 *
 * Se lo scanner smette di trovare i nomi che sorveglia — rinominati, spostati,
 * spariti — questo lock **cade** invece di passare su un perimetro vuoto. Un lock
 * che non può più fallire è una decorazione, e una decorazione che dice «un motore
 * solo» è peggio di niente: fa smettere di guardare.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mascheraSorgente, fileSorgente, fineParentesi, riga } from '../fixtures/sorgente';

const RADICE = path.join(__dirname, '..', '..');
const SRC = path.join(RADICE, 'src');

/** L'ARBITRO: l'unico file autorizzato a confrontare una scadenza di avviso. */
const ARBITRO = path.join('src', 'lib', 'avvisi', 'scadenze.ts');

/**
 * I DEBITI DICHIARATI — adesso NESSUNO, e la casella vuota è il punto.
 *
 * Fino al 2026-09-19 qui dentro c'era `src/components/features/avvisi/AvvisoCard.tsx`,
 * che faceva `new Date(avviso.scadenza) < new Date()`: il server calcolava già i
 * due booleani giusti (`scaduto`, `adesioni_chiuse`, in `GET /api/avvisi`) ma la
 * card non li riceveva, perché la sua interfaccia `Avviso` non li dichiarava.
 *
 * La card adesso li riceve (`avviso.scaduto === true`, `AvvisoCard.tsx:205-206`) e
 * non confronta più niente — quindi il lock è diventato ROSSO **anche allora**,
 * chiedendo di cancellare questa riga. È il terzo punto per cui l'elenco è stato
 * scritto ESATTO e non come un `contains`, ed è successo davvero: un debito chiuso
 * non deve poter restare scritto come aperto.
 *
 * Con l'elenco vuoto il divieto non ha più eccezioni in nessun punto di `src/`.
 * Chi riapre un debito qui dentro scriva ANCHE perché, con la data: una riga in
 * questo array è l'unico posto del repo in cui un confronto di scadenza scritto a
 * mano è tollerato, e il modo in cui quel difetto è arrivato fin qui la prima
 * volta è che nessuno lo vedeva.
 */
const DEBITI_DICHIARATI: string[] = [];

/**
 * I nomi che DICONO «scadenza di un avviso». Deliberatamente ristretti: nel repo
 * ci sono decine di scadenze che non c'entrano — la rata, la fattura, l'armadietto,
 * il documento — e un lock che le pescasse tutte sarebbe disattivato entro una
 * settimana. Qui contano le due colonne del cantiere A2 e i nomi TypeScript che
 * le trasportano.
 */
const NOME_SCADENZA_AVVISO =
    /\b(?:[A-Za-z_$][\w$]*)?(?:scadenza(?:_avviso|_adesione)|[sS]cadenzaAvviso|[sS]cadenzaAdesione|[sS]cadenzaEffettiva)[\w$]*\b/g;

/**
 * La scadenza «nuda» — la colonna STORICA e le variabili che la trasportano —
 * sorvegliata SOLO dentro i file degli avvisi.
 *
 * Non basta `\.scadenza` (l'accesso a proprietà): una forma con cui il difetto
 * rientra è la VARIABILE LOCALE, `const scadenza = scadenzaEffettiva(a)` seguito
 * da un confronto a mano, e quella qui si prende.
 *
 * ⚠️ MA È UN LIMITE, NON UNA COPERTURA, e va scritto come limite. Il nome deve
 * essere **esattamente** `scadenza`, e il file deve essere «di avvisi». Tutto il
 * resto passa:
 *
 *     const s = avviso.scadenza_avviso;   if (s < oggi) …        ← NON catturato
 *     const quando = scadenzaEffettiva(a); if (quando < oggi) …  ← NON catturato
 *     const t = row.scadenza_adesione;    if (adessoISO > t) …   ← NON catturato
 *
 * Un'analisi testuale non sa che `s` è una scadenza: per saperlo bisognerebbe
 * seguire l'assegnazione, cioè avere un type-checker, e questo file non ne ha
 * uno. Ciò che il lock garantisce è la NOMENCLATURA — nessun confronto scritto a
 * mano *su un nome che dice «scadenza di avviso»* — non la semantica. Chi legge
 * «un motore solo» deve sapere dove finisce la promessa: un lock che promette
 * più di quanto mantiene è **esattamente** la cosa che questo lock esiste per
 * impedire, ed è il modo in cui `AvvisoCard.tsx:91` è sopravvissuta in piena
 * vista per mesi.
 *
 * Fuori dai file degli avvisi questo nome significa tutt'altro (la rata, la
 * fattura, l'armadietto), e infatti lì non si guarda: un lock che pescasse ogni
 * «scadenza» del repo verrebbe spento in una settimana. `scadenza_avviso` e
 * `scadenza_adesione` non vengono ricatturati qui, perché `\b` non spezza prima
 * di un `_`.
 */
const NOME_SCADENZA_STORICA = /\bscadenza\b/g;

/** Un file «degli avvisi»: quello in cui `.scadenza` non può voler dire altro. */
function fileDiAvvisi(relativo: string): boolean {
    return /(^|[\\/])(avvisi)[\\/]/.test(relativo) || /Avviso[\w-]*\.tsx?$/.test(relativo);
}

type Reperto = { file: string; linea: number; forma: string; frammento: string };

/** Il carattere non-bianco prima di `i`, e il suo indice. */
function primaNonBianco(testo: string, i: number): { c: string; k: number } {
    let k = i - 1;
    while (k >= 0 && /\s/.test(testo[k])) k -= 1;
    return { c: k >= 0 ? testo[k] : '', k };
}

/** Un operando ritagliato: `[da, a)` su `struttura`, col suo operatore e il suo lato. */
type Operando = { op: string; lato: 'SINISTRO' | 'DESTRO'; da: number; a: number };

/** Indice DOPO il delimitatore che chiude quello aperto in `apertura` (`(` o `[`). */
function fineDelimitatore(strut: string, apertura: number): number {
    if (strut[apertura] === '(') return fineParentesi(strut, apertura);
    let livello = 0;
    for (let k = apertura; k < strut.length; k++) {
        if (strut[k] === '[') livello += 1;
        else if (strut[k] === ']') {
            livello -= 1;
            if (livello === 0) return k + 1;
        }
    }
    return strut.length;
}

/** Indice del delimitatore che APRE quello chiuso in `chiusura` (`)`, `]` o `}`). */
function inizioDelimitatore(strut: string, chiusura: number): number {
    const chiusa = strut[chiusura];
    // La graffa serve solo a `aperturaGenerico`, che risale liste di argomenti in
    // cui può comparire un tipo oggetto (`Record<string, { a: 1 }>`).
    const aperta = chiusa === ')' ? '(' : chiusa === ']' ? '[' : '{';
    let livello = 0;
    for (let k = chiusura; k >= 0; k--) {
        if (strut[k] === chiusa) livello += 1;
        else if (strut[k] === aperta) {
            livello -= 1;
            if (livello === 0) return k;
        }
    }
    return 0;
}

/**
 * IL `<` CHE APRE LA LISTA DI ARGOMENTI a cui appartiene la virgola in `virgola`,
 * oppure `-1` se quella virgola non sta dentro un generico.
 *
 * 🔴 PERCHÉ ESISTE. Il `>` che chiude un generico si riconosce dall'operando
 * sinistro: con UN argomento (`Promise<ScadenzaAdesione>`) quell'operando è chiuso
 * dal `<` stesso, e la prova è immediata. Con DUE o più
 * (`Record<string, ScadenzaAvviso>`) l'operando sinistro è chiuso dalla VIRGOLA —
 * `chiusoDa` è `,`, non `<` — e la prova non poteva scattare. Misurate il
 * 2026-09-19, tre forme di codice GIUSTO che il lock dichiarava colpevoli:
 *
 *   · `type M = Record<string, ScadenzaAvviso>` a fine riga, con la riga dopo che
 *     comincia con un identificatore (due varianti: `type …` e `let …`);
 *   · `as Record<string, ScadenzaAvviso> satisfies X`.
 *
 * Nessuna era pericolosa — rosso su codice giusto, mai verde su codice sbagliato —
 * ma `Record<string, ScadenzaAvviso>` è un tipo che qualcuno scriverà, e un lock
 * che fa rosso sul codice giusto è un lock che qualcuno spegne.
 *
 * Si risale la lista con un conteggio bilanciato di `<`/`>`, saltando all'indietro
 * i delimitatori chiusi. Ci si FERMA (e si risponde «non è un generico») su un
 * `(`/`[`/`{` spaiato, su un `;` o su un `=`: sono i confini oltre i quali una
 * virgola non appartiene più a una lista di tipi, ed è ciò che tiene fuori i
 * confronti VERI scritti dopo una virgola — `f(a, adessoISO > x.scadenza_avviso)`
 * si ferma sulla parentesi e resta catturato. Fermarsi è sempre la direzione
 * sicura: non salta nessun divieto, al massimo lascia un falso positivo.
 */
function aperturaGenerico(strut: string, virgola: number): number {
    let livello = 0;
    for (let k = virgola; k >= 0; k -= 1) {
        const c = strut[k];
        if (c === '>') {
            livello += 1;
            continue;
        }
        if (c === '<') {
            if (livello === 0) return k;
            livello -= 1;
            continue;
        }
        if (c === ')' || c === ']' || c === '}') {
            k = inizioDelimitatore(strut, k);
            continue;
        }
        if (c === '(' || c === '[' || c === '{' || c === ';' || c === '=') return -1;
    }
    return -1;
}

/**
 * Ciò che CHIUDE un operando. `(` e `[` non chiudono niente quando si va in
 * avanti (sono una chiamata o un indice: `scadenzaEffettiva(a) >= limite`), e
 * `)` `]` non chiudono niente quando si va indietro — in ciascuna direzione il
 * salto bilanciato viene tentato PRIMA di questa prova.
 */
const TERMINATORE = /[,;{}()[\]&|?:=<>!]/;

/** L'operando che comincia dopo `da` (primo carattere dopo l'operatore). */
function operandoDestro(strut: string, da: number): { da: number; a: number } {
    let k = da;
    // Lo spazio (e l'a capo) PRIMA dell'operando non lo chiude: `adessoISO >\n  x`.
    while (k < strut.length && /\s/.test(strut[k])) k += 1;
    const inizio = k;
    while (k < strut.length) {
        const c = strut[k];
        if (c === '(' || c === '[') {
            k = fineDelimitatore(strut, k);
            continue;
        }
        // `?.` e `!.` fanno parte dell'operando: `avviso?.scadenza_avviso` è UN nome.
        if ((c === '?' || c === '!') && strut[k + 1] === '.') {
            k += 2;
            continue;
        }
        // Una volta cominciato, l'operando finisce alla fine della riga: senza
        // questo, `const x = a > b` seguito da `const scadenzaAvviso = …` avrebbe
        // inghiottito la riga dopo fino al primo `=`, cioè un falso positivo.
        if (c === '\n' || TERMINATORE.test(c)) break;
        k += 1;
    }
    return { da: inizio, a: k };
}

/** L'operando che finisce prima di `opIdx` (indice dell'operatore). */
function operandoSinistro(strut: string, opIdx: number): { da: number; a: number; chiusoDa: number } {
    let k = opIdx - 1;
    while (k >= 0 && /\s/.test(strut[k])) k -= 1;
    const fine = k + 1;
    while (k >= 0) {
        const c = strut[k];
        if (c === ')' || c === ']') {
            k = inizioDelimitatore(strut, k) - 1;
            continue;
        }
        if (c === '.' && (strut[k - 1] === '?' || strut[k - 1] === '!')) {
            k -= 2;
            continue;
        }
        if (c === '\n' || TERMINATORE.test(c)) break;
        k -= 1;
    }
    return { da: k + 1, a: fine, chiusoDa: k };
}

/**
 * TUTTI I CONFRONTI RELAZIONALI DI UN SORGENTE, CON I DUE OPERANDI RITAGLIATI.
 *
 * ─── PERCHÉ SI SCANDISCONO GLI OPERATORI E NON I NOMI ───────────────────────
 *
 * La prima stesura partiva dal NOME e guardava «a destra» e «a sinistra» con due
 * pezzi di codice diversi. La scansione a destra percorreva tutta l'espressione;
 * quella a sinistra si fermava all'adiacenza — saltava spazi e `(`, e **basta**.
 * Il risultato è che il punto di un accesso a proprietà la spegneva del tutto: il
 * match comincia dopo il `.` (`avviso.` non è `[\w$]`), quindi il primo carattere
 * a sinistra era `.`, il ciclo non partiva e la funzione tornava `null`.
 *
 * 🔴 MISURATO IL 2026-09-19 — un file di prova dentro `src/lib/avvisi/` con sei
 * righe, poi cancellato; lo stesso file scandito due volte. L'elenco è il
 * reperto, non un ricordo:
 *
 *                                                          vecchio   corrente
 *   · `adessoISO > avviso.scadenza_avviso` ..............   MUTO      `>` DESTRO
 *   · `adessoISO >= avviso.scadenza_adesione` ...........   MUTO      `>=` DESTRO
 *   · `adessoISO > (nul.scadenza_avviso ?? '')` .........   MUTO      `>` DESTRO
 *   · `new Date() > new Date(a.scadenza)` ...............   MUTO      `>` DESTRO
 *   · `righe.filter((x) => adessoISO <= x.scadenza_avviso)` MUTO      `<=` DESTRO
 *   · `adessoISO > scadenza_avviso` (senza il punto) ....   `>` sin.  `>` DESTRO
 *                                                           ───────   ─────────
 *                                                           1 su 6    6 su 6
 *
 * L'ultima riga è la COPPIA CONTROLLATA, ed è ciò che rende il reperto una
 * misura invece di un'impressione: stesso operatore, stesso nome, stessa riga —
 * cambia **solo** il prefisso `avviso.`. Il vecchio scanner vedeva quella e
 * nient'altro, perché il match comincia dopo il punto e il suo ciclo a sinistra
 * saltava soltanto spazi e `(`: `strut[j]` era `.`, il ciclo non partiva e la
 * funzione tornava `null`. Con cinque di quelle forme in `src/lib/avvisi/` il
 * lock girava `Test Files 1 passed · Tests 6 passed` — verde anche sull'`it` che
 * dichiara «qui il divieto non ha eccezioni». Oggi le nomina tutte e sei, con
 * file, riga e operatore.
 *
 * 🔑 E la prima riga è **la forma dell'arbitro**: `adesso > scadenza` è ciò che
 * `avvisoScaduto` scrive davvero, ed è ciò che l'`it` qui sotto asserisce con
 * `toMatch(/adesso\s*>\s*scadenza/)`. Chi riscrive il confronto a mano copia da
 * lì. Il punto cieco coincideva con il difetto più probabile.
 *
 * 🔑 E il controllo positivo non lo vedeva perché le quattro righe del campione
 * avevano TUTTE l'operatore a destra del nome: un rilevatore provato solo nella
 * direzione in cui funziona è una prova ripetuta quattro volte, non quattro
 * prove. Per questo il campione qui sotto contiene adesso entrambe le direzioni,
 * e l'asserzione è PER RIGA invece che sul totale.
 *
 * ─── COME LEGGE, ADESSO ─────────────────────────────────────────────────────
 *
 * Si scandiscono i `<`/`>` di `struttura` e per ciascuno si ritagliano i DUE
 * operandi fino a un terminatore. La distinzione destra/sinistra sparisce — ed
 * era l'origine del difetto: un nome è vietato se cade dentro l'uno o dentro
 * l'altro, e non esiste più un ramo che può restare indietro rispetto al gemello.
 *
 * Le esclusioni non sono cosmetiche:
 *   · `=>` è una freccia, non un «maggiore»;
 *   · `==`, `===`, `!==` sono uguaglianze: non decidono un ORDINE, e non sono il
 *     difetto che questo file insegue (non hanno `<`/`>`, quindi non entrano);
 *   · `<<`/`>>` sono scorrimenti di bit;
 *   · un `<`/`>` conta solo se seguito da `=` o da uno spazio: `<span`, `</span>`,
 *     `<Componente`, `useState<X>(…)` non sono operatori, e trattarli come tali
 *     riempirebbe l'elenco di falsi positivi proprio nei file delle card;
 *   · un confronto ha DUE operandi: se uno dei due è vuoto non è un confronto ma
 *     la chiusura di un generico (`Record<string, ScadenzaAvviso> = {}`) o di un
 *     tag (`<Card>` seguito da `{`). Questa sola condizione toglie una classe di
 *     falsi positivi che la vecchia scansione «a destra» produceva davvero;
 *   · e se l'operando sinistro finisce contro un `<` che non è a sua volta un
 *     operatore, quel `>` è la sua chiusura: `</Card>`, `Promise<void>`.
 *
 * ⚠️ IL LIMITE, DETTO — E MISURATO, NON RACCONTATO.
 *
 * Un `<`/`>` conta come operatore se è STACCATO A DESTRA (segue `=` o uno spazio)
 * oppure — **solo il `>`** — se è staccato A SINISTRA. Resta fuori `a<b`, `a>b`
 * (incollati da entrambi i lati) e `a <b` (un `<` incollato al suo operando
 * destro).
 *
 * Fino al 2026-09-19 la condizione guardava **solo** il carattere dopo
 * l'operatore, e il limite era scritto più stretto di quanto fosse: diceva «la
 * forma SENZA spazi — `a<b`», ma la condizione vera (`dopo !== '=' &&
 * !/\s/.test(dopo)`) lasciava passare anche `adessoISO >avviso.scadenza_avviso`,
 * cioè lo spazio SOLO PRIMA. Quella forma adesso si prende.
 *
 * 🔑 L'ASIMMETRIA DEL `<` NON È UNA DIMENTICANZA: È UN PREZZO MISURATO. Un `<`
 * incollato a un identificatore è un TAG, non un confronto (`return <div …`,
 * `</Card>`), e per un'analisi testuale le due cose sono la stessa cosa.
 * Misurato il 2026-09-19 sullo `src/` vero, contando gli operandi che questa
 * funzione ritaglia:
 *
 *                                                    operandi     costo
 *   · condizione vecchia (solo a destra) .........    5.020         —
 *   · + spazio a sinistra sul solo `>` ...........    5.032      +12  (+0,2%)
 *   · + spazio a sinistra anche sul `<` ..........    5.350     +330  (+6,6%)
 *   · + `<` anche davanti a `/` (`</Card>`) ......    5.600     +580 (+11,6%)
 *
 * I 330 sono intervalli FINTI ritagliati dentro il JSX (`return` ⟷ `div
 * className`), e basta che ci cada dentro la parola `scadenza` di un testo
 * italiano perché il lock diventi rosso su codice giusto — che è il modo in cui
 * un lock viene spento. Dodici intervalli su cinquemila sono un altro ordine di
 * grandezza, e sono il prezzo di chiudere la forma misurata.
 *
 * 🔴 E NON C'È UNA MITIGAZIONE ESTERNA DA CITARE — QUESTO FILE NE CITAVA UNA CHE
 * NON ESISTE. Fino al 2026-09-19 qui stava scritto che «Prettier in questo repo
 * mette gli spazi attorno agli operatori binari, quindi la forma non compare».
 * È falso: Prettier non ha un file di configurazione, non è uno script di
 * `package.json`, non è una dipendenza dichiarata e non è nel gate — sta in
 * `node_modules` solo come dipendenza di qualcun altro, e nessuno lo esegue.
 * Provato: `npx eslint <file con la forma> --max-warnings 0` su
 * `adessoISO >avviso.scadenza_avviso` esce **0, senza una riga di output**.
 * La regola che la prenderebbe, `space-infix-ops`, oggi NON è accesa: accenderla
 * costerebbe 6 violazioni in 2 file (misurate il 2026-09-19 con
 * `npx eslint . --rule '{"space-infix-ops":"error"}'`), tutte in file di altri
 * cantieri, cioè un gate rosso per codice non nostro — ed è per di più una regola
 * deprecata in ESLint 9. Un limite spiegato con un fatto non verificato chiude la
 * discussione invece di aprirla, e chi legge smette di cercare: è lo stesso
 * difetto che questo cantiere ha già corretto una volta, due giri fa.
 */
function relazionali(strut: string): Operando[] {
    const out: Operando[] = [];
    for (let k = 0; k < strut.length; k += 1) {
        const c = strut[k];
        if (c !== '<' && c !== '>') continue;
        if (strut[k - 1] === '<' || strut[k - 1] === '>') continue; // `<<`, `>>`, `>>>`, `<>`
        const dopo = strut[k + 1] ?? '';
        // Staccato a DESTRA (`a > b`, `a >= b`) oppure — solo il `>` — staccato a
        // SINISTRA (`adessoISO >avviso.scadenza_avviso`, la forma che fino al
        // 2026-09-19 passava indenne). Il perché il `<` non segue, con i numeri,
        // sta in «IL LIMITE, DETTO» qui sopra.
        const staccatoADestra = dopo === '=' || /\s/.test(dopo);
        const staccatoASinistra = /\s/.test(strut[k - 1] ?? '');
        if (!staccatoADestra && !(c === '>' && staccatoASinistra)) continue;
        const prima = primaNonBianco(strut, k);
        if (c === '>' && prima.c === '=' && !['=', '!', '<', '>'].includes(strut[prima.k - 1])) continue;
        const op = dopo === '=' ? `${c}=` : c;
        const sin = operandoSinistro(strut, k);
        const des = operandoDestro(strut, dopo === '=' ? k + 2 : k + 1);
        if (sin.da >= sin.a || des.da >= des.a) continue;
        // Il `>` che CHIUDE un generico non è un «maggiore». Con un argomento solo
        // l'operando sinistro è chiuso dal `<` stesso; con due o più è chiuso dalla
        // VIRGOLA, e il `<` va ritrovato risalendo la lista (`aperturaGenerico`).
        // In entrambi i casi la prova è la stessa: quel `<` è a sua volta un
        // operatore? Se no, questo `>` lo chiude.
        const apre =
            strut[sin.chiusoDa] === '<'
                ? sin.chiusoDa
                : strut[sin.chiusoDa] === ','
                  ? aperturaGenerico(strut, sin.chiusoDa)
                  : -1;
        if (apre >= 0) {
            const d = strut[apre + 1] ?? '';
            if (d !== '=' && !/\s/.test(d)) continue;
        }
        out.push({ op, lato: 'SINISTRO', da: sin.da, a: sin.a });
        out.push({ op, lato: 'DESTRO', da: des.da, a: des.a });
    }
    return out;
}

// Memoria di UN solo sorgente: `scandisci` chiama `cerca` due volte sullo stesso
// file, e il campione dei due `it` di autoinganno è sempre lo stesso testo.
// Tenerli tutti significherebbe trascinarsi in memoria l'intero `src/`.
let ultimoTesto: string | null = null;
let ultimiOperandi: Operando[] = [];
function operandiDi(strut: string): Operando[] {
    if (strut !== ultimoTesto) {
        ultimoTesto = strut;
        ultimiOperandi = relazionali(strut);
    }
    return ultimiOperandi;
}

/** Il token `[inizio, fine)` è operando di un confronto relazionale? */
function toccatoDaRelazionale(strut: string, inizio: number, fine: number): string | null {
    for (const o of operandiDi(strut)) {
        if (o.da <= inizio && fine <= o.a) return `${o.op} · operando ${o.lato}`;
    }
    return null;
}

/**
 * `Date.parse(NOME`: la conversione che esiste SOLO per confrontare.
 *
 * ⚠️ `new Date(NOME)` NON è qui, e la distinzione è misurata sul repo vero:
 * `formattaIstante(new Date(avviso.scadenza), locale)` è come si MOSTRA una data
 * a schermo, e ne esistono due occorrenze legittime nelle pagine del cockpit.
 * Vietarlo avrebbe reso questo lock rosso su codice giusto, cioè lo avrebbe fatto
 * spegnere. `Date.parse` invece restituisce un NUMERO: non si formatta, si
 * confronta — ed è esattamente il gesto che `avvisoScaduto` esiste per contenere.
 * Il caso misto (`new Date(x) < new Date()`, la riga storica di `AvvisoCard`) lo
 * prende comunque `toccatoDaRelazionale`, che vede l'operatore dopo la parentesi.
 */
function convertitaAMano(strut: string, inizio: number): string | null {
    const finestra = strut.slice(Math.max(0, inizio - 40), inizio);
    if (/Date\.parse\s*\(\s*[\w.?!]*$/.test(finestra)) return 'Date.parse(…)';
    return null;
}

function scandisci(): Reperto[] {
    const fuori: Reperto[] = [];
    for (const assoluto of fileSorgente(SRC)) {
        const relativo = path.relative(RADICE, assoluto);
        if (relativo === ARBITRO) continue;
        const src = fs.readFileSync(assoluto, 'utf8');
        const { senzaCommenti, struttura } = mascheraSorgente(src);

        const cerca = (forma: RegExp, etichetta: string) => {
            forma.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = forma.exec(senzaCommenti)) !== null) {
                const inizio = m.index;
                const fine = m.index + m[0].length;
                const rel = toccatoDaRelazionale(struttura, inizio, fine);
                const conv = convertitaAMano(struttura, inizio);
                if (!rel && !conv) continue;
                fuori.push({
                    file: relativo,
                    linea: riga(src, inizio),
                    forma: etichetta,
                    frammento: `${m[0]} — ${[rel, conv].filter(Boolean).join(' + ')}`,
                });
            }
        };

        cerca(NOME_SCADENZA_AVVISO, 'scadenza di avviso');
        if (fileDiAvvisi(relativo)) cerca(NOME_SCADENZA_STORICA, 'colonna storica `scadenza`');
    }
    return fuori;
}

const REPERTI = scandisci();

describe('LOCK · autoinganno — lo scanner vede ancora qualcosa', () => {
    it('i nomi sorvegliati esistono ancora, fuori dall’arbitro', () => {
        // Se `scadenza_avviso`/`scadenza_adesione` sparissero da `src/` (rinominati,
        // o il cantiere disfatto), il divieto qui sotto sarebbe verde su un
        // perimetro VUOTO — cioè non sarebbe più un divieto.
        const conNomi = fileSorgente(SRC).filter((f) => {
            if (path.relative(RADICE, f) === ARBITRO) return false;
            const { senzaCommenti } = mascheraSorgente(fs.readFileSync(f, 'utf8'));
            NOME_SCADENZA_AVVISO.lastIndex = 0;
            return NOME_SCADENZA_AVVISO.test(senzaCommenti);
        });
        expect(
            conNomi.length,
            'Nessun file di `src/` nomina più una scadenza di avviso: o il cantiere A2 è ' +
                'stato smontato, o questo lock sta sorvegliando nomi che non esistono più.',
        ).toBeGreaterThan(2);
    });

    it('l’ARBITRO esiste e confronta davvero (altrimenti «un motore solo» non ha motore)', () => {
        const arbitro = fs.readFileSync(path.join(RADICE, ARBITRO), 'utf8');
        const { struttura } = mascheraSorgente(arbitro);
        expect(struttura, 'in `scadenze.ts` non si confronta più niente').toMatch(/adesso\s*>\s*scadenza/);
        expect(struttura).toMatch(/Date\.parse\s*\(/);
    });

    it('lo scanner SA riconoscere il difetto che insegue (OGNI riga del campione)', () => {
        // Un rilevatore mai visto scattare non è un rilevatore — e un rilevatore
        // provato solo nella direzione in cui funziona è una prova ripetuta N
        // volte, non N prove. Fino al 2026-09-19 le quattro righe di questo
        // campione avevano TUTTE l'operatore a destra del nome: il punto cieco
        // dello scanner coincideva con il punto cieco del suo controllo positivo,
        // e cinque forme con l'operatore a SINISTRA passavano indenni (l'elenco
        // misurato sta nella testata di `relazionali`).
        const righe = [
            // ── operatore a DESTRA del nome ──────────────────────────────────
            // la riga vera di `AvvisoCard.tsx` prima della correzione…
            'const isExpired = avviso.scadenza && new Date(avviso.scadenza) < new Date();',
            'if (a.scadenza_avviso < oggi) return false',
            'const morto = Date.parse(scadenzaAdesione) <= adesso',
            'return scadenzaEffettiva(a) >= limite',
            // ── operatore a SINISTRA del nome: le cinque forme misurate, che
            //    l'adiacenza semplice non vedeva perché si fermava sul `.` ─────
            // 🔑 questa è la forma dell'ARBITRO (`adesso > scadenza`), cioè quella
            //    che un successore copia dal riquadro di `scadenze.ts`
            'const scaduto = adessoISO > avviso.scadenza_avviso',
            'const chiuse = adessoISO >= avviso.scadenza_adesione',
            "const s = adessoISO > (avviso.scadenza_avviso ?? '')",
            // `AvvisoCard:91` con gli operandi scambiati
            'const card = new Date() > new Date(a.scadenza)',
            'const vivi = righe.filter((x) => adessoISO <= x.scadenza_avviso)',
            // ── la COPPIA CONTROLLATA della forma dell'arbitro: stesso operatore,
            //    stesso nome, cambia solo il prefisso `avviso.` ────────────────
            'const nudo = adessoISO > scadenza_avviso',
            // ── la spaziatura, che fino al 2026-09-19 bastava a sfuggire ──────
            // 🔑 SPAZIO SOLO PRIMA. Il limite dichiarato diceva «la forma senza
            //    spazi, `a<b`», ma la condizione guardava solo il carattere DOPO
            //    l'operatore: questa riga passava indenne, ed è la stessa forma
            //    dell'arbitro con un carattere di meno.
            'const stretto = adessoISO >avviso.scadenza_avviso',
            'const anche = adessoISO >=avviso.scadenza_adesione',
            // ── un confronto VERO dopo una virgola: l'operando sinistro è chiuso
            //    da `,` esattamente come in `Record<string, X>`, e la risalita che
            //    scusa il generico NON deve scusare anche questo ────────────────
            'const arg = confronta(a, adessoISO > avviso.scadenza_avviso)',
        ];
        const campione = righe.join('\n');
        const { senzaCommenti, struttura } = mascheraSorgente(campione);

        const visti = new Map<number, string[]>();
        for (const forma of [NOME_SCADENZA_AVVISO, NOME_SCADENZA_STORICA]) {
            forma.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = forma.exec(senzaCommenti)) !== null) {
                const motivo =
                    toccatoDaRelazionale(struttura, m.index, m.index + m[0].length) ??
                    convertitaAMano(struttura, m.index);
                if (!motivo) continue;
                const n = riga(campione, m.index);
                visti.set(n, [...(visti.get(n) ?? []), `${m[0]} — ${motivo}`]);
            }
        }

        // Per RIGA e non sul totale: un conteggio complessivo resta verde anche se
        // una forma sparisce, purché un'altra ne porti due. È il modo in cui questo
        // controllo positivo ha già mentito una volta.
        const mute = righe.map((t, i) => `${i + 1}: ${t}`).filter((_, i) => !visti.has(i + 1));
        expect(
            mute,
            'lo scanner NON riconosce più queste forme — sono confronti di scadenza scritti ' +
                'a mano, e sono le stesse che il 2026-09-19 gli passavano davanti:',
        ).toEqual([]);
    });

    it('…e NON scatta su ciò che è lecito (filtri del database, assegnazioni, frecce)', () => {
        // Controllo positivo all'incontrario: se scattasse anche qui, il lock
        // verrebbe spento entro una settimana e non proteggerebbe più niente.
        const innocenti = [
            "query = query.gte('scadenza_avviso', adessoISO)",
            'const scadenzaAvviso = istanteDaLocale(valore)',
            'righe.map((a) => scadenzaEffettiva(a))',
            'scadenza_adesione: scad.scadenzaAdesione,',
            'if (scadenza_avviso !== undefined && scadenza_avviso !== null) {',
            // Il `>` che CHIUDE un generico non è un «maggiore», e fino al
            // 2026-09-19 la scansione «a destra» lo prendeva per tale: `>` seguito
            // da uno spazio, nome subito prima. Adesso lo escludono due condizioni
            // indipendenti — l'operando destro è vuoto, e quello sinistro finisce
            // contro un `<` che non è un operatore.
            'const mappa: Record<string, ScadenzaAvviso> = {}',
            'function leggi(): Promise<ScadenzaAdesione> {',
            // ⚠️ LE TRE FORME MISURATE IL 2026-09-19, e la ragione per cui la riga
            // qui sopra non bastava: lì il `= {}` lascia l'operando destro VUOTO,
            // e il falso positivo muore per quello. Qui l'operando destro c'è
            // (`const`, `indice`, `satisfies`), e con DUE argomenti di generico
            // l'operando sinistro è chiuso dalla VIRGOLA — non dal `<` — quindi
            // la prova «chiude un generico» non poteva scattare. Adesso il `<` si
            // ritrova risalendo la lista (`aperturaGenerico`).
            'type MappaScadenze = Record<string, ScadenzaAvviso>',
            'const conteggio = 0',
            'let indice: Record<string, ScadenzaAdesione>',
            'indice = {}',
            'const m = grezzo as Record<string, ScadenzaAvviso> satisfies MappaScadenze',
            // Il `>` che chiude un TAG, con l'a capo che lo fa sembrare un operatore.
            '<Card>',
            '  {formattaIstante(avviso.scadenza_avviso)}',
            '</Card>',
        ].join('\n');
        const { senzaCommenti, struttura } = mascheraSorgente(innocenti);
        NOME_SCADENZA_AVVISO.lastIndex = 0;
        let m: RegExpExecArray | null;
        const falsi: string[] = [];
        while ((m = NOME_SCADENZA_AVVISO.exec(senzaCommenti)) !== null) {
            const motivo =
                toccatoDaRelazionale(struttura, m.index, m.index + m[0].length) ??
                convertitaAMano(struttura, m.index);
            if (motivo) falsi.push(`${m[0]} (${motivo})`);
        }
        expect(falsi, 'lo scanner scatta su codice lecito: sarebbe disattivato entro una settimana').toEqual([]);
    });
});

describe('LOCK · nessuno confronta una scadenza di avviso fuori da `@/lib/avvisi/scadenze`', () => {
    it('l’elenco dei confronti a mano è ESATTAMENTE quello dichiarato', () => {
        const file = [...new Set(REPERTI.map((r) => r.file))].sort();
        const dettaglio = REPERTI.map((r) => `  · ${r.file}:${r.linea} — ${r.frammento}`).join('\n');
        expect(
            file,
            'Confronti di scadenza scritti a mano fuori da `@/lib/avvisi/scadenze`:\n' +
                `${dettaglio}\n\n` +
                'Se ne hai AGGIUNTO uno: usa `avvisoScaduto` / `adesioniChiuse` / `risolviScadenze`. ' +
                'La regola è «la scadenza è l\'ultimo istante valido, INCLUSO» e vive in quel ' +
                'modulo insieme ai suoi tre gemelli SQL — riscriverla a mano significa, ogni ' +
                'volta, un millisecondo di differenza fra ciò che la bacheca mostra e ciò che ' +
                'il database accetta.\n' +
                'Se ne hai TOLTO uno (per esempio: AvvisoCard passa ai booleani del server): ' +
                'cancella la sua riga da `DEBITI_DICHIARATI` in questo file. L\'elenco è esatto ' +
                'apposta, perché un debito chiuso non deve poter restare scritto come aperto.',
        ).toEqual(DEBITI_DICHIARATI);
    });

    it('nessun confronto a mano è entrato nelle ROUTE degli avvisi o in `@/lib/avvisi`', () => {
        // Il perimetro dove il difetto è già nato due volte: il feed (che lo aveva
        // scritto fra stringhe) e il promemoria. Qui il divieto non ha mai avuto
        // eccezioni — nemmeno quando `DEBITI_DICHIARATI` ne conteneva una — e
        // resta un `it` a parte proprio per quello: se un giorno una riga tornasse
        // in quell'elenco, questa asserzione continuerebbe a dire di no per le
        // rotte degli avvisi e per `@/lib/avvisi`.
        const server = REPERTI.filter(
            (r) => r.file.startsWith(path.join('src', 'app', 'api', 'avvisi')) || r.file.startsWith(path.join('src', 'lib', 'avvisi')),
        );
        expect(server.map((r) => `${r.file}:${r.linea} ${r.frammento}`)).toEqual([]);
    });
});
