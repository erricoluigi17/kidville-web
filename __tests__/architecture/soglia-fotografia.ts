/**
 * LA SOGLIA DI UNA FOTOGRAFIA — quali migrazioni sono POSTERIORI allo scatto.
 *
 * Tre lock girano su una fotografia versionata di produzione (`fk-scuola-id`,
 * `rls-per-sede`, `migrazioni-complete`). Una fotografia è cieca a ciò che succede
 * DOPO lo scatto, quindi ognuno di loro guarda anche le migrazioni più recenti della
 * fotografia. La domanda «più recente di quando?» ha una sola risposta giusta, e fino
 * al 2026-08-04 tutti e tre la davano sbagliata nello stesso modo.
 *
 * ─── IL DIFETTO, MISURATO ─────────────────────────────────────────────────────
 *
 * `fk-scuola-id.test.ts` e `rls-per-sede.test.ts` confrontavano
 *     f.slice(0, 8) > foto.generato_il.replace(/-/g, '')
 * cioè la sola DATA. Il nome di un file di migrazione porta invece quattordici cifre,
 * `YYYYMMDDHHMMSS`: buttarne via sei significa che **una migrazione applicata lo
 * stesso giorno della fotografia non è mai posteriore**. E lo stesso giorno è proprio
 * quando succede: si applica una migrazione e si rigenera la fotografia nella stessa
 * sessione. Il 2026-08-01 la fotografia della RLS è stata scattata mentre quel giorno
 * portava già `20260801081633_policy_orario_per_sede` e altre sette migrazioni: se una
 * di quelle fosse arrivata DOPO lo scatto, il guard sarebbe rimasto muto.
 *
 * Il guard che nasce per coprire l'unico punto cieco della fotografia aveva quindi lo
 * stesso punto cieco della fotografia. Verde per costruzione nella finestra in cui
 * serviva.
 *
 * ─── LA CORREZIONE ────────────────────────────────────────────────────────────
 *
 * I generatori scrivono ora `generato_alle`: l'ISTANTE dello scatto, in UTC, con i
 * secondi. La soglia diventa quel timestamp ridotto alle stesse quattordici cifre di
 * una `version`, e il confronto è fra stringhe omogenee.
 *
 * **Perché UTC e non l'ora locale**: la `version` che `apply_migration` assegna è UTC
 * (misurato il 2026-08-04: applicata alle 12:30 di Roma, `version` `20260804103025`).
 * Una soglia in ora locale sarebbe due ore avanti in estate, cioè cieca a due ore di
 * migrazioni — lo stesso difetto, più piccolo e più difficile da vedere.
 *
 * **Il ripiego, quando `generato_alle` non c'è** (fotografia vecchia, non ancora
 * rigenerata): mezzanotte UTC di `generato_il`. È la scelta PRUDENTE — tutte le
 * migrazioni di quel giorno risultano posteriori, quindi il lock può gridare al lupo
 * ma non può tacere. Il verso dell'errore, in un lock, non è un dettaglio: un falso
 * allarme si chiude rigenerando la fotografia, un silenzio non si chiude mai.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Le quattordici cifre di una `version`: `YYYYMMDDHHMMSS`. */
export type Soglia = string

export type MetadatiFotografia = {
    generato_il: string
    generato_alle?: string | null
}

/**
 * L'istante dello scatto, nella stessa forma di una `version` (14 cifre, UTC).
 * Con `generato_alle` è preciso al secondo; senza, ripiega sulla mezzanotte del
 * giorno — cioè sulla soglia più BASSA compatibile con `generato_il`, che è quella
 * che fa considerare posteriori più migrazioni, non meno.
 */
export function sogliaFotografia(foto: MetadatiFotografia): Soglia {
    const istante = foto.generato_alle
    if (typeof istante === 'string' && istante.length > 0) {
        const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(istante)
        if (m) return m.slice(1, 7).join('')
        throw new Error(
            `\`generato_alle\` non è un istante ISO-8601 riconoscibile: «${istante}». ` +
            `Rigenera la fotografia con il suo generatore invece di scriverla a mano.`,
        )
    }
    const g = /^(\d{4})-(\d{2})-(\d{2})/.exec(foto.generato_il ?? '')
    if (!g) {
        throw new Error(
            `\`generato_il\` non è una data ISO (YYYY-MM-DD): «${foto.generato_il}». ` +
            `Senza data non si sa a che cosa la fotografia si riferisca.`,
        )
    }
    return g.slice(1, 4).join('') + '000000'
}

