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
//
// RIAPERTA il 2026-10-02 dalla PR 2 dei video («server e web»): le tre migrazioni della PR
// entrano qui SE E SOLO SE una guardia le segnalerebbe (la prova gemella 5 boccia le voci che
// nessuna guardia vedrebbe). Il file A (T2a) crea un indice UNIQUE parziale e ricrea un CHECK
// con DROP/ADD CONSTRAINT, quindi due guardie su tre lo vedono. Le voci si tolgono nella PR-B
// (T16), insieme alla rigenerazione delle fotografie: la prova gemella 2 diventa rossa da sola.
// SVUOTATA il 03/10 (02/10 22:3x UTC): il file A, rinominato `20261002215600_…`, e' applicato in produzione
// e le fotografie sono rigenerate dalla produzione (202 migrazioni, 232 indici unici).
//
// RIAPERTA il 2026-10-05 (metodi di pagamento ammessi): la migrazione della PR aggiunge
// `pagamenti.metodi_ammessi` col suo CHECK, scritto con DROP/ADD CONSTRAINT perché sia
// rieseguibile — è quella forma che la guardia delle FK verso `utenti` vede, non una FK.
// Si toglie dopo il merge, insieme alla rigenerazione delle fotografie dalla produzione.
// SVUOTATA il 05/10 (PR-B dopo il merge di #186, `57c1d28e`): la migrazione è applicata in
// produzione dall'integrazione con la version del file (una riga sola nel registro) e le
// fotografie sono rigenerate dalla produzione.
//
// 2026-10-07 · PARTE 2 «servizi mensili»: `20261007170813_servizi_mensili.sql` (tabella
// `iscrizioni_servizi` con PRIMARY KEY, EXCLUDE e RLS senza policy; colonne nuove su
// `payment_categories`). SVUOTATA l'08/10 (PR-B dopo il merge di #205, `f836d94d`): applicata in
// produzione dall'integrazione, una riga sola nel registro; fotografie rigenerate dalla produzione.
//
// 2026-10-09 · FASE 4 «scatola nera»: `20261009171012_scatola_nera_registro_eliminazioni.sql`
// (schema `scatola_nera`, due tabelle con PRIMARY KEY e RLS senza policy, trigger su 42
// tabelle di `public`). SVUOTATA il 10/10 (PR-B dopo il merge di #210, `d0fb54af`): applicata
// in produzione dall'integrazione, una riga sola nel registro (209 migrazioni); fotografie
// rigenerate dalla produzione — cambia solo quella delle migrazioni, perché le altre cinque
// guardano `public` e la scatola sta nel suo schema.
//
// 2026-10-10 · FASE 6 «indici»: `20261010221643_indici_fk_initplan_doppioni.sql` (95 indici
// sulle FK, 15 policy riscritte con `(select auth.uid())` via ALTER POLICY, 2 indici doppi
// tolti). Tocca la fotografia della RLS (il testo delle 15 policy cambia, il significato no:
// lo prova `__tests__/lib/policy-initplan-equivalenti-sql.test.ts`). Si toglie con la PR-B,
// dopo che l'integrazione l'ha applicata al merge, rigenerando le fotografie dalla produzione.
// Con lei, nella stessa PR (#219, fasi 6·7·8 in un solo rilascio), la FASE 7 PR 2
// `20261010230042_freni_restrict_catene_legali.sql` (22 FK da CASCADE a RESTRICT, nessuna verso
// `utenti`). SVUOTATA l'11/10 (PR-B dopo il merge di #219, `291f7a41`): le quattro migrazioni delle
// fasi 6·7·8 sono applicate in produzione dall'integrazione, una riga ciascuna con la version del
// file (218 migrazioni); fotografie rigenerate dalla produzione — cambiano davvero solo quella
// delle migrazioni e quella della RLS (le 15 policy con `( SELECT auth.uid() AS uid)`); le altre
// quattro cambiano solo l'istante dello scatto, con la stessa sha256.
//
// 2026-10-12 · FASE 9 «chat sul broadcast privato» (S4-B):
// `20261012085225_chat_broadcast_privato.sql` crea la policy di SELECT su
// `realtime.messages` (più il trigger e la funzione su `public.chat_messages`), quindi la
// guardia della RLS la vede per la parola `policy`. Il contenuto della fotografia della RLS
// NON cambia — quella fotografia guarda `public`, e questa policy vive nello schema
// `realtime` — ma la guardia non lo sa e grida comunque, come deve.
// SVUOTATA il 12/10 (PR-B dopo il merge di #224, `685667e7`): applicata in produzione
// dall'integrazione, una riga sola nel registro (219 migrazioni); fotografie rigenerate dalla
// produzione — cambia davvero solo quella delle migrazioni; le altre cinque cambiano solo
// l'istante dello scatto, con la stessa sha256 (la policy nuova vive in `realtime`, non in `public`).
//
// 2026-10-19 · FASE 9b «pubblicazione Realtime potata» (S4-C):
// `20261019202225_realtime_pubblicazione_potata.sql` è un `ALTER PUBLICATION … DROP TABLE` su sei
// tabelle, e la guardia della RLS la vede per le parole `drop table`. Nessuna policy, nessuna
// tabella, nessuna colonna cambia: le fotografie della RLS e delle tabelle restano identiche, cambia
// solo quella delle migrazioni. Si toglie con la PR-B dopo il merge, rigenerando dalla produzione.
// SVUOTATA il 19/10 (PR-B dopo il merge di #247, `c14b3521`): applicata dall'integrazione, una riga
// sola nel registro (226 migrazioni), pubblicazione `supabase_realtime` a 0 tabelle; fotografie
// rigenerate dalla produzione — cambia davvero solo quella delle migrazioni, le altre sei solo
// l'istante dello scatto.
//
// 2026-10-19 · FASE 12 «storico delle modifiche» e «registri, permessi, vincoli», nella PR delle
// fasi 11-12. `20261019215733_scatola_nera_modifiche.sql` crea `scatola_nera.modifiche` (PRIMARY
// KEY, RLS senza policy) e un trigger AFTER UPDATE su 13 tabelle di `public`: le guardie degli
// indici unici e della RLS la vedono per `primary key` e `row level security`, ma la tabella vive
// nello schema `scatola_nera` e nessun indice o policy di `public` cambia.
// `20261019220315_registri_worm_permessi_vincoli_bucket.sql` aggiunge due CHECK su `pagamenti`
// con `ADD CONSTRAINT`, e la guardia delle FK verso `utenti` la vede per quelle parole: nessuna
// FK cambia. Cambierà davvero solo la fotografia delle migrazioni (e quella delle tabelle per i
// due CHECK, se li guarda). Si tolgono con la PR-B dopo il merge, rigenerando dalla produzione.
// SVUOTATA il 20/10 (PR-B dopo il merge di #250, `bff14d4e`): le tre migrazioni delle fasi 11-12
// sono applicate dall'integrazione, una riga ciascuna con la version del file (231 migrazioni);
// fotografie rigenerate dalla produzione — cambia davvero solo quella delle migrazioni. Le altre
// sette cambiano solo l'istante dello scatto: la fotografia delle tabelle non guarda i CHECK, e
// quella dei bucket guarda nome e visibilità, non i tipi ammessi.
//
// 2026-10 · ROBUSTEZZA 2, SESSIONE 1 «iscrizioni: documenti mai persi, stati vincolati»:
// `20261024235116_iscrizioni_stati_vincolati.sql` aggiunge due CHECK (`enrollment_submissions.status`,
// `alunni.stato`) con `ADD CONSTRAINT`, e la guardia delle FK verso `utenti` la vede per quelle
// parole: nessuna FK, nessuna policy, nessun indice unico cambia. Si toglie con la PR-B, cioè il
// primo commit della sessione che apre dopo il rilascio, rigenerando le fotografie dalla produzione.
// SVUOTATA il 25/10/2026 (PR-B, primo commit della sessione dopo il merge di #266, `cdcb5347`):
// applicata dall'integrazione, una riga sola nel registro; fotografie delle migrazioni e delle FK verso
// `utenti` rigenerate dalla produzione — cambia davvero solo quella delle migrazioni.
//
// Sessione 6 della seconda serie (2026-10-25): la migrazione degli esiti dei cron crea due tabelle con
// PRIMARY KEY e RLS accesa. La applica l'integrazione al merge; la voce la toglie la sessione dopo,
// nella chiusura della precedente (piano della sessione 6, «Per la sessione dopo»).
// SVUOTATA il 25/10/2026 (chiusura nel primo commit della sessione seguente, dopo il merge di #267,
// `89150a39`): applicata dall'integrazione, una riga nel registro; fotografie rigenerate dalla
// produzione — migrazioni, indici unici (due PRIMARY KEY nuove) e policy (due tabelle con RLS).
//
// 2026-10-25 · SESSIONE 8 della seconda serie «cron e igiene»: `20261025161733_promemoria_e_sync_senza_doppioni.sql`
// aggiunge `notifiche.chiave_dedup` con l'indice UNICO `notifiche_chiave_dedup_key` (arbitro
// dell'upsert dei promemoria) e crea `cron_prese` (PRIMARY KEY, RLS senza policy, solo
// service_role). Le guardie degli indici unici e della RLS la vedono per `unique`, `primary key` e
// `row level security`. Cambieranno davvero la fotografia degli indici unici (`notifiche_chiave_dedup_key`
// e la chiave primaria di `cron_prese`), quella della RLS (`cron_prese` entra in `tabelle_rls_attiva`;
// nessuna policy nuova) e quella delle migrazioni. Si toglie nella chiusura della precedente fatta
// dalla sessione che apre dopo (sezione «Per la sessione dopo» del piano della sessione 8), dopo
// aver rigenerato quelle tre fotografie dalla produzione.
export const MIGRAZIONI_ATTESE_AL_MERGE: Readonly<Record<string, string>> = {
  '20261025161733_promemoria_e_sync_senza_doppioni.sql':
    'Sessione 8 della seconda serie: indice unico su notifiche.chiave_dedup e tabella cron_prese. ' +
    'La applica l’integrazione Supabase al merge; la voce si toglie nella chiusura della precedente ' +
    '(la PR-B) fatta dalla sessione che apre dopo, rigenerando dalla produzione le fotografie delle ' +
    'migrazioni, degli indici unici e della RLS.',
}

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
