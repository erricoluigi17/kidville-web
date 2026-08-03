import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
    readFileSync,
    writeFileSync,
    existsSync,
    statSync,
    readdirSync,
    mkdtempSync,
    mkdirSync,
    rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * Lock — LA PASSWORD DEGLI ACCOUNT TEST NON RESTA NEI LOG DI MAESTRO.
 *
 * LA STORIA, misurata e non temuta. Maestro scrive la password **in chiaro** dentro
 * `~/.maestro/tests/<run>/maestro.log`, e non c'è modo di impedirglielo dal flow: il
 * 2026-08-01, con due canarini finti, si è verificato che finisce nel log sia il valore
 * passato come variabile d'ambiente sia quello passato con `-e NOME=valore`, e che in più
 * Maestro logga da sé il testo digitato (`Inputting text: <password>`).
 *
 * Non è una password qualunque: è quella, UNICA, dei 41 account TEST che vivono in
 * PRODUZIONE — fra cui `test.segreteria@kidville.test`, che legge l'anagrafica dell'intera
 * sede, e `test.multisede.admin@kidville.test`, che vede tutte e tre le sedi.
 *
 * Il 2026-08-01 sotto `~/.maestro/tests` c'erano **70 file** con la password corrente in
 * chiaro (278 occorrenze) e, dopo averli ripuliti, altre **156 righe** con password già
 * RUOTATE. Il rimedio esisteva già — `esegui.sh` con la sua bonifica — ma:
 *   · nessuno l'aveva mai eseguito, perché il README insegnava `maestro test` a mano;
 *   · e inseguiva UN valore, quello corrente, quindi era cieco su tutti gli altri.
 *
 * QUEST'ULTIMO È IL PUNTO. Una pulizia che insegue un valore diventa cieca da sé a ogni
 * rotazione della password: il giorno dopo la rotazione i log vecchi non vengono più
 * toccati da nessuno, e nessuno se ne accorge perché il file «è passato dalla bonifica».
 * Perciò questo lock non chiede che la bonifica ESISTA — chiede che sia per FORMA.
 *
 * PERCHÉ UN LOCK E NON UNA NOTA. Tutto il resto dello step S12 è sorvegliato da
 * `maestro-flows-selettori.test.ts`; questa metà no, ed è quella che può tornare senza
 * fare rumore: basta che qualcuno «semplifichi» la funzione o riscriva l'esempio nel
 * README. La verifica del contenuto di `~/.maestro/tests` non sta qui di proposito — è
 * fuori dal repo, non esiste in CI, e un lock che dipende dalla macchina di chi lo lancia
 * è un lock che si impara a spegnere.
 */

const RADICE = process.cwd()
const FLOWS = join(RADICE, '.claude', 'maestro-flows')
const SCRIPT = join(FLOWS, 'esegui.sh')

const script = existsSync(SCRIPT) ? readFileSync(SCRIPT, 'utf8') : ''