/** `20260704120000_baseline.sql` → `20260704120000`; qualunque altra forma → `null`. */
export function versioneDelFile(file: string): string | null {
    const m = /^(\d{14})_.+\.sql$/.exec(file)
    return m ? m[1] : null
}

/**
 * I file di migrazione POSTERIORI (o contemporanei) alla fotografia, in ordine.
 *
 * Il confronto è `>=` di proposito: una migrazione applicata nello stesso secondo
 * dello scatto può esserci finita dentro oppure no, e fra «la segnalo per niente» e
 * «la ignoro proprio quando conta» il lock sceglie la prima.
 *
 * I file fuori forma non entrano: li sorveglia `migrazioni-complete.test.ts`, che li
 * nomina uno per uno. Contarli anche qui direbbe la stessa cosa due volte, con due
 * messaggi diversi.
 */
export function migrazioniPosteriori(cartella: string, soglia: Soglia): string[] {
    return readdirSync(cartella)
        .filter((f) => f.endsWith('.sql'))
        .filter((f) => {
            const v = versioneDelFile(f)
            return v !== null && v >= soglia
        })
        .sort()
}

/** Le posteriori il cui SQL soddisfa `riconosci`. Legge il file una sola volta. */
export function posterioriCheContengono(
    cartella: string,
    soglia: Soglia,
    riconosci: (sql: string) => boolean,
): string[] {
    return migrazioniPosteriori(cartella, soglia).filter((f) =>
        riconosci(readFileSync(join(cartella, f), 'utf8')),
    )
}

/**
 * LE MIGRAZIONI SCRITTE E ATTESE AL MERGE — la sola via d'uscita dalle tre guardie di
 * freschezza (`rls-per-sede`, `onconflict-arbitro`, `tracce-docente-dichiarate`), e si
 * dichiara QUI, file per file, con la ragione accanto.
 *
 * ─── PERCHÉ ESISTE (2026-09-23, coda fatture, contratto S21) ─────────────────
 *
 * Le tre guardie gridano su ogni migrazione posteriore alla fotografia che tocca ciò che
 * la fotografia contiene, e la loro unica cura è RIGENERARE la fotografia dalla
 * produzione. Ma una migrazione dentro una PR non è in produzione: la applica
 * l'integrazione Supabase AL MERGE, mai a mano. Fino a quel momento nessuna
 * rigenerazione la può contenere — il database non la conosce ancora — e il rosso non
 * si può spegnere se non applicandola a mano prima del merge, cioè facendo proprio ciò
 * che la regola del repo vieta. Un lock che si fa tornare verde solo violando una regola
 * insegna a violarla, oppure a mettere `.skip`.
 *
 * La dichiarazione non spegne niente in silenzio, perché è TENUTA DA PROVE GEMELLE
 * (`soglia-fotografia.test.ts`) che la fanno diventare rossa da sola:
 *  1. ogni chiave è un file che esiste davvero in `supabase/migrations/`;
 *  2. nessuna chiave è già fra le `version` della fotografia delle migrazioni: il giorno
 *     in cui la PR-B rigenera le fotografie dalla produzione la migrazione c'è, la prova
 *     diventa rossa e IMPONE di svuotare questo elenco — la voce non può sopravvivere
 *     al suo motivo;
 *  3. ogni chiave è posteriore a TUTTE e tre le fotografie che le guardie leggono: se
 *     una fotografia viene rigenerata dopo, il file si rinomina con l'istante vero (mai
 *     con un istante futuro), non si lascia la dichiarazione a coprire uno scatto che
 *     la migrazione non l'ha mai vista;
 *  4. la ragione è scritta per esteso e nomina l'integrazione e la PR-B;
 *  5. nessuna voce morta: ogni chiave è riconosciuta da almeno una delle tre guardie
 *     (un file che nessuna guardia segnala non ha bisogno di essere dichiarato, e una
 *     dichiarazione inutile è un'esenzione che aspetta il prossimo file con quel nome);
 *  6. un controllo positivo su una cartella sintetica: la sottrazione toglie ESATTAMENTE
 *     i file dichiarati, e lascia gridare ogni altro file posteriore.
 *
 * Chiave: il nome del file, esatto. Il riconoscimento resta quello delle guardie: la
 * dichiarazione toglie il file dall'elenco, non allarga nessun riconoscitore.
 */
