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
})