describe('lock architettura · la password TEST non sopravvive nei log di Maestro', () => {
    it("l'esecutore con la bonifica esiste ed è eseguibile", () => {
        expect(
            existsSync(SCRIPT),
            `Manca \`.claude/maestro-flows/esegui.sh\`. È l'unico posto in cui la password degli ` +
            `account TEST di produzione viene tolta dai log di Maestro: senza, ogni esecuzione ` +
            `di un flow la lascia in chiaro su disco.`,
        ).toBe(true)
        // Un file non eseguibile è un file che nessuno lancerà: si tornerebbe a
        // `maestro test` a mano, cioè al difetto.
        expect(
            (statSync(SCRIPT).mode & 0o111) !== 0,
            `\`esegui.sh\` non ha il bit di esecuzione: \`chmod +x .claude/maestro-flows/esegui.sh\`.`,
        ).toBe(true)
    })

    it('la bonifica è agganciata a trap EXIT INT TERM, non alla fine dello script', () => {
        // Il caso pericoloso è quello in cui lo script NON arriva in fondo: flow fallito,
        // Ctrl-C, timeout dell'orchestratore. Se la pulizia sta in coda, lì il segreto resta.
        const trap = /trap\s+bonifica\s+EXIT\s+INT\s+TERM/.exec(script)
        expect(
            trap?.[0],
            `La bonifica deve essere agganciata a \`trap bonifica EXIT INT TERM\`: se sta in coda ` +
            `allo script, un flow fallito o un Ctrl-C lasciano la password su disco — ed è ` +
            `esattamente quando un collaudo va male che si preme Ctrl-C.`,
        ).toBeTruthy()
    })

    it('la bonifica maschera per FORMA, non solo il valore corrente', () => {
        // ⟵ IL CUORE DEL LOCK. `s/\Q$p\E/***/g` da solo era il difetto del 2026-08-01:
        // ripuliva la password di oggi e lasciava intatte tutte quelle di ieri.
        //
        // Questa asserzione, fino al 2026-08-02, cercava la stringa letterale
        // `(MAESTRO_KV_PASSWORD=)`. Cioè fissava il NOME della variabile — e un elenco
        // chiuso di nomi è lo stesso difetto di un elenco chiuso di valori: passava
        // verde mentre 211 righe `KV_PASSWORD=<valore>` restavano in chiaro. Ora chiede
        // la CLASSE dei nomi che denunciano un segreto.
        const suffissi = ['PASSWORD', 'PASSWD', 'PWD', 'SECRET', 'TOKEN', 'KEY']
        const mancanti = suffissi.filter((s) => !new RegExp(`\\b${s}\\b`).test(script))
        expect(
            mancanti,
            `La maschera per forma non copre questi suffissi di nome. Deve mascherare il valore ` +
            `di QUALUNQUE variabile il cui nome finisca per ${suffissi.join(', ')}: i flow ` +
            `dichiarano da sé nomi che questo script non ha mai visto (\`KV_PASSWORD\` nel loro ` +
            `blocco \`env:\`), e chi ne aggiungerà un altro non verrà a modificare la bonifica.`,
        ).toEqual([])

        const perForma = [{ chiave: 'Inputting text: ', re: /Inputting text: \)/ }]
        const assenti = perForma.filter((p) => !p.re.test(script)).map((p) => p.chiave)
        expect(
            assenti,
            `La bonifica non maschera per FORMA questi punti: una pulizia che insegue il solo ` +
            `valore corrente è cieca sulle password già ruotate, e lo diventa da sé a ogni ` +
            `rotazione. Il 2026-08-01 restavano 156 righe in chiaro proprio per questo.`,
        ).toEqual([])

        // Controllo positivo: senza la sostituzione del valore corrente, le due regex per
        // forma non coprirebbero un log che scrive la password in una riga di forma nuova.
        expect(
            /\\Q\$p\\E/.test(script),
            `Sparita la sostituzione del valore corrente (\`s/\\Q$p\\E/***/g\`): la bonifica per ` +
            `forma copre i due punti noti, non una riga che Maestro imparasse a scrivere domani.`,
        ).toBe(true)
    })

    it('la bonifica guarda tutti i file, non tre estensioni indovinate', () => {
        const find = /find\s+"\$dir"\s+-type\s+f([^\n]*)/.exec(script)
        expect(find, 'Non trovo il `find` della bonifica in esegui.sh').toBeTruthy()
        expect(
            find?.[1] ?? '',
            `Il \`find\` della bonifica filtra per estensione. Quella terna (\`*.log\`, \`*.json\`, ` +
            `\`*.txt\`) era un'ipotesi su come Maestro nomina i suoi file, e un'ipotesi sbagliata ` +
            `qui si paga in segreti: deve passare su -type f e basta.`,
        ).not.toMatch(/-name/)
    })

    it('lo script non contiene la password: la legge da KV_TEST_PASSWORD', () => {
        expect(
            /KV_TEST_PASSWORD/.test(script),
            `\`esegui.sh\` deve prendere la password da \`KV_TEST_PASSWORD\` — la sorgente unica ` +
            `di tutto il repo (\`e2e/lib/test-password.mjs\`, \`scripts/seed-test-sedi.mjs\`).`,
        ).toBe(true)
        // Assente → si esce, senza default e senza stringa vuota: una password vuota
        // farebbe girare la bonifica su `s//***/g`, che è un modo elaborato di non pulire.
        expect(
            /if\s+\[\[\s+-z\s+"\$PW"\s+\]\]/.test(script),
            `Senza la guardia sul valore vuoto, \`esegui.sh\` lancerebbe il flow con una password ` +
            `vuota e la bonifica girerebbe a vuoto.`,
        ).toBe(true)
    })

    it('nessun documento insegna a lanciare i flow con la password in variabile', () => {
        // È il difetto che ha prodotto i 70 file: il README mostrava
        // `maestro test -e KV_PASSWORD="$MAESTRO_KV_PASSWORD" …` e non nominava esegui.sh.
        // Chi segue la documentazione riempie i log, e lo fa in buona fede.
        const documenti = readdirSync(FLOWS)
            .filter((f) => f.endsWith('.md') || f.endsWith('.yaml'))
            .map((f) => ({ nome: f, testo: readFileSync(join(FLOWS, f), 'utf8') }))

        const colpevoli: string[] = []
        for (const d of documenti) {
            d.testo.split('\n').forEach((riga, i) => {
                // Si cerca l'INVOCAZIONE, non la parola: i file possono (e devono) parlare
                // del problema, spiegarlo e citare il nome della variabile.
                if (/^\s*maestro\s+test\b/.test(riga)) colpevoli.push(`${d.nome}:${i + 1}`)
                if (/-e\s+KV_PASSWORD=/.test(riga)) colpevoli.push(`${d.nome}:${i + 1}`)
            })
        }
        expect(
            [...new Set(colpevoli)].sort(),
            `Questi punti insegnano a invocare Maestro direttamente. I flow si lanciano SEMPRE da ` +
            `\`.claude/maestro-flows/esegui.sh\`: è l'unica strada che poi ripulisce i log. Una ` +
            `riga di documentazione che mostra l'altra è il modo più efficace di riempirli di ` +
            `nuovo — è così che ci sono finiti 70 file.`,
        ).toEqual([])
    })
})

