import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redact, hashCorrelabile, redigiPath } from '@/lib/logging/redact';

/**
 * Campione REALE del dominio: se anche un solo valore sopravvive alla redazione,
 * il logging sta versando dati personali di minori nei log di Vercel.
 * Questo test è il gate: se è rosso, non si va in produzione.
 */
const CAMPIONE = {
    // salute (art. 9 GDPR, minori)
    allergie: 'arachidi e crostacei',
    diagnosi: 'disturbo specifico apprendimento',
    certificato_medico: 'cert-2026-0031.pdf',
    motivo: 'febbre alta',
    // testo libero
    descrizione: 'ha avuto una crisi durante la mensa',
    note: 'la mamma chiede di essere richiamata',
    testo: 'contenuto della comunicazione',
    contenuto: 'messaggio in chat',
    giudizio: 'raggiunge pienamente gli obiettivi',
    // identità
    nome: 'Mario',
    cognome: 'Rossi',
    email: 'genitore@example.com',
    codice_fiscale: 'RSSMRA80A01H501U',
    indirizzo: 'Via Roma 1',
    telefono: '3331234567',
    // sicurezza e valore legale
    password: 'Segreta.2026!',
    token: 'eyJhbGciOiJIUzI1NiJ9',
    code: '482913',
    firma: 'base64-della-firma-FEA',
    iban: 'IT60X0542811101000000123456',
    // valutazione (numerica: NON deve passare solo perché è un numero)
    voto: 7,
    valutazione: 9,
};

