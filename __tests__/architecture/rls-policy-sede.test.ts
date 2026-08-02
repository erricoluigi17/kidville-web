import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · una policy `USING (true)` o si chiude, o si dichiara. Mai si dimentica.
 *
 * Perché esiste. Il collaudo del 2026-07-31 (warning sicurezza W6) ha contato 13 policy
 * `SELECT TO authenticated USING (true)` sopravvissute alla pulizia RLS del 31 luglio:
 * campanelle, materie, menù, causali, obiettivi… e **due che sono per SEZIONE** —
 * `orario_settimanale` e `sezione_materia_obiettivo`. Con tre sedi in produzione quel
 * `true` significa che un genitore di Aversa, con la sola chiave anon del browser e la
 * propria sessione, legge via PostgREST l'orario delle classi di Giugliano: chi insegna,
 * cosa, in che ora e in quale sezione. Nessun errore, nessun log, nessun test rosso —
 * la tabella restituisce solo più righe del dovuto.
 *
 * Le altre undici restano `true` per **decisione scritta**, che è cosa diversa da una
 * dimenticanza: sono configurazione (orari di campanella, nomi delle materie, menù della
 * mensa, causali contabili), non dati di minori. Questo lock pretende che quella
 * decisione stia scritta **sulla policy**, in produzione, dove la legge chi apre il
 * database — non in un commento di una migrazione che nessuno riaprirà.
 *
 * Come guarda. Incrocia due fonti che non si possono compiacere a vicenda:
 *   · `__tests__/fixtures/pg-policies-snapshot.json` — la fotografia di `pg_policies`
 *     presa sul DB di produzione: dice quali `true` ci sono DAVVERO;
 *   · `supabase/migrations/*.sql` — dice come ciascuna viene trattata.
 * Una policy `true` è «trattata» se la migrazione la droppa, la sostituisce con un
 * predicato vero, o le appende un `COMMENT ON POLICY` con la ragione per esteso.
 * Il lock resta quindi verde sia PRIMA sia DOPO l'applicazione della migrazione, e
 * diventa rosso il giorno in cui una `true` nuova compare senza che nessuno decida.
 *
 * Non sostituisce `rls-per-sede.test.ts` (che sorveglia la forma di TUTTE le policy):
 * quello ammette le `true` di configurazione tramite un'ALLOWLIST scritta nel test;
 * questo pretende che la stessa decisione sia scritta anche nel database.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')
const FOTOGRAFIA = join(process.cwd(), '__tests__', 'fixtures', 'pg-policies-snapshot.json')

/** Il file di questo step. Se cambia nome, cambia qui: il lock deve puntare a un file vero. */
const MIGRAZIONE_S33 = '_policy_orario_per_sede.sql'

/**
 * Le due tabelle che il collaudo ha misurato come leggibili in cross-sede e che sono
 * per SEZIONE: qui il commento non basta, ci vuole il predicato.
 */
const DA_CHIUDERE_CON_PREDICATO = ['orario_settimanale', 'sezione_materia_obiettivo'] as const

type Policy = {
    tabella: string
    policy: string
    cmd: string
    permissive: string
    ruoli: string[]
    using_expr: string
    check_expr: string
}

type Fotografia = {
    generato_il: string
    policies: Policy[]
    tabelle_con_scuola_id: string[]
    tabelle_rls_attiva: string[]
}

const foto: Fotografia = JSON.parse(readFileSync(FOTOGRAFIA, 'utf8'))

// ─────────────────────────────────────────────────────────────────────────────
// Lettura dell'SQL. Si guarda l'SQL ESEGUITO, non la prosa: una migrazione che
// SPIEGA nel proprio commento perché una policy era `USING (true)` non deve essere
// scambiata per una che ne crea una. È la lezione di security-definer-revoke-lock.
// ─────────────────────────────────────────────────────────────────────────────

