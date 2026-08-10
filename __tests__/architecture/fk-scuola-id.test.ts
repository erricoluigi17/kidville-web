import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { posterioriCheContengono, sogliaFotografia } from './soglia-fotografia'

/**
 * LOCK · lo SCHEMA deve difendere il tenant: nessuna colonna `scuola_id` senza vincolo.
 *
 * Perché esiste. Fino al 2026-07-31, su 65 tabelle di `public` con una colonna
 * `scuola_id`, TRENTUNO non avevano nessuna FOREIGN KEY verso le sedi. Le FK erano
 * state messe sul nucleo (`alunni`, `utenti`, `sections`, `presenze`,
 * `registro_orario`) e poi omesse via via che il perimetro cresceva, senza una regola
 * che lo imponesse.
 *
 * Che cosa comporta, concretamente: su quelle tabelle `scuola_id` è un uuid libero —
 * il database accetta QUALUNQUE valore, compreso uno che non corrisponde a nessuna
 * sede. Una riga così non appartiene a nessun plesso e diventa invisibile a ogni
 * filtro `.in('scuola_id', plessi)`: non è una fuga di dati, è una SPARIZIONE
 * silenziosa. E riguardava tabelle con valore probatorio — `fatture_emesse`,
 * `ricevute_emesse`, `riconciliazione_movimenti`, `pagamenti_transazioni`.
 *
 * È lo stesso difetto di famiglia della RLS mono-sede: **non rompe niente e non
 * avvisa nessuno.** Un lock è l'unico modo per accorgersene il giorno in cui una
 * migrazione nuova ricomincia a dimenticare il vincolo.
 *
 * Come funziona. Il test gira OFFLINE (in CI non c'è il database di produzione):
 * legge la fotografia versionata `__tests__/fixtures/fk-scuola-id-snapshot.json`,
 * che si rigenera con `scripts/fk-sede-fotografia.mjs`. Porta un `sha256` del
 * contenuto: non si può ammorbidire il file a mano per far tacere il lock.
 *
 * E siccome una fotografia, da sola, è cieca a ciò che succede DOPO lo scatto,
 * l'ultimo test guarda le migrazioni più recenti della fotografia: una che
 * introduce una colonna `scuola_id` senza dichiararne il riferimento nello stesso
 * file fa cadere il lock anche se nessuno ha rigenerato la fotografia.
 */

type Tabella = {
    tabella: string
    not_null: boolean
    fk_nome: string | null
    fk_verso: string | null
}

type Vincolo = { nome: string; def: string }

type Fotografia = {
    generato_il: string
    /** L'istante dello scatto, UTC al secondo. Vedi `./soglia-fotografia`. */
    generato_alle?: string
    sha256: string
    tabelle: Tabella[]
    alunni_colonne_cf: string[]
    alunni_vincoli_cf: Vincolo[]
}

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWLIST — le tabelle il cui `scuola_id` punta a `scuole` invece che a `schools`.
//
// Il repo trascina due tabelle delle sedi: `schools` (su cui puntano tutte le FK
// storiche e da cui legge il trigger ETL) e `scuole` (su cui ragiona una parte
// dell'applicazione). Contengono gli stessi 4 id. La doppia sorgente è essa stessa
// un rilievo dell'audit — ma unificarla è una migrazione a sé: qui si CONGELA
// l'elenco di chi punta al gemello, così una tabella NUOVA che sceglie `scuole`
// non passa inosservata.
// ─────────────────────────────────────────────────────────────────────────────
const FK_VERSO_SCUOLE: Record<string, string> = {
    cassa_categorie: 'modulo Cassa (2026-07-20): nato puntando a `scuole`, ON DELETE CASCADE',
    cassa_chiusure: 'modulo Cassa (2026-07-20): nato puntando a `scuole`, ON DELETE CASCADE',
    cassa_movimenti: 'modulo Cassa (2026-07-20): nato puntando a `scuole`, ON DELETE CASCADE',
    news_categorie: 'modulo News (2026-07-20): nato puntando a `scuole`',
}

