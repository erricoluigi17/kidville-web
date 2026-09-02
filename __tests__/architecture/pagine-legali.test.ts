import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Lock sulle tre pagine legali pubbliche.
 *
 * Sono gli URL che gli store chiedono (Privacy Policy URL e Support URL) e le
 * uniche pagine che un genitore legge per sapere chi tratta i dati di suo
 * figlio. Sono già andate in produzione **con i segnaposto dentro** — nessun
 * test le guardava, e il gate era verde.
 */

const RADICE = process.cwd();
const PAGINE = ['privacy', 'termini', 'assistenza'] as const;

function leggi(p: string): string {
    return fs.readFileSync(path.join(RADICE, 'src/app', p, 'page.tsx'), 'utf8');
}

/**
 * Il sorgente SENZA i commenti. Attenzione: è il SORGENTE, non il testo reso —
 * restano import, tag JSX e attributi. Basta per le ricerche di stringa qui
 * sotto, NON basta per calcolare un'impronta (vedi `testoVisibile`).
 *
 * Serve perché i commenti di quelle pagine CITANO le formule sbagliate per
 * spiegare perché sono state tolte («utilizzando il servizio dichiari di
 * accettare», la piattaforma ODR chiusa). Un lock che cercasse quelle stringhe
 * nel file intero fallirebbe sulla documentazione della correzione invece che
 * sulla correzione: verificherebbe il contrario di quello che intende.
 */
