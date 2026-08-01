import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · `supabase/migrations/` deve poter RICOSTRUIRE il database.
 *
 * Perché esiste. Fino al 2026-07-31 non ci riusciva, e nessuno poteva accorgersene:
 * il repo aveva 63 file, la produzione 69 migrazioni applicate. **Sei migrazioni
 * vivevano soltanto dentro il database** — applicate con lo strumento MCP
 * `apply_migration`, che scrive su `supabase_migrations.schema_migrations` e NON
 * lascia niente sul disco. E quindici file portavano un timestamp INVENTATO a mano,
 * diverso dalla `version` con cui erano stati davvero applicati, con tre coppie in
 * ordine **invertito** rispetto all'applicazione reale.
 *
 * Le due conseguenze, entrambe silenziose:
 *  · `supabase db push` avrebbe riapplicato quindici migrazioni già presenti nel
 *    database, perché per lui una `version` che non è in tabella è una migrazione
 *    nuova — e alcune non sono idempotenti;
 *  · una ricostruzione da zero a partire dai file (nuovo ambiente, disaster
 *    recovery, database di collaudo) si sarebbe rotta sulle dipendenze: un `ALTER`
 *    prima del `CREATE` che lo giustifica.
 *
 * È il difetto della famiglia peggiore: **non rompe niente finché non serve**, e
 * quando serve è il giorno in cui il database va ricostruito. Il gate era verde con
 * 3424 test. Lo squilibrio è stato chiuso il 2026-07-31 (commit `a10ceac`): da lì
 * repo e database coincidono, 69 migrazioni, stessi nomi, stesso ordine.
 *
 * ─── COME FUNZIONA ────────────────────────────────────────────────────────────
 * Il test gira OFFLINE. In CI il database di produzione non c'è — e non deve
 * esserci: le sue credenziali non stanno né in CI né in un test. Quindi la verità
 * del database è versionata in una FOTOGRAFIA,
 * `__tests__/fixtures/migrazioni-applicate-snapshot.json`, esattamente come già si
 * fa per `pg_policies` (`rls-per-sede.test.ts`) e per le FK di sede
 * (`fk-scuola-id.test.ts`).
 *
 * La fotografia è la verità del DATABASE, mai un'eco del filesystem: si rigenera
 * SOLO da una query su produzione, e il generatore non ha nemmeno il permesso di
 * leggere `supabase/migrations/` (è la penultima prova qui sotto). Una fotografia
 * ricavata dalla cartella che il lock controlla renderebbe il lock un
 * confronto della cartella con se stessa: sempre verde, sempre inutile.
 *
 * ─── COME SI RIGENERA ─────────────────────────────────────────────────────────
 * 1. `node __tests__/fixtures/migrazioni-fotografia.mjs --sql` stampa la query.
 *    È di SOLA LETTURA e legge una sola tabella:
 *      select version, name from supabase_migrations.schema_migrations order by version
 * 2. Eseguila sul DB di produzione (strumento MCP `execute_sql`, oppure
 *    `psql "$DATABASE_URL"`), e salva la risposta JSON in un file.
 * 3. `node __tests__/fixtures/migrazioni-fotografia.mjs < risposta.json`
 * 4. `npx vitest run __tests__/architecture/migrazioni-complete.test.ts`
 *
 * Va rigenerata **ogni volta che una migrazione viene applicata**, cioè dopo ogni
 * `apply_migration`. Finché non lo fai, il lock resta rosso: è voluto — è l'unico
 * momento in cui qualcuno guarda davvero se il repo e il database dicono la stessa
 * cosa.
 */

type Migrazione = { version: string; name: string }
type Fotografia = {
    _come_si_rigenera: string
    generato_il: string
    sha256: string
    migrazioni: Migrazione[]
}

const RADICE = process.cwd()
const CARTELLA_MIGRAZIONI = join(RADICE, 'supabase', 'migrations')
const FOTOGRAFIA = join(RADICE, '__tests__', 'fixtures', 'migrazioni-applicate-snapshot.json')
const GENERATORE = join(RADICE, '__tests__', 'fixtures', 'migrazioni-fotografia.mjs')

const COME_RIGENERARE =
    'Rigenera la fotografia: `node __tests__/fixtures/migrazioni-fotografia.mjs --sql` → esegui ' +
    'la query sul DB di produzione (sola lettura) → ' +
    '`node __tests__/fixtures/migrazioni-fotografia.mjs < risposta.json`.'