// ─────────────────────────────────────────────────────────────────────────────
// IL `NOT NULL` SU `scuola_id` È UNA CONQUISTA, E SI CONGELA QUI.
//
// NATO DA UN CASO VERO, misurato il 2026-08-10. Il 31 luglio tre migrazioni hanno
// reso obbligatoria `scuola_id` su `enrollment_submissions`,
// `richieste_cancellazione` e `task_interni`. La fotografia era stata scattata
// poche ore prima e continuava a dire `not_null: false` su tutte e tre: per DIECI
// GIORNI il repo ha descritto uno schema più debole di quello reale, col gate
// verde. Il motivo è che `not_null` era un campo della fotografia che NESSUNA
// asserzione guardava — c'era la dichiarazione di tipo, e basta.
//
// Il verso che fa danno è però l'altro. Un `ALTER COLUMN scuola_id DROP NOT NULL`
// rimette in circolo righe senza sede, e una riga con `scuola_id` NULL non è
// protetta dalla FK: la FK garantisce che il valore, SE c'è, sia una sede vera.
// Con NULL la riga non appartiene a nessun plesso e sparisce da ogni filtro
// `.in('scuola_id', plessi)` — è la stessa SPARIZIONE silenziosa contro cui esiste
// tutto questo lock, presa dall'altro capo.
//
// Perciò l'elenco sta QUI, in codice, e non si ricava dalla fotografia: una
// fotografia rigenerata da un database indebolito porterebbe con sé anche
// l'indebolimento, e il lock lo ratificherebbe invece di segnalarlo. Togliere un
// nome da questa lista deve essere un gesto deliberato, con la ragione nel commit.
//
// CHE COSA QUESTO ELENCO NON DICE. È stato compilato copiando le 44 tabelle con
// `not_null: true` dalla fotografia del 2026-08-10: FOTOGRAFA quello stato, non lo
// CERTIFICA. Se quel giorno una tabella era già indebolita per errore, la sua
// assenza da qui non è una scelta — è la registrazione dell'errore. La protezione
// che l'elenco dà è tutta rivolta in AVANTI: da oggi una rigenerazione non lo muove
// più, e un `DROP NOT NULL` diventa rosso. All'indietro non prova niente.
// Perciò chi aggiunge o toglie un nome verifichi la TABELLA — `\d public.<nome>` o
// `information_schema.columns` su produzione — e non questa lista.
//
// Aggiornato allo scatto del 2026-08-10: 44 tabelle su 66.
// ─────────────────────────────────────────────────────────────────────────────
const NOT_NULL_ATTESE: readonly string[] = [
    'admin_settings', 'alunni', 'armadietto', 'candidature_insegnanti', 'cassa_chiusure',
    'cassa_movimenti', 'certificati_competenze', 'crediti_famiglia', 'divise_articoli',
    'divise_ordini', 'enrollment_submissions', 'eventi_agenda', 'fatture_emesse',
    'fatture_numerazione', 'forms_templates', 'giudizi_sintetici_scala', 'gruppi_mensa',
    'materie', 'mensa_alternative', 'mensa_class_menu_assignment', 'mensa_menu_config',
    'merch_fornitori', 'merch_ordini_fornitore', 'merch_po_numerazione', 'merch_rettifiche',
    'news_digest_edizioni', 'obiettivi_apprendimento', 'pagamenti_transazioni', 'presenze',
    'protocolli', 'protocolli_categorie', 'protocolli_numerazione', 'ricevute_emesse',
    'ricevute_numerazione', 'richieste_cancellazione', 'scrutinio_giudizio_descrittivo',
    'scrutinio_periodi', 'sections', 'sidi_import_batches', 'sidi_sync_state', 'solleciti',
    'task_interni', 'utenti', 'utenti_scuole',
]

/**
 * Il solo SQL ESEGUIBILE di una migrazione: i commenti non contano.
 *
 * Non è un dettaglio di pulizia. `20260731192131_task_interni_scuola_obbligatoria.sql`
 * porta, dentro un commento, la riga esatta con cui si TORNEREBBE indietro
 * (`-- alter table public.task_interni alter column scuola_id drop not null;`).
 * Un guard che leggesse anche i commenti diventerebbe rosso su quel file per
 * sempre — e un rosso che nessuna rigenerazione può togliere è un rosso che
 * insegna a mettere `.skip`.
 *
 * Postgres ha DUE forme di commento e qui si tolgono entrambe: `--` fino a fine riga
 * e i blocchi `/* … *\/`. Oggi nessuna delle 107 migrazioni usa la seconda forma
 * (misurato il 2026-08-10: zero file), quindi togliere solo `--` darebbe lo stesso
 * risultato — ma il primo che incapsulerà quella riga di rollback in un blocco
 * riaprirebbe esattamente il rosso irreparabile descritto qui sopra.
 */
