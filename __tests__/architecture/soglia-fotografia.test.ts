import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    MIGRAZIONI_ATTESE_AL_MERGE,
    migrazioniPosteriori,
    posterioriCheContengono,
    posterioriDaRigenerare,
    sogliaFotografia,
    toccaLaRls,
    toccaLeFkUtenti,
    toccaUnUnico,
    versioneDelFile,
    type MetadatiFotografia,
} from './soglia-fotografia'

/**
 * I test del GUARD che copre il punto cieco delle fotografie.
 *
 * Girano su una cartella finta di migrazioni, non su `supabase/migrations`: un test
 * che chiedesse alla cartella vera di contenere un certo file sarebbe verde o rosso a
 * seconda di che cosa qualcun altro ha appena scritto — cioè non misurerebbe questo
 * codice. Qui i file li scrive il test, e quindi la risposta attesa è nota.
 *
 * Le prove sono di COMPORTAMENTO: nessuna cerca il nome di una funzione dentro un
 * sorgente. Il primo blocco descrive esattamente il difetto del 2026-08-04 — soglia
 * al giorno invece che al secondo — e resta rosso se qualcuno lo rimette.
 */

let CARTELLA: string

const scrivi = (nome: string, sql: string) => writeFileSync(join(CARTELLA, nome), sql, 'utf8')

beforeAll(() => {
    CARTELLA = mkdtempSync(join(tmpdir(), 'kv-soglia-'))
    // Tre file NELLO STESSO GIORNO della fotografia: uno prima dello scatto, uno dopo,
    // uno molto dopo. È il caso che il vecchio confronto per data non poteva distinguere.
    scrivi('20260801081633_prima_dello_scatto.sql', 'CREATE POLICY "p" ON public.t FOR SELECT USING (true);')
    scrivi('20260801120000_dopo_lo_scatto.sql', 'CREATE POLICY "q" ON public.t FOR SELECT USING (true);')
    scrivi('20260801235959_molto_dopo.sql', 'ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;')
    // Un file del giorno prima: non deve mai risultare posteriore.
    scrivi('20260731235959_il_giorno_prima.sql', 'CREATE POLICY "r" ON public.t FOR SELECT USING (true);')
    // Un file fuori forma: lo sorveglia un altro lock, qui non deve entrare.
    scrivi('note.sql', 'select 1;')
})

afterAll(() => {
    rmSync(CARTELLA, { recursive: true, force: true })
})

describe('soglia di una fotografia · «più recente» si misura al secondo', () => {
    it('con `generato_alle` la soglia porta ore, minuti e secondi', () => {
        expect(sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T10:30:25Z' })).toBe(
            '20260801103025',
        )
    })

    it('una migrazione dello STESSO GIORNO ma successiva allo scatto è posteriore', () => {
        // ⟵ È LA PROVA DEL DIFETTO. Il vecchio guard confrontava `f.slice(0, 8)` con la
        // data della fotografia: per lui nessuno di questi tre file era mai posteriore,
        // perché nessuno di loro ha una DATA maggiore del 1° agosto. Cioè il giorno in
        // cui si applica una migrazione e si rigenera la fotografia — l'unico giorno in
        // cui il guard serve — era il giorno in cui taceva.
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T10:00:00Z' })
        expect(migrazioniPosteriori(CARTELLA, soglia)).toEqual([
            '20260801120000_dopo_lo_scatto.sql',
            '20260801235959_molto_dopo.sql',
        ])
    })

    it('una migrazione dello stesso giorno ma ANTERIORE allo scatto non è posteriore', () => {
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T23:59:59Z' })
        expect(migrazioniPosteriori(CARTELLA, soglia)).toEqual(['20260801235959_molto_dopo.sql'])
    })

    it('senza `generato_alle` la soglia ripiega su mezzanotte: prudente, mai muta', () => {
        // Il ripiego deve sbagliare per eccesso. Con la sola data, tutte le migrazioni
        // di quel giorno risultano posteriori: si può gridare al lupo, non si può tacere.
        const soglia = sogliaFotografia({ generato_il: '2026-08-01' })
        expect(soglia).toBe('20260801000000')
        expect(migrazioniPosteriori(CARTELLA, soglia)).toEqual([
            '20260801081633_prima_dello_scatto.sql',
            '20260801120000_dopo_lo_scatto.sql',
            '20260801235959_molto_dopo.sql',
        ])
    })

    it('i file del giorno prima e quelli fuori forma restano fuori', () => {
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T00:00:00Z' })
        const posteriori = migrazioniPosteriori(CARTELLA, soglia)
        expect(posteriori).not.toContain('20260731235959_il_giorno_prima.sql')
        expect(posteriori).not.toContain('note.sql')
    })

    it('una fotografia con un `generato_alle` illeggibile fa rumore invece di ripiegare in silenzio', () => {
        // Se ripiegasse sulla data, un campo storto diventerebbe una perdita di
        // precisione invisibile — cioè il difetto di partenza, rientrato dalla finestra.
        expect(() => sogliaFotografia({ generato_il: '2026-08-01', generato_alle: 'ieri' })).toThrow(/generato_alle/)
        expect(() => sogliaFotografia({ generato_il: 'boh' })).toThrow(/generato_il/)
    })

    it('`versioneDelFile` legge le quattordici cifre, e nient\'altro', () => {
        expect(versioneDelFile('20260704120000_baseline.sql')).toBe('20260704120000')
        expect(versioneDelFile('20260704_baseline.sql')).toBeNull()
        expect(versioneDelFile('baseline.sql')).toBeNull()
        expect(versioneDelFile('20260704120000_baseline.txt')).toBeNull()
    })

    it('`posterioriCheContengono` filtra sul contenuto, non sul nome', () => {
        const soglia = sogliaFotografia({ generato_il: '2026-08-01', generato_alle: '2026-08-01T10:00:00Z' })
        expect(posterioriCheContengono(CARTELLA, soglia, (sql) => /ENABLE ROW LEVEL SECURITY/i.test(sql))).toEqual([
            '20260801235959_molto_dopo.sql',
        ])
    })
})

