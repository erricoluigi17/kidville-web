import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JOB_CRON, JOB_CRON_NON_SORVEGLIATI } from '@/lib/health/controlli'

/**
 * LOCK · UN NOME IN `JOB_CRON` E IL SUO `cron.schedule` VIAGGIANO INSIEME.
 *
 * ─── IL DIFETTO, MISURATO DUE VOLTE ─────────────────────────────────────────
 *
 * `controlloBattitoCron` (`/api/health`) considera muto anche il job che non ha
 * MAI battuto (`t === undefined`). Quindi un nome in `JOB_CRON` la cui migrazione
 * non è stata applicata manda l'endpoint di salute in `degradato` **dal primo
 * deploy e per sempre**, su un lavoro che non esiste ancora. È successo il
 * 2026-08-10 a `candidature-retention`, ed è scritto nella testata della sua
 * migrazione. Un allarme che suona da solo viene spento — e quando il lavoro
 * smetterà davvero di girare non se ne accorgerà nessuno, perché il rosso era
 * rosso da settimane.
 *
 * ─── PERCHÉ QUESTO FILE, VISTO CHE UN LOCK C'ERA GIÀ ────────────────────────
 *
 * Perché il lock c'era per UN job solo. `gdpr-retention-personale.test.ts` teneva
 * la coppia di `retention-personale`; `scadenze-documenti-personale` — l'altro job
 * della stessa consegna, con la stessa migrazione non applicata — non aveva
 * nessuno che la tenesse: la sua suite verificava soltanto che il nome coincidesse
 * con quello della route. Applicando la sola migrazione del primo, il gate sarebbe
 * diventato verde e `/api/health` sarebbe rimasto `degradato` per l'altro, senza
 * che nulla lo segnalasse (rilievo del revisore, 2026-08-11). Una regola che vale
 * per ogni job va scritta una volta sola, e in un posto che li guarda tutti.
 *
 * ─── COME SI SA SE UNA MIGRAZIONE È APPLICATA (e perché non lo si legge nella
 *     prosa della sua testata) ─────────────────────────────────────────────────
 *
 * La verità non è nei commenti: è in
 * `__tests__/fixtures/migrazioni-applicate-snapshot.json`, la fotografia di
 * `supabase_migrations.schema_migrations` che `migrazioni-complete.test.ts` già
 * pretende aggiornata a ogni `apply_migration`. Una `version` che sta lì è
 * applicata al database di produzione; una che non c'è, no.
 *
 * ⚠️ E LA PROSA DA SOLA NON BASTEREBBE, misurato l'11/08/2026 su questi stessi
 * file: il rilevatore usato altrove è `/NON\s+APPLICATA/i`, e la testata di
 * `20260811234403_scadenze_documenti_cron.sql` diceva **«NON ANCORA APPLICATA»**.
 * Due parole in mezzo, e la migrazione risultava applicata a chiunque cercasse
 * quel marcatore. Un rilevatore che una parola in più aggira è peggio di nessun
 * rilevatore, perché dà un verde. La fotografia non si può aggirare scrivendo.
 *
 * ─── LE DUE STRADE QUANDO QUESTO LOCK È ROSSO ───────────────────────────────
 *
 *  (a) applicare la migrazione nello stesso rilascio (`apply_migration` +
 *      `get_advisors` a 0 ERROR) e rigenerare la fotografia — è la stessa
 *      operazione che `migrazioni-complete.test.ts` chiede già;
 *  (b) spostare il nome in `JOB_CRON_NON_SORVEGLIATI` con la ragione, finché non
 *      lo si applica.
 * I TERMINI eventualmente dichiarati in `/privacy` restano dove sono in entrambi i
 * casi: è il meccanismo a non potersi sorvegliare prima di esistere, non la
 * promessa a dover sparire.
 */

const RADICE = process.cwd()
const CARTELLA = join(RADICE, 'supabase', 'migrations')
const FOTOGRAFIA = join(RADICE, '__tests__', 'fixtures', 'migrazioni-applicate-snapshot.json')

type Fotografia = { generato_il: string; migrazioni: { version: string; name: string }[] }
const foto: Fotografia = JSON.parse(readFileSync(FOTOGRAFIA, 'utf8'))

/** Le `version` che il DATABASE dichiara applicate. Non i commenti: la tabella. */
const APPLICATE = new Set(foto.migrazioni.map((m) => m.version))

const MIGRAZIONI = readdirSync(CARTELLA)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, version: file.slice(0, 14), sql: readFileSync(join(CARTELLA, file), 'utf8') }))

/**
 * «NON APPLICATA», ma anche «NON ANCORA APPLICATA»: la seconda forma esisteva nel
 * repo e sfuggiva a chi cercava solo la prima. Vedi la testata di questo file.
 */
const MARCATA_NON_APPLICATA = /NON\s+(?:ANCORA\s+)?APPLICATA/i

/**
 * Le migrazioni che installano un lavoro con QUEL nome. Il nome è la stringa che
 * `cron.schedule` registra in `cron.job`, e in questo repo coincide — per i job
 * che passano da una route — con `contesto.campi.operazione` del battito, cioè con
 * la chiave di `JOB_CRON`.
 */
function installano(job: string) {
    const re = new RegExp(`cron\\.schedule\\s*\\(\\s*'${job}'`, 'i')
    return MIGRAZIONI.filter(({ sql }) => re.test(sql))
}