const foto: Fotografia = JSON.parse(readFileSync(FOTOGRAFIA, 'utf8'))

/** Il nome canonico del file di una migrazione: `<version>_<name>.sql`. */
const nomeFile = (m: Migrazione) => `${m.version}_${m.name}.sql`

/** `20260704120000_baseline.sql` → `{ version: '20260704120000', name: 'baseline' }`. */
const FORMA_NOME = /^(\d{14})_(.+)\.sql$/

/** I soli file `.sql` di primo livello, in ordine alfabetico: è l'ordine con cui `supabase` li applica. */
const FILE_SUL_DISCO: string[] = readdirSync(CARTELLA_MIGRAZIONI, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort()

function scomponi(file: string): Migrazione | null {
    const m = FORMA_NOME.exec(file)
    return m ? { version: m[1], name: m[2] } : null
}

describe('lock architettura · le migrazioni del repo ricostruiscono il database', () => {
    it('la fotografia non è stata addomesticata a mano (sha256)', () => {
        // Stesse chiavi, stesso ordine di `normalizza()` in
        // `__tests__/fixtures/migrazioni-fotografia.mjs`: l'impronta copre il
        // contenuto, non i metadati (`_come_si_rigenera`, `generato_il`, `sha256`).
        // Senza questa prova basterebbe cancellare una riga dalla fotografia per
        // far tacere il lock sulla migrazione che manca nel repo — cioè per
        // rimettere esattamente il difetto che il lock esiste per impedire.
        const atteso = createHash('sha256')
            .update(JSON.stringify({ migrazioni: foto.migrazioni }))
            .digest('hex')
        expect(
            foto.sha256,
            `Il contenuto della fotografia non corrisponde al suo sha256: qualcuno l'ha ` +
            `modificata a mano invece di rigenerarla dal database. ${COME_RIGENERARE}`,
        ).toBe(atteso)
    })

    it('la fotografia è piena e plausibile (se cade, il lock si sta autoingannando)', () => {
        // Un lock che gira su una fotografia vuota passa sempre: è il modo più
        // silenzioso di non controllare niente. Soglia tarata sul valore reale
        // (69 migrazioni applicate al 2026-07-31), abbassata quel tanto che basta
        // a non doverla toccare a ogni rilascio.
        expect(
            foto.migrazioni.length,
            `La fotografia contiene ${foto.migrazioni.length} migrazioni: troppo poche per essere ` +
            `la storia vera di questo database. ${COME_RIGENERARE}`,
        ).toBeGreaterThan(60)
        // La baseline è la prima migrazione di questo database e non sparirà mai:
        // se non c'è, la query ha guardato la tabella sbagliata.
        expect(foto.migrazioni.map((m) => m.name)).toContain('baseline')
        for (const m of foto.migrazioni) {
            expect(m.version, `version non valida nella fotografia: ${JSON.stringify(m)}`).toMatch(/^\d{14}$/)
            expect(m.name, `name vuoto nella fotografia: ${JSON.stringify(m)}`).toBeTruthy()
        }
        // E la cartella deve esistere davvero: se il walk tornasse vuoto, tutti i
        // confronti qui sotto girerebbero su un insieme vuoto.
        expect(FILE_SUL_DISCO.length, 'nessun file .sql sotto supabase/migrations').toBeGreaterThan(60)
    })

    it('la fotografia è ordinata per version, senza duplicati e senza nomi ripetuti', () => {
        const versioni = foto.migrazioni.map((m) => m.version)
        expect(
            [...versioni].sort(),
            `La fotografia non è ordinata per version: la query deve finire con ` +
            `\`order by version\`, altrimenti «l'ordine di applicazione» non vuol dire niente.`,
        ).toEqual(versioni)
        expect(new Set(versioni).size, 'version duplicate nella fotografia').toBe(versioni.length)
        // I `name` unici non sono un vezzo: la prova sull'ORDINE qui sotto accoppia
        // disco e produzione PER NOME, e due migrazioni omonime la renderebbero
        // ambigua — cioè verde per caso.
        const nomi = foto.migrazioni.map((m) => m.name)
        const ripetuti = nomi.filter((n, i) => nomi.indexOf(n) !== i)
        expect(
            [...new Set(ripetuti)],
            'Due migrazioni con lo stesso nome: dai un nome diverso alla nuova prima di applicarla.',
        ).toEqual([])
    })

    it('ogni file di migrazione ha la forma <version>_<nome>.sql', () => {
        const malformati = FILE_SUL_DISCO.filter((f) => !FORMA_NOME.test(f))
        expect(
            malformati,
            `Questi file non hanno la forma \`<14 cifre>_<nome>.sql\`. Il CLI di Supabase legge ` +
            `la \`version\` dal nome del file: un nome fuori forma non viene applicato, oppure ` +
            `viene applicato con una version che nessuno si aspetta.`,
        ).toEqual([])
    })

    it('due file di migrazione non hanno la stessa version', () => {
        // NATO DA UN CASO VERO (2026-08-01). Due esecutori in parallelo hanno scritto
        // due migrazioni diverse — l'allowlist MIME dei bucket e le policy dell'orario
        // per sede — scegliendo lo stesso istante: `20260801031500`. Nessun test se n'è
        // accorto, perché il controllo sui duplicati qui sopra guarda la FOTOGRAFIA,
        // cioè ciò che è già in produzione, dove una collisione non può esistere: la
        // `version` è la chiave di `supabase_migrations.schema_migrations`.
        //
        // È proprio questo a rendere il difetto pericoloso invece che fastidioso: la
        // collisione è invisibile finché resta sul disco, e si manifesta al momento
        // peggiore — quando si applica. Delle due, una sola entra; l'altra viene
        // rifiutata per chiave duplicata o, a seconda dello strumento, considerata
        // «già applicata» e SALTATA IN SILENZIO. Nel nostro caso avrebbe potuto saltare
        // le policy dell'orario: il repo direbbe che i genitori di Aversa non leggono
        // più l'orario di Giugliano, e il database non l'avrebbe mai saputo.
        const perVersion = new Map<string, string[]>()
        for (const f of FILE_SUL_DISCO) {
            const m = FORMA_NOME.exec(f)
            if (!m) continue // la forma la sorveglia il test qui sopra
            const version = m[1]
            perVersion.set(version, [...(perVersion.get(version) ?? []), f])
        }
        const collisioni = [...perVersion.entries()]
            .filter(([, file]) => file.length > 1)
            .map(([version, file]) => `${version}: ${file.sort().join(' + ')}`)
            .sort()
        expect(
            collisioni,
            `Due migrazioni con la STESSA version. Ne verrebbe applicata una sola, e l'altra ` +
            `sarebbe rifiutata o saltata senza dirlo a nessuno: il repo descriverebbe un ` +
            `database che non esiste. Rinomina la più recente con l'istante vero in cui è ` +
            `stata scritta (\`<14 cifre>_<nome>.sql\`), non con un secondo a caso.`,
        ).toEqual([])
    })

    it('ogni migrazione applicata in produzione ha il suo file nel repo', () => {
        // ⟵ È IL CUORE DEL LOCK. Il difetto storico stava tutto qui: sei migrazioni
        // applicate con `apply_migration` e mai riportate su disco. Nessuna
        // tolleranza, nessuna allowlist: una migrazione che vive solo nel database
        // è una modifica di schema che nessuno può rivedere, ripetere o annullare.
        const presenti = new Set(FILE_SUL_DISCO)
        const mancanti = foto.migrazioni.map(nomeFile).filter((f) => !presenti.has(f))
        expect(
            mancanti,
            `Queste migrazioni sono APPLICATE in produzione ma non esistono nel repo:\n` +
            `  ${mancanti.join('\n  ')}\n` +
            `Il database non è più ricostruibile dai file. Recupera lo statement applicato ` +
            `(\`select statements from supabase_migrations.schema_migrations where version = '…'\`) ` +
            `e scrivilo in \`supabase/migrations/<version>_<name>.sql\` — con la version REALE, ` +
            `non un timestamp inventato. Se invece la migrazione è stata rimossa dal database, ` +
            `${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('nessun file di migrazione si intercala nella storia già applicata', () => {
        // Un file che la produzione non conosce è legittimo in UN caso solo: è appena
        // stato scritto e non è ancora stato applicato — quindi sta in CODA, con un
        // timestamp posteriore a tutte le migrazioni già applicate.
        //
        // Un file sconosciuto INTERCALATO fra due version già applicate è invece
        // esattamente il difetto del 2026-07-31: un timestamp inventato che si
        // infila in una storia già scritta. Sul database non cambia niente (quelle
        // righe ci sono già), ma su una ricostruzione dai file cambia l'ORDINE — e
        // l'ordine è l'unica cosa che una migrazione garantisce.
        const applicate = new Set(foto.migrazioni.map(nomeFile))
        const ultimaApplicata = foto.migrazioni[foto.migrazioni.length - 1].version
        const intercalati = FILE_SUL_DISCO.filter((f) => !applicate.has(f)).filter((f) => {
            const m = scomponi(f)
            // I file fuori forma li segnala la prova precedente: qui non si contano due volte.
            return m !== null && m.version <= ultimaApplicata
        })
        expect(
            intercalati,
            `Questi file non risultano applicati in produzione, ma portano un timestamp ` +
            `ANTERIORE all'ultima migrazione applicata (${ultimaApplicata}):\n` +
            `  ${intercalati.join('\n  ')}\n` +
            `Se è una migrazione nuova, il suo timestamp deve essere posteriore: un file che si ` +
            `infila nel mezzo verrebbe applicato PRIMA di migrazioni che in produzione sono già ` +
            `passate, e su un database ricostruito da zero l'ordine sarebbe diverso da quello ` +
            `reale. Se invece è già stata applicata, ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it("l'ordine alfabetico dei file è l'ordine con cui la produzione le ha applicate", () => {
        // Il confronto è PER NOME, non per timestamp: è l'unico modo di accorgersi
        // che un file è stato rinominato con una version inventata che lo sposta di
        // posto. Confrontare i timestamp direbbe solo «file diverso»; confrontare i
        // nomi dice «questa migrazione, in produzione, è passata prima di
        // quest'altra — sul disco no».
        //
        // Si guarda l'INTERSEZIONE: le migrazioni assenti da una delle due parti
        // sono affare delle due prove precedenti, che le nominano una per una. Così
        // ogni rosso qui significa una cosa sola, e la dice.
        const inProduzione = foto.migrazioni.map((m) => m.name)
        const noti = new Set(inProduzione)
        const sulDisco = FILE_SUL_DISCO.map(scomponi)
            .filter((m): m is Migrazione => m !== null)
            .map((m) => m.name)
            .filter((n) => noti.has(n))
        const attesi = inProduzione.filter((n) => sulDisco.includes(n))

        const divergenze: string[] = []
        for (let i = 0; i < attesi.length; i++) {
            if (sulDisco[i] !== attesi[i]) {
                divergenze.push(`posizione ${i + 1}: sul disco «${sulDisco[i]}», in produzione «${attesi[i]}»`)
            }
        }
        expect(
            divergenze,
            `L'ordine dei file NON è l'ordine di applicazione reale:\n` +
            `  ${divergenze.join('\n  ')}\n` +
            `Il CLI applica i file in ordine alfabetico di nome, cioè in ordine di timestamp: se ` +
            `il timestamp di un file non è la version con cui è stato applicato, una ricostruzione ` +
            `da zero esegue le migrazioni in un ordine che in produzione non è mai esistito — e si ` +
            `rompe sulle dipendenze (un ALTER prima del CREATE che lo giustifica). Rinomina il file ` +
            `con la sua version REALE. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('il generatore della fotografia non legge la cartella che il lock controlla', () => {
        // Se la fotografia si rigenerasse leggendo `supabase/migrations/`, questo file
        // confronterebbe la cartella con se stessa: verde per costruzione, cioè
        // nessun controllo. La fotografia è la verità del DATABASE. Il generatore
        // riceve solo testo su stdin — non si connette nemmeno da sé al database,
        // perché `.env.local` punta alla PRODUZIONE.
        expect(existsSync(GENERATORE), `manca il generatore ${GENERATORE}`).toBe(true)
        const codice = readFileSync(GENERATORE, 'utf8')
        for (const vietato of ['readdirSync', 'supabase/migrations', "'supabase'"]) {
            expect(
                codice.includes(vietato),
                `Il generatore della fotografia contiene «${vietato}»: se ricava l'elenco dalla ` +
                `cartella delle migrazioni invece che dal database, questo lock confronta la ` +
                `cartella con se stessa e non verifica più niente.`,
            ).toBe(false)
        }
        // E deve nominare la tabella da cui la verità arriva davvero.
        expect(
            codice.includes('supabase_migrations.schema_migrations'),
            'Il generatore non nomina `supabase_migrations.schema_migrations`: da dove verrebbe la fotografia?',
        ).toBe(true)
    })
})
