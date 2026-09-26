import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Lock sui CATCH MUTI — la difesa che impedisce alla categoria di ricrescere.
 *
 * LA STORIA. AGENTS.md regola 6 vieta il `catch` che non logga da quando esiste il documento,
 * eppure al collaudo del 2026-07-31 il repo ne conteneva 87: `.catch(() => {})` e `catch {}`
 * sparsi quasi tutti sulle fetch delle pagine di dashboard e dei componenti feature — cioè
 * esattamente il canale su cui un genitore vede «la pagina non si riempie» e l'assistenza non
 * ha niente da leggere. Nessuno di loro era nuovo: la disciplina di chi scriveva aveva retto,
 * il debito no. Ed è normale che sia andata così: **la regola 6 non aveva un lock**, viveva
 * solo nella buona volontà, e una regola senza gate non è una regola, è un auspicio.
 *
 * COME È FATTA LA DIFESA. Due pezzi che si coprono a vicenda, di proposito:
 *
 *  1. **ESLint** (`no-restricted-syntax` in `eslint.config.mjs`) vieta il pattern in TUTTO
 *     `src/`, tranne che nei file elencati nell'allowlist qui sotto. È ciò che ferma il catch
 *     muto in un file NUOVO, prima ancora del commit.
 *  2. **Questo test** conta le occorrenze dei file in allowlist e pretende che il numero
 *     COMBACI. È ciò che ferma il catch muto in un file VECCHIO — dove ESLint, per forza di
 *     cose, tace. E pretende che una voce bonificata venga tolta: l'allowlist può solo
 *     rimpicciolirsi, e i due tetti costanti qui sotto scendono con lei.
 *
 * Senza (1) il debito ricresce nei file nuovi; senza (2) i 53 file esentati diventerebbero un
 * porto franco. Nessuno dei due da solo basta.
 *
 * PERCHÉ IL CONTEGGIO E NON LA RIGA. Le righe si spostano a ogni modifica sopra di loro: un
 * lock sui numeri di riga sarebbe rosso per motivi che non c'entrano niente, e un lock che
 * suona a vuoto è un lock che si impara a spegnere. Il conteggio si muove solo quando si
 * aggiunge o si toglie un catch muto — che è esattamente l'evento da sorvegliare.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────
 * ⚠️ IL LIMITE DI QUESTO LOCK, misurato il 2026-09-19 — leggerlo PRIMA di fidarsi del verde.
 *
 * Il nome dice «catch muti». Per metà non è vero, e la metà mancante è proprio la forma che
 * AGENTS.md regola 6 CITA fra le due vietate:
 *
 *     «`.catch(() => {})` e `catch { /* ignora *\/ }` sono vietati»
 *
 * Il secondo esempio questo lock NON lo prende. Il motivo è nella misura qui sopra: per le
 * CLAUSOLE i commenti vengono mascherati con `§` (non-spazio) apposta per seguire `no-empty`,
 * che ignora i blocchi contenenti un commento. Risultato: `catch {}` è rosso, e
 * `catch { /* noop *\/ }` — lo stesso silenzio, con una riga di scuse dentro — è verde. Lo ha
 * trovato il 2026-09-19 chi stava bonificando `AvvisiPreview.tsx`: rimettere la versione
 * commentata lasciava il lock a 7/7.
 *
 * Un commento dentro un `catch` NON è un log. Non finisce in `app_log`, non si interroga in
 * SQL, non dice niente a nessuno alle tre di notte. È lo stesso identico silenzio delle email
 * di credenziali da cui nasce la regola 6.
 *
 * QUANTO GRANDE È IL BUCO — misurato il 2026-09-19 su tutto `src/`, escluso il logger:
 * **59 occorrenze in 44 file** (40 fuori allowlist per 55 occorrenze, 4 dentro per 5).
 * I concentratori: `src/lib/auth/logout.ts` (8), `src/lib/pagamenti/solleciti-invio.ts` (3),
 * e poi 1-2 a testa su rotte API, hook di identità, shim nativi, `middleware.ts`,
 * `instrumentation.ts`, `src/lib/supabase/server-client.ts`.
 *
 * PERCHÉ NON È STATO ACCESO QUEL GIORNO. Accendere il criterio esteso significava 59
 * violazioni da bonificare in un colpo solo, quasi tutte in file che questo lavoro non tocca e
 * su cui in quel momento stavano lavorando altri quattro cantieri: avrebbe portato al rosso il
 * gate di un branch lungo per codice di nessuno, e un gate rosso per colpa di terzi è un gate
 * che si impara a spegnere. La scelta è stata **dichiarare il limite invece di nasconderlo**.
 *
 * MA IL NUMERO NON È UN COMMENTO. Questo repo ha già pagato i numeri scritti a mano che
 * invecchiano in silenzio: sotto c'è `MAX_SOLO_COMMENTI`, un tetto monotono decrescente
 * RIMISURATO a ogni run, gemello degli altri due. Non pretende zero — non è quello il momento
 * — ma la categoria non può più CRESCERE, e chi ne bonifica una stringe il tetto. Quando
 * arriverà a zero, le due mascherature si fondono in una e questo riquadro si cancella.
 * ────────────────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');