function sqlSenzaCommenti(testo: string): string {
    return testo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/** L'SQL spezzato in statement, rispettando le stringhe `'…'` e i corpi `$tag$…$tag$`. */
function statementSql(sql: string): string[] {
    const fuori: string[] = []
    let corrente = ''
    let i = 0
    while (i < sql.length) {
        const c = sql[i]
        if (c === "'") {
            let j = i + 1
            while (j < sql.length) {
                if (sql[j] === "'") {
                    if (sql[j + 1] === "'") {
                        j += 2
                        continue
                    }
                    break
                }
                j++
            }
            corrente += sql.slice(i, Math.min(j + 1, sql.length))
            i = j + 1
            continue
        }
        if (c === '$') {
            const apertura = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))
            if (apertura) {
                const tag = apertura[0]
                const fine = sql.indexOf(tag, i + tag.length)
                const j = fine === -1 ? sql.length : fine + tag.length
                corrente += sql.slice(i, j)
                i = j
                continue
            }
        }
        if (c === ';') {
            fuori.push(corrente)
            corrente = ''
            i++
            continue
        }
        corrente += c
        i++
    }
    fuori.push(corrente)
    return fuori.filter((s) => s.trim().length > 0)
}

/** Identificatore SQL: nudo o fra virgolette. */
const NOME = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`

function nomeSemplice(qualificato: string): string {
    const pezzi = qualificato.split('.')
    return (pezzi[pezzi.length - 1] ?? '').trim().replace(/"/g, '')
}

/** Il contenuto della parentesi che si apre alla posizione `da` (che deve essere una `(`). */
function contenutoParentesi(testo: string, da: number): string {
    let profondita = 0
    for (let i = da; i < testo.length; i++) {
        const c = testo[i]
        if (c === "'") {
            i++
            while (i < testo.length && testo[i] !== "'") i++
            continue
        }
        if (c === '(') profondita++
        if (c === ')') {
            profondita--
            if (profondita === 0) return testo.slice(da + 1, i)
        }
    }
    return testo.slice(da + 1)
}

/** L'espressione di una clausola (`USING`, `WITH CHECK`) dentro uno statement. */
function clausola(statement: string, parolaChiave: RegExp): string {
    const m = parolaChiave.exec(statement)
    if (!m) return ''
    const apertura = statement.indexOf('(', m.index + m[0].length - 1)
    if (apertura === -1) return ''
    return contenutoParentesi(statement, apertura).replace(/\s+/g, ' ').trim()
}

type PolicyCreata = {
    tabella: string
    policy: string
    cmd: string
    ruoli: string
    using: string
    check: string
    file: string
}

function creazioni(sql: string, file: string): PolicyCreata[] {
    const create: PolicyCreata[] = []
    for (const statement of statementSql(sqlSenzaCommenti(sql))) {
        const m = new RegExp(String.raw`\bCREATE\s+POLICY\s+(${NOME})\s+ON\s+((?:${NOME}\s*\.\s*)?${NOME})`, 'i').exec(
            statement,
        )
        if (!m) continue
        const cmd = /\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i.exec(statement)?.[1]?.toUpperCase() ?? 'ALL'
        // I ruoli arrivano fino a `USING`/`WITH CHECK`, e nell'SQL di questo repo stanno su
        // un'altra riga: la classe deve poter attraversare il ritorno a capo, altrimenti la
        // clausola non viene mai letta e OGNI policy risulta senza ruoli — cioè il filtro
        // «solo authenticated» diventa muto e il lock non controlla più niente.
        // È `[\w",\s]` a farlo, non un flag: qui non c'è nessun `.`, quindi `s` sarebbe
        // inerte — e con `target: ES2017` non compila nemmeno (TS1501).
        const ruoli = /\bTO\s+([A-Za-z_"][\w",\s]*?)\s*(?=USING|WITH\s+CHECK|$)/i.exec(statement)?.[1]?.trim() ?? ''
        create.push({
            tabella: nomeSemplice(m[2]),
            policy: nomeSemplice(m[1]),
            cmd,
            ruoli,
            using: clausola(statement, /\bUSING\s*\(/i),
            check: clausola(statement, /\bWITH\s+CHECK\s*\(/i),
            file,
        })
    }
    return create
}

function eliminazioni(sql: string): { tabella: string; policy: string }[] {
    const drop: { tabella: string; policy: string }[] = []
    for (const statement of statementSql(sqlSenzaCommenti(sql))) {
        const m = new RegExp(
            String.raw`\bDROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${NOME})\s+ON\s+((?:${NOME}\s*\.\s*)?${NOME})`,
            'i',
        ).exec(statement)
        if (!m) continue
        drop.push({ tabella: nomeSemplice(m[2]), policy: nomeSemplice(m[1]) })
    }
    return drop
}

function commenti(sql: string): { tabella: string; policy: string; testo: string }[] {
    const esiti: { tabella: string; policy: string; testo: string }[] = []
    for (const statement of statementSql(sqlSenzaCommenti(sql))) {
        const m = new RegExp(
            String.raw`\bCOMMENT\s+ON\s+POLICY\s+(${NOME})\s+ON\s+((?:${NOME}\s*\.\s*)?${NOME})\s+IS\s+'((?:[^']|'')*)'`,
            'i',
        ).exec(statement)
        if (!m) continue
        esiti.push({ tabella: nomeSemplice(m[2]), policy: nomeSemplice(m[1]), testo: m[3].replace(/''/g, "'") })
    }
    return esiti
}

// ─────────────────────────────────────────────────────────────────────────────
// Le fonti
// ─────────────────────────────────────────────────────────────────────────────

const fileMigrazioni = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()

const sqlPerFile = new Map(fileMigrazioni.map((f) => [f, readFileSync(join(MIGRAZIONI, f), 'utf8')]))

const tutteLeCreazioni = fileMigrazioni.flatMap((f) => creazioni(sqlPerFile.get(f) ?? '', f))
const tutteLeEliminazioni = fileMigrazioni.flatMap((f) => eliminazioni(sqlPerFile.get(f) ?? ''))
const tuttiICommenti = fileMigrazioni.flatMap((f) => commenti(sqlPerFile.get(f) ?? ''))

const fileS33 = fileMigrazioni.find((f) => f.endsWith(MIGRAZIONE_S33))
const sqlS33 = fileS33 ? (sqlPerFile.get(fileS33) ?? '') : ''

/** Le tabelle che portano `section_id`: la sezione È il legame con la sede (`sections.scuola_id`). */
const tabelleConSezione = new Set<string>()
for (const [, sql] of sqlPerFile) {
    const senzaCommenti = sqlSenzaCommenti(sql)
    for (const m of senzaCommenti.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
        if (/\bsection_id\b/.test(m[2])) tabelleConSezione.add(m[1])
    }
    for (const m of senzaCommenti.matchAll(/ALTER TABLE (?:ONLY )?(?:public\.)?(\w+)[\s\S]{0,200}?ADD COLUMN (?:IF NOT EXISTS )?section_id\b/gi)) {
        tabelleConSezione.add(m[1])
    }
}

const tabelleConSede = new Set(foto.tabelle_con_scuola_id)

/** Le policy `USING (true)` che la produzione ha davvero, per un ruolo non-service_role. */
const permissiveNude = foto.policies.filter(
    (p) => p.permissive === 'PERMISSIVE' && (p.using_expr === 'true' || p.check_expr === 'true'),
)

function chiave(p: { tabella: string; policy: string }): string {
    return `${p.tabella} · ${p.policy}`
}

const droppate = new Set(tutteLeEliminazioni.map(chiave))
const commentate = new Map(tuttiICommenti.map((c) => [chiave(c), c.testo]))

/** Una policy di SELECT, per `authenticated`, con un predicato che non è `true`. */
function letturaVincolata(tabella: string): PolicyCreata[] {
    return tutteLeCreazioni.filter(
        (c) =>
            c.tabella === tabella &&
            (c.cmd === 'SELECT' || c.cmd === 'ALL') &&
            /\bauthenticated\b/.test(c.ruoli) &&
            c.using.trim().toLowerCase() !== 'true' &&
            c.using.trim().length > 0,
    )
}

describe('lock architettura · le policy `USING (true)` si chiudono o si dichiarano (W6)', () => {
    it('le fonti sono piene: se cadono queste, tutto il resto starebbe controllando il vuoto', () => {
        // Controllo positivo del parser e delle fonti. Un lock che gira su un elenco vuoto
        // passa sempre, ed è il modo più silenzioso di non controllare niente.
        // 13 fino al 2026-08-01, **11 da quando la migrazione di questo step è stata
        // applicata**: `orario_settimanale` e `sezione_materia_obiettivo` non sono più
        // `true`. La soglia serve a impedire che il lock giri su una fotografia vuota, non
        // a fissare un numero: si abbassa insieme alle chiusure vere e **non si alza mai**
        // — una `true` nuova deve passare dal commento di dichiarazione, non da qui.
        expect(permissiveNude.length, 'La fotografia non contiene nessuna policy `true`: rigenerala.').toBeGreaterThanOrEqual(11)
        expect(fileS33, `Manca la migrazione dello step S33 (\`*${MIGRAZIONE_S33}\`) in supabase/migrations/.`).toBeTruthy()
        expect(sqlS33.length, 'La migrazione S33 è vuota.').toBeGreaterThan(500)
        expect(tutteLeCreazioni.length, 'Il parser non trova nessuna CREATE POLICY in tutto supabase/migrations/.').toBeGreaterThan(50)
        expect(tuttiICommenti.length, 'Il parser non trova nessun COMMENT ON POLICY.').toBeGreaterThan(0)
        // Il rilevatore delle tabelle per-sezione: se smettesse di funzionare, il test sui
        // commenti diventerebbe muto proprio sulle tabelle che contano.
        for (const t of ['campanelle', 'materie', 'orario_settimanale', 'sezione_materia_obiettivo', 'tempo_scuola']) {
            expect(tabelleConSezione, `\`${t}\` ha section_id nel DDL ma il parser non l'ha vista.`).toContain(t)
        }
        expect(tabelleConSede.size).toBeGreaterThan(50)
    })

    it('le due tabelle PER SEZIONE non si accontentano di un commento: hanno il predicato', () => {
        for (const tabella of DA_CHIUDERE_CON_PREDICATO) {
            // Il lock deve dire il vero sia PRIMA che la migrazione venga applicata (la
            // fotografia mostra ancora il `true`, ma una migrazione lo chiude) sia DOPO (nella
            // fotografia il `true` non c'è più). Ancorarsi allo stato di applicazione
            // renderebbe rosso il gate a ogni passaggio, e un lock che si deve zittire a mano
            // due volte è un lock che verrà zittito e basta.
            const nudeResidue = permissiveNude
                .filter((p) => p.tabella === tabella)
                .filter((p) => !droppate.has(chiave(p)))
                .map(chiave)
            expect(
                nudeResidue,
                `Su \`${tabella}\` la produzione ha una policy \`USING (true)\` che nessuna migrazione ` +
                `chiude: è una tabella per SEZIONE, quindi oggi un genitore di Aversa legge le sezioni ` +
                `di Giugliano via PostgREST. Qui il commento non basta: ci vuole il predicato.`,
            ).toEqual([])

            const nuove = letturaVincolata(tabella)
            expect(
                nuove.length,
                `Su \`${tabella}\` la policy di lettura è stata tolta ma non ne è stata creata una con un ` +
                `predicato: se il deny è voluto, dichiaralo togliendo \`${tabella}\` da DA_CHIUDERE_CON_PREDICATO.`,
            ).toBeGreaterThan(0)

            for (const nuova of nuove) {
                // Ciò che conta non è che esista una policy: è che il predicato ANCORI la riga
                // a chi la legge. `current_parent_student_ids()` è SECURITY DEFINER e ritorna i
                // SOLI figli del chiamante — è l'unico ancoraggio che funziona davvero da qui,
                // perché `utenti`, `utenti_scuole` e `sections` hanno la RLS attiva e ZERO
                // policy: una sottoquery su di loro, dentro un'espressione di policy, non
                // ritorna mai niente.
                expect(
                    /current_parent_student_ids/.test(nuova.using),
                    `\`${nuova.policy}\` su \`${tabella}\` non àncora la riga a chi legge: ` +
                    `USING (${nuova.using}).`,
                ).toBe(true)
                expect(
                    /\bsection_id\b|\bscuola_id\b/.test(nuova.using),
                    `\`${nuova.policy}\` su \`${tabella}\` non nomina né la sezione né la sede: ` +
                    `USING (${nuova.using}).`,
                ).toBe(true)
            }

            // E quando la fotografia sarà quella di dopo l'applicazione, il controllo si
            // sposta dal file SQL al DATABASE: ogni policy che la produzione ha davvero su
            // queste due tabelle, e che nessuna migrazione toglie, deve portare l'ancoraggio.
            // È l'unica asserzione qui dentro che guarda la mutazione avvenuta e non l'intento.
            const inProduzione = foto.policies
                .filter((p) => p.tabella === tabella && p.ruoli.includes('authenticated'))
                .filter((p) => !droppate.has(chiave(p)))
            for (const p of inProduzione) {
                expect(
                    `${p.using_expr} ${p.check_expr}`,
                    `In produzione \`${p.policy}\` su \`${tabella}\` non àncora la riga a chi legge.`,
                ).toMatch(/current_parent_student_ids/)
            }
        }
    })

    it('ogni altra `USING (true)` che resta in produzione porta la sua ragione SCRITTA SULLA POLICY', () => {
        const senzaDecisione = permissiveNude
            .filter((p) => !droppate.has(chiave(p)))
            .filter((p) => (commentate.get(chiave(p)) ?? '').trim().length < 60)
            .map(chiave)
        expect(
            senzaDecisione,
            `Policy \`USING (true)\` per un ruolo non-service_role che nessuna migrazione chiude e ` +
            `nessun \`COMMENT ON POLICY\` dichiara. Delle due l'una: o si aggiunge il predicato, o si ` +
            `scrive sulla policy PERCHÉ va bene che chiunque abbia una sessione legga quelle righe da ` +
            `qualunque sede. Una decisione scritta non è un buco; una dimenticanza sì.`,
        ).toEqual([])
    })

    it('il commento dice al titolare che cosa sta accettando: «per sezione» o «per sede»', () => {
        // Undici policy restano aperte per scelta. Il collaudo ne aveva riconosciute come
        // per-sezione soltanto due — ma `campanelle`, `materie` e `tempo_scuola` hanno anche
        // loro `section_id`, e `materie` ha pure `scuola_id`. Se il commento non lo dice, chi
        // legge la decisione fra un anno crede di aver accettato un elenco globale.
        const vaghi: string[] = []
        for (const p of permissiveNude) {
            if (droppate.has(chiave(p))) continue
            const testo = (commentate.get(chiave(p)) ?? '').toLowerCase()
            if (!testo) continue // già coperto dal test precedente
            const perSezione = tabelleConSezione.has(p.tabella)
            const perSede = tabelleConSede.has(p.tabella)
            if (perSezione && !/sezion/.test(testo)) vaghi.push(`${chiave(p)} (ha section_id, il commento non lo dice)`)
            if (perSede && !/sede|scuola|plesso/.test(testo)) vaghi.push(`${chiave(p)} (ha scuola_id, il commento non lo dice)`)
            if (!perSezione && !perSede && !/global|tutte le sedi|dominio|ministerial/.test(testo)) {
                vaghi.push(`${chiave(p)} (nessuna colonna di ambito: il commento deve dire che è globale)`)
            }
        }
        expect(
            vaghi,
            `Commenti che non dicono l'ambito reale della tabella. Il senso di accettare una ` +
            `\`USING (true)\` è che la decisione resti leggibile: se la tabella è per sezione o per ` +
            `sede, il commento deve nominarlo.`,
        ).toEqual([])
    })

    it('la migrazione S33 restringe e basta: niente `anon`, niente scritture, nessun `USING (true)` nuovo', () => {
        const nuove = creazioni(sqlS33, fileS33 ?? '')
        expect(nuove.length, 'La migrazione S33 non crea nessuna policy.').toBeGreaterThan(0)
        for (const c of nuove) {
            expect(/\banon\b|\bpublic\b/i.test(c.ruoli), `\`${c.policy}\` è concessa a \`${c.ruoli}\`.`).toBe(false)
            expect(c.cmd, `\`${c.policy}\` non è di sola lettura: FOR ${c.cmd}.`).toBe('SELECT')
            expect(c.using.trim().toLowerCase(), `\`${c.policy}\` nasce con USING (true).`).not.toBe('true')
            expect(c.check, `\`${c.policy}\` porta una WITH CHECK: è una policy di scrittura travestita.`).toBe('')
        }
    })

    it('la migrazione S33 non lascia orfana nessuna policy che droppa', () => {
        // Un DROP senza CREATE è legittimo (il deny), ma dev'essere una scelta: qui lo step
        // dichiara di sostituire, non di togliere. Se un domani si volesse togliere e basta,
        // questo test va cambiato apposta — che è il punto.
        for (const d of eliminazioni(sqlS33)) {
            expect(
                letturaVincolata(d.tabella).length,
                `La migrazione droppa \`${d.policy}\` su \`${d.tabella}\` senza ricrearne una: ` +
                `dopo l'applicazione quella tabella non sarà più leggibile da nessuno col client del browser.`,
            ).toBeGreaterThan(0)
        }
    })
})
