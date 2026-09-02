import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fineParentesi, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK — SCRIVERE UNA PASSWORD SU UN ACCOUNT SI FA IN SEI POSTI, E SONO QUESTI.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IL GESTO SORVEGLIATO non è «cambiare la propria password»: è **scrivere una
 * password nell'archivio di GoTrue**, in qualunque forma. Sono due chiamate:
 *
 *   · `admin.auth.admin.updateUserById(id, { password })` — riscrive quella di un
 *     account che esiste già;
 *   · `admin.auth.admin.createUser({ …, password })` — la scrive alla nascita.
 *
 * Metterle nello stesso lock non è pignoleria: chi volesse aggirare il primo
 * userebbe il secondo. Il difetto che si vuole impedire non è «qualcuno cambia il
 * modo di scrivere una password»: è «qualcuno ne aggiunge un settimo posto, e
 * nessuno se ne accorge» — che è esattamente ciò che è successo al generatore delle
 * password temporanee (vedi `password-temporanea-un-posto-solo.test.ts`: una copia
 * viveva in `scripts/` e continuava a produrre il vecchio formato, invisibile a
 * `src/`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA SECONDA REGOLA È QUELLA CHE COSTA DI PIÙ SE CADE.
 *
 * `supabase.auth.updateUser({ password })` — la forma che si chiama DAL BROWSER —
 * non deve comparire in `src/`. Sembra la scorciatoia ovvia («è una riga, la fa il
 * client»), e in una riga si perdono quattro cose insieme:
 *
 *   1. la verifica della password ATTUALE, che GoTrue non fa
 *      (`secure_password_change = false`, `supabase/config.toml:223`): dal browser
 *      il controllo è teatro, chi chiama l'API direttamente lo salta;
 *   2. il TETTO di frequenza, che ha il contatore su Postgres
 *      (`src/lib/security/rate-limit.ts`) e dal browser non esiste;
 *   3. il LOG: `console.*` è vietato in `src/` e `src/lib/logging/client.ts` per
 *      scelta dichiarata NON spedisce i 4xx — un cambio fallito non lascerebbe
 *      traccia da nessuna parte, né su Vercel né in `app_log`;
 *   4. il TEMPO: le chiamate Supabase del browser non hanno scadenza (lo dichiara
 *      `supabase-client-strumentato.test.ts`, blocco «cosa questo lock NON copre»).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ COSA QUESTO LOCK **NON** COPRE — va saputo prima di fidarsene.
 *
 *  · `scripts/` e `e2e/`. Ci sono altre otto chiamate (misurate il 2026-09-01:
 *    `seed-e2e.mjs`, `seed-test-sedi.mjs`, `crea-account-tester.mjs`,
 *    `allinea-password-revisore.mjs`, `repair_parent_identities.mjs`,
 *    `e2e/collaudo-giornata/seed/`, `e2e/primaria-360/scripts/`): sono strumenti di
 *    semina che non finiscono nel prodotto e che, per esistere, DEVONO scrivere
 *    password. Il lock gemello che guarda anche `scripts/` è quello sul FORMATO
 *    della password temporanea, dove la divergenza fa danno; qui il perimetro è il
 *    prodotto. Chi sposta una di quelle chiamate dentro `src/` la vede diventare
 *    rossa qui, che è il verso giusto.
 *  · Che il gesto sia fatto BENE. Il lock vede DOVE si scrive una password, non se
 *    chi lo fa abbia verificato l'identità: quello è mestiere di
 *    `gate-coverage.test.ts` e dei test di rotta.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

const rel = (f: string) => path.relative(RADICE, f).split(path.sep).join('/')

/**
 * I SEI POSTI, con la ragione di ciascuno. A MATCH ESATTO sul percorso, mai per
 * prefisso: una route nuova sotto `admin/` non eredita niente.
 */
const SCRITTORI_DICHIARATI = new Map<string, string>([
    [
        'src/app/api/account/password/route.ts',
        "IL CAMBIO PASSWORD, condiviso fra genitori e personale: la password non è un affare di area. È l'unico dei sei in cui la password la sceglie la PERSONA, e per questo è l'unico che verifica quella attuale (GoTrue non lo fa: `secure_password_change = false`), che ha un tetto per utente e per IP, e che registra il gesto in `password_cambi`.",
    ],
    [
        'src/lib/auth/password-invito.ts',
        "La password da CONSEGNARE quando l'account esiste già: il cron degli inviti non può rileggerla da `auth.users` (esiste solo l'impronta), quindi la rigenera. Ogni chiamata invalida la precedente — è il motivo per cui vive in un modulo solo invece che copiata nelle route che invitano.",
    ],
    [
        'src/app/api/admin/regenerate-credentials/route.ts',
        'La rigenerazione fatta a mano dalla Segreteria quando una famiglia ha perso le credenziali: è il percorso storico da cui nasce la regola 3 di AGENTS.md (per mesi le email non arrivavano e il codice registrava «403» buttando via il motivo).',
    ],
    [
        'src/app/api/parent/onboarding/route.ts',
        "Il primo accesso del genitore: la password è FACOLTATIVA e si imposta insieme ai consensi. Non è un doppione del cambio password — lì non c'è nessuna password precedente da verificare, e infatti `valutaPasswordNuova` viene chiamata senza `attuale`.",
    ],
    [
        'src/lib/auth/parent-identity.ts',
        "La NASCITA dell'account di un genitore (`createUser`): la password temporanea si scrive alla creazione, ed è l'unico istante in cui esiste in chiaro. `ensureParentIdentity` la restituisce solo se ha appena creato l'account — vedi `password-invito.ts` per il caso opposto.",
    ],
    [
        'src/lib/auth/staff-identity.ts',
        "La nascita dell'account del PERSONALE, gemella di quella del genitore: stessa forma, stessa ragione, tabella d'anagrafica diversa (`utenti` invece di `parents`).",
    ],
    [
        'src/lib/auth/backfill.ts',
        "Il backfill che dà un account auth ai genitori che ne erano rimasti senza: gira una volta e crea, non aggiorna. Sta qui e non fra gli script perché è invocabile da una route d'amministrazione, cioè vive dentro il prodotto.",
    ],
])

/** Le due chiamate che scrivono una password nell'archivio di GoTrue. */
const SCRITTURE = [
    { nome: 'updateUserById', re: /\bupdateUserById\s*\(/g },
    { nome: 'createUser', re: /\bcreateUser\s*\(/g },
]

/** La forma VIETATA: il cambio password fatto dal browser. */
const DAL_BROWSER = /\bauth\s*\.\s*updateUser\s*\(/g

export interface Scrittura {
    file: string
    riga: number
    forma: string
}

/**
 * Le scritture di password in un sorgente: la chiamata più i suoi argomenti, a
 * parentesi bilanciate.
 *
 * A parentesi bilanciate e NON su una finestra di N caratteri: `createUser({ email,
 * email_confirm: true })` seguito venti righe più sotto da un `password` in un
 * oggetto diverso verrebbe attribuito alla chiamata sbagliata. Su un lock un falso
 * positivo si zittisce con un'esenzione, e l'esenzione poi copre anche il caso vero.
 */
export function scrittureDiPassword(src: string, file = '?'): Scrittura[] {
    const { senzaCommenti, struttura } = mascheraSorgente(src)
    const out: Scrittura[] = []
    for (const { nome, re } of SCRITTURE) {
        re.lastIndex = 0
        for (let m = re.exec(struttura); m; m = re.exec(struttura)) {
            const aperta = m.index + m[0].length - 1
            const fine = fineParentesi(struttura, aperta)
            // Il CONTENUTO si legge dal testo con le stringhe ancora leggibili: qui
            // interessa il nome di una proprietà, che stringa non è, ma `senzaCommenti`
            // è comunque il testo giusto — `struttura` sostituirebbe con `x` un
            // eventuale `['password']`.
            const argomenti = senzaCommenti.slice(aperta, fine)
            if (!/\bpassword\b/.test(argomenti)) continue
            out.push({ file, riga: riga(src, m.index), forma: nome })
        }
    }
    return out
}

function scrittureDelRepo(): Scrittura[] {
    return fileSorgente(SRC).flatMap((f) =>
        scrittureDiPassword(fs.readFileSync(f, 'utf8'), rel(f)),
    )
}

function cambiDalBrowser(): { file: string; riga: number }[] {
    const out: { file: string; riga: number }[] = []
    for (const f of fileSorgente(SRC)) {
        const src = fs.readFileSync(f, 'utf8')
        const { senzaCommenti } = mascheraSorgente(src)
        DAL_BROWSER.lastIndex = 0
        for (let m = DAL_BROWSER.exec(senzaCommenti); m; m = DAL_BROWSER.exec(senzaCommenti)) {
            out.push({ file: rel(f), riga: riga(src, m.index) })
        }
    }
    return out
}

describe('lock — una password si scrive su un account in sei posti dichiarati', () => {
    it('la misura vede davvero il repo (se cade, tutto il resto è verde sul vuoto)', () => {
        // PROVA DI SANITÀ. Senza, una cartella sbagliata o una regex rotta renderebbe
        // VERDI tutte le regole qui sotto: «zero file scanditi» e «zero violazioni»
        // hanno lo stesso colore. È la lezione già pagata da
        // `password-temporanea-un-posto-solo.test.ts` e da `ritmo-email-un-posto-solo`.
        expect(fileSorgente(SRC).length).toBeGreaterThan(500)
        const trovate = scrittureDelRepo()
        expect(trovate.length, 'lo scanner non trova più nessuna scrittura di password').toBeGreaterThanOrEqual(7)
        // E deve vedere ENTRAMBE le forme: se ne riconoscesse una sola, l'altra
        // diventerebbe la porta di servizio.
        expect(new Set(trovate.map((s) => s.forma))).toEqual(new Set(['updateUserById', 'createUser']))
    })

    it('nessuno scrive una password fuori dai sei posti dichiarati', () => {
        const fuori = [...new Set(
            scrittureDelRepo()
                .filter((s) => !SCRITTORI_DICHIARATI.has(s.file))
                .map((s) => `${s.file}:${s.riga} (${s.forma})`),
        )].sort()

        expect(
            fuori,
            'Qui si scrive una password su un account GoTrue, e questo posto non è dichiarato. ' +
            'Se è il CAMBIO di una password scelta dalla persona, la route esiste già ed è ' +
            '`POST /api/account/password`: usala, invece di riscrivere il gesto senza la verifica ' +
            "dell'attuale, senza tetto e senza log. Se è davvero un settimo caso, va aggiunto a " +
            'SCRITTORI_DICHIARATI con la ragione scritta per esteso — e la ragione va difesa, ' +
            'perché ognuno di questi punti può chiudere fuori una famiglia dal proprio account.',
        ).toEqual([])
    })

    it('il CAMBIO password vive nella route, e la route c’è davvero (controllo positivo)', () => {
        // Un lock che verifica solo ASSENZE resta verde anche quando il codice sparisce.
        // Qui si pretende il contrario: che la route dichiarata scriva davvero la password.
        const nella = scrittureDelRepo().filter((s) => s.file === 'src/app/api/account/password/route.ts')
        expect(
            nella.map((s) => s.forma),
            'La route del cambio password non scrive più nessuna password: o è stata spostata ' +
            '(e allora questo elenco mente), o il gesto è tornato da qualche altra parte.',
        ).toEqual(['updateUserById'])
    })

    it('`auth.updateUser(` non compare in nessun file di `src/`: il cambio non torna nel browser', () => {
        expect(
            cambiDalBrowser().map((c) => `${c.file}:${c.riga}`),
            'Il cambio password è stato «semplificato» spostandolo nel browser. In quella riga si ' +
            'perdono insieme: la verifica della password ATTUALE (GoTrue non la chiede, ' +
            '`secure_password_change = false`), il tetto di frequenza (contatore su Postgres, dal ' +
            'browser non esiste), il log (il client non spedisce i 4xx, per scelta dichiarata) e la ' +
            'scadenza della chiamata. Il gesto sta in `POST /api/account/password`.',
        ).toEqual([])
    })

    it('ogni voce dichiarata è VIVA e motivata (un elenco che mente è peggio di nessun elenco)', () => {
        const vivi = new Set(scrittureDelRepo().map((s) => s.file))
        for (const [file, perche] of SCRITTORI_DICHIARATI) {
            expect(fs.existsSync(path.join(RADICE, file)), `dichiarato ma sparito: ${file}`).toBe(true)
            expect(perche.length, `la voce di ${file} non è motivata`).toBeGreaterThan(120)
            expect(
                vivi.has(file),
                `${file} non scrive più nessuna password: togliere la voce, o la prossima ` +
                'scrittura che nasce lì eredita un permesso che nessuno ha deciso per lei.',
            ).toBe(true)
        }
    })
})

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
 *
 * Un lock verde perché non trova violazioni e un lock verde perché non guarda più
 * niente, da fuori, sono identici. Qui sotto la forma vietata resta scritta e ferma:
 * se il rilevatore smette di riconoscerla, questi test cadono PRIMA che qualcuno se
 * ne accorga in produzione.
 * ─────────────────────────────────────────────────────────────────────────────
 */
describe('il rilevatore riconosce le forme sorvegliate', () => {
    it('riconosce `updateUserById(id, { password })`', () => {
        const src = `const { error } = await admin.auth.admin.updateUserById(uid, { password: nuova })`
        expect(scrittureDiPassword(src)).toEqual([{ file: '?', riga: 1, forma: 'updateUserById' }])
    })

    it('riconosce `createUser({ …, password })` anche su più righe', () => {
        const src = [
            'const { data } = await admin.auth.admin.createUser({',
            '  email,',
            '  email_confirm: true,',
            '  password,',
            '})',
        ].join('\n')
        expect(scrittureDiPassword(src).map((s) => s.forma)).toEqual(['createUser'])
    })

    it('NON segnala un `updateUserById` che non tocca la password', () => {
        const src = `await admin.auth.admin.updateUserById(uid, { email_confirm: true })`
        expect(scrittureDiPassword(src)).toEqual([])
    })

    it('NON segnala la forma nominata in un COMMENTO (mezzo repo la cita)', () => {
        // I file di questo repo spiegano i propri difetti nei commenti: un rilevatore a
        // grep accuserebbe la spiegazione di essere il difetto.
        const src = [
            '// Qui c\'era `updateUserById(uid, { password })` senza controllare l\'esito.',
            '/* e in blocco: createUser({ password }) */',
            'const x = 1',
        ].join('\n')
        expect(scrittureDiPassword(src)).toEqual([])
    })

    it('gli argomenti si leggono a parentesi BILANCIATE, non a finestra', () => {
        // La `password` sta in una chiamata DIVERSA, venti righe più sotto: attribuirla a
        // `createUser` sarebbe un falso positivo, e un falso positivo su un lock è il modo
        // più rapido di farlo spegnere da qualcuno.
        const src = [
            'await admin.auth.admin.createUser({ email, email_confirm: true })',
            '',
            'await altroServizio.invia({ password: temporanea })',
        ].join('\n')
        expect(scrittureDiPassword(src)).toEqual([])
    })

    it('riconosce `auth.updateUser({ password })`, la forma del browser', () => {
        DAL_BROWSER.lastIndex = 0
        expect(DAL_BROWSER.test("await supabase.auth.updateUser({ password: nuova })")).toBe(true)
        // …e NON confonde `updateUserById`, che è la forma lecita lato server.
        DAL_BROWSER.lastIndex = 0
        expect(DAL_BROWSER.test('await admin.auth.admin.updateUserById(uid, { password })')).toBe(false)
    })
})