const ALLOWLIST = path.join(RADICE, 'docs/superpowers/catch-muti-allowlist.json');

/**
 * L'UNICA deroga, la stessa che vale per `no-console`: `src/lib/logging/**` è il logger, e il
 * suo fail-open è VOLUTO e documentato (regola 9: «il logger non deve mai rompere l'app»).
 * Un `.catch(() => {})` lì dentro è la scelta giusta — loggare il fallimento del logging con
 * il logging è il modo più diretto di costruire un ciclo infinito. Non sta in allowlist
 * perché non è debito da smaltire: è un'esenzione permanente, e vive nella config.
 */
const ESENTE = 'src/lib/logging/';

/**
 * TETTI MONOTONI DECRESCENTI. Sono la misura del 2026-08-01, dopo la bonifica dei 5 percorsi
 * che contavano. Si abbassano, mai si alzano: chi bonifica un file toglie la voce e porta giù
 * il numero. Chi si trovasse a doverli ALZARE sta aggiungendo un catch muto, ed è quello il
 * momento di fermarsi, non dopo.
 */
// 52 → 51 e 82 → 81 il 2026-09-06: bonificato `src/app/(dashboard)/parent/page.tsx`, il cui
// `.catch(() => {})` inghiottiva la lettura del nome del bambino sulla home. L'effetto era
// invisibile per costruzione — la pagina salutava «Ciao!» invece che per nome, e di un
// guasto di rete non restava niente da nessuna parte. Ora è un `logClient` di livello `warn`
// (`info` sul client non esiste: `/api/logs` lo rifiuta), col solo `nomeErrore` perché il
// `message` di una fetch fallita si porta dietro l'URL, e in quell'URL c'è l'id di un minore.
// 51 → 50 e 79 → 78 il 2026-09-09: bonificato
// `src/app/(dashboard)/teacher/primaria/[sectionId]/registro/page.tsx`. Il suo
// `.catch(() => {})` stava sull'elenco delle sezioni per la supplenza, e accanto c'erano
// altri due silenzi della stessa famiglia — un `load()` con `try/finally` senza nessun ramo
// su `success: false`, e un `await r.json()` PRIMA di `setSaving(false)`. Il primo lasciava
// la modale della firma senza materie né alunni, muta; il secondo, su un 413/502 che
// risponde HTML, lanciava e lasciava il bottone «Firma» disabilitato per sempre. Nessuno dei
// tre produceva una riga da nessuna parte: la maestra vedeva due tendine vuote e un bottone
// che non rispondeva più.
//
// 🔻 50 → 48 e 78 → 76 il 2026-09-11: bonificati `FatturaButton.tsx` (staff) e
// `StoricoPagamenti.tsx` (genitore), riscritti per lo scarico della fattura. Il loro
// `.catch(() => {})` inghiottiva l'esito del comando «Fattura»: al genitore il pulsante
// spariva — o non faceva niente — e di quel guasto non restava una riga da nessuna parte,
// che è lo stesso silenzio delle email di credenziali da cui nasce la regola 6. Adesso
// l'esito passa da `scaricaDocumento` (`src/lib/native/scarica.ts`, chiamato da
// `salvaFattura` in `src/lib/pagamenti/scarico-fattura.ts`; 2026-09-25, NAT3b), che
// logga anche il SUCCESSO: senza la riga del successo, «nessun log» non distinguerebbe
// «va tutto bene» da «il pulsante non ha mai fatto partire niente».
//
// ⚠️ I due cicli sono nati su branch paralleli e si sono incontrati solo al merge. I numeri
// qui sotto NON sono quelli di nessuno dei due rami: sono la somma delle bonifiche (51−1−2
// file, 79−1−2 occorrenze), rimisurata sul file unito — 48 voci, somma 76 — invece di
// prendere il minore dei due tetti. Prendere 49 o 50 avrebbe lasciato il lock più largo del
// vero, cioè decorativo.
//
// 🔻 48 → 47 e 76 → 71 il 2026-09-12: bonificato `src/lib/media/video-mediarecorder.ts`, e la
// bonifica non è un ripulisci-log, è la riscrittura per cui quel file esisteva. I suoi CINQUE
// `.catch(() => {})` erano cinque chiusure diverse, ognuna con la sua copia della pulizia:
// `play()` che rigettava chiamava il fallimento DOPO che `start()` era partito, `onstop`
// risolveva una promise già rigettata, AudioContext e object URL venivano liberati due volte.
// Adesso la chiusura è UNA (`chiudi`, idempotente) e il suo unico `catch` logga. In quel file
// il silenzio non era un log perso: su iOS la conversione non rigettava MAI — zero righe di
// `gallery-video-conversione-fallita` in tutta `app_log` — e ogni guasto usciva sotto forma di
// FILE, un video di durata giusta, congelato su un fotogramma e muto, che il primo a vedere era
// il genitore. Il tetto si stringe insieme al debito: lasciarlo a 48/76 dopo una bonifica di 5
// occorrenze significa tenere credito non speso, cioè un tetto che non misura più niente.
//
// 🔻 47 → 46 e 71 → 69 il 2026-09-14: la logica della chat esce dalle due pagine gemelle e va in
// `useConversazioneChat`, e con lei la PATCH «segna letto» immediata, che in entrambe finiva in
// `.catch(() => {/* silenzioso */})`. Quel silenzio non perdeva una riga di log qualunque: un
// messaggio segnato letto (o NON segnato) dal realtime non lasciava traccia da nessuna parte,
// mentre il mittente guardava la spunta. Nel hook il ramo logga (`chat-segna-letti-fallito`).
// `teacher/chat/page.tsx` scende a zero ed esce dall'allowlist; `parent/chat/page.tsx` scende a 1
// (resta il `.catch` sulla configurazione degli orari, fuori da questo intervento). Le parti
// successive dello stesso lavoro toccano gli stessi file: i numeri vanno RIMISURATI sul ramo
// unito, non presi da qui.
// Rimisurati il 2026-09-15 sul ramo finale (`fix/chat-doppioni-coda-notifica`, dopo le parti B e C,
// che toccano pagine chat, `ChatMessageArea`, Service Worker, pannelli e shell nativa), con la stessa
// misura di questo file: 46 file e 69 occorrenze, uguali all'allowlist. I tetti restano quelli.
//
// 🔻 46 → 45 e 69 → 68 il 2026-09-25 (NAT3g1): `CompetenzePanel.tsx` esce dall'allowlist. Il suo
// unico `.catch` muto era sul caricamento delle quinte: con l'elenco non arrivato la pagina
// diceva «nessuna quinta», uguale al caso vero, e non restava traccia. Ora logga
// (`competenze-sezioni-non-caricate`).
// 🔻 45 → 44 e 68 → 67 il 2026-09-25: la pagina galleria docente
// registra ora il fallimento della lettura del ruolo, senza catch muto.
// 🔻 44 → 43 e 67 → 66 il 2026-09-26 (A1): `PresenzeTodayCard.tsx` esce dall'allowlist. Il suo
// `.catch(() => {})` sul caricamento delle presenze di oggi faceva dire al riquadro «non
// disponibili» senza traccia; ora logga (`logClient`, anche sul ramo `!res.ok`).
// 🔻 43 → 42 e 66 → 64 il 2026-09-26 (P2a): `PaymentsDashboard.tsx` esce dall'allowlist. I suoi
// due `.catch(() => {})` stavano sulle categorie e sulla configurazione Aruba: con più sedi la
// GET Aruba senza `scuola_id` rispondeva 400 e il badge «integrazione non configurata» spariva
// in silenzio. Ora la configurazione si legge per sede e ogni guasto logga (`logClient`).
const MAX_FILE = 42;
const MAX_OCCORRENZE = 64;