//
// VUOTA dal 2026-09-23 (PR-B della coda fatture): `20260923102831_fatture_coda_nucleo.sql`,
// l'unica voce mai scritta qui, è stata applicata dall'integrazione al merge della PR-A e le
// fotografie (migrazioni, policy, indici unici, FK e tabelle con `scuola_id`) sono state
// rigenerate dalla produzione — la prova gemella 2 l'aveva resa rossa, come previsto. Vuota
// è lo stato normale: la prossima voce entra con la prossima migrazione scritta in una PR.
//
// VUOTA di nuovo dal 2026-09-25 (PR-B dei sei interventi, dopo il merge di #166):
// `20260924220000_primaria_modifica_elimina.sql` è stata applicata dall'integrazione al merge,
// le fotografie sono state rigenerate dalla produzione (192 migrazioni, 58 FK verso `utenti`)
// e le due FK nuove (`allegati_registro.eliminato_da`, `student_documents.eliminato_da`) sono
// censite in TRACCE_DOCENTE.
//
// VUOTA di nuovo dal 2026-09-26 (PR-B dopo il merge di #171, `be44d743`):
// `20260926100000_presenze_assenza_oraria_giustificata.sql` è stata applicata dall'integrazione
// al merge, e le sette fotografie sono state rigenerate dalla produzione (196 migrazioni,
// 58 FK verso `utenti` — invariate, 231 indici unici, 78 tabelle con `scuola_id`, fra cui
// `gallery_photo_uploads` della #170, entrata nella fotografia solo ora).
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {}

/**
 * Le posteriori che una guardia deve segnalare: quelle che `riconosci` vede, MENO i file
 * dichiarati in `attese` (per nome esatto). Il quarto parametro esiste per il controllo
 * positivo su una cartella sintetica; le guardie usano sempre la costante.
 */
export function posterioriDaRigenerare(
    cartella: string,
    soglia: Soglia,
    riconosci: (sql: string) => boolean,
    attese: Readonly<Record<string, string>> = MIGRAZIONI_ATTESE_AL_MERGE,
): string[] {
    return posterioriCheContengono(cartella, soglia, riconosci).filter(
        (f) => !Object.prototype.hasOwnProperty.call(attese, f),
    )
}

/**
 * Questa migrazione può cambiare ciò che la fotografia degli INDICI UNICI contiene?
 *
 * È il riconoscitore di `onconflict-arbitro.test.ts`, spostato qui (2026-09-23) con lo
 * stesso testo perché ora serve anche alla prova gemella «nessuna voce morta» di
 * `MIGRAZIONI_ATTESE_AL_MERGE`. Si guarda lo SQL, non la prosa: una migrazione che nel
 * commento dichiara di NON toccare un vincolo lo nomina comunque, e un guard che misura
 * la spiegazione paga chi commenta di meno. Il riconoscimento è LARGO di proposito —
 * anche una PRIMARY KEY entra nella fotografia — e un falso allarme costa una
 * rigenerazione, che è l'unico momento in cui qualcuno guarda davvero se repo e database
 * dicono la stessa cosa.
 */
export function toccaUnUnico(sql: string): boolean {
    const istruzioni = senzaCommenti(sql)
    return /\bunique\b/i.test(istruzioni) || /\bprimary\s+key\b/i.test(istruzioni)
}

/**
 * Questa migrazione può cambiare ciò che la fotografia delle FK verso `utenti` contiene?
 *
 * È il riconoscitore di `tracce-docente-dichiarate.test.ts`, spostato qui (2026-09-23)
 * con lo stesso testo, per la stessa ragione di `toccaUnUnico`. Si cercano le due forme
 * che possono cambiare una FK — un `references utenti` e un `add`/`drop constraint` —
 * non la parola «on delete»: il 2026-09-20 quel filtro più largo ha sparato su una frase
 * scritta in un commento DENTRO un corpo `$$`, dove `senzaCommenti` giustamente non
 * tocca niente. `add constraint` / `drop constraint` restano perché cambiare la
 * `ON DELETE` di una chiave esistente si fa SOLO così.
 */
