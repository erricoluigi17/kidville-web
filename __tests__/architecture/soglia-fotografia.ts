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
 */
export function toccaLaRls(sql: string): boolean {
    return (
        /\bpolicy\b/i.test(sql) ||
        /\brow\s+level\s+security\b/i.test(sql) ||
        /\bdrop\s+table\b/i.test(sql) ||
        /\badd\s+column\s+(if\s+not\s+exists\s+)?scuola_id\b/i.test(sql) ||
        /^\s*scuola_id\s+uuid\b/im.test(sql)
    )
}