/**
 * I percorsi bonificati in questo ciclo, che NON possono tornare in allowlist. Non è un
 * elenco a caso: `regenerate-credentials` è il percorso delle EMAIL DI CREDENZIALI, cioè il
 * difetto storico da cui nasce l'intera regola 6 (per mesi nessuna credenziale arrivò a
 * destinazione, il provider rispondeva 403 e il codice registrava solo il numero); gli altri
 * due sono le pagine di anagrafica e di ricarica ticket, dove il fallimento muto di una fetch
 * si presenta all'operatore come «l'elenco è vuoto» — indistinguibile da «non c'è nessuno».
 *
 * AGGIUNTO IL 2026-08-04 — `NativePushAutoRegister.tsx`, e vale la pena dire cosa è costato.
 * Il suo `.catch(() => {})` inghiottiva l'ESITO della registrazione push nativa. Quel giorno
 * l'app girava su un iPhone vero, installata da TestFlight: in `push_subscriptions` non
 * c'era NESSUNA riga `ios`, e del tentativo non restava traccia da nessuna parte — non si
 * poteva distinguere «l'utente ha detto no» da «il plugin è esploso» da «non è mai partito
 * niente». Il file ha per giunta un `attempted` di modulo che rende il tentativo UNICO per
 * sessione: il catch muto non perdeva un errore fra tanti, perdeva l'unico che ci fosse.
 *
 * TOLTO IL 2026-08-11 — `AdultRegistryForm.tsx` era entrato qui il giorno prima, e il giorno
 * dopo il file non esiste più: cancellato insieme a `POST /api/admin/adults`, la rotta
 * irraggiungibile e rotta che serviva. Una voce che punta a un percorso inesistente farebbe
 * cadere il controllo POSITIVO qui sotto (`fs.existsSync`), che è esattamente ciò che deve
 * fare: questo elenco parla di file vivi e bonificati, non di file scomparsi.
 *
 * AGGIUNTO IL 2026-09-01 — `teacher/modulistica/page.tsx`, bonificata riscrivendola per la
 * barra filtri. Il suo unico `.catch(() => {})` stava sulla lettura delle SEZIONI del docente
 * (`/api/educator-sections`), ed è il caso peggiore della categoria: senza sezioni la pagina
 * non sa quale classe mostrare, quindi resta ferma sullo spinner — e uno spinner eterno è
 * indistinguibile da «questo docente non ha sezioni». Ora quel ramo logga, e la voce esce
 * dall'allowlist: se restasse, ESLint continuerebbe a tacere sul file e il prossimo catch
 * muto ci rientrerebbe senza che nessuno se ne accorga.
 */