/**
 * ─── LA BONIFICA ESEGUITA DAVVERO, SU CANARINI FINTI ────────────────────────────
 *
 * I test qui sopra leggono lo script. Leggere non basta, e il 2026-08-02 si è visto
 * perché: passavano tutti mentre sotto `~/.maestro/tests` c'erano **211 occorrenze di
 * `KV_PASSWORD=<valore>` in chiaro** — e **0** di `MAESTRO_KV_PASSWORD=`, l'unica forma
 * che la maschera conosceva.
 *
 * LA CAUSA RADICE, ed è una sola riga di YAML. I flow non usano direttamente la
 * variabile d'ambiente: la ri-dichiarano nel loro blocco `env:` con un ALTRO nome —
 * `KV_PASSWORD: ${MAESTRO_KV_PASSWORD}` — e Maestro logga anche quella, dentro lo stesso
 * `DefineVariablesCommand(env={…})`. Il difetto non si vedeva perché la maschera per
 * VALORE prendeva comunque la password del giorno; ma alla rotazione del 2026-07-31 i log
 * di prima sono rimasti lì, con una password che la bonifica non conosce più.
 *
 * È lo stesso difetto già scritto in `esegui.sh` per `MAESTRO_KV_PASSWORD` — «una pulizia
 * che insegue UN valore è cieca su tutti gli altri, e diventa cieca da sé a ogni
 * rotazione» — applicato a metà: era stata corretta la forma nota, non la classe.
 *
 * Perciò questo blocco non legge lo script: lo **esegue**, su una cartella temporanea con
 * canarini che NON sono la password vera. È l'unico modo di sapere se maschera davvero, e
 * l'unico che resta valido se domani qualcuno riscrive la funzione con un'altra sintassi.
 *
 * Sicurezza del test: la directory da bonificare arriva da `MAESTRO_TESTS_DIR`, e punta a
 * una `mkdtemp` fuori dal repo. `~/.maestro/tests` — che contiene i log veri del collaudo —
 * non viene mai né letta né toccata.
 */