const senzaCommenti = (sql: string) =>
    sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')

/**
 * Questa migrazione cambia l'obbligatorietà di `scuola_id`?
 *
 * Il predicato accetta le forme che Postgres accetta, non quelle che siamo abituati
 * a scrivere. Nella grammatica di `ALTER TABLE` la parola `COLUMN` è FACOLTATIVA
 * (`ALTER [ COLUMN ] nome { SET | DROP } NOT NULL`), e l'identificatore può essere
 * fra virgolette: `ALTER TABLE t ALTER "scuola_id" DROP NOT NULL` è SQL valido e
 * passava indenne davanti alla versione precedente, che pretendeva `alter column`.
 * Nessuna delle 107 migrazioni di oggi usa quelle forme (misurato: il predicato
 * largo e quello stretto individuano gli stessi 4 file), quindi il buco era teorico —
 * ma un guard nasce proprio per il caso che nessuno sta guardando, e la forma che
 * sfugge a un guard è per definizione quella che nessuno si aspetta.
 */
const toccaIlNotNullDiSede = (sql: string) =>
    /alter\s+(column\s+)?"?scuola_id"?\s+(set|drop)\s+not\s+null\b/i.test(senzaCommenti(sql))

const FOTOGRAFIA = join(process.cwd(), '__tests__', 'fixtures', 'fk-scuola-id-snapshot.json')
const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

const COME_RIGENERARE =
    'Rigenera la fotografia: `node scripts/fk-sede-fotografia.mjs --sql` → esegui la query sul DB ' +
    'di produzione (sola lettura) → `node scripts/fk-sede-fotografia.mjs < risposta.json`.'

const foto: Fotografia = JSON.parse(readFileSync(FOTOGRAFIA, 'utf8'))