const MAI_PIU_IN_ALLOWLIST = [
    'src/app/api/admin/regenerate-credentials/route.ts',
    'src/app/(dashboard)/admin/students/page.tsx',
    'src/components/features/admin/pagamenti/TicketMensaPanel.tsx',
    'src/components/providers/NativePushAutoRegister.tsx',
    'src/app/(dashboard)/teacher/modulistica/page.tsx',
];

/* ────────────────────────────────────────────────────────────────────────────────
 * LA MISURA, e perché non è semplicemente «fai girare ESLint».
 *
 * Far girare ESLint dentro il test sarebbe la cosa più ovvia — una sola definizione di
 * «catch muto», zero possibilità di divergenza. È stato provato: 70 secondi. Su un gate che
 * ESLint lo lancia già per conto suo, sarebbe un minuto e dieci pagato due volte a ogni run,
 * ed è il genere di costo che porta la gente a lanciare i test «solo prima del push».
 *
 * Quindi la misura è testuale, ed è stata VERIFICATA file per file contro l'output vero di
 * ESLint: coincidono su tutti e 56 i file che ESLint vede. Le uniche due differenze sono in
 * `src/app/offline/*`, e vanno nella direzione innocua: sono `catch(e){}` dentro le stringhe
 * ES5 dello script inline che il Service Worker serve quando la rete non c'è. Per ESLint è
 * testo; per il browser di un genitore in metropolitana è codice che gira davvero, e quando
 * muore muore in silenzio come tutti gli altri. Il test li conta, ESLint no.
 *
 * Le due passate esistono perché ESLint tratta i commenti in modo DIVERSO nei due casi, e la
 * misura deve seguirlo per non diventare rossa dove lui è verde (o viceversa):
 *  · `no-empty` IGNORA i blocchi che contengono un commento → per le CLAUSOLE `catch {}` i
 *    commenti devono restare visibili (maschera `§`, che non è spazio);
 *  · `no-restricted-syntax` lavora sull'AST, dove i commenti non esistono → per gli HANDLER
 *    `.catch(() => { /* … *\/ })` i commenti devono sparire (maschera con spazi).
 * ──────────────────────────────────────────────────────────────────────────────── */

/**
 * Sostituisce i commenti con `riempi`, lasciando INTATTE le stringhe (è così che si contano i
 * catch di `/offline`) e i ritorni a capo (è così che i numeri di riga restano quelli veri).
 *
 * Con `§` una riga di commento che *cita* `.catch(() => {})` — e in questo repo ce ne sono
 * quattro, tutte a spiegare perché il catch muto è stato tolto — resta non-vuota e non
 * inquina il conteggio. Con `' '` sparisce, che è quello che serve per gli handler.
 */