describe('riconoscitore · una migrazione che cambia ciò che la fotografia della RLS contiene', () => {
    it('vede una tabella nuova che nasce protetta, senza nessun CREATE POLICY', () => {
        // ⟵ IL SECONDO PUNTO CIECO. `tabelle_rls_attiva` fa parte della fotografia:
        // accendere la RLS su una tabella la cambia, e il vecchio filtro
        // `/(CREATE|DROP|ALTER)\s+POLICY/` non ci arrivava nemmeno vicino.
        const sql = `CREATE TABLE public.nuova (id uuid primary key);
                     ALTER TABLE public.nuova ENABLE ROW LEVEL SECURITY;`
        expect(toccaLaRls(sql)).toBe(true)
    })

    it('vede una policy creata in SQL dinamico dentro un DO $$', () => {
        const sql = `DO $$ BEGIN
                       EXECUTE format('create policy %I on public.t for select using (true)', 'p');
                     END $$;`
        expect(toccaLaRls(sql)).toBe(true)
    })

    it('vede il DROP di una tabella, che porta via con sé le sue policy', () => {
        expect(toccaLaRls('DROP TABLE IF EXISTS public.vecchia;')).toBe(true)
    })

    it('vede la NASCITA di una colonna `scuola_id`', () => {
        expect(toccaLaRls('ALTER TABLE public.t ADD COLUMN IF NOT EXISTS scuola_id uuid;')).toBe(true)
        expect(toccaLaRls('CREATE TABLE public.t (\n  id uuid,\n  scuola_id uuid NOT NULL\n);')).toBe(true)
    })

    it('NON si accende per una migrazione che nomina `scuola_id` solo per usarla', () => {
        // Il confine serve: `scuola_id` compare in quasi tutte le migrazioni di questo
        // repo, e un guard rosso su tutto sarebbe rosso anche dove non si può spegnere
        // (una migrazione scritta e non ancora applicata non entra in una fotografia
        // della produzione). Un lock che non si può far tornare verde insegna il `.skip`.
        const sql = `CREATE INDEX idx_t_scuola ON public.t (scuola_id);
                     UPDATE public.t SET x = 1 WHERE scuola_id = '00000000-0000-0000-0000-000000000000';`
        expect(toccaLaRls(sql)).toBe(false)
    })

    it('NON si accende per una migrazione che non c\'entra niente', () => {
        expect(toccaLaRls('CREATE INDEX idx_a ON public.a (b);\nANALYZE public.a;')).toBe(false)
    })

    it('NON si accende per la parola «policy» scritta dentro un COMMENTO', () => {
        // ⟵ IL TERZO PUNTO CIECO, misurato il 2026-08-12 e non dedotto: tre migrazioni
        // scritte quel giorno finivano tutte con una riga che diceva, con parole loro,
        // «NON accende RLS e non crea policy» — ed era PROPRIO quella riga a farle
        // risultare «migrazioni che toccano le policy». Il guard leggeva la PROSA
        // invece dello SQL: il file si autoincriminava con la frase con cui dichiarava
        // di non toccare niente, e l'unico modo di spegnere il rosso era cancellare la
        // spiegazione. Un lock che si spegne togliendo un commento insegna a scrivere
        // meno commenti — che in questo repo è il danno più caro di tutti.
        const sql = `-- NON accende RLS su niente: le due tabelle ce l'hanno già, senza policy.
                     /* nemmeno qui dentro: nessuna policy, nessun row level security */
                     ALTER TABLE public.t RENAME COLUMN a TO b;`
        expect(toccaLaRls(sql)).toBe(false)
    })

    it('vede la policy VERA anche quando un commento la precede', () => {
        // Il controllo positivo accanto al rifiuto: senza, uno stripper che si mangiasse
        // tutto il file passerebbe il test qui sopra e spegnerebbe il guard per sempre.
        const sql = `-- questa invece la tocca davvero
                     create policy p on public.t for select using (true);`
        expect(toccaLaRls(sql)).toBe(true)
    })

    it('non scambia per commento un `--` che sta DENTRO una stringa', () => {
        // `comment on column … is '…'` è prosa dentro una stringa SQL, e un trattino
        // doppio là dentro non apre nessun commento. Uno stripper che lo credesse si
        // mangerebbe tutto il resto della riga — cioè anche lo SQL vero che segue.
        const sql = `comment on column public.t.a is 'un trattino -- in mezzo alla frase';
                     create policy p on public.t for select using (true);`
        expect(toccaLaRls(sql)).toBe(true)
    })

    it('non scambia per commento un `--` dentro un corpo `$$ … $$`', () => {
        // Il corpo dollaro-quotato è codice eseguito, non prosa: `EXECUTE format('create
        // policy …')` è la forma con cui si scrive una policy idempotente, ed è già uno
        // dei due punti ciechi chiusi il 2026-08-04. Perderlo qui li riaprirebbe.
        const sql = `DO $$ BEGIN
                       -- niente da vedere
                       EXECUTE format('create policy %I on public.t for select using (true)', 'p');
                     END $$;`
        expect(toccaLaRls(sql)).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// LE PROVE GEMELLE DI `MIGRAZIONI_ATTESE_AL_MERGE` (2026-09-23, contratto S21)
//
// A differenza di tutto ciò che sta sopra, queste prove leggono la cartella VERA e
// le fotografie VERE, e di proposito: non collaudano una funzione, collaudano una
// DICHIARAZIONE contro lo stato del repo. È una dichiarazione che toglie file da
// tre guardie, e l'unico modo perché non diventi un'allowlist che marcisce è che
// diventi rossa da sola nel momento in cui smette di essere vera — la migrazione
// applicata (prova 2), il file rinominato o sparito (prova 1), una fotografia
// scattata dopo (prova 3), un file che nessuna guardia segnala più (prova 5).
//
// PROVE DI ROTTURA, eseguite davvero il 2026-09-23 e poi rimesse a posto:
//  · chiave con un nome che non esiste su disco → rossa la prova 1;
//  · chiave sostituita con una migrazione già applicata
//    (`20260919132612_avvisi_scadenze_posti_e_partecipanti.sql`) → rossa la prova 2
//    (e la 3, perché è anche anteriore agli scatti);
//  · chiave sostituita con `20260923071958_fatture_emesse_senza_vincolo_numero_per_sede.sql`,
//    non applicata ma anteriore a `generato_alle` di fk-utenti → rossa la sola prova 3;
//  · ragione ridotta a «PR-A» → rossa la prova 4;
//  · `posterioriDaRigenerare` che ignora le dichiarazioni, oppure che restituisce
//    sempre `[]` → rossa la prova 6.
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()
const MIGRAZIONI_VERE = join(RADICE, 'supabase', 'migrations')
const FIXTURES = join(RADICE, '__tests__', 'fixtures')

const leggiFoto = <T,>(nome: string): T => JSON.parse(readFileSync(join(FIXTURES, nome), 'utf8')) as T

/** Le tre fotografie che le guardie di freschezza leggono, con la guardia di ciascuna. */
const FOTO_DELLE_GUARDIE: { guardia: string; file: string }[] = [
    { guardia: 'rls-per-sede', file: 'pg-policies-snapshot.json' },
    { guardia: 'onconflict-arbitro', file: 'indici-unici-snapshot.json' },
    { guardia: 'tracce-docente-dichiarate', file: 'fk-utenti-snapshot.json' },
]

const CHIAVI_ATTESE = Object.keys(MIGRAZIONI_ATTESE_AL_MERGE)

describe('MIGRAZIONI_ATTESE_AL_MERGE · una dichiarazione che si chiude da sola', () => {
    it('1 · ogni chiave è un file di migrazione che esiste davvero, nella forma giusta', () => {
        const fantasma = CHIAVI_ATTESE.filter(
            (f) => versioneDelFile(f) === null || !existsSync(join(MIGRAZIONI_VERE, f)),
        )
        expect(
            fantasma,
            'Voci di MIGRAZIONI_ATTESE_AL_MERGE che non corrispondono a un file in supabase/migrations/ ' +
                '(rinominato, cancellato o scritto male): una dichiarazione che non nomina niente è ' +
                "un'esenzione in attesa del prossimo file con quel nome. Toglila o correggila.",
        ).toEqual([])
    })

    it('2 · nessuna chiave è già applicata: quando la fotografia la contiene, la voce si toglie', () => {
        const foto = leggiFoto<{ migrazioni: { version: string }[] }>('migrazioni-applicate-snapshot.json')
        const applicate = new Set(foto.migrazioni.map((m) => m.version))
        // Sanity: una fotografia vuota renderebbe verde questa prova per il motivo sbagliato.
        expect(applicate.size).toBeGreaterThan(60)
        const giaApplicate = CHIAVI_ATTESE.filter((f) => applicate.has(versioneDelFile(f) ?? ''))
        expect(
            giaApplicate,
            'Queste migrazioni risultano APPLICATE nella fotografia delle migrazioni, e sono ancora ' +
                'dichiarate «attese al merge». Il motivo della dichiarazione è finito: toglile da ' +
                'MIGRAZIONI_ATTESE_AL_MERGE e rigenera le fotografie delle guardie (policy, indici ' +
                'unici, FK verso utenti) — è la PR-B della coda fatture.',
        ).toEqual([])
    })

    it('3 · ogni chiave è posteriore a TUTTE le fotografie che le guardie leggono', () => {
        const anteriori: string[] = []
        for (const { guardia, file } of FOTO_DELLE_GUARDIE) {
            const soglia = sogliaFotografia(leggiFoto<MetadatiFotografia>(file))
            for (const f of CHIAVI_ATTESE) {
                if ((versioneDelFile(f) ?? '') < soglia) anteriori.push(`${f} < ${file} (${guardia}, ${soglia})`)
            }
        }
        expect(
            anteriori,
            'Una fotografia è stata scattata DOPO l\'istante che il file dichiara: quella fotografia ' +
                'o la contiene (e allora la migrazione è applicata: togli la voce) o no (e allora il ' +
                'nome del file mente sul suo istante). Rinomina il file con l\'istante vero in cui è ' +
                'scritto — mai con un istante futuro — e aggiorna la chiave.',
        ).toEqual([])
    })

    it('4 · ogni voce porta la sua ragione per esteso, con l\'integrazione e la PR-B', () => {
        for (const [f, ragione] of Object.entries(MIGRAZIONI_ATTESE_AL_MERGE)) {
            expect(ragione.length, `«${f}» non ha una ragione scritta per esteso.`).toBeGreaterThan(30)
            expect(ragione, `«${f}»: la ragione deve dire CHI la applica (l'integrazione).`).toMatch(/integrazione/i)
            expect(ragione, `«${f}»: la ragione deve dire DOVE la voce si toglie (la PR-B).`).toContain('PR-B')
        }
    })

    it('5 · nessuna voce morta: ogni chiave è un file che almeno una guardia segnalerebbe', () => {
        const nessunaGuardia = CHIAVI_ATTESE.filter((f) => existsSync(join(MIGRAZIONI_VERE, f))).filter((f) => {
            const sql = readFileSync(join(MIGRAZIONI_VERE, f), 'utf8')
            return !(toccaLaRls(sql) || toccaUnUnico(sql) || toccaLeFkUtenti(sql))
        })
        expect(
            nessunaGuardia,
            'Queste migrazioni sono dichiarate ma nessuna delle tre guardie le segnalerebbe: la ' +
                'dichiarazione non serve, e un\'esenzione che non serve aspetta solo di coprire ' +
                'qualcos\'altro. Toglila.',
        ).toEqual([])
    })

    it('6 · controllo positivo: la sottrazione toglie ESATTAMENTE i dichiarati, gli altri gridano ancora', () => {
        // Senza questa prova, una `posterioriDaRigenerare` che restituisse sempre `[]`
        // renderebbe verdi le tre guardie per sempre — e le prove 1-5 non se ne
        // accorgerebbero, perché guardano la dichiarazione, non la sottrazione.
        const cartella = mkdtempSync(join(tmpdir(), 'kv-attese-'))
        try {
            const RLS = 'CREATE TABLE public.t (id uuid primary key);\nALTER TABLE public.t ENABLE ROW LEVEL SECURITY;'
            writeFileSync(join(cartella, '20260901000000_prima_dello_scatto.sql'), RLS, 'utf8')
            writeFileSync(join(cartella, '20260923100000_dichiarata.sql'), RLS, 'utf8')
            writeFileSync(join(cartella, '20260923110000_non_dichiarata.sql'), RLS, 'utf8')
            // Stesso nome della dichiarata ma con un'altra version: il confronto è per nome ESATTO.
            writeFileSync(join(cartella, '20260923120000_dichiarata.sql'), RLS, 'utf8')
            const attese = { '20260923100000_dichiarata.sql': 'PR-A: la applica l’integrazione al merge; PR-B la toglie.' }
            const soglia = '20260920000000'

            expect(posterioriCheContengono(cartella, soglia, toccaLaRls)).toEqual([
                '20260923100000_dichiarata.sql',
                '20260923110000_non_dichiarata.sql',
                '20260923120000_dichiarata.sql',
            ])
            expect(posterioriDaRigenerare(cartella, soglia, toccaLaRls, attese)).toEqual([
                '20260923110000_non_dichiarata.sql',
                '20260923120000_dichiarata.sql',
            ])
            // Il riconoscitore resta quello della guardia: un file dichiarato non diventa
            // «riconosciuto» per il fatto di essere dichiarato, né il contrario.
            expect(posterioriDaRigenerare(cartella, soglia, toccaUnUnico, attese)).toEqual([
                '20260923110000_non_dichiarata.sql',
                '20260923120000_dichiarata.sql',
            ])
            expect(posterioriDaRigenerare(cartella, soglia, toccaLeFkUtenti, attese)).toEqual([])
            // Senza il quarto argomento vale la costante: sui file sintetici non toglie niente.
            expect(posterioriDaRigenerare(cartella, soglia, toccaLaRls)).toEqual(
                posterioriCheContengono(cartella, soglia, toccaLaRls),
            )
        } finally {
            rmSync(cartella, { recursive: true, force: true })
        }
    })
})

describe('i riconoscitori spostati qui dalle guardie dicono ancora la stessa cosa', () => {
    it('`toccaUnUnico` vede UNIQUE e PRIMARY KEY nello SQL, non nei commenti', () => {
        expect(toccaUnUnico('CREATE UNIQUE INDEX i ON public.t (a) WHERE b;')).toBe(true)
        expect(toccaUnUnico('CREATE TABLE public.t (id uuid PRIMARY KEY);')).toBe(true)
        expect(toccaUnUnico('-- niente unique qui\nCREATE INDEX i ON public.t (a);')).toBe(false)
    })

    it('`toccaLeFkUtenti` vede `references utenti` e `add/drop constraint`, non la prosa', () => {
        expect(toccaLeFkUtenti('ALTER TABLE t ADD COLUMN u uuid REFERENCES public.utenti(id);')).toBe(true)
        expect(toccaLeFkUtenti('ALTER TABLE t DROP CONSTRAINT t_u_fkey;')).toBe(true)
        expect(toccaLeFkUtenti('-- references utenti, on delete cascade\nSELECT 1;')).toBe(false)
        // Senza FK verso `utenti` (è il caso di `fatture_coda.creato_da`): non si accende.
        expect(toccaLeFkUtenti('CREATE TABLE t (creato_da uuid NOT NULL, p uuid REFERENCES public.pagamenti(id));')).toBe(false)
    })
})