export function toccaLeFkUtenti(sql: string): boolean {
    const s = senzaCommenti(sql)
    return /references\s+(public\.)?utenti\b/i.test(s) || /\b(add|drop)\s+constraint\b/i.test(s)
}

/**
 * Questa migrazione può cambiare ciò che la fotografia della RLS contiene?
 *
 * ─── IL SECONDO PUNTO CIECO (2026-08-04) ──────────────────────────────────────
 *
 * Il filtro era `/\b(CREATE|DROP|ALTER)\s+POLICY\b/i`, e ha due buchi che si aprono
 * proprio sulle migrazioni nuove:
 *
 *  1. **una tabella nuova che nasce già protetta.** `pg-policies-snapshot.json` non
 *     contiene solo le policy: contiene anche `tabelle_con_scuola_id` e
 *     `tabelle_rls_attiva`. Un `CREATE TABLE … scuola_id uuid` seguito da
 *     `ALTER TABLE … ENABLE ROW LEVEL SECURITY` cambia entrambe quelle liste senza
 *     scrivere mai `CREATE POLICY` in quella forma — e il lock, che sulle tabelle con
 *     `scuola_id` è più severo, non se ne accorgeva.
 *  2. **una policy creata in SQL dinamico.** `EXECUTE format('create policy %I …')`
 *     dentro un `DO $$` è la forma che si usa per rendere una migrazione idempotente
 *     su un database (quello E2E della CI) che non è allineato alla produzione.
 *     Contiene la parola `policy` ma non sempre nella sequenza `CREATE POLICY`.
 *
 * Quindi si riconosce **la parola `policy`** in qualunque contesto, più tutto ciò che
 * accende, spegne o forza la RLS, più un `DROP TABLE` (che porta via con sé le sue
 * policy), più la NASCITA di una colonna `scuola_id`.
 *
 * ─── DOV'È IL CONFINE, E PERCHÉ STA LÌ ────────────────────────────────────────
 *
 * `scuola_id` si riconosce solo quando la colonna viene **definita** (`ADD COLUMN`, o
 * una dichiarazione di tipo dentro un `CREATE TABLE`), mai quando è soltanto nominata
 * in una `WHERE`, in una FK o in un indice. La tentazione era cercare `scuola_id` e
 * basta — ma quella colonna compare in quasi tutte le migrazioni di questo repo, e un
 * guard che diventa rosso per ogni file renderebbe rosso anche il caso in cui il rosso
 * non si può togliere: una migrazione SCRITTA e non ancora applicata non può entrare
 * in una fotografia della produzione, quindi rigenerare non la spegnerebbe. Un lock
 * che non si può far tornare verde se non applicando una migrazione è un lock che
 * insegna a mettere `.skip`.
 *
 * Nel dubbio, largo: un falso positivo costa una rigenerazione della fotografia — che
 * è l'unico momento in cui qualcuno guarda davvero se repo e database dicono la stessa
 * cosa. Un falso negativo costa un lock verde su uno stato che non esiste più.
 *
 * ─── IL TERZO PUNTO CIECO (2026-08-12): SI GUARDA LO SQL, NON LA PROSA ────────
 *
 * «Nel dubbio, largo» vale sulle ISTRUZIONI, non sui commenti. Il 12/08/2026 tre
 * migrazioni scritte lo stesso giorno sono risultate tutte «migrazioni che toccano le
 * policy» per una riga sola, e in tutti e tre i casi era la riga in cui il file
 * dichiarava di **non** toccarle: «NON accende RLS su niente … senza policy». Il guard
 * misurava la spiegazione invece del prodotto, e l'unico modo di spegnerlo era
 * cancellare la spiegazione — cioè un lock che paga chi commenta di meno.
 *
 * Perciò il riconoscimento gira su `senzaCommenti(sql)`. Non è un allargamento del
 * confine: un commento non arriva a Postgres, quindi non può cambiare `pg_policies`.
 * E non apre falsi negativi, perché una policy vera vive comunque in un'istruzione o
 * in una stringa eseguita (`EXECUTE format('create policy …')`) — e le stringhe non si
 * toccano.
 */