function mascheraCommenti(sorgente: string, riempi: string): string {
    let out = '';
    let i = 0;
    let stato: 'code' | 'riga' | 'blocco' | 'str' = 'code';
    let apice = '';
    while (i < sorgente.length) {
        const c = sorgente[i];
        const d = sorgente[i + 1];
        if (stato === 'code') {
            if (c === '/' && d === '/') { stato = 'riga'; out += riempi + riempi; i += 2; continue; }
            if (c === '/' && d === '*') { stato = 'blocco'; out += riempi + riempi; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { stato = 'str'; apice = c; out += c; i++; continue; }
            out += c; i++; continue;
        }
        if (stato === 'riga') {
            if (c === '\n') { stato = 'code'; out += '\n'; } else out += riempi;
            i++; continue;
        }
        if (stato === 'blocco') {
            if (c === '*' && d === '/') { stato = 'code'; out += riempi + riempi; i += 2; continue; }
            out += c === '\n' ? '\n' : riempi; i++; continue;
        }
        // stato === 'str'
        if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
        if (c === apice) stato = 'code';
        out += c; i++;
    }
    return out;
}

/** `catch {}` e `catch (e) {}` — la clausola che non dice niente. Gemella di `no-empty`. */
const CLAUSOLA_MUTA = /\bcatch\s*(?:\(\s*[A-Za-z_$][\w$]*\s*\))?\s*\{\s*\}/g;

/**
 * `.catch(() => {})`, `.catch(e => {})`, `.catch(function () {})` — l'handler c'è e non fa
 * niente. Gemello del selettore `no-restricted-syntax` della config.
 */
const HANDLER_MUTO = new RegExp(
    [
        String.raw`\.catch\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)`,
        String.raw`\.catch\s*\(\s*(?:async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*\{\s*\}\s*\)`,
    ].join('|'),
    'g',
);

function sorgenti(dir = SRC): string[] {
    const out: string[] = [];
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name);
        if (voce.isDirectory()) { out.push(...sorgenti(assoluto)); continue; }
        if (!/\.tsx?$/.test(voce.name)) continue;
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'));
    }
    return out;
}

/**
 * Quante volte quel file tace, **con il criterio di ESLint** — cioè senza i `catch` il cui
 * corpo contiene soltanto commenti. Per quelli vedi `soloCommenti()` e il riquadro in testata:
 * `0` qui NON significa «questo file logga sempre», significa «questo file non ha catch
 * sintatticamente vuoti». La differenza è la metà scoperta del lock.
 */
function contaMuti(sorgente: string): number {
    CLAUSOLA_MUTA.lastIndex = 0;
    HANDLER_MUTO.lastIndex = 0;
    const clausole = (mascheraCommenti(sorgente, '§').match(CLAUSOLA_MUTA) ?? []).length;
    const handler = (mascheraCommenti(sorgente, ' ').match(HANDLER_MUTO) ?? []).length;
    return clausole + handler;
}

function quantiMuti(rel: string): number {
    return contaMuti(fs.readFileSync(path.join(RADICE, rel), 'utf8'));
}

/**
 * LA METÀ SCOPERTA: le clausole `catch { /* … *\/ }` il cui corpo è SOLO commenti.
 *
 * Si ottengono per differenza fra le due mascherature, che hanno la stessa lunghezza carattere
 * per carattere (`//` → due `riempi`, ogni char di commento → un `riempi`, i ritorni a capo
 * intatti): quindi gli indici combaciano e ciò che compare con gli spazi ma non con i `§` è
 * esattamente un blocco che contiene solo commenti. Gli HANDLER non entrano qui: quelli sono
 * già contati da `quantiMuti`, perché `no-restricted-syntax` lavora sull'AST, dove i commenti
 * non esistono.
 */
function trovaSoloCommenti(sorgente: string): { riga: number; testo: string }[] {
    const conSegno = mascheraCommenti(sorgente, '§');
    const conSpazi = mascheraCommenti(sorgente, ' ');

    const gia = new Set<number>();
    CLAUSOLA_MUTA.lastIndex = 0;
    for (let m = CLAUSOLA_MUTA.exec(conSegno); m; m = CLAUSOLA_MUTA.exec(conSegno)) gia.add(m.index);

    const fuori: { riga: number; testo: string }[] = [];
    CLAUSOLA_MUTA.lastIndex = 0;
    for (let m = CLAUSOLA_MUTA.exec(conSpazi); m; m = CLAUSOLA_MUTA.exec(conSpazi)) {
        if (gia.has(m.index)) continue;
        fuori.push({
            riga: sorgente.slice(0, m.index).split('\n').length,
            testo: sorgente.slice(m.index, m.index + m[0].length).replace(/\s+/g, ' ').slice(0, 100),
        });
    }
    return fuori;
}