describe('lock architettura · la bonifica eseguita davvero (canarini finti, cartella temporanea)', () => {
    // Canarini: stringhe inventate, mai la password vera. Il repo è pubblico.
    const VALORE_CORRENTE = 'canarino-valore-corrente-finto'
    const CANARINI = {
        secondoNome: 'canarino-uno', // KV_PASSWORD=  ← il buco del 2026-08-02
        nomeNoto: 'canarino-due', // MAESTRO_KV_PASSWORD=
        token: 'canarino-tre', // KV_API_TOKEN=
        digitato: 'canarino-quattro', // Inputting text:
        passwd: 'canarino-cinque', // …_PASSWD=
        chiave: 'canarino-sei', // …_KEY=
        segreto: 'canarino-sette', // …_SECRET=
        pwd: 'canarino-otto', // …_PWD=
        // Il COOKIE DI SESSIONE Supabase: `sb-<ref>-auth-token`. Nome in minuscolo e
        // con i TRATTINI, cioè fuori dalla classe `[A-Za-z0-9_]*` che la maschera
        // conosceva — vedi il caso qui sotto.
        cookie: 'canarino-nove',
    }

    let dir = ''
    let dopo: Record<string, string> = {}
    let uscita = ''

    const leggi = (rel: string) => readFileSync(join(dir, rel), 'utf8')

    beforeAll(() => {
        // Guardia, prima di eseguire qualunque cosa: se lo script non leggesse più
        // `MAESTRO_TESTS_DIR`, questo test andrebbe a riscrivere `~/.maestro/tests`, cioè
        // i log veri del collaudo. Un test che ripulisce di nascosto i file di casa è il
        // modo migliore per rendere impossibile capire se la bonifica funziona.
        if (!/MAESTRO_TESTS_DIR/.test(script)) {
            throw new Error(
                'esegui.sh non legge più MAESTRO_TESTS_DIR: la bonifica non è più dirigibile ' +
                'su una cartella di prova, e questo test non deve toccare ~/.maestro/tests.',
            )
        }

        dir = mkdtempSync(join(tmpdir(), 'kv-bonifica-canarini-'))
        mkdirSync(join(dir, '2026-08-02_120000'), { recursive: true })

        // Riproduce la forma esatta con cui Maestro scrive le variabili: un solo
        // `DefineVariablesCommand(env={…})` con le due chiavi diverse, virgola e graffa.
        writeFileSync(
            join(dir, '2026-08-02_120000', 'maestro.log'),
            [
                'INFO: maestro.orchestra.Orchestra: DefineVariablesCommand(env={' +
                    'KV_EMAIL=test.inf.genitore1@kidville.test, ' +
                    `KV_PASSWORD=${CANARINI.secondoNome}}, label=null)`,
                'INFO: env dump: MAESTRO_DRIVER_STARTUP_TIMEOUT=240000, ' +
                    `MAESTRO_KV_PASSWORD=${CANARINI.nomeNoto}, MAESTRO_KV_EMAIL_DOCENTE=x@kidville.test`,
                `INFO: maestro.Maestro: inputText: Inputting text: ${CANARINI.digitato}`,
                // Controlli negativi: la diagnostica del collaudo deve sopravvivere.
                'INFO: maestro.Maestro: inputText: Inputting text: test.segreteria@kidville.test',
                'INFO: maestro.Maestro: inputText: Inputting text: 1234',
                'INFO: tempo di avvio: MAESTRO_DRIVER_STARTUP_TIMEOUT=240000',
                // `pressKey` finisce per KEY: 52 occorrenze nello storico al 2026-08-02.
                // Mascherarlo toglierebbe dai log quale tasto è stato premuto — cioè metà
                // di ciò che serve a capire un flow fallito. La maschera guarda `=`, non `:`.
                'INFO: maestro.Maestro: pressKey: ENTER',
                'INFO: già bonificato in un run precedente: KV_PASSWORD=***',
            ].join('\n') + '\n',
            'utf8',
        )

        // File senza estensione e in sottocartella: il `find` deve arrivarci comunque.
        writeFileSync(
            join(dir, '2026-08-02_120000', 'commands-senza-estensione'),
            [
                `KV_API_TOKEN=${CANARINI.token}`,
                `KV_DB_PASSWD=${CANARINI.passwd}`,
                `SUPABASE_SERVICE_KEY=${CANARINI.chiave}`,
                `KV_WEBHOOK_SECRET=${CANARINI.segreto}`,
                `KV_PWD=${CANARINI.pwd}`,
                // IL COOKIE DI SESSIONE, nelle due forme in cui compare davvero.
                `set-cookie: sb-uimulkjyekgemjakmepp-auth-token=${CANARINI.cookie}; Path=/`,
                `document.cookie = "sb-uimulkjyekgemjakmepp-auth-token=${CANARINI.cookie}; Max-Age=3600"`,
                `{"sb-uimulkjyekgemjakmepp-auth-token": "${CANARINI.cookie}"}`,
                // La sostituzione per VALORE resta indispensabile: copre le forme che
                // nessuno ha ancora visto, come questa.
                `una-riga-di-forma-mai-vista: ${VALORE_CORRENTE}`,
            ].join('\n') + '\n',
            'utf8',
        )

        uscita = execFileSync('bash', [SCRIPT, '--solo-bonifica'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                // La directory da bonificare: la temporanea, MAI `~/.maestro/tests`.
                MAESTRO_TESTS_DIR: dir,
                // Il "valore corrente" è finto: la password vera non entra nel test,
                // non viene letta e non viene stampata.
                KV_TEST_PASSWORD: VALORE_CORRENTE,
                MAESTRO_KV_PASSWORD: VALORE_CORRENTE,
            },
        })

        dopo = {
            log: leggi(join('2026-08-02_120000', 'maestro.log')),
            senzaEstensione: leggi(join('2026-08-02_120000', 'commands-senza-estensione')),
        }
    })

    afterAll(() => {
        if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('maschera il COOKIE DI SESSIONE `sb-<ref>-auth-token`, in tutte e tre le forme', () => {
        // ⟵ IL CASO CHE MANCAVA (misurato il 2026-08-03, verifica adversariale W9r).
        //
        // La maschera per CLASSE conosce la famiglia `…TOKEN=`, ma il nome ammetteva
        // solo `[A-Za-z0-9_]*`: il cookie di Supabase si chiama
        // `sb-<ref>-auth-token`, tutto minuscolo e con i TRATTINI, e nessuna delle due
        // regole lo vedeva. Provato eseguendo la bonifica vera su un canarino: la
        // password veniva mascherata e il cookie restava in chiaro, riga sotto.
        //
        // NON È UN SEGRETO DI SECONDA FASCIA: quel valore È la sessione. Chi ce l'ha
        // in mano è l'utente collegato finché non scade, senza sapere la password e
        // senza passare dal login — e i flow Maestro girano sugli account TEST di
        // PRODUZIONE, fra cui `test.segreteria@kidville.test`, che legge l'anagrafica
        // di un'intera sede. È la stessa lezione già scritta due volte in cima a
        // `esegui.sh` — prima per i VALORI, poi per i NOMI — applicata ora alla terza
        // dimensione che era rimasta fuori: l'ALFABETO del nome.
        expect(
            dopo.senzaEstensione,
            'il cookie di sessione è sopravvissuto alla bonifica: chi lo legge è dentro come ' +
                'quell’utente, senza password e senza login',
        ).not.toContain(CANARINI.cookie)
        // Tutte e tre le forme, non solo la prima che capita.
        expect(dopo.senzaEstensione).toContain('sb-uimulkjyekgemjakmepp-auth-token=***')
        expect(dopo.senzaEstensione).toContain('"sb-uimulkjyekgemjakmepp-auth-token": "***"')
    })

    it('maschera `KV_PASSWORD=` — il secondo nome, quello che i flow dichiarano da sé', () => {
        // ⟵ IL CASO CHE MANCAVA. Il 2026-08-02: 211 occorrenze in chiaro sotto
        // ~/.maestro/tests, tutte di questa forma, tutte passate dalla bonifica.
        expect(
            dopo.log.includes(CANARINI.secondoNome),
            `\`KV_PASSWORD=<valore>\` è rimasto in chiaro. È la forma che i flow generano da ` +
            `soli — ogni YAML dichiara \`KV_PASSWORD: \${MAESTRO_KV_PASSWORD}\` nel blocco ` +
            `\`env:\` — e Maestro la scrive nel log accanto a quella nota. Finché la password ` +
            `è quella corrente il difetto non si vede, perché la maschera per VALORE la prende ` +
            `lo stesso: si vede il giorno DOPO la rotazione, sui log di prima, quando non c'è ` +
            `più nessun valore da inseguire.`,
        ).toBe(false)
        expect(dopo.log).toMatch(/KV_PASSWORD=\*\*\*\}/)
    })

    it('maschera qualunque nome della famiglia: PASSWORD · PASSWD · PWD · SECRET · TOKEN · KEY', () => {
        // Un elenco chiuso di NOMI ha lo stesso difetto di un elenco chiuso di VALORI:
        // copre ciò che è già successo. Domani un flow chiamerà la variabile in un
        // altro modo, e la bonifica sarà cieca senza che nessuno la modifichi.
        const superstiti = Object.entries(CANARINI)
            .filter(([, valore]) => dopo.senzaEstensione.includes(valore))
            .map(([nome]) => nome)
        expect(
            superstiti,
            `Questi canarini sono sopravvissuti: la maschera per forma copre solo i nomi già ` +
            `visti, non la classe. Deve mascherare il valore di QUALUNQUE variabile il cui nome ` +
            `finisca per PASSWORD, PASSWD, PWD, SECRET, TOKEN o KEY.`,
        ).toEqual([])
    })

    it('maschera `MAESTRO_KV_PASSWORD=` e il testo digitato (le due forme già coperte)', () => {
        expect(dopo.log.includes(CANARINI.nomeNoto)).toBe(false)
        expect(dopo.log.includes(CANARINI.digitato)).toBe(false)
        expect(dopo.log).toMatch(/MAESTRO_KV_PASSWORD=\*\*\*/)
        expect(dopo.log).toMatch(/Inputting text: \*\*\*/)
    })

    it('maschera il valore corrente anche in una forma mai vista', () => {
        // La maschera per forma copre i nomi noti; la maschera per valore copre la riga
        // che Maestro imparasse a scrivere domani. Servono entrambe.
        expect(
            dopo.senzaEstensione.includes(VALORE_CORRENTE),
            `La sostituzione del valore corrente è sparita: resta scoperta ogni riga di forma ` +
            `nuova.`,
        ).toBe(false)
    })

    it('non maschera ciò che serve a capire il collaudo (email, timeout, testo corto)', () => {
        // Una bonifica che cancella tutto è una bonifica che qualcuno spegnerà.
        expect(dopo.log).toContain('KV_EMAIL=test.inf.genitore1@kidville.test')
        expect(dopo.log).toContain('MAESTRO_DRIVER_STARTUP_TIMEOUT=240000')
        expect(dopo.log).toContain('Inputting text: test.segreteria@kidville.test')
        expect(dopo.log).toContain('Inputting text: 1234')
        expect(dopo.log).toContain('pressKey: ENTER')
        // Idempotente: ciò che era già `***` non diventa `******`.
        expect(dopo.log).toContain('KV_PASSWORD=***\n')
        expect(dopo.log).not.toMatch(/\*{4,}/)
    })

    it('non stampa mai un segreto, e dice quanti file ha toccato', () => {
        for (const canarino of [...Object.values(CANARINI), VALORE_CORRENTE]) {
            expect(
                uscita.includes(canarino),
                `L'output di esegui.sh contiene un canarino: la bonifica non deve MAI stampare ` +
                `ciò che sta mascherando — finirebbe nel log dell'orchestratore, che è ` +
                `esattamente il posto da cui lo stiamo togliendo.`,
            ).toBe(false)
        }
        expect(uscita).toMatch(/bonifica log Maestro: 2 file/)
    })
})