describe('redact — lista bianca', () => {
    // L'hash è FAIL-CLOSED: senza salt non produce un hash debole ma "[redatto]".
    // I test che verificano la FORMA dell'hash devono quindi fornire un salt.
    beforeEach(() => {
        vi.stubEnv('LOG_HASH_SALT', 'salt-di-test');
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('nessun valore del campione sopravvive', () => {
        const redatto = redact(CAMPIONE) as Record<string, unknown>;
        const out = JSON.stringify(redatto);
        for (const [chiave, valore] of Object.entries(CAMPIONE)) {
            const cercato = String(valore);

            // Controllo puntuale: il valore redatto della chiave non contiene l'originale.
            // Vale per TUTTI i valori, compresi i numerici (voto: 7 → "[redatto]").
            expect(
                JSON.stringify(redatto[chiave]),
                `il valore di "${chiave}" è sopravvissuto`,
            ).not.toContain(cercato);

            // Controllo globale (più forte: intercetta anche un leak sotto un'ALTRA chiave).
            // Applicabile solo se la stringa cercata è abbastanza lunga da essere un segnale:
            // per i numeri a una cifra la ricerca per sottostringa sull'intero JSON è priva di
            // significato, perché le cifre compaiono per forza nei METADATI di redazione
            // (le lunghezze in "[redatto:str/17]", le cifre esadecimali degli hash).
            if (cercato.length >= 4) {
                expect(out, `il valore di "${chiave}" è sopravvissuto`).not.toContain(cercato);
            }
        }
    });

    it('conserva la FORMA: chiavi presenti, tipo e lunghezza delle stringhe', () => {
        const out = redact({ note: 'ciao' }) as Record<string, string>;
        expect(Object.keys(out)).toEqual(['note']);
        expect(out.note).toBe('[redatto:str/4]');
    });

    it('lascia in chiaro ciò che serve al debug e non identifica nessuno', () => {
        const out = redact({
            id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            section_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3302',
            tipo: 'assenza',
            stato: 'confermato',
            azione: 'insert',
            periodo: '2026-07',
            attivo: true,
            quantita: 3,
        }) as Record<string, unknown>;
        expect(out.id).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
        expect(out.section_id).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3302');
        expect(out.tipo).toBe('assenza');
        expect(out.stato).toBe('confermato');
        expect(out.azione).toBe('insert');
        expect(out.periodo).toBe('2026-07');
        expect(out.attivo).toBe(true);
        expect(out.quantita).toBe(3);
    });

    it('nome/cognome/email diventano un hash STABILE (correlabile, non identificante)', () => {
        const a = redact({ email: 'genitore@example.com' }) as Record<string, string>;
        const b = redact({ email: 'genitore@example.com' }) as Record<string, string>;
        const c = redact({ email: 'altro@example.com' }) as Record<string, string>;
        expect(a.email).toBe(b.email);          // stabile → posso dire "è sempre lo stesso"
        expect(a.email).not.toBe(c.email);      // distingue persone diverse
        expect(a.email).not.toContain('genitore');
        expect(a.email).toMatch(/^#[0-9a-f]{8}$/);
    });

    it('`livello` è la VALUTAZIONE di un minore, non il livello di log', () => {
        // Competenze D.M. 14/2024: `livello` vale A|B|C|D e viaggia insieme ad
        // `alunno_id` (uuid, in chiaro). In lista bianca sarebbe la valutazione di un
        // bambino identificabile, scritta nei log di Vercel.
        const out = redact({
            alunno_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            competenza_codice: 'imparare_a_imparare',
            livello: 'D',
        }) as Record<string, unknown>;
        expect(out.livello).toBe('[redatto]');
        expect(JSON.stringify(out)).not.toContain('"D"');
        expect(out.alunno_id).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301'); // resta debuggabile
    });

    it('la valutazione di un minore è redatta anche quando è un NUMERO', () => {
        // La lista bianca chiude le stringhe, non i numeri: senza le radici sensibili
        // questi passerebbero tutti in chiaro accanto a un alunno_id. Sono chiavi REALI:
        // voto_numerico (api/grades), media (api/primaria/prospetto: media per materia).
        const out = redact({
            alunno_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            voto_numerico: 7,
            media: 4.5,
            giudizio: 8,
            votoNumerico: 9,
            punteggio: 100,
        }) as Record<string, unknown>;
        expect(out.voto_numerico).toBe('[redatto]');
        expect(out.media).toBe('[redatto]');
        expect(out.giudizio).toBe('[redatto]');
        expect(out.votoNumerico).toBe('[redatto]'); // camelCase: normalizzazione della chiave
        expect(out.punteggio).toBe('[redatto]');
        expect(out.alunno_id).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301'); // resta debuggabile
    });

    it('la chiave è confrontata NORMALIZZATA (maiuscole, camelCase, trattini)', () => {
        const out = redact({
            PASSWORD: 'Segreta.2026!',
            newPassword: 'Altra.2026!',
            'CODICE-FISCALE': 'RSSMRA80A01H501U',
            Livello: 'D',
        }) as Record<string, string>;
        expect(out.PASSWORD).toBe('[redatto]');
        // senza normalizzazione uscirebbe "[redatto:str/11]": ne rivelerebbe la lunghezza
        expect(out.newPassword).toBe('[redatto]');
        expect(out['CODICE-FISCALE']).toMatch(/^#[0-9a-f]{8}$/);
        expect(out.Livello).toBe('[redatto]');
    });

    it('`codice` non è in chiaro: la competenza viaggia anche come Livello.codice', () => {
        // src/lib/competenze/modello.ts → `codice: 'A' | 'B' | 'C' | 'D'`
        const out = redact({ codice: 'A' }) as Record<string, string>;
        expect(out.codice).not.toBe('A');
        expect(out.codice).toBe('[redatto:str/1]');
    });

    it('redigiPath tiene il PATTERN e butta token, id e query string', () => {
        // Il token del modulo pubblico è un SEGMENTO di path (`/m/[token]`): è una
        // capability. E le query string trasportano ?userId=, ?email=, ?token=.
        expect(redigiPath('/m/8f3a9c2e-secretissimo-token-firma')).toBe('/m/[tok]');
        expect(redigiPath('/api/admin/parents/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/api/admin/parents/[id]');
        expect(redigiPath('/api/genitori?email=x@y.z')).toBe('/api/genitori');
        expect(redigiPath('/api/alunni/42')).toBe('/api/alunni/[n]');
    });

    it('redigiPath NON distrugge i nomi di route legittimi (19 nel repo sono ≥16 char)', () => {
        // Se bastasse la lunghezza, queste due route collasserebbero nello stesso
        // pattern e il log perderebbe la sua unica funzione: sapere chi è stato colpito.
        expect(redigiPath('/api/medical-certificates/3')).toBe('/api/medical-certificates/[n]');
        expect(redigiPath('/api/giustifiche-didattiche/12')).toBe('/api/giustifiche-didattiche/[n]');
        // ma ciò che SEMBRA opaco (lungo + con cifre) resta [tok]
        expect(redigiPath('/api/public/forms/tok_live_9f8e7d6c5b4a3210/submit')).toBe('/api/public/forms/[tok]/submit');
    });

    it('redigiPath regge i casi limite', () => {
        expect(redigiPath('')).toBe('');
        expect(redigiPath('api/alunni')).toBe('api/alunni');
        expect(redigiPath('?email=x@y.z')).toBe('');
        expect(redigiPath('https://app.kidville.it/m/tok_live_9f8e7d6c5b4a3210')).toBe('https://app.kidville.it/m/[tok]');
    });

    it('le chiavi path/route/url non escono mai grezze da redact', () => {
        const out = redact({
            path: '/m/8f3a9c2e-secretissimo-token-firma',
            route: '/api/genitori?email=mario.rossi@gmail.com',
            url: '/api/public/forms/tok_live_9f8e7d6c5b4a3210/submit',
        }) as Record<string, string>;
        expect(out.path).toBe('/m/[tok]');
        expect(out.route).toBe('/api/genitori');
        expect(out.url).toBe('/api/public/forms/[tok]/submit');
        const json = JSON.stringify(out);
        expect(json).not.toContain('secretissimo');
        expect(json).not.toContain('mario.rossi');
        expect(json).not.toContain('tok_live');
    });

    it('il NOME DI FILE non è una rotta: «certificato-<cognome>.pdf» non esce in chiaro', () => {
        // Misurato in produzione (report log W4): nella riga persistita del guasto indotto
        // convivevano `"url":"NON-ESISTE-collaudo-log.pdf"` IN CHIARO e
        // `"fileUrl":"[redatto:str/27]"` — stesso valore, due trattamenti. `redigiPath`
        // maschera i segmenti uuid, tutto-cifre o lunghi-con-cifre: un NOME DI FILE senza
        // cifre gli passa in mezzo. E un allegato di avviso può chiamarsi
        // «certificato-<cognome>.pdf» — il cognome di un minore in una colonna che vive
        // 30 giorni e si interroga in SQL.
        expect(redigiPath('certificato-rossi.pdf')).not.toBe('certificato-rossi.pdf');
        expect(redigiPath('certificato-rossi.pdf')).toBe('[file].pdf');
        expect(redigiPath('/storage/v1/object/avvisi_allegati/certificato-rossi.pdf'))
            .toBe('/storage/v1/object/avvisi_allegati/[file].pdf');

        // CONTROLLI POSITIVI — ciò che il pattern deve CONTINUARE a dire, altrimenti si è
        // solo spento il log invece di averlo reso onesto:
        //  · l'ESTENSIONE resta (dice che era un PDF, e non è il dato di nessuno);
        //  · i nomi di rotta restano leggibili;
        //  · l'HOST resta: è ciò che dice QUALE provider ha risposto.
        expect(redigiPath('/api/medical-certificates/3')).toBe('/api/medical-certificates/[n]');
        expect(redigiPath('https://api.resend.com/emails')).toBe('https://api.resend.com/emails');
        expect(redigiPath('https://app.kidville.it')).toBe('https://app.kidville.it');
        expect(redigiPath('https://app.kidville.it/m/tok_live_9f8e7d6c5b4a3210')).toBe('https://app.kidville.it/m/[tok]');
        // …e l'host va protetto ANCHE nella forma protocollo-relativa, che non è un caso di
        // scuola: è esattamente ciò che `redigiPathNelTesto` ritaglia dal messaggio di un
        // browser («Failed to fetch https://app.kidville.it» → il match comincia dopo i `:`,
        // cioè da `//app.kidville.it`). Senza, l'host diventerebbe `[file].it`.
        expect(redigiPath('//app.kidville.it')).toBe('//app.kidville.it');
        expect(redigiPath('//x.supabase.co/storage/v1/object/avvisi_allegati/certificato-rossi.pdf'))
            .toBe('//x.supabase.co/storage/v1/object/avvisi_allegati/[file].pdf');
    });

    it('sotto una chiave di path LA CHIAVE APRE E IL VALORE CONFERMA: `url` e `fileUrl` dicono la stessa cosa', () => {
        // `url` è in CHIAVI_PATH, quindi passava da `redigiPath` QUALUNQUE cosa fosse. Ma
        // `redigiPath` riduce un PATH a pattern: su una stringa che path non è, non riduce
        // niente e la restituisce intatta. È lo stesso difetto di forma che la deroga
        // `digest` chiude da tempo — la chiave da sola non basta.
        const out = redact({
            url: 'NON-ESISTE-collaudo-log.pdf',
            fileUrl: 'NON-ESISTE-collaudo-log.pdf',
        }) as Record<string, string>;
        expect(out.url).toBe(out.fileUrl);
        expect(out.url).toBe('[redatto:str/27]');

        // `redact()` gira sul BODY GREZZO di ogni richiesta (`parseBody` deposita il raw PRIMA
        // di zod): senza la conferma sul valore, `{"url":"<quello che ti pare>"}` è un canale
        // di TESTO LIBERO verso `app_log`, aperto a chiunque sappia fare una POST.
        const ostile = redact({
            url: 'mario.rossi@gmail.com',
            path: 'Mario Rossi',
            // codice fiscale in OMOCODIA PIENA: 16 caratteri, zero cifre → nessuna delle
            // euristiche di `redigiPath` lo tocca.
            route: 'RSSMRALMTLLASLMS',
        }) as Record<string, string>;
        const json = JSON.stringify(ostile);
        expect(json).not.toContain('mario.rossi');
        expect(json).not.toContain('Mario Rossi');
        expect(json).not.toContain('RSSMRALMTLLASLMS');

        // CONTROLLO POSITIVO: un path VERO continua a uscire ridotto a PATTERN, non redatto —
        // se cadesse anche questo, il test non starebbe misurando la conferma del valore ma
        // solo la morte del campo.
        const veri = redact({
            path: '/m/8f3a9c2e-secretissimo-token-firma',
            url: 'https://app.kidville.it/api/public/forms/tok_live_9f8e7d6c5b4a3210/submit',
        }) as Record<string, string>;
        expect(veri.path).toBe('/m/[tok]');
        expect(veri.url).toBe('https://app.kidville.it/api/public/forms/[tok]/submit');
    });

    it('senza LOG_HASH_SALT l’hash è FAIL-CLOSED (niente hash debole)', () => {
        // Il repo è pubblico: con il salt noto e poche centinaia di input possibili,
        // l'hash sarebbe invertibile per forza bruta. Meglio nessun hash.
        vi.stubEnv('LOG_HASH_SALT', undefined);
        expect(hashCorrelabile('genitore@example.com')).toBe('[redatto]');
        const out = redact({ email: 'genitore@example.com' }) as Record<string, string>;
        expect(out.email).toBe('[redatto]');
    });

    it('i SEGRETI spariscono anche se numerici o uuid', () => {
        const out = redact({
            voto: 7,
            token: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            code: 482913,
        }) as Record<string, string>;
        expect(out.voto).toBe('[redatto]');
        expect(out.token).toBe('[redatto]');
        expect(out.code).toBe('[redatto]');
    });

    it('una stringa nuda (senza chiave) è sempre redatta', () => {
        expect(redact('crisi convulsiva')).toBe('[redatto:str/16]');
    });

    it('regge annidamento, array, profondità e cicli senza lanciare', () => {
        const ciclico: Record<string, unknown> = { tipo: 'x' };
        ciclico.self = ciclico;
        expect(() => redact(ciclico)).not.toThrow();
        expect(() => redact({ a: { b: { c: { d: { e: { f: 1 } } } } } })).not.toThrow();
        const arr = redact({ figli: [{ nome: 'A' }, { nome: 'B' }] }) as { figli: unknown[] };
        expect(arr.figli).toHaveLength(2);
        expect(JSON.stringify(arr)).not.toContain('"A"');
    });

    it('un testo libero che COMINCIA con una data resta redatto', () => {
        // Regressione: con un regex data non ancorato in fondo, una nota di diario
        // datata ("2026-07-12 ...") sarebbe stata giudicata "auto-descrittiva" e
        // sarebbe uscita in chiaro nei log. Passa solo il timestamp ISO puro.
        const out = redact({
            note: '2026-07-12 il bambino ha avuto una crisi convulsiva in mensa',
            creato_il: '2026-07-12T10:30:00Z',
            data: '2026-07-12',
        }) as Record<string, string>;
        expect(out.note).not.toContain('crisi');
        expect(out.note).toBe('[redatto:str/60]');
        expect(out.creato_il).toBe('2026-07-12T10:30:00Z');
        expect(out.data).toBe('2026-07-12');
    });

    /* ────────────────────────────────────────────────────────────────────────
     * LA DATA DI NASCITA DI UN MINORE — trovata in chiaro in produzione.
     *
     * Le date erano in lista bianca PER TIPO: qualunque stringa con la forma di un
     * timestamp ISO usciva in chiaro, qualunque fosse la sua chiave. Nelle righe
     * `iscrizione warn` di `app_log` nome, cognome e codice fiscale uscivano hashati e
     * tutto il resto redatto — ma `data_nascita` e `birth_date` passavano intatti.
     * Accanto alla provincia di residenza e all'orario dell'invio, la data di nascita di
     * un bambino resta un dato personale, e la tabella la conserva 30 giorni.
     *
     * La correzione è quella che la regola 8 di AGENTS.md impone: si decide sulla
     * CHIAVE, e nel verso giusto — si toglie dalla lista bianca, non si aggiunge.
     * ──────────────────────────────────────────────────────────────────────── */
    it('la data di nascita NON esce in chiaro solo perché è una data', () => {
        const out = redact({
            data_nascita: '2019-05-03',
            birth_date: '2019-05-03',
            dataNascita: '2019-05-03',
            'DATA-NASCITA': '2019-05-03',
            date_of_birth: '2019-05-03',
            nascita: '2019-05-03T00:00:00Z',
        }) as Record<string, unknown>;

        for (const [chiave, valore] of Object.entries(out)) {
            expect(String(valore), `"${chiave}" è uscita in chiaro`).not.toContain('2019');
        }
    });

    it('...nemmeno quando arriva come oggetto Date (il ramo che scavalca le stringhe)', () => {
        // `v instanceof Date` viene PRIMA del ramo delle stringhe: una difesa messa solo
        // lì lascerebbe passare `new Date(...)`, che è la forma con cui una data arriva da
        // un ORM o da un `JSON.parse` con reviver.
        const out = redact({ data_nascita: new Date('2019-05-03T00:00:00Z') }) as Record<string, unknown>;
        expect(String(out.data_nascita)).not.toContain('2019');
    });

    it('il CAMPO ASSENTE resta diagnosticabile: `null` non diventa `[redatto]`', () => {
        // «il campo mancava» è il 95% dei bug (vedi §5 del design): redigere un `null`
        // cancellerebbe l'unica cosa che quella riga di log doveva dire.
        const out = redact({ data_nascita: null, birth_date: undefined }) as Record<string, unknown>;
        expect(out.data_nascita).toBeNull();
        expect(out.birth_date).toBeUndefined();
    });

    it('le date LEGITTIME continuano a passare: sono ciò che rende leggibile un log', () => {
        const out = redact({
            creato_il: '2026-07-31T13:24:07Z',
            data: '2026-07-31',
            data_evento: '2026-09-15',
            scadenza: '2026-08-31',
            data_scadenza: '2026-08-31',
            visto_l_ultima: '2026-07-31T13:24:07Z',
        }) as Record<string, string>;
        expect(out.creato_il).toBe('2026-07-31T13:24:07Z');
        expect(out.data).toBe('2026-07-31');
        expect(out.data_evento).toBe('2026-09-15');
        expect(out.scadenza).toBe('2026-08-31');
        expect(out.data_scadenza).toBe('2026-08-31');
        expect(out.visto_l_ultima).toBe('2026-07-31T13:24:07Z');
    });

    /* ────────────────────────────────────────────────────────────────────────
     * IL CAP E IL CIVICO — il buco che restava aperto sui NUMERI.
     *
     * Come stringhe erano già redatti (sono fuori dalla lista bianca), ma la forma del
     * valore la sceglie chi manda la richiesta: `redact()` gira anche sul BODY GREZZO,
     * che `parseBody` deposita PRIMA di zod. `{"cap": 80014}` usciva quindi intero per
     * TIPO — la stessa terza direzione da cui il canale si era già aperto con `motivo`
     * (rilievo Q19) — e un CAP più un civico, accanto a un `sede_id` in chiaro,
     * restringono a una manciata di case. Identico per il numero del documento
     * d'identità, che il modulo `/anagrafica-personale` chiede insieme agli altri due.
     *
     * Le tre forme si provano tutte e tre, ed è il punto: se una difesa tratta in modo
     * diverso lo stesso dato a seconda di come arriva, non è una difesa.
     * ──────────────────────────────────────────────────────────────────────── */
    it('CAP, civico e numero del documento non escono in chiaro: stringa, NUMERO e dentro un oggetto', () => {
        const out = redact({
            sede_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
            cap: 80014,
            zip_code: '80014',
            civico: 12,
            numero_civico: '12',
            residence_street_number: 12,
            domicilio_zip_code: 80014,
            domicilio_street_number: 12,
            street_number: 12,
            numero_documento: 1234567,
            document_number: 'AB1234567',
            // La stessa informazione un piano più sotto: se la difesa guardasse solo il
            // primo livello, basterebbe annidare per scavalcarla.
            residenza: { cap: 80014, civico: 12, numero_documento: 1234567 },
        }) as Record<string, unknown>;

        const tutto = JSON.stringify(out);
        for (const perduto of ['80014', '1234567', 'AB1234567']) {
            expect(tutto, `«${perduto}» è sopravvissuto alla redazione`).not.toContain(perduto);
        }
        // Il NUMERO non esce più, e si vede che era un numero: `[redatto:num]` è ciò che
        // spiega perché il CHECK `^[0-9]{5}$` l'ha respinto.
        expect(out.cap).toBe('[redatto:num]');
        expect(out.civico).toBe('[redatto:num]');
        expect(out.numero_documento).toBe('[redatto:num]');
        // La STRINGA conserva la lunghezza, e deve continuare a farlo: `zip_code` è
        // `varchar(5)`, e il guasto vero già pagato una volta è un `22001` (valore
        // troppo lungo). Con `[redatto]` secco quella diagnosi sparirebbe.
        expect(out.zip_code).toBe('[redatto:str/5]');
        expect(out.document_number).toBe('[redatto:str/9]');
        // …e l'uuid della sede resta leggibile: la riga deve restare diagnosticabile.
        expect(out.sede_id).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    });

    it('…e sono NOMI ESATTI: `capienza` e `n_documenti` continuano a uscire', () => {
        // Il verso opposto dell'errore, e costa quanto l'altro: `cap` dentro un
        // `includes` prenderebbe `capienza` (la capienza di una sede) e `capitolo`, e
        // `document` come radice cancellerebbe `n_documenti` — il conteggio che il cron
        // delle scadenze del documento esiste per scrivere. Una difesa che spegne il log
        // del lavoro che deve sorvegliare non è una difesa.
        const out = redact({
            capienza: 60,
            capitolo: 3,
            n_documenti: 12,
            documenti_in_scadenza: 4,
            capacita: 25,
        }) as Record<string, unknown>;
        expect(out.capienza).toBe(60);
        expect(out.capitolo).toBe(3);
        expect(out.n_documenti).toBe(12);
        expect(out.documenti_in_scadenza).toBe(4);
        expect(out.capacita).toBe(25);
    });

    it('una chiave sconosciuta con valore stringa è redatta (default chiuso)', () => {
        const out = redact({ campo_inventato_domani: 'dato sensibilissimo' }) as Record<string, string>;
        expect(out.campo_inventato_domani).toBe('[redatto:str/19]');
    });

    it('un getter che lancia costa UN campo, non l’intera riga di log', () => {
        const out = redact({
            tipo: 'assenza',
            get esplode(): string { throw new Error('boom'); },
            stato: 'confermato',
        }) as Record<string, unknown>;
        expect(out.tipo).toBe('assenza');
        expect(out.stato).toBe('confermato');
        expect(out.esplode).toBe('[campo-illeggibile]');
    });

    it('un body ostile con __proto__ non inquina Object.prototype', () => {
        const ostile: unknown = JSON.parse('{"__proto__": {"inquinato": true}, "tipo": "x"}');
        const out = redact(ostile) as Record<string, unknown>;
        expect(({} as Record<string, unknown>).inquinato).toBeUndefined();
        expect(out.tipo).toBe('x');
        expect(() => JSON.stringify(out)).not.toThrow();
    });

    it('un Error non sparisce (ma il suo message resta redatto)', () => {
        // message/stack NON sono enumerabili: senza un ramo dedicato Object.keys non li
        // vede e l'errore uscirebbe come {} — e chi cabla il logger, vedendo {}, sarebbe
        // tentato di bypassare redact() proprio per gli errori.
        const err = new Error('utente genitore@example.com non trovato');
        const out = redact(err) as Record<string, unknown>;
        expect(out.name).toBe('Error');
        expect(out.message).toBe('[redatto:str/39]');
        expect(JSON.stringify(out)).not.toContain('genitore@example.com');
        expect(Array.isArray(out.stack)).toBe(true);
        expect((out.stack as string[]).length).toBeLessThanOrEqual(5);
    });

    it('i guardrail anti-esplosione producono un output VERO, non solo "non lancia"', () => {
        const prof = redact({ a: { b: { c: { d: { e: { f: 1 } } } } } }) as { a: { b: { c: { d: { e: unknown } } } } };
        expect(prof.a.b.c.d.e).toBe('[profondità-max]');

        const elenco = redact({ elenco: Array.from({ length: 25 }, (_, i) => i) }) as { elenco: unknown[] };
        expect(elenco.elenco).toHaveLength(21); // 20 elementi + il marcatore
        expect(elenco.elenco[20]).toBe('[+5 elementi]');

        const tante: Record<string, number> = {};
        for (let i = 0; i < 45; i++) tante[`k${i}`] = i;
        const chiavi = redact(tante) as Record<string, unknown>;
        expect(Object.keys(chiavi)).toHaveLength(41); // 40 chiavi + il marcatore
        expect(chiavi['[…]']).toBe('[+5 chiavi]');
    });

    it('date, bigint e symbol non fanno saltare la redazione', () => {
        const out = redact({
            creato: new Date('2026-07-12T10:30:00Z'),
            rotta: new Date('non-una-data'),
            grande: BigInt(10),
            simbolo: Symbol('x'),
        }) as Record<string, unknown>;
        expect(out.creato).toBe('2026-07-12T10:30:00.000Z');
        expect(out.rotta).toBe('[data-invalida]'); // .toISOString() su data invalida LANCIA
        expect(out.grande).toBe('10n');
        expect(out.simbolo).toBe('[symbol]');
    });

    it('un riferimento CONDIVISO non è un ciclo (il dato non deve sparire)', () => {
        const condiviso = { tipo: 'assenza' };
        const out = redact({ a: condiviso, b: condiviso }) as Record<string, Record<string, unknown>>;
        expect(out.a.tipo).toBe('assenza');
        expect(out.b.tipo).toBe('assenza'); // NON '[ciclo]'

        const ciclico: Record<string, unknown> = { tipo: 'x' };
        ciclico.self = ciclico;
        const cic = redact(ciclico) as Record<string, unknown>;
        expect(cic.self).toBe('[ciclo]'); // il ciclo VERO invece si riconosce
    });

    it('hashCorrelabile non correla il FALSO: un oggetto non diventa un hash', () => {
        // String({...}) è "[object Object]" per qualunque oggetto: l'hash sarebbe
        // identico per persone diverse. Un hash che correla il falso è peggio di niente.
        expect(hashCorrelabile({ first: 'Mario' })).toBe('[redatto]');
        expect((redact({ nome: { first: 'Mario' } }) as Record<string, string>).nome).toBe('[redatto]');
    });

    it('hashCorrelabile è deterministico e corto', () => {
        expect(hashCorrelabile('x')).toBe(hashCorrelabile('x'));
        expect(hashCorrelabile('x')).toMatch(/^#[0-9a-f]{8}$/);
    });

    it('un campo VUOTO non diventa un identificativo: `hashCorrelabile("")` era una COSTANTE', () => {
        // Misurato in produzione (report privacy): in una riga `iscrizione warn` reale il nome,
        // il cognome, il codice fiscale e l'email di un adulto uscivano TUTTI come lo stesso
        // `#xxxxxxxx`, perché erano stringhe vuote. Lo stesso `#xxxxxxxx` compariva sulle righe
        // di persone DIVERSE: un hash "correlabile" che correla il VUOTO correla persone che non
        // c'entrano niente — e chi indaga ci crede, perché la riga sembra dire qualcosa.
        expect(hashCorrelabile('')).not.toMatch(/^#/);
        expect(hashCorrelabile('')).toBe('[redatto:str/0]');
        // Uno spazio non è un dato più di quanto lo sia il vuoto, e la LUNGHEZZA resta
        // diagnosticabile come per ogni altra stringa fuori dalla lista bianca.
        expect(hashCorrelabile('   ')).toBe('[redatto:str/3]');

        const vuoti = redact({
            nome: '', cognome: '', codice_fiscale: '', email: '',
        }) as Record<string, string>;
        for (const [chiave, valore] of Object.entries(vuoti)) {
            expect(valore, `"${chiave}" vuoto è uscito come identificativo`).not.toMatch(/^#/);
        }

        // CONTROLLO POSITIVO — la correlazione VERA, che è l'unica ragione per cui questo hash
        // esiste, continua a funzionare: la stessa persona resta lo stesso hash, due persone
        // diverse restano due hash diversi. Senza questo controllo il test sarebbe passato
        // anche spegnendo `hashCorrelabile` del tutto.
        expect(hashCorrelabile('Mario')).toMatch(/^#[0-9a-f]{8}$/);
        expect(hashCorrelabile('Mario')).toBe(hashCorrelabile('Mario'));
        expect(hashCorrelabile('Mario')).not.toBe(hashCorrelabile('Luigi'));
        expect((redact({ nome: 'Mario' }) as Record<string, string>).nome).toMatch(/^#[0-9a-f]{8}$/);
    });
});

/**
 * IL `digest` DI NEXT: l'unica deroga alla lista bianca, e l'unico filo fra l'utente e il log.
 *
 * `error.tsx` lo mostra come «il codice da dare alla segreteria» ed è l'unico appiglio che un
 * genitore ha quando telefona. `instrumentation.ts` lo mette in `campi.digest`, sulla riga che
 * porta lo STACK VERO. Finché `digest` non era in lista bianca, quella riga in tabella diceva
 * `[redatto:str/10]`: il codice dettato al telefono non trovava NESSUNA riga in SQL, e lo stack
 * — che c'era — restava irraggiungibile.
 *
 * La deroga però si stringe sul VALORE, e i test qui sotto sono lì apposta: `redact()` gira anche
 * sul BODY GREZZO di ogni richiesta (`parseBody` → `impostaPayload('body', raw)` PRIMA di zod), e
 * la sola chiave in lista bianca avrebbe aperto un canale di testo libero verso `app_log` a
 * chiunque sappia spedire `{"digest": "..."}`.
 */
describe('redact — il digest passa, ma solo se è un digest', () => {
    it('il digest di Next esce IN CHIARO: senza, il codice dell\'utente non trova nessuna riga', () => {
        // Le due forme che Next produce davvero: il digest numerico dei Server Component
        // (`stringHash`) e un hash esadecimale.
        const out = redact({
            operazione: '/parent/pagamenti',
            digest: '2043430104',
        }) as Record<string, unknown>;
        expect(out.digest).toBe('2043430104');

        const esa = redact({ digest: 'a3f9c1e7b20d4488' }) as Record<string, unknown>;
        expect(esa.digest).toBe('a3f9c1e7b20d4488');
    });

    it('ma è la FORMA a decidere: sotto `digest`, il testo libero resta redatto', () => {
        // Il vettore vero: `{"digest": "<qualunque cosa>"}` nel body di una POST finisce in
        // `app_log.contesto.payload.body` passando da `redact()`. Con la sola chiave in lista
        // bianca sarebbe un canale di testo libero — in chiaro, in tabella, per 30 giorni.
        const out = redact({
            digest: 'il bambino ha avuto una crisi in mensa',
        }) as Record<string, unknown>;
        expect(out.digest).toBe('[redatto:str/38]');
        expect(JSON.stringify(out)).not.toContain('crisi');
    });

    it('e nulla di sensibile entra insieme al digest: email, CF e path restano fuori', () => {
        // Ogni caso sotto la chiave `digest` VERA: è l'unica che apre, quindi è l'unica su cui
        // il guardiano del valore vale qualcosa. (Con `digest2`/`digest3` il test si assolverebbe
        // da solo: quelle chiavi non sono in lista bianca e sarebbero redatte comunque.)
        const email = redact({ digest: 'mario.rossi@example.com' }) as Record<string, unknown>;
        expect(email.digest).toBe('[redatto:str/23]');
        expect(JSON.stringify(email)).not.toContain('mario.rossi');

        const cf = redact({ digest: 'RSSMRA80A01H501U' }) as Record<string, unknown>;
        expect(cf.digest).toBe('[redatto:str/16]');
        expect(JSON.stringify(cf)).not.toContain('RSSMRA80A01H501U');

        // Il digest di CONTROLLO di Next non è un hash: è una stringa con dentro un PATH. E in
        // questo repo il path È una credenziale (`/m/[token]` è una capability). Una lista
        // bianca sulla sola chiave avrebbe versato nei log proprio ciò che `redigiPath` toglie.
        const redirect = redact({
            digest: 'NEXT_REDIRECT;replace;/m/tok_live_9f8e7d6c5b4a3210;307;',
        }) as Record<string, unknown>;
        const json = JSON.stringify(redirect);
        expect(json).not.toContain('tok_live');
        expect(json).not.toContain('NEXT_REDIRECT');
    });

    it('un valore troppo lungo per essere un digest non lo è: redatto', () => {
        // 64 caratteri sono uno sha256 in esadecimale. Oltre, non è un digest: è qualcos'altro,
        // e la lista bianca non deve indovinare cosa.
        const out = redact({ digest: 'a'.repeat(65) }) as Record<string, unknown>;
        expect(out.digest).toBe('[redatto:str/65]');
    });

    it('la deroga vale per la chiave `digest`, non per gli esadecimali del mondo', () => {
        // Un valore esadecimale sotto un'ALTRA chiave resta chiuso: la chiave apre, il valore
        // conferma — non il contrario. Altrimenti basterebbe un dato che "sembra" un hash.
        const out = redact({ note: 'deadbeef', codice: 'abc123' }) as Record<string, unknown>;
        expect(out.note).toBe('[redatto:str/8]');
        expect(out.codice).toBe('[redatto:str/6]');
    });

    it('il digest NON scavalca i segreti: una chiave segreta resta segreta', () => {
        // `eSegreta` gira PRIMA: se un domani nascesse un `digest_password` o un `token_digest`,
        // la radice segreta vince e il valore sparisce comunque.
        const out = redact({
            digest_password: 'aaaaaaaa',
            token_digest: 'deadbeef',
        }) as Record<string, unknown>;
        expect(out.digest_password).toBe('[redatto]');
        expect(out.token_digest).toBe('[redatto]');
    });
});