export function toccaLaRls(sql: string): boolean {
    const istruzioni = senzaCommenti(sql)
    return (
        /\bpolicy\b/i.test(istruzioni) ||
        /\brow\s+level\s+security\b/i.test(istruzioni) ||
        /\bdrop\s+table\b/i.test(istruzioni) ||
        /\badd\s+column\s+(if\s+not\s+exists\s+)?scuola_id\b/i.test(istruzioni) ||
        /^\s*scuola_id\s+uuid\b/im.test(istruzioni)
    )
}

/**
 * Lo stesso SQL senza i commenti `--` e `/* … *\/`, e con le STRINGHE intatte.
 *
 * Le stringhe restano perché sono codice: `EXECUTE format('create policy %I …')` è il
 * modo in cui in questo repo si scrive una policy idempotente, ed è uno dei due punti
 * ciechi chiusi il 2026-08-04. Togliere anche quelle riaprirebbe il buco che il guard
 * esiste per coprire.
 *
 * Si riconoscono tre contesti, perché tre sono quelli in cui un `--` NON apre un
 * commento: dentro `'…'` (dove `''` è un apice, non la fine), dentro un corpo
 * `$tag$ … $tag$`, e dentro un blocco `/* … *\/` già aperto.
 *
 * Un commento a blocco ANNIDATO (Postgres li ammette) si chiude qui alla prima `*\/`
 * invece che all'ultima: si toglie meno del dovuto, cioè si resta dal lato che fa
 * scattare il guard. È la direzione giusta in cui sbagliare.
 *
 * ── PERCHÉ È `export` (2026-08-25) ──────────────────────────────────────────
 *
 * La usa anche `__tests__/lib/insegnanti-template.test.ts`, che dal 2026-08-25 ha
 * la sua guardia di freschezza sulla fotografia di `candidature_insegnanti`. Il
 * riconoscimento di quel lock deve girare sulle ISTRUZIONI per la stessa ragione
 * scritta qui sopra: una migrazione che nel commento dichiara di NON toccare quella
 * tabella la nomina comunque, e un guard che misura la prosa si spegne cancellando
 * la prosa. Riscrivere lì un secondo parser SQL avrebbe significato avere due
 * parser che invecchiano separatamente.
 */
export function senzaCommenti(sql: string): string {
    let fuori = ''
    let i = 0
    let dentro: 'sql' | 'apice' | 'dollaro' = 'sql'
    let tag = ''

    while (i < sql.length) {
        if (dentro === 'apice') {
            if (sql[i] === "'") dentro = 'sql'
            fuori += sql[i++]
            continue
        }
        if (dentro === 'dollaro') {
            if (sql.startsWith(tag, i)) {
                dentro = 'sql'
                fuori += tag
                i += tag.length
                continue
            }
            fuori += sql[i++]
            continue
        }

        const due = sql.slice(i, i + 2)
        if (due === '--') {
            // Si salta fino all'a capo ESCLUSO: la riga successiva deve restare una
            // riga a sé, o `/^\s*scuola_id\s+uuid/m` perderebbe la sua àncora.
            const fine = sql.indexOf('\n', i)
            i = fine < 0 ? sql.length : fine
            continue
        }
        if (due === '/*') {
            const fine = sql.indexOf('*/', i + 2)
            i = fine < 0 ? sql.length : fine + 2
            // Uno spazio al posto del blocco: senza, `alter/* x */table` diventerebbe
            // `altertable` e una parola vera sparirebbe dal riconoscimento.
            fuori += ' '
            continue
        }
        if (sql[i] === "'") {
            dentro = 'apice'
            fuori += sql[i++]
            continue
        }
        const dollaro = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
        if (dollaro) {
            dentro = 'dollaro'
            tag = dollaro[0]
            fuori += tag
            i += tag.length
            continue
        }
        fuori += sql[i++]
    }
    return fuori
}