/** I soli job di `JOB_CRON` per cui esiste davvero un `cron.schedule` con quel nome. */
const COPPIE = JOB_CRON.map((j) => ({ nome: j.nome, migrazioni: installano(j.nome) })).filter(
    (c) => c.migrazioni.length > 0,
)

describe('lock architettura · un job sorvegliato ha la sua migrazione APPLICATA', () => {
    it('la fotografia e le coppie si leggono (sanity: senza, tutto il resto sarebbe verde sul vuoto)', () => {
        expect(
            APPLICATE.size,
            'la fotografia delle migrazioni applicate è vuota o illeggibile: questo lock non ' +
                'starebbe misurando niente.',
        ).toBeGreaterThan(50)
        expect(
            COPPIE.length,
            'nessun nome di `JOB_CRON` corrisponde a un `cron.schedule` in supabase/migrations/. ' +
                'O la convenzione dei nomi è cambiata, o la cartella non si legge più: in entrambi i ' +
                'casi questo file direbbe «verde» senza aver guardato nessun job.',
        ).toBeGreaterThanOrEqual(3)
    })

    it('🔴 ogni job di `JOB_CRON` installato da una migrazione è installato da una migrazione APPLICATA', () => {
        const suCarta = COPPIE.flatMap(({ nome, migrazioni }) =>
            migrazioni.filter((m) => !APPLICATE.has(m.version)).map((m) => ({ nome, file: m.file })),
        )
        expect(
            suCarta,
            suCarta.length === 0
                ? ''
                : `Questi job sono sorvegliati da \`JOB_CRON\` (src/lib/health/controlli.ts) e la ` +
                  `migrazione che li installa non risulta applicata al database:\n` +
                  suCarta.map((x) => `  · ${x.nome} → ${x.file}`).join('\n') +
                  `\nAl merge \`/api/health\` risponde \`degradato\` con «job senza battito: ` +
                  `${suCarta.map((x) => x.nome).join(',')}» dal primo secondo e per sempre, su lavori ` +
                  `che non esistono ancora — e un allarme che suona da solo viene spento. ` +
                  `⚠️ SI APPLICANO INSIEME, in un solo rilascio: applicandone una sola il gate ` +
                  `diventa verde e l'endpoint di salute resta degradato per l'altra, senza che nulla ` +
                  `lo segnali. Le due strade: (a) \`apply_migration\` + \`get_advisors\` a 0 ERROR, ` +
                  `poi rigenerare __tests__/fixtures/migrazioni-applicate-snapshot.json; ` +
                  `(b) spostare il nome in \`JOB_CRON_NON_SORVEGLIATI\` con la ragione. I termini ` +
                  `dichiarati in /privacy restano dove sono in entrambi i casi.`,
        ).toEqual([])
    })

    it('🔴 la testata della migrazione non contraddice la fotografia', () => {
        // Il verso opposto, e non è teorico: applicare la migrazione e lasciare in
        // testata «NON APPLICATA» produce un file che descrive un database che non
        // esiste più. È la stessa classe di difetto che `CLAUDE.md` chiama «un
        // documento che descrive una protezione che non c'è più è peggio di nessun
        // documento» — e qui inganna il prossimo lock che leggerà quella prosa.
        const bugiarde = COPPIE.flatMap(({ nome, migrazioni }) =>
            migrazioni
                .filter((m) => APPLICATE.has(m.version) && MARCATA_NON_APPLICATA.test(m.sql))
                .map((m) => ({ nome, file: m.file })),
        )
        expect(
            bugiarde,
            bugiarde.length === 0
                ? ''
                : `Queste migrazioni sono applicate al database (la fotografia le contiene) e la loro ` +
                  `testata dice ancora «NON APPLICATA»:\n` +
                  bugiarde.map((x) => `  · ${x.nome} → ${x.file}`).join('\n') +
                  `\nAttesta l'apply in testata con una riga «APPLICATA il AAAA-MM-GG» e togli il ` +
                  `marcatore: «l'ho applicata» detto a voce non si rilegge fra sei mesi, e finché ` +
                  `quella riga resta, ogni lock che legge la prosa crederà che il lavoro non giri.`,
        ).toEqual([])
    })

    it('un job dichiarato fuori dalla sorveglianza porta con sé la sua ragione', () => {
        // `JOB_CRON_NON_SORVEGLIATI` è la via d'uscita legittima di questo lock: se
        // diventasse un elenco di nomi senza motivo, sarebbe un modo per far tacere
        // l'allarme invece che per dichiarare una decisione.
        for (const { nome, perche } of JOB_CRON_NON_SORVEGLIATI) {
            expect(
                perche.length,
                `\`${nome}\` è fuori dalla sorveglianza di /api/health e non dice perché. Le due ` +
                    'costanti esistono per distinguere «lasciato fuori apposta» da «dimenticato»: ' +
                    'senza la ragione, sono la stessa cosa.',
            ).toBeGreaterThan(30)
        }
    })

    it('un job non può stare in ENTRAMBE le liste', () => {
        const sorvegliati = new Set(JOB_CRON.map((j) => j.nome))
        const doppi = JOB_CRON_NON_SORVEGLIATI.filter((j) => sorvegliati.has(j.nome)).map((j) => j.nome)
        expect(
            doppi,
            `${doppi.join(', ')} è in \`JOB_CRON\` e insieme in \`JOB_CRON_NON_SORVEGLIATI\`: chi ` +
                'legge le due costanti per capire se un lavoro è guardato o no trova due risposte ' +
                'opposte, e quella che vince dipende da quale delle due ha aperto per prima.',
        ).toEqual([])
    })
})