describe('lock architettura · integrità di schema sulle sedi (fotografia delle FK)', () => {
    it('la fotografia non è stata addomesticata a mano (sha256)', () => {
        // Stesse chiavi, stesso ordine di `normalizza()` in scripts/fk-sede-fotografia.mjs:
        // l'impronta copre il contenuto, non i metadati (`generato_il`, `sha256`).
        const contenuto = {
            tabelle: foto.tabelle,
            alunni_colonne_cf: foto.alunni_colonne_cf,
            alunni_vincoli_cf: foto.alunni_vincoli_cf,
        }
        const atteso = createHash('sha256').update(JSON.stringify(contenuto)).digest('hex')
        expect(
            foto.sha256,
            `Il contenuto della fotografia non corrisponde al suo sha256: qualcuno l'ha ` +
            `modificata a mano invece di rigenerarla. ${COME_RIGENERARE}`,
        ).toBe(atteso)
    })

    it('la fotografia è piena e plausibile (se cade, il lock si sta autoingannando)', () => {
        // Un lock che gira su una fotografia vuota passa sempre: è il modo più
        // silenzioso di non controllare niente. Soglia tarata sul valore reale (65).
        expect(foto.tabelle.length).toBeGreaterThan(55)
        for (const t of ['alunni', 'utenti', 'sections', 'presenze', 'pagamenti', 'app_log', 'fatture_emesse']) {
            expect(foto.tabelle.map((x) => x.tabella)).toContain(t)
        }
        expect(foto.alunni_colonne_cf).toContain('codice_fiscale')
    })

    it('ogni tabella con `scuola_id` ha una FOREIGN KEY verso le sedi', () => {
        const nude = foto.tabelle.filter((t) => !t.fk_nome).map((t) => t.tabella)
        expect(
            nude,
            `Tabelle con la colonna \`scuola_id\` e nessuna FK verso le sedi. Su queste ` +
            `\`scuola_id\` è un uuid libero: una riga con un valore che non corrisponde a ` +
            `nessuna sede non appartiene a nessun plesso e sparisce da ogni filtro ` +
            `\`.in('scuola_id', plessi)\` — senza errore, senza log, senza niente di rosso. ` +
            `Aggiungi \`FOREIGN KEY (scuola_id) REFERENCES public.schools(id)\` in una ` +
            `migrazione. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('le FK di sede puntano a `schools`, salvo le eccezioni dichiarate', () => {
        const fuori = foto.tabelle
            .filter((t) => t.fk_verso && t.fk_verso !== 'schools')
            .filter((t) => !FK_VERSO_SCUOLE[t.tabella])
            .map((t) => `${t.tabella} → ${t.fk_verso}`)
        expect(
            fuori,
            `FK di sede che puntano a una tabella diversa da \`schools\` senza una ragione ` +
            `dichiarata. \`schools\` e \`scuole\` contengono gli stessi id ma sono due ` +
            `sorgenti di verità: aggiungerne una terza per distrazione è come è nato il ` +
            `difetto del trigger ETL. Dichiara l'eccezione in FK_VERSO_SCUOLE con la ragione, ` +
            `oppure punta a \`schools\`.`,
        ).toEqual([])
    })

    it('l\'allowlist FK_VERSO_SCUOLE non contiene voci morte', () => {
        const versoScuole = new Set(
            foto.tabelle.filter((t) => t.fk_verso && t.fk_verso !== 'schools').map((t) => t.tabella),
        )
        const morte = Object.keys(FK_VERSO_SCUOLE).filter((t) => !versoScuole.has(t))
        expect(morte, 'Voci di FK_VERSO_SCUOLE che non corrispondono a nessuna FK: rimuovile.').toEqual([])
        for (const [k, motivo] of Object.entries(FK_VERSO_SCUOLE)) {
            expect(motivo.length, `L'eccezione «${k}» non ha una ragione scritta.`).toBeGreaterThan(20)
        }
    })

    it('la colonna dismessa `alunni.fiscal_code` non ha più un vincolo di unicità proprio', () => {
        // R100. Su `alunni` convivono `codice_fiscale` (14 valori su 30) e `fiscal_code`
        // (ZERO su 30, residuo della doppia nomenclatura italiano/inglese). Entrambe
        // avevano un UNIQUE globale. Due chiavi di deduplica per lo stesso dato, di cui
        // una su una colonna morta, sono la premessa di una futura scrittura sulla
        // colonna sbagliata che non incrocerebbe MAI la deduplica dell'altra: due
        // anagrafiche per lo stesso minore, e il pre-flight cross-sede di
        // `admin/iscrizioni` che non se ne accorge.
        const suColonnaMorta = foto.alunni_vincoli_cf.filter((v) => /\bfiscal_code\b/.test(v.def))
        const unicita = suColonnaMorta.filter((v) => /^(UNIQUE|PRIMARY KEY)/i.test(v.def)).map((v) => v.nome)
        expect(
            unicita,
            `Vincoli di unicità sulla colonna dismessa \`alunni.fiscal_code\`. Il codice ` +
            `fiscale del minore vive in \`codice_fiscale\`: l'unicità va tenuta lì (una sola). ` +
            `${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('la colonna dismessa `alunni.fiscal_code`, finché esiste, non può essere scritta', () => {
        // Espand/contract: la colonna si rimuove solo DOPO che il codice in produzione
        // ha smesso di leggerla (oggi la nominano ancora la lista alunni del cockpit e
        // `StudentDetailPanel`, che appartengono a un altro step). Nel frattempo il CHECK
        // la neutralizza in modo RUMOROSO: una scrittura sulla colonna sbagliata fallisce
        // invece di riuscire in silenzio scavalcando la deduplica.
        if (!foto.alunni_colonne_cf.includes('fiscal_code')) return // già rimossa: nulla da difendere
        const check = foto.alunni_vincoli_cf.find(
            (v) => /^CHECK/i.test(v.def) && /\bfiscal_code\b/.test(v.def) && /IS NULL/i.test(v.def),
        )
        expect(
            check?.nome,
            `La colonna \`alunni.fiscal_code\` esiste ancora ma niente ne impedisce la ` +
            `scrittura. Finché non la si può rimuovere, va neutralizzata: ` +
            `\`CHECK (fiscal_code IS NULL)\`. ${COME_RIGENERARE}`,
        ).toBeTruthy()
    })

    it('l\'unicità globale del codice fiscale del minore resta al suo posto', () => {
        // NON è un difetto: `alunni_codice_fiscale_key` impedisce che lo stesso bambino
        // risulti iscritto in due sedi contemporaneamente (mentre un TRASFERIMENTO — un
        // UPDATE di `scuola_id` — resta possibile, perché non tocca il CF). È presidiata
        // con un pre-flight cross-sede e un messaggio dedicato in `admin/iscrizioni`.
        // Sta qui perché il modo più facile di «risolvere» un 23505 è togliere il vincolo.
        const globale = foto.alunni_vincoli_cf.find((v) => v.def === 'UNIQUE (codice_fiscale)')
        expect(
            globale?.nome,
            `Sparito l'UNIQUE globale su \`alunni.codice_fiscale\`: senza, lo stesso minore ` +
            `può essere iscritto in due sedi e nessuno se ne accorge. È voluto — vedi il ` +
            `pre-flight cross-sede in admin/iscrizioni.`,
        ).toBe('alunni_codice_fiscale_key')
    })

    it('nessuna migrazione più recente della fotografia introduce `scuola_id` senza riferimento', () => {
        // La fotografia è cieca a ciò che succede dopo lo scatto. Questo test guarda le
        // migrazioni posteriori: se una crea/aggiunge una colonna `scuola_id` deve
        // dichiarare nello stesso file il riferimento verso le sedi (REFERENCES … o una
        // ADD CONSTRAINT … FOREIGN KEY). Vale anche se nessuno ha rigenerato la fotografia.
        //
        // ⚠️ «PIÙ RECENTE» SI CONFRONTA AL SECONDO, NON AL GIORNO (corretto il 2026-08-04).
        // Qui c'era `f.slice(0, 8) > foto.generato_il.replace(/-/g, '')`: le sole otto
        // cifre della data contro le quattordici di una `version`. Una migrazione
        // applicata LO STESSO GIORNO della fotografia non risultava mai posteriore — ed è
        // il caso normale, perché si applica e si rigenera nella stessa sessione. Il
        // guard nato per coprire il punto cieco della fotografia aveva lo stesso punto
        // cieco della fotografia. Il confronto ora passa da `sogliaFotografia`.
        const soglia = sogliaFotografia(foto)
        const colpevoli = posterioriCheContengono(MIGRAZIONI, soglia, (sql) => {
            // Righe che DEFINISCONO la colonna (dichiarazione di tipo o ADD COLUMN),
            // non quelle che la usano soltanto in una WHERE o in un UPDATE.
            const introduce =
                /add\s+column\s+(if\s+not\s+exists\s+)?scuola_id\b/i.test(sql) ||
                /^\s*scuola_id\s+uuid\b/im.test(sql)
            if (!introduce) return false
            const dichiaraIlVincolo =
                /references\s+(public\.)?(schools|scuole)\b/i.test(sql) ||
                /foreign\s+key\s*\(\s*scuola_id\s*\)/i.test(sql)
            return !dichiaraIlVincolo
        })
        expect(
            colpevoli,
            `Queste migrazioni introducono una colonna \`scuola_id\` senza dichiarare il ` +
            `riferimento verso le sedi. È esattamente come sono nate le 31 colonne senza FK: ` +
            `una alla volta, ognuna con una buona ragione per rimandare. Aggiungi ` +
            `\`REFERENCES public.schools(id)\` nella stessa migrazione. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('nessuna tabella ha PERSO il `NOT NULL` su `scuola_id`', () => {
        const perTabella = new Map(foto.tabelle.map((t) => [t.tabella, t] as const))
        const indebolite = NOT_NULL_ATTESE.filter((t) => perTabella.get(t)?.not_null === false)
        expect(
            indebolite,
            `Su queste tabelle \`scuola_id\` era OBBLIGATORIA e adesso ammette NULL. La FK non ` +
            `copre questo caso: garantisce che il valore, se c'è, sia una sede vera — non che ci ` +
            `sia. Una riga con \`scuola_id\` NULL non appartiene a nessun plesso e sparisce da ` +
            `ogni filtro \`.in('scuola_id', plessi)\`, senza errore e senza log. Se l'indebolimento ` +
            `è voluto, toglilo da NOT_NULL_ATTESE nello stesso commit che lo introduce, con la ` +
            `ragione scritta.`,
        ).toEqual([])
    })

    it('NOT_NULL_ATTESE non contiene voci morte (tabelle che la fotografia non conosce più)', () => {
        const note = new Set(foto.tabelle.map((t) => t.tabella))
        const morte = NOT_NULL_ATTESE.filter((t) => !note.has(t))
        expect(
            morte,
            `Voci di NOT_NULL_ATTESE che non corrispondono a nessuna tabella con \`scuola_id\` ` +
            `nella fotografia: o la tabella è stata rimossa, o le è stata tolta la colonna. ` +
            `Rimuovile — un elenco che sopravvive al suo oggetto smette di proteggere e nessuno ` +
            `se ne accorge. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('nessuna migrazione più recente della fotografia tocca il `NOT NULL` di `scuola_id`', () => {
        // Il gemello del guard qui sopra, per la finestra che la fotografia non vede.
        // La prova sull'elenco congelato legge la fotografia: una migrazione applicata
        // DOPO lo scatto le è invisibile, ed è esattamente la finestra in cui il difetto
        // del 2026-07-31 è vissuto dieci giorni.
        const soglia = sogliaFotografia(foto)
        const colpevoli = posterioriCheContengono(MIGRAZIONI, soglia, toccaIlNotNullDiSede)
        expect(
            colpevoli,
            `Queste migrazioni cambiano l'obbligatorietà di \`scuola_id\` e sono più recenti ` +
            `della fotografia, che quindi non la racconta più. Rigenerala e verifica che ` +
            `NOT_NULL_ATTESE dica ancora il vero. ${COME_RIGENERARE}`,
        ).toEqual([])
    })

    it('il guard sul `NOT NULL` riconosce davvero un ALTER COLUMN … SET NOT NULL (prova storica)', () => {
        // Un guard che non ha mai visto un colpevole non è un guard: è una riga di codice
        // che nessuno ha mai messo alla prova. Qui lo si prova sul caso VERO che gli è
        // sfuggito — le tre migrazioni del 2026-07-31 che il predicato precedente (solo
        // «NASCITA di una colonna scuola_id») lasciava passare.
        //
        // La finestra è CHIUSA per costruzione (31 luglio → 1 agosto): è storia, i file di
        // migrazione non si riscrivono, e una migrazione futura che tocchi il NOT NULL non
        // può entrarci — la sorveglia la prova qui sopra, che guarda in avanti.
        const storiche = posterioriCheContengono(MIGRAZIONI, '20260731000000', toccaIlNotNullDiSede)
            .filter((f) => f < '20260801')
        expect(
            storiche,
            `Il guard non riconosce più le migrazioni del 2026-07-31 che hanno reso ` +
            `obbligatoria \`scuola_id\`: il predicato è stato ristretto e adesso il difetto ` +
            `che questo lock esiste per vedere gli passerebbe di nuovo davanti.`,
        ).toEqual([
            '20260731114449_presenze_armadietto_scuola_id.sql',
            '20260731142105_oblio_sede_obbligatoria_retention_consensi.sql',
            '20260731192131_task_interni_scuola_obbligatoria.sql',
        ])
    })

    it('il guard riconosce le forme che Postgres accetta, non solo quella che siamo abituati a scrivere', () => {
        // Le tre righe qui sotto sono SQL VALIDO e sono tutte lo stesso indebolimento.
        // Alla prima versione del predicato (`alter column scuola_id …`) le ultime due
        // passavano davanti senza fermarsi: `COLUMN` è facoltativa nella grammatica di
        // `ALTER TABLE`, e un identificatore può essere fra virgolette. Nessuna delle
        // migrazioni di oggi le usa — ed è proprio per questo che nessuno le avrebbe viste.
        const varianti = [
            'ALTER TABLE public.presenze ALTER COLUMN scuola_id DROP NOT NULL;',
            'ALTER TABLE public.presenze ALTER scuola_id DROP NOT NULL;',
            'ALTER TABLE public.presenze ALTER COLUMN "scuola_id" SET NOT NULL;',
            'alter table public.presenze\n  alter  "scuola_id"\n  drop  not  null;',
        ]
        expect(
            varianti.filter((sql) => !toccaIlNotNullDiSede(sql)),
            `Queste forme cambiano l'obbligatorietà di \`scuola_id\` e il guard non le vede.`,
        ).toEqual([])

        // E il verso opposto: ciò che è solo COMMENTATO non conta, in tutte e due le
        // forme di commento di Postgres. Senza questo, il rollback documentato dentro
        // `20260731192131` renderebbe quel file rosso per sempre.
        const inerti = [
            '-- alter table public.task_interni alter column scuola_id drop not null;',
            '/* alter table public.task_interni alter "scuola_id" drop not null; */',
            'ALTER TABLE public.presenze ALTER COLUMN scuola_id SET DEFAULT NULL;',
            'ALTER TABLE public.presenze ALTER COLUMN classe_id DROP NOT NULL;',
        ]
        expect(
            inerti.filter((sql) => toccaIlNotNullDiSede(sql)),
            `Il guard si accende su righe che non cambiano l'obbligatorietà di \`scuola_id\`: ` +
            `un rosso che nessuna rigenerazione può togliere insegna a mettere \`.skip\`.`,
        ).toEqual([])
    })
})