function soloCommenti(rel: string): { riga: number; testo: string }[] {
    return trovaSoloCommenti(fs.readFileSync(path.join(RADICE, rel), 'utf8'));
}

/**
 * TETTI MONOTONI DECRESCENTI della metà scoperta — misura del 2026-09-19, prima volta che
 * questa categoria viene contata. 59 occorrenze in 44 file, logger escluso.
 *
 * Non sono un permesso: sono il debito dichiarato. Salgono mai — chi ne aggiunge uno lo vede
 * qui e ha davanti la scelta giusta, che è `logClient`/`logEvento` a livello `info` con scritto
 * PERCHÉ l'errore è ignorabile. Chi ne bonifica uno porta giù il numero, come per gli altri
 * due tetti: lasciarlo largo significa tenere credito non speso, cioè un tetto che non misura
 * più niente.
 */
const MAX_SOLO_COMMENTI = 59;
const MAX_FILE_SOLO_COMMENTI = 44;

type Voce = { path: string; n: number };
type Allowlist = { totale_occorrenze: number; file: Voce[] };

function leggiAllowlist(): Allowlist {
    return JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')) as Allowlist;
}

describe('lock — catch muti: VUOTI vietati, con soli commenti solo contati (AGENTS.md regola 6)', () => {
    it('l’allowlist esiste, è ben formata e non ha doppioni', () => {
        expect(
            fs.existsSync(ALLOWLIST),
            'Manca docs/superpowers/catch-muti-allowlist.json. È il file che `eslint.config.mjs` ' +
                'legge per sapere dove la regola sui catch muti è ancora spenta: senza, o il gate ' +
                'è rosso su 84 punti legacy, o la regola non esiste affatto.',
        ).toBe(true);

        const a = leggiAllowlist();
        expect(Array.isArray(a.file)).toBe(true);
        for (const v of a.file) {
            expect(typeof v.path, `voce senza path: ${JSON.stringify(v)}`).toBe('string');
            expect(Number.isInteger(v.n) && v.n > 0, `voce con n non valido: ${v.path}`).toBe(true);
            expect(v.path.startsWith('src/'), `path fuori da src/: ${v.path}`).toBe(true);
        }
        const doppi = a.file.map((v) => v.path).filter((p, i, arr) => arr.indexOf(p) !== i);
        expect(doppi, 'stesso file due volte in allowlist: il conteggio non sarebbe più leggibile').toEqual([]);
    });

    it('ogni voce dell’allowlist esiste ancora e ha ESATTAMENTE il numero dichiarato', () => {
        const a = leggiAllowlist();
        const scomparsi: string[] = [];
        const bonificati: string[] = [];
        const cresciuti: string[] = [];

        for (const v of a.file) {
            if (!fs.existsSync(path.join(RADICE, v.path))) { scomparsi.push(v.path); continue; }
            const misurato = quantiMuti(v.path);
            if (misurato === 0) { bonificati.push(v.path); continue; }
            if (misurato !== v.n) {
                cresciuti.push(`${v.path}: dichiarati ${v.n}, misurati ${misurato} → scrivi "n": ${misurato}`);
            }
        }

        expect(
            scomparsi,
            'File in allowlist che non esistono più: togli la voce. Una riga che non corrisponde ' +
                'a niente fa sembrare il debito più grande di quello che è, e fa perdere tempo a ' +
                'chi lo smaltisce.',
        ).toEqual([]);

        expect(
            bonificati,
            'Questi file NON hanno più catch muti: ottimo lavoro, ora togli la voce dall’allowlist ' +
                'e abbassa MAX_FILE/MAX_OCCORRENZE qui sopra. Se la voce resta, ESLint continua a ' +
                'tacere su quel file e il prossimo catch muto ci rientra senza che nessuno se ne ' +
                'accorga — cioè si riapre esattamente il buco che questo lock è nato per chiudere.',
        ).toEqual([]);

        expect(
            cresciuti,
            'In questi file il numero di catch muti NON combacia con l’allowlist. Se è SALITO: ' +
                'ne hai aggiunto uno in un file dove ESLint tace, ed è il caso che questo test ' +
                'esiste per prendere — usa `logClient({livello:"warn",evento:"fetch",…})` nel ' +
                'browser o `logEvento(…)` sul server. Se è SCESO: hai bonificato, aggiorna il ' +
                'numero (e i tetti) invece di lasciare credito non speso.',
        ).toEqual([]);
    });

    it('nessun catch muto FUORI dall’allowlist (l’unica esenzione permanente è il logger)', () => {
        const a = leggiAllowlist();
        const noti = new Set(a.file.map((v) => v.path));
        const nuovi = sorgenti()
            .filter((f) => !f.startsWith(ESENTE) && !noti.has(f))
            .map((f) => ({ f, n: quantiMuti(f) }))
            .filter(({ n }) => n > 0)
            .map(({ f, n }) => `${f} (${n})`);

        expect(
            nuovi,
            'Catch muto in un file NON in allowlist. Non aggiungerlo all’allowlist: l’allowlist ' +
                'può solo rimpicciolirsi. Un errore che non lascia traccia è un guasto che ' +
                'l’assistenza non può nemmeno vedere — «nessun log» non distingue «tutto ok» da ' +
                '«non è mai partito niente», ed è letteralmente l’ambiguità che ha nascosto per ' +
                'mesi il guasto delle email di credenziali.',
        ).toEqual([]);
    });

    it('l’allowlist può solo rimpicciolirsi (tetti monotoni decrescenti)', () => {
        const a = leggiAllowlist();
        const somma = a.file.reduce((s, v) => s + v.n, 0);

        expect(
            a.file.length,
            `L’allowlist è cresciuta a ${a.file.length} file (tetto ${MAX_FILE}). Alzare il tetto ` +
                'non è la risposta: è la mossa che ha lasciato arrivare il debito a 87.',
        ).toBeLessThanOrEqual(MAX_FILE);

        expect(
            somma,
            `L’allowlist dichiara ${somma} catch muti (tetto ${MAX_OCCORRENZE}).`,
        ).toBeLessThanOrEqual(MAX_OCCORRENZE);

        expect(
            a.totale_occorrenze,
            `Il totale in testa al file dice ${a.totale_occorrenze}, la somma delle voci fa ` +
                `${somma}: scrivi "totale_occorrenze": ${somma}. È il numero che legge chi apre ` +
                'il file per sapere quanto debito resta, e deve dire il vero.',
        ).toBe(somma);
    });

    it('il logger non è in allowlist: la sua deroga è permanente e vive nella config', () => {
        const a = leggiAllowlist();
        const intrusi = a.file.map((v) => v.path).filter((p) => p.startsWith(ESENTE));
        expect(
            intrusi,
            'src/lib/logging/** non è debito da smaltire: è il fail-open della regola 9. Sta in ' +
                'eslint.config.mjs, dove il motivo è scritto accanto all’eccezione.',
        ).toEqual([]);
    });

    it('i percorsi bonificati in questo ciclo non possono rientrare', () => {
        const a = leggiAllowlist();
        const noti = new Set(a.file.map((v) => v.path));
        const rientrati = MAI_PIU_IN_ALLOWLIST.filter((p) => noti.has(p));
        expect(
            rientrati,
            'Questi percorsi sono stati bonificati apposta e non tornano in allowlist: ' +
                'credenziali (il difetto storico che ha dato origine alla regola 6), anagrafica ' +
                'alunni, ricarica ticket mensa, registrazione push nativa e modulistica del ' +
                'docente.',
        ).toEqual([]);

        // Controllo POSITIVO, accanto a quello negativo: i tre file esistono davvero e sono
        // puliti sul serio. Senza, il test passerebbe anche se qualcuno li cancellasse.
        for (const p of MAI_PIU_IN_ALLOWLIST) {
            expect(fs.existsSync(path.join(RADICE, p)), `sparito: ${p}`).toBe(true);
            expect(quantiMuti(p), `il catch muto è tornato in ${p}`).toBe(0);
        }
    });

    it('nessuna soppressione inline della regola fuori dal logger', () => {
        // Il giro di fuga più economico: `// eslint-disable-next-line no-restricted-syntax`.
        // È il gemello di `eslint-suppressions.json` — non rompe niente, non avvisa nessuno,
        // e riporta il gate al verde senza correggere una riga.
        const colpevoli = sorgenti()
            .filter((f) => !f.startsWith(ESENTE))
            .filter((f) => {
                const s = fs.readFileSync(path.join(RADICE, f), 'utf8');
                return /eslint-disable[^\n]*no-restricted-syntax/.test(s);
            });

        expect(
            colpevoli,
            'Soppressione inline di `no-restricted-syntax` fuori da src/lib/logging/**. La ' +
                'deroga è ammessa solo lì, e lì la dà la config: non serve scriverla nei file.',
        ).toEqual([]);
    });

    it('la metà scoperta (catch con SOLI commenti) è contata e non può crescere', () => {
        const perFile = sorgenti()
            .filter((f) => !f.startsWith(ESENTE))
            .map((f) => ({ f, occorrenze: soloCommenti(f) }))
            .filter(({ occorrenze }) => occorrenze.length > 0);

        const totale = perFile.reduce((s, v) => s + v.occorrenze.length, 0);
        const elenco = perFile
            .map(({ f, occorrenze }) => `  ${f} (${occorrenze.length}): ${occorrenze.map((o) => `L${o.riga}`).join(', ')}`)
            .join('\n');

        expect(
            totale,
            `I \`catch { /* … */ }\` con dentro SOLO commenti sono ${totale} (tetto ` +
                `${MAX_SOLO_COMMENTI}, misurato il 2026-09-19).\n` +
                'Se è SALITO: ne hai scritto uno nuovo, ed è la forma che AGENTS.md regola 6 cita ' +
                'testualmente fra le vietate. ESLint non la prende (`no-empty` ignora i blocchi ' +
                'con un commento) e per questo la conta questo test. Un commento non è un log: ' +
                'non sta in `app_log`, non si interroga in SQL, non dice niente a nessuno alle tre ' +
                'di notte. Usa `logClient({ livello: "warn", … })` nel browser o `logEvento(…)` ' +
                'sul server, a livello `info` se l\'errore è davvero ignorabile — scrivendoci ' +
                'PERCHÉ lo è, che è quello che il commento voleva dire.\n' +
                'Se è SCESO: hai bonificato, abbassa il tetto invece di lasciare credito non ' +
                'speso.\n' +
                `Occorrenze trovate:\n${elenco}`,
        ).toBeLessThanOrEqual(MAX_SOLO_COMMENTI);

        expect(
            perFile.length,
            `I file coinvolti sono ${perFile.length} (tetto ${MAX_FILE_SOLO_COMMENTI}). La ` +
                'categoria può solo restringersi: un file in più è un file nuovo che ha imparato ' +
                'a tacere.',
        ).toBeLessThanOrEqual(MAX_FILE_SOLO_COMMENTI);
    });

    it('lo scanner vede davvero qualcosa, e le due misure riconoscono un campione noto', () => {
        // L'AUTOINGANNO che questa asserzione chiude: ogni altro test qui sopra confronta una
        // lista con `[]`. Se `sorgenti()` tornasse vuota — una cartella rinominata, un filtro
        // sbagliato, `src/` spostato — oppure se le due regex smettessero di agganciare per una
        // modifica alla mascheratura, il file resterebbe verde su SETTE test senza aver esaminato
        // una riga. Un lock che non può fallire non è un lock: lo si fa fallire apposta.
        const visti = sorgenti();
        expect(
            visti.length,
            `Lo scanner ha trovato ${visti.length} file .ts/.tsx sotto src/. Se è crollato, non ` +
                'sta più guardando il codice: questo lock non misura più niente e il verde qui ' +
                'sopra non vale nulla. Controlla SRC e il filtro in `sorgenti()`.',
        ).toBeGreaterThan(800);

        // Lo strumento provato sui suoi stessi casi, scritti qui in chiaro: se una maschera o una
        // regex cambia, è QUESTO a diventare rosso, non un conteggio che scende in silenzio.
        //
        // Il campione sta in una stringa e non in un file di `src/`: un file vero, anche solo per
        // il tempo del test, lo vedrebbero gli altri lock architetturali che scandiscono `src/` in
        // parallelo (`logging-coverage`, `zod-coverage`, …), e li farebbe cadere a caso. Le due
        // funzioni pure qui sotto sono le stesse che leggono i file veri: si prova lo strumento,
        // non una sua copia.
        const campione = [
            'function a() { try { a(); } catch {} }', //                        vuoto      → muto
            'function b() { try { b(); } catch (e) {} }', //                    vuoto      → muto
            'const c = () => Promise.resolve().catch(() => {});', //            handler    → muto
            'function d() { try { d(); } catch { /* solo scuse */ } }', //      commenti   → scoperto
            'function e() { try { e(); } catch { return 1; } }', //             fa qualcosa→ innocuo
            'const f = "catch {}";', //                                         in stringa → muto (*)
        ].join('\n');

        // (*) Sì, anche quello in stringa: è una scelta, non una svista. Le stringhe restano
        // INTATTE sotto entrambe le maschere perché `src/app/offline/*` serve al browser uno
        // script ES5 dentro una stringa, e lì un `catch {}` gira davvero — per il genitore in
        // metropolitana è codice, non testo. ESLint quei due non li vede; questo lock sì.
        expect(contaMuti(campione), 'le due regex non agganciano più i catch VUOTI').toBe(4);
        expect(
            trovaSoloCommenti(campione).map((o) => o.riga),
            'la differenza fra le due mascherature non isola più il catch con soli commenti',
        ).toEqual([4]);
    });
});