function leggiTesto(p: string): string {
    return leggi(p)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * IL TESTO CHE L'UTENTE LEGGE DAVVERO — cioè i soli nodi di testo del JSX.
 *
 * Non è la stessa cosa di `leggiTesto`, e la differenza è stata MISURATA: con il
 * sorgente-meno-commenti, aggiungere una classe a un `className` cambiava
 * l'impronta (97d68d52… → 8a1f2574…). Un lock che diventa rosso perché qualcuno
 * ha ritoccato una spaziatura chiede, ogni volta, di riscrivere l'impronta di
 * una versione GIÀ citata nelle righe di `consents_log` — e un lock che va
 * aggirato di routine smette di proteggere esattamente ciò per cui esiste.
 *
 * Si tiene quindi solo il JSX (dal `return (` del componente in giù: sopra ci
 * sono import e costanti di stile) e da lì si tolgono i tag con i loro
 * attributi. Restano le parole, la punteggiatura e le entità.
 *
 * `__provaSorgente` esiste per la prova di sanità qui sotto: la stessa
 * estrazione va applicata a un sorgente MUTATO in memoria, senza toccare il
 * file su disco.
 */
function testoVisibile(p: string, __provaSorgente?: string): string {
    const src = (__provaSorgente ?? leggi(p))
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');
    const dal = src.indexOf('return (', src.indexOf('export default'));
    if (dal === -1) return '';
    return src
        .slice(dal + 'return ('.length)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const improntaDi = (testo: string): string => createHash('sha256').update(testo).digest('hex');

/** Le forme dei segnaposto usati durante la stesura. */
const SEGNAPOSTO = /\[(Ragione sociale|indirizzo sede|email d[^\]]*)\]/i;

describe('lock — pagine legali', () => {
    for (const p of PAGINE) {
        it(`/${p} non contiene segnaposto`, () => {
            expect(leggi(p)).not.toMatch(SEGNAPOSTO);
        });
    }

    it('il recapito è una casella ORDINARIA, mai una PEC', () => {
        // Una PEC come recapito di supporto RIFIUTA la posta ordinaria: il
        // genitore che scrive da Gmail — e il revisore Apple, che usa
        // /assistenza come Support URL — riceve un errore di consegna. Un
        // recapito che rimbalza è peggio di nessun recapito: sembra funzionare.
        for (const p of PAGINE) {
            const email = leggi(p).match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? [];
            expect(email.length, `/${p} non espone alcun recapito`).toBeGreaterThan(0);
            for (const e of email) {
                expect(e, `/${p} usa una PEC come recapito`).not.toMatch(/@pec\.|@.*\.pec\./i);
            }
        }
    });

    it('tutte e tre usano lo STESSO recapito', () => {
        // Tre indirizzi diversi significano tre caselle da tenere vive; e quando
        // una muore non se ne accorge nessuno.
        const primo = (leggi('privacy').match(/[\w.+-]+@[\w.-]+\.\w+/) ?? [])[0];
        for (const p of PAGINE) {
            expect(leggi(p)).toContain(primo);
        }
    });

    it('/privacy dichiara i dati conservati sul dispositivo e lo sblocco biometrico', () => {
        // Sono due trattamenti che l'app fa davvero e che l'informativa taceva.
        const privacy = leggi('privacy');
        expect(privacy).toContain('Dati conservati sul dispositivo');
        expect(privacy).toContain('Sblocco con impronta o volto');
    });

    it('/privacy e /termini identificano il Titolare', () => {
        for (const p of ['privacy', 'termini'] as const) {
            const testo = leggi(p);
            expect(testo).toMatch(/La Favola/i);
            expect(testo).toContain('03394870616');
        }
    });

    it('le tre pagine restano PUBBLICHE', () => {
        // Se uscissero da PUBLIC_PREFIXES, gli URL dichiarati agli store
        // risponderebbero con un redirect al login.
        const regole = fs.readFileSync(
            path.join(RADICE, 'src/lib/auth/middleware-rules.ts'),
            'utf8',
        );
        for (const p of PAGINE) expect(regole).toContain(`'/${p}'`);
    });

    // ── Correzioni sostanziali del 2026-07-31 ────────────────────────────────
    // Non sono preferenze di stile: sono i punti che rendevano i due documenti
    // sbagliati, e sono anche quelli che un domani si reintroducono da soli
    // copiando un modello generico trovato altrove.

    it('/privacy NON fonda i dati sanitari sul consenso (art. 9.2.a)', () => {
        // Un consenso «obbligato» non è libero: se non comunichi l'allergia, la
        // Scuola non può preparare il pasto in sicurezza. E un consenso non
        // libero non è una base giuridica — fondarci sopra il trattamento di
        // dati sanitari di minori significa trattarli SENZA base.
        const privacy = leggiTesto('privacy');
        expect(privacy).not.toMatch(/lett\.?\s*a\s*GDPR[^)]*salute|salute[^.]{0,120}lett\.?\s*a\s*GDPR/i);
        expect(privacy).toContain('lett. g GDPR');
        expect(privacy).toContain('2-sexies');
        expect(privacy).toContain('non viene richiesto il consenso');
    });

    it('/privacy dichiara il consenso SOLO per foto e video', () => {
        const privacy = leggi('privacy');
        expect(privacy).toMatch(/fotografie e video[\s\S]{0,400}consenso/i);
        // …e che rifiutarlo non pregiudica il servizio: è ciò che lo rende libero.
        expect(privacy).toMatch(/non pregiudicano in alcun modo/i);
    });

    it('/privacy nomina Apple/APNs fra i destinatari', () => {
        // Le notifiche iOS transitano da APNs: tacere un destinatario noto è la
        // stessa omissione, in piccolo, già corretta sui trasferimenti.
        expect(leggi('privacy')).toContain('APNs');
    });

    it('/termini non usa la formula che non vincola nessuno', () => {
        // «Utilizzando il servizio dichiari di accettare» non è un'accettazione:
        // senza consenso espresso la limitazione di responsabilità non protegge.
        const termini = leggiTesto('termini');
        expect(termini).not.toMatch(/utilizzando il servizio.{0,60}accett/i);
        expect(termini).toMatch(/accettati\s*\{?'?\s*<strong>espressamente|espressamente<\/strong>/i);
    });

    it('/termini salva le norme inderogabili a tutela del consumatore', () => {
        // Il genitore verso una paritaria è un consumatore (Cass. 10910/2017):
        // le esclusioni di responsabilità per inadempimento sono NULLE.
        const termini = leggi('termini');
        expect(termini).toContain('Codice del Consumo');
        expect(termini).toMatch(/Nulla nei presenti termini esclude o limita/i);
        expect(termini).toContain('66-bis');
    });

    it('/termini NON rimanda alla piattaforma ODR europea, che è chiusa', () => {
        // Reg. UE 2024/3228: la piattaforma ODR non esiste più dal 20/07/2025.
        // Rinviarci sarebbe mandare un consumatore su una porta murata.
        expect(leggiTesto('termini')).not.toMatch(/ec\.europa\.eu\/consumers\/odr|piattaforma ODR/i);
    });

    it('nessuna pagina pubblica un segnaposto da completare', () => {
        for (const p of PAGINE) {
            expect(leggiTesto(p), `/${p} contiene un segnaposto`).not.toMatch(/DA COMPLETARE|■|TODO:/);
        }
    });

    /**
     * WCAG 3.1.2 «Lingua delle parti», livello AA.
     *
     * `src/app/layout.tsx` rende `<html lang={locale}>`: con l'app in inglese —
     * ed è pubblicata in inglese sugli store — queste tre pagine venivano
     * servite `lang="en"` con dentro un testo integralmente italiano. Misurato:
     * `curl -H 'Cookie: KV_LOCALE=en' /privacy | grep '<html'` → `lang="en"`,
     * mentre l'h1 è «Informativa sulla privacy» e i 19 h2 sono tutti in
     * italiano. Uno screen reader legge l'informativa che parla di dati sanitari
     * di minori con la pronuncia inglese, cioè non la legge affatto.
     *
     * La scelta di NON tradurre è deliberata (un'informativa tradotta senza
     * validazione legale è un rischio maggiore di una non tradotta) ed è scritta
     * nell'intestazione dei file. Finché resta così, la lingua va dichiarata
     * dove il testo vive: sul contenitore. Il giorno in cui le pagine passeranno
     * da `useTranslations`, questo lock va tolto insieme all'attributo — e
     * l'asserzione qui sotto sul «testo non tradotto» è ciò che lo segnala.
     */
    it('le tre pagine dichiarano lang="it" sul contenitore, perché il testo NON è tradotto', () => {
        for (const p of PAGINE) {
            const src = leggi(p);
            expect(
                src,
                `/${p} usa useTranslations: se il testo è tradotto, lang="it" cablato è SBAGLIATO e va tolto`,
            ).not.toContain('useTranslations');
            expect(
                src,
                `/${p} non dichiara lang="it": con KV_LOCALE=en il documento è lang="en" su testo italiano (WCAG 3.1.2)`,
            ).toMatch(/<main[^>]*\slang="it"/);
        }
    });

    it('la versione dei testi coincide con le costanti usate per la prova di accettazione', () => {
        // Se il testo cambia e la costante no, il genitore accetta un documento
        // e nel registro dei consensi ne risulta un altro: la prova si svuota.
        const versioni = fs.readFileSync(path.join(RADICE, 'src/lib/legal/versioni.ts'), 'utf8');
        // ⚠️ La data dell'informativa NON è ribattuta qui. Era scritta in due
        // punti — questo regex e le chiavi di `IMPRONTE_PRIVACY` — e chi avesse
        // alzato la versione avrebbe raccolto due rossi, il primo dei quali dice
        // solo «non combacia» senza indicare dove sta l'altra copia. La chiave
        // di `IMPRONTE_PRIVACY` è la sola fonte, e la prova qui sotto la usa.
        expect(versioni).toMatch(/VERSIONE_PRIVACY = '\d{4}-\d{2}-\d{2}'/);
        expect(versioni).toMatch(/VERSIONE_TERMINI = '2026-07-31'/);
        expect(leggi('privacy')).toContain('VERSIONE_PRIVACY');
        expect(leggi('termini')).toContain('VERSIONE_TERMINI');
    });

    /**
     * L'IMPRONTA DEL TESTO, e perché il controllo qui sopra da solo non bastava.
     *
     * MISURATO il 2026-08-10: l'informativa era stata modificata NEL MERITO —
     * una voce nuova che dichiara «dodici mesi … ventiquattro mesi» per una
     * categoria di interessati che prima non c'era (chi si candida a un lavoro)
     * — e `VERSIONE_PRIVACY` era rimasta a '2026-07-31'. Questo file girava
     * VERDE, 17 test su 17. Non per un difetto di scrittura: per costruzione.
     * Un lock che confronta una costante con una data SCRITTA NEL LOCK STESSO
     * non può accorgersi che è cambiato un terzo file. Vede due cose ferme e
     * conclude che tutto è fermo.
     *
     * Conseguenza reale, non teorica: `VERSIONE_PRIVACY` viene stampata dentro
     * `consents_log.versione_informativa` a ogni candidatura e a ogni
     * iscrizione. Ogni riga avrebbe attestato l'accettazione di un documento
     * che quella voce non conteneva — la prova d'accettazione avrebbe detto il
     * falso proprio sul punto per cui esiste (art. 13 §2 lett. a).
     *
     * COSA FA QUESTA PROVA: lega la versione al CONTENUTO che quella versione
     * dichiara. L'impronta è calcolata sui soli NODI DI TESTO del JSX
     * (`testoVisibile`): fuori i commenti, fuori gli import e le costanti di
     * stile, fuori i tag con i loro attributi, spazi normalizzati. Cambiare una
     * parola del testo legale è rosso; ritoccare una classe, andare a capo o
     * riscrivere un commento no. Non è un'affermazione di intenti: la prova di
     * sanità qui sotto lo verifica mutando il sorgente in memoria.
     *
     * SE QUESTO TEST È ROSSO non «aggiustare l'impronta»: dato ciò che entra
     * nell'impronta, un rosso significa che le PAROLE dell'informativa sono
     * cambiate. L'ordine giusto è (1) alzare `VERSIONE_PRIVACY` in
     * `src/lib/legal/versioni.ts` alla data della modifica, scrivendoci accanto
     * COSA è cambiato, e (2) aggiungere qui la voce nuova, lasciando intatte le
     * vecchie. Sovrascrivere l'impronta di una versione GIÀ PUBBLICATA — cioè
     * già accettata da persone vere e già citata nelle righe di `consents_log` —
     * significa riscrivere a posteriori il contenuto di un documento che
     * qualcuno ha firmato: è la cosa che questo lock esiste per rendere
     * impossibile per distrazione, e per questo il messaggio d'errore non la
     * propone come alternativa comoda.
     */
    const IMPRONTE_PRIVACY: Record<string, string> = {
        // 2026-08-25 — due voci nuove, e nessuna redazionale.
        // (1) «Natura del conferimento» dichiara che nel modulo «Lavora con noi» il
        //     CURRICULUM è necessario e che senza allegato la candidatura non si può
        //     inviare (art. 13 §2 lett. e). L'obbligo è nato il 24/08 con il campo:
        //     finché il curriculum era facoltativo quel modulo non aveva niente di
        //     necessario da dichiarare, e la sezione parlava solo dei minori.
        // (2) Il «curriculum caricato e mai inviato» passa da ventiquattro a
        //     QUARANTOTTO ore. Non perché il codice sia cambiato: perché le 24 ore
        //     erano false dal 15/08. Misurato in produzione il 2026-08-25 alle 03:56Z:
        //     36 orfani, 21 con più di 24 ore, il più vecchio 45 h; oltre le 48 zero.
        //     La soglia è giusta (24 h), la cadenza no: la spazzata passa una volta a
        //     notte, quindi il tetto vero è soglia + un giro. Il lock
        //     `informativa-termine-orfani-sostenibile` ora lega le tre cifre.
        //
        // ⚠️ QUESTA IMPRONTA È STATA RISCRITTA, non affiancata, ed è lecito qui per
        // la stessa ragione — e con la stessa prova — del '2026-08-19' più sotto:
        // la versione '2026-08-25' NON è mai andata in produzione. Misurato il
        // 2026-08-25 con un conteggio sulle quattro tabelle che portano un
        // `consents_log` (`candidature_insegnanti`, `enrollment_submissions`,
        // `form_submissions`, `pratiche_personale`): le versioni presenti sono
        // '2026-07-31' (285), '2026-08-10' (5), '2026-08-11' (7), '2026-08-15' (95)
        // e '2026-08-20' (234). Di '2026-08-25' nessuna riga. Il divieto di
        // riscrivere protegge i documenti che qualcuno ha già accettato, non le
        // bozze — e la differenza fra i due casi si stabilisce con la query, non
        // con la data.
        // Cosa è cambiato rispetto alla prima stesura di oggi: SOLO la forma del
        // capoverso «Lavora con noi». Spariti l'inciso parlato («che è la cosa che
        // la persona ci chiede di fare») e l'attacco ripetuto («È invece
        // facoltativo», che apriva anche il capoverso seguente sulle fotografie).
        // Necessità del curriculum e conseguenza del rifiuto restano dichiarate.
        //
        // ── E RISCRITTA UNA SECONDA VOLTA LO STESSO GIORNO (rifinitura del 25/08) ──
        // Quattro correzioni di FORMA, nessuna di merito, tutte dentro la stessa
        // versione mai pubblicata:
        //  1. il capoverso «Lavora con noi» è andato in FONDO alla sezione. Era il
        //     terzo di quattro, cioè un adulto che si candida a un lavoro incastrato
        //     fra i dati sanitari del minore e le fotografie del minore;
        //  2. tolta l'ECO col capoverso seguente — «è INVECE facoltativo … NON
        //     PREGIUDICA IN ALCUN MODO» ripetuto due volte di fila su due soggetti
        //     estranei. Ora «invece» è uno solo e il rifiuto «non incide sulla
        //     valutazione»;
        //  3. i DUE TERMINI si scrivono («dodici mesi anziché ventiquattro») invece
        //     di «al più breve dei termini indicati più avanti»: è la frase su cui si
        //     decide se spuntare un consenso, e il numero era rimandato. La seconda
        //     copia dei due numeri è sotto lo stesso lock della prima —
        //     `gdpr-retention-candidature` è stato esteso a questo capoverso;
        //  4. «la richiesta dell'interessato» → «la richiesta di chi si candida». Era
        //     l'unico capoverso della pagina rivolto a chi si candida, e usava il
        //     maschile mentre il corpo della sezione sul personale — stessa
        //     popolazione — scrive «l'interessata» tre volte.
        // Più una fuori sezione: la voce «curriculum caricato e mai inviato» torna
        // alla PASSIVA dell'elenco («viene rimosso … dalla pulizia notturna, entro
        // due passaggi») invece di «e lo toglie dall'archivio la pulizia notturna»,
        // che cambiava soggetto a metà frase.
        //
        // ⚠️ RISCRITTA E NON AFFIANCATA, e la licenza è di nuovo una MISURA, non la
        // data. Conteggio del 2026-08-25 su `candidature_insegnanti`, raggruppando
        // per `consents_log->>'versione_informativa'`: '2026-08-20' 195 righe,
        // '2026-08-15' 38, '2026-08-10' 1 — di '2026-08-25' NESSUNA.
        // ⚠️ E LA MISURA FACILE MENTIVA: `consents_log::text LIKE '%2026-08-25%'`
        // torna 1, e quell'1 non è una versione — è un TIMESTAMP di un consenso
        // accettato oggi. Fidandosi di quel conteggio si sarebbe inventata una
        // versione '2026-08-26' per un documento che nessuno ha mai letto. La
        // domanda è «quale versione attesta questa riga», e si fa al campo, non al
        // testo intero.
        //
        // ── E RISCRITTA UNA TERZA VOLTA, SEMPRE IL 25/08 (rifinitura di lingua) ──
        // UNA correzione di forma, zero di merito. Il capoverso «Lavora con noi»
        // reggeva sotto lo stesso «e» due cose di natura diversa — uno SCOPO
        // («servono a esaminare la candidatura») e una CONSEGUENZA («e senza il
        // curriculum allegato la candidatura non può essere inviata») — così che per
        // capire a che cosa si attaccasse la congiunzione bisognava tornare indietro;
        // e «candidatura» compariva tre volte in due righe. Ora sono due frasi:
        // «…dare seguito alla richiesta di chi si candida. Senza il curriculum
        // allegato il modulo non si invia.» Una parola in meno, stessa informazione,
        // stessi obblighi dichiarati (art. 13 §2 lett. e).
        //
        // ⚠️ RISCRITTA E NON AFFIANCATA per la TERZA volta, e la licenza è ancora una
        // misura rifatta, non ereditata dalle due qui sopra. Conteggio del 2026-08-25
        // su `candidature_insegnanti` per `consents_log->>'versione_informativa'`:
        // '2026-08-20' 197 righe, '2026-08-15' 38, '2026-08-10' 1 — di '2026-08-25'
        // NESSUNA. (Le 197 erano 195 quando è stata scritta la misura precedente,
        // poche ore fa: il modulo riceve candidature vere mentre lo si tocca, ed è il
        // motivo per cui il conteggio si rifà invece di ricopiarlo.)
        // ⚠️ E LA TRAPPOLA DEL `LIKE` HA COLPITO DI NUOVO, esattamente come previsto
        // dieci righe più su: `consents_log::text LIKE '%2026-08-25%'` oggi torna 3,
        // e nessuna delle tre è una versione — sono i TIMESTAMP di tre consensi
        // accettati stamattina. Il paragrafo che avverte del difetto non ha impedito
        // di commetterlo: a fermarlo è stata la query giusta, sul campo.
        '2026-08-25': 'ca47f58ee52197fcb44ecd51dd2f7edfee114356cac68b9c439acbda39103ad8',
        // 2026-08-20 — la voce «candidature spontanee di personale» dichiara la COPIA
        // che arriva nella casella di OGNI sede scelta, e il fatto che quella copia il
        // job di cancellazione NON la tocca.
        //
        // ⚠️ Questa riga ha portato per qualche ora la chiave '2026-08-19', ed è stata
        // SOSTITUITA e non affiancata. È legittimo qui e solo qui: quella versione non
        // è mai andata in produzione — misurato il 2026-08-20, le uniche versioni nei
        // `consents_log` sono '2026-08-10' e '2026-08-15'. Il divieto di riscrivere
        // protegge i documenti che qualcuno ha già accettato, non le bozze.
        //
        // È una modifica al MERITO e non alla forma: fino al 18/08 il documento
        // prometteva senza riserve che «il curriculum allegato viene cancellato
        // insieme alla candidatura», e da oggi quella promessa è vera per l'archivio
        // dell'applicazione e falsa per la copia in posta. Un'informativa che
        // descrive una cancellazione che non avviene è peggio di una che non la
        // promette: chi legge rinuncia a chiedere ciò che crede già garantito. La
        // voce nuova dice anche a chi rivolgersi per farla rimuovere.
        //
        // Le impronte precedenti restano dove sono: sono i testi che le persone hanno
        // letto fino a ieri, e sono citati nelle righe di `consents_log` già scritte.
        '2026-08-20': 'ae05485a021e8b5e93bae7ba7010bff70cd91a7a8cb7805e3ff78ec0cb0c9cef',
        // 2026-08-15 — aggiunta la voce di conservazione «curriculum caricato e mai
        // inviato»: ventiquattro ore.
        //
        // È un termine per un trattamento che fino al 14/08 non poteva ESISTERE: il
        // campo del curriculum era nel template ma il modulo non lo rendeva, perché
        // nessuna rotta di caricamento produceva un percorso che il server
        // accettasse (misurato in produzione: 0 candidature con curriculum, 0 oggetti
        // sotto il prefisso `candidature/`). Dal 15/08 il file si carica davvero, e
        // si carica PRIMA che la candidatura esista: esiste quindi un dato personale
        // trattato che nessuna riga nomina, e i dodici mesi della candidatura non lo
        // coprono — quel file una valutazione non ce l'ha.
        //
        // Le voci del 10 e dell'11 restano dove sono: sono i testi che le persone
        // hanno letto fino a ieri, e sono citati nelle righe di `consents_log` già
        // scritte.
        '2026-08-15': '6609363f6fbb6e00101b640912299f32ecdbc0e04b9bf98f57551769be0e6cbf',
        // 2026-08-10 — aggiunta la voce «candidature spontanee di personale».
        '2026-08-10': 'f073aa87b1cfcd1e879ebe1ef9166383868d263a45fab4167dcf31e1c69a1143',
        // 2026-08-11 — aggiunta la sezione «Personale della Scuola (dipendenti e
        // collaboratori)» e le sue tre voci di conservazione: dieci anni per il
        // fascicolo, dodici mesi per la copia del documento d'identità, novanta
        // giorni per la richiesta non approvata. La voce del 2026-08-10 resta
        // dov'è: è il testo che le persone hanno letto fino a ieri, ed è citato
        // nelle righe di `consents_log` già scritte.
        //
        // ⚠️ QUESTA IMPRONTA È STATA RISCRITTA DUE VOLTE, ed è il caso che il
        // messaggio d'errore qui sotto vieta — quindi va spiegato con la misura che
        // lo autorizza, non con una buona intenzione.
        //
        // (1) Dall'informativa è stata tolta, prima del rilascio, la frase che
        // prometteva che la copia del documento d'identità «viene sostituita, con
        // cancellazione della precedente»: quel meccanismo non esiste nel repo
        // (nessuna riga di `src/` scrive `anagrafica_personale.documento_path`), ed
        // era una dichiarazione non veritiera. Vedi la prova in
        // `__tests__/api/gdpr-retention-personale.test.ts`.
        //
        // (2) Alla voce «richieste di anagrafica del personale non approvate» è stata
        // AGGIUNTA la frase che dice cosa succede alla richiesta APPROVATA: cancellata
        // insieme al fascicolo, a dieci anni dalla cessazione. La voce prometteva già
        // che quella richiesta «segue i termini indicati ai due punti precedenti», e
        // MISURATO: in tutto `src/` non esisteva nessuna `.delete()` che toccasse una
        // riga `approvata` di `pratiche_personale` — la route di conservazione leggeva
        // i soli stati non approvati. Era un termine promesso e applicato da nessuno
        // (art. 13 §2 lett. a). Ora la route la cancella, e la frase lo dice col numero
        // invece che per rimando.
        //
        // PERCHÉ SI PUÒ RISCRIVERE INVECE DI AGGIUNGERE UNA VERSIONE NUOVA: perché
        // '2026-08-11' non è mai stata mostrata a nessuno. RIMISURATO il 2026-08-12,
        // in sola lettura, su TUTTE E TRE le tabelle che archiviano un `consents_log`
        // (la prima volta era stata interrogata solo `enrollment_submissions`):
        //   · enrollment_submissions → '2026-07-31' 285 righe, '2026-08-10' 4, NULL 93
        //   · candidature_insegnanti → '2026-08-10' 1 riga
        //   · pratiche_personale     → nessuna riga (tabella nuova, ancora vuota)
        // Di '2026-08-11' non esiste una sola riga da nessuna parte, perché nasce su
        // questo branch e il branch non è mai stato rilasciato. Non c'è quindi nessun
        // documento «già citato» il cui contenuto cambi a posteriori: è lo stesso
        // rilascio che corregge il proprio testo prima di consegnarlo.
        // Chi si trovasse di nuovo qui rifaccia QUELLE query invece di fidarsi di
        // questa nota: dal primo invio con la versione corrente la risposta cambia, e
        // da quel momento l'unica strada è aggiungere una voce nuova.
        '2026-08-11': 'c0396f2a20292e419fbcccced9c9394829cb4ff2b87d71ddb371d8bb6d78bda5',
    };

    /**
     * PROVA DI SANITÀ DELL'ESTRATTORE — senza, il commento qui sopra sarebbe una
     * promessa non verificata, ed è già successo: la prima stesura affermava
     * «una riformattazione non produce un rosso falso» mentre l'impronta girava
     * sul sorgente intero e cambiava per una classe in più.
     */
    it("l'impronta guarda le parole e non il markup (sanità dell'estrattore)", () => {
        const sorgente = leggi('privacy');
        const base = testoVisibile('privacy');

        // Nulla di ciò che l'utente NON legge deve essere finito nel testo.
        for (const scoria of ['className', 'import ', 'export default', 'font-maven']) {
            expect(base, `«${scoria}» è finito nel testo su cui si calcola l'impronta`).not.toContain(scoria);
        }
        // …e ciò che legge dev'esserci: se l'estrattore un giorno restituisse il
        // vuoto, l'impronta sarebbe stabilissima e non guarderebbe niente.
        for (const frase of ['Informativa sulla privacy', 'Conservazione dei dati', 'candidature spontanee di personale']) {
            expect(base, `«${frase}» non si legge più: l'estrattore non sta leggendo l'informativa`).toContain(frase);
        }

        const impronta = (src: string) => improntaDi(testoVisibile('privacy', src));
        const invariante: [string, string][] = [
            ['una classe in più', sorgente.replace('className="', 'className="pt-0 ')],
            ['un import in più', sorgente.replace(/^import /m, 'import { Fragment } from "react";\nimport ')],
            ['una costante di stile diversa', sorgente.replace("font-maven text-[15px]", "font-lato text-[15px]")],
            ['un a capo nel JSX', sorgente.replace('<strong>ventiquattro mesi</strong>', '<strong>\n  ventiquattro mesi\n</strong>')],
        ];
        for (const [che, mutato] of invariante) {
            expect(mutato, `la mutazione «${che}» non è stata applicata: la prova girerebbe a vuoto`).not.toBe(sorgente);
            expect(impronta(mutato), `«${che}» ha cambiato l'impronta: è un rosso falso`).toBe(improntaDi(base));
        }

        const sostanziali: [string, string][] = [
            ['un termine di conservazione', sorgente.replace('ventiquattro mesi', 'trentasei mesi')],
            ['la voce sulle candidature, tolta', sorgente.replace(/<li>\s*<strong>candidature spontanee[\s\S]*?<\/li>/, '')],
        ];
        for (const [che, mutato] of sostanziali) {
            expect(mutato, `la mutazione «${che}» non è stata applicata: la prova girerebbe a vuoto`).not.toBe(sorgente);
            expect(impronta(mutato), `«${che}» NON ha cambiato l'impronta: il lock non protegge`).not.toBe(improntaDi(base));
        }
    });

    it("l'impronta del testo dell'informativa corrisponde alla versione dichiarata", () => {
        const versioni = fs.readFileSync(path.join(RADICE, 'src/lib/legal/versioni.ts'), 'utf8');
        const versione = versioni.match(/VERSIONE_PRIVACY = '([^']+)'/)?.[1];
        expect(versione, 'VERSIONE_PRIVACY non è leggibile da versioni.ts').toBeTruthy();

        expect(
            IMPRONTE_PRIVACY[versione!],
            `Nessuna impronta registrata per la versione '${versione}' dell'informativa. ` +
                `Chi ha alzato la versione non ha depositato qui il testo che quella versione ` +
                `dichiara: aggiungi la voce '${versione}' a IMPRONTE_PRIVACY.`,
        ).toBeTruthy();

        const atteso = improntaDi(testoVisibile('privacy'));

        expect(
            atteso,
            `Le PAROLE dell'informativa non sono più quelle della versione '${versione}'.\n` +
                `Nell'impronta entrano i soli nodi di testo del JSX: né classi, né import, né ` +
                `commenti, né a capo. Un rosso qui è una modifica al testo legale, non al markup.\n` +
                `Da fare: alza VERSIONE_PRIVACY in src/lib/legal/versioni.ts alla data di oggi e ` +
                `aggiungi qui la voce nuova (impronta attuale: ${atteso}), LASCIANDO le voci ` +
                `vecchie dove sono.\n` +
                `Riscrivere l'impronta di '${versione}' invece di aggiungerne una nuova cambia a ` +
                `posteriori il contenuto di un documento già citato in consents_log: se davvero ` +
                `il testo reso non è cambiato, allora è rotto l'estrattore — lo dice la prova di ` +
                `sanità qui sopra — e si ripara quello, non l'impronta.`,
        ).toBe(IMPRONTE_PRIVACY[versione!]);
    });
});
