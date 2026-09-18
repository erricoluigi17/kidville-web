import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * LOCK · UN JOB VIDEO NON PUÒ ESSERE CONCLUSO SENZA UNA DATA DI MORTE PER IL SUO
 * ORIGINALE.
 *
 * ─── IL DIFETTO, TROVATO DUE VOLTE ──────────────────────────────────────────
 *
 * `video_jobs_retention_originali_idx` è un indice PARZIALE
 * (`20260916190000_video_jobs.sql:291`):
 *
 *     WHERE original_deleted_at IS NULL AND original_delete_after IS NOT NULL
 *
 * Una riga con `original_delete_after` a NULL non è «in ritardo»: è **fuori
 * dall'indice**. Nessuna query che parta dalla scadenza la trova, nessun conteggio
 * la nomina, e il video di un bambino resta nel bucket privato `video_originals`
 * per sempre.
 *
 *  · **Prima volta**, 2026-09-16: `video_intent_supersede` spegneva i job della
 *    revisione superata senza dare loro una scadenza. Misurato su PGlite e scritto
 *    nel corpo della funzione: «0 righe su 1».
 *  · **Seconda volta**, 2026-09-18: gli upload abbandonati e le code incagliate —
 *    i due cammini in cui non chiama nessuno. Li chiude `video_retention_scadenze`.
 *
 * ─── PERCHÉ UN LOCK, E NON SOLO LE DUE CORREZIONI ───────────────────────────
 *
 * Perché la forma del difetto non è un errore di battitura: è che **la scadenza
 * dell'originale è una conseguenza della transizione di stato, e sta scritta in
 * otto posti diversi**. La nona RPC che qualcuno scriverà fra sei mesi non lo
 * saprà, e il gate sarà verde in entrambi i casi — con la scadenza e senza.
 *
 * La regola che questo file sorveglia è una sola, e si legge senza conoscere il
 * dominio: **ogni `UPDATE` di `video_jobs` che tocca `status` tocca anche
 * `original_delete_after`**, oppure sta nell'elenco qui sotto con la sua ragione.
 * Le eccezioni legittime ci sono e sono poche — le transizioni che NON concludono
 * niente (`awaiting_upload → queued`, `queued → processing`) — e dichiararle una
 * per una è ciò che distingue «lasciato fuori apposta» da «dimenticato».
 *
 * ⚠️ Il lock guarda il SET, non lo stato finale, ed è deliberato: `video_job_fail`
 * scrive `status = v_status`, dove `v_status` vale `'failed'` o `'rejected'`
 * secondo un parametro. Un rilevatore che cercasse i letterali `'failed'` e
 * `'cancelled'` non vedrebbe quella riga — cioè non vedrebbe proprio la RPC che
 * conclude più job di tutte.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

const FILE = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .sort()

/** Il testo senza commenti `--`: una regola citata in un commento non è codice. */
function senzaCommenti(sql: string): string {
    return sql
        .split('\n')
        .map((r) => r.replace(/--.*$/, ''))
        .join('\n')
}

const CONTENUTO = new Map(FILE.map((f) => [f, senzaCommenti(readFileSync(join(MIGRAZIONI, f), 'utf8'))]))

type Aggiornamento = { file: string; funzione: string; set: string }

/**
 * Tutti gli `UPDATE public.video_jobs` di un testo SQL, con la clausola `SET` e il
 * nome della funzione che li contiene.
 *
 * La clausola `SET` finisce al primo `FROM` o `WHERE` di parola intera: `CASE WHEN
 * … THEN … ELSE … END` dentro un SET non contiene nessuno dei due, e i due sono gli
 * unici modi in cui un `UPDATE` prosegue.
 */
export function aggiornamentiDiVideoJobs(file: string, sql: string): Aggiornamento[] {
    const trovati: Aggiornamento[] = []
    const inizio = /UPDATE\s+public\.video_jobs\b/gi
    let m: RegExpExecArray | null
    while ((m = inizio.exec(sql)) !== null) {
        const resto = sql.slice(m.index)
        const fine = /\b(FROM|WHERE)\b/i.exec(resto)
        const blocco = resto.slice(0, fine ? fine.index : resto.length)

        // La funzione che lo contiene: l'ultima dichiarata PRIMA di questo punto.
        const prima = sql.slice(0, m.index)
        const funzioni = [...prima.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.(\w+)/gi)]
        const funzione = funzioni.length > 0 ? funzioni[funzioni.length - 1][1] : '(fuori da una funzione)'

        trovati.push({ file, funzione, set: blocco })
    }
    return trovati
}

/** L'aggiornamento tocca lo stato del job? */
export function toccaLoStato(set: string): boolean {
    return /\bstatus\s*=/i.test(set)
}

/** L'aggiornamento dà all'originale una data di cancellazione? */
export function daLaScadenza(set: string): boolean {
    return /\boriginal_delete_after\s*=/i.test(set)
}

/**
 * Le transizioni che toccano lo stato e NON danno una scadenza, con la ragione.
 *
 * Non è una scappatoia: è l'elenco delle transizioni che **non concludono niente**.
 * Un job che passa da `awaiting_upload` a `queued` ha ancora davanti tutta la sua
 * vita, e dargli una data di distruzione dell'originale significherebbe
 * distruggere la sorgente del video prima di averlo convertito. La ragione va
 * scritta perché fra un anno «lo so io» non si rilegge.
 *
 * ⚠️ CHI AGGIUNGE UNA VOCE QUI SI FERMI E RILEGGA: se la transizione porta a
 * `failed`, `rejected` o `cancelled`, questa non è la lista giusta — è la scadenza
 * che manca.
 */
const SENZA_SCADENZA_GIUSTIFICATE: Record<string, string> = {
    video_job_uploaded:
        'awaiting_upload → queued. Non conclude niente: dichiara che i byte sono arrivati e che il job può essere convertito. L’originale serve ancora, ed è proprio adesso che serve di più — dargli una scadenza qui significherebbe mettere una data di distruzione sulla sorgente prima di averla letta.',
    video_job_claim:
        'queued → processing. Un worker ha preso in carico il job e sta leggendo l’originale in questo istante. La scadenza arriva a conclusione avvenuta, e ci pensano `video_job_ready` (verified_at + 7 giorni) o `video_job_fail` (now + 7 giorni).',
}

/**
 * ⚠️ `video_job_heartbeat` STAVA QUI, ed è stato tolto il 2026-09-18 dopo averlo
 * misurato: il suo `UPDATE` scrive `lease_expires_at` e `updated_at` e basta
 * (`20260916190100_video_job_transitions.sql:360-363`), quindi `toccaLoStato` non
 * lo segnala e l'esenzione non serviva. La ragione che portava scritta — «il SET
 * nomina `status`» — era **falsa**, e la prova di liveness della prima stesura non
 * poteva accorgersene: chiedeva soltanto che esistesse una funzione con quel nome
 * contenente un `UPDATE` di `video_jobs`, il che era vero.
 *
 * È la stessa forma di difetto che il lock sorveglia, applicata al lock stesso: una
 * dichiarazione che descrive un mondo che non c'è. La prova di liveness qui sotto è
 * stata stretta di conseguenza — un'esenzione è VIVA solo se sta davvero
 * sopprimendo un rilievo — e con quella regola questa voce risultava morta.
 */

describe('lock architettura · nessun job video si conclude senza una scadenza per l’originale', () => {
    const TUTTI = FILE.flatMap((f) => aggiornamentiDiVideoJobs(f, CONTENUTO.get(f) ?? ''))

    it('le fonti sono piene (se cade questa, tutto il resto è verde sul vuoto)', () => {
        expect(FILE.length, 'nessun file .sql sotto supabase/migrations').toBeGreaterThan(60)
        expect(
            TUTTI.length,
            'Lo scanner non trova nessun `UPDATE public.video_jobs`: o la convenzione dei nomi è ' +
                'cambiata, o le migrazioni video non si leggono più. In entrambi i casi questo file ' +
                'direbbe «verde» senza aver guardato niente.',
        ).toBeGreaterThanOrEqual(7)
        expect(
            TUTTI.filter((a) => toccaLoStato(a.set)).length,
            'Nessun aggiornamento tocca `status`: il rilevatore non riconosce più la forma che deve ' +
                'sorvegliare.',
        ).toBeGreaterThanOrEqual(6)
        expect(
            TUTTI.filter((a) => daLaScadenza(a.set)).length,
            'Nessun aggiornamento scrive `original_delete_after`: il rilevatore non riconosce più la ' +
                'forma che cerca, quindi segnalerebbe tutto o niente.',
        ).toBeGreaterThanOrEqual(4)
    })

    it('🔴 ogni UPDATE che tocca `status` dà anche la scadenza, o è dichiarato', () => {
        const scoperti = TUTTI.filter(
            (a) =>
                toccaLoStato(a.set) &&
                !daLaScadenza(a.set) &&
                SENZA_SCADENZA_GIUSTIFICATE[a.funzione] === undefined,
        ).map((a) => `${a.funzione}  ←  ${a.file}`)

        expect(
            [...new Set(scoperti)],
            scoperti.length === 0
                ? ''
                : `Questi aggiornamenti cambiano lo stato di un job video e NON danno all'originale ` +
                  `una data di cancellazione:\n  ${[...new Set(scoperti)].join('\n  ')}\n` +
                  `Se la transizione CONCLUDE il job (failed, rejected, cancelled), scrivi ` +
                  `\`original_delete_after\` nello stesso UPDATE: senza, la riga resta fuori ` +
                  `dall'indice parziale \`video_jobs_retention_originali_idx\` — che filtra ` +
                  `\`original_delete_after IS NOT NULL\` — e il video di un minore resta nel bucket ` +
                  `privato \`video_originals\` per sempre, invisibile a ogni conteggio. ` +
                  `Se invece la transizione NON conclude niente (verso queued o processing), ` +
                  `dichiarala in \`SENZA_SCADENZA_GIUSTIFICATE\` con la ragione: è successo due ` +
                  `volte in tre giorni, e le due volte il gate era verde.`,
        ).toEqual([])
    })

    it('le voci dichiarate sono VIVE e portano una ragione (un’esenzione morta è un buco dimenticato)', () => {
        // ⚠️ «VIVA» significa CHE STA SOPPRIMENDO UN RILIEVO, non che esiste una
        // funzione con quel nome. La differenza l'ha pagata questo stesso file il
        // giorno in cui è nato: `video_job_heartbeat` era dichiarato qui con una
        // ragione falsa, e la versione debole della prova lo accettava perché quella
        // funzione un `UPDATE` di `video_jobs` ce l'ha — solo che quell'UPDATE non
        // tocca `status`, quindi l'esenzione non serviva a niente. Un'allowlist con
        // dentro nomi che non servono è il posto in cui, un giorno, qualcuno aggiunge
        // il nome che serve eccome.
        const sopprimono = new Set(
            TUTTI.filter((a) => toccaLoStato(a.set) && !daLaScadenza(a.set)).map((a) => a.funzione),
        )
        for (const [funzione, ragione] of Object.entries(SENZA_SCADENZA_GIUSTIFICATE)) {
            expect(
                sopprimono.has(funzione),
                `\`${funzione}\` è dichiarata fra le transizioni senza scadenza, ma in ` +
                    `supabase/migrations/ non c'è nessun \`UPDATE public.video_jobs\` dentro una ` +
                    `funzione con quel nome che tocchi \`status\` SENZA dare la scadenza. Quindi ` +
                    `questa voce non sta esentando niente: o la funzione è stata rinominata, o ha ` +
                    `smesso di toccare lo stato, o la scadenza ora la scrive. Toglila — ` +
                    `un'esenzione che sopravvive al suo motivo è un buco che nessuno ricorda di ` +
                    `aver aperto.`,
            ).toBe(true)
            expect(
                ragione.length,
                `\`${funzione}\` è esente senza dire perché. Questa lista esiste per distinguere ` +
                    `«lasciato fuori apposta» da «dimenticato»: senza la ragione, sono la stessa cosa.`,
            ).toBeGreaterThan(80)
        }
    })

    it('l’indice su cui poggia tutta la regola è ancora PARZIALE nella forma che si suppone', () => {
        // Se qualcuno togliesse il `WHERE`, l'indice diventerebbe totale e una riga
        // senza scadenza smetterebbe di essere invisibile: la premessa di questo lock
        // cadrebbe, e il lock resterebbe verde a sorvegliare un problema che non c'è
        // più. Meglio accorgersene qui che continuare a chiedere una cosa inutile.
        const schema = CONTENUTO.get('20260916190000_video_jobs.sql') ?? ''
        const indice = /CREATE\s+INDEX[^;]*video_jobs_retention_originali_idx[^;]*;/i.exec(schema)?.[0] ?? ''
        expect(indice, 'l’indice `video_jobs_retention_originali_idx` non si trova più').not.toBe('')
        expect(
            /original_deleted_at\s+IS\s+NULL/i.test(indice) &&
                /original_delete_after\s+IS\s+NOT\s+NULL/i.test(indice),
            `La clausola dell'indice è cambiata:\n${indice}\nQuesto lock esiste perché ` +
                `\`original_delete_after IS NOT NULL\` rende INVISIBILE una riga con NULL. Se quella ` +
                `condizione non c'è più, la regola qui sorvegliata va ripensata, non tenuta per inerzia.`,
        ).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Un lock verde perché non trova violazioni e un lock verde perché non guarda più
// niente si somigliano moltissimo — dall'esterno sono identici. Queste prove
// tengono ferme le forme che il rilevatore DEVE vedere e quelle che NON deve
// segnalare, su testi scritti qui e non sul repo: sono l'unico modo di sapere che
// il verde di sopra è una misura e non un'omissione.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore vede ciò che deve vedere', () => {
    const CONCLUDE_SENZA_SCADENZA = `
CREATE OR REPLACE FUNCTION public.video_job_rottama()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_jobs
  SET status = 'cancelled',
      fence_epoch = fence_epoch + 1,
      updated_at = v_now
  WHERE id = p_job_id;
END $$;`

    const CONCLUDE_CON_SCADENZA = `
CREATE OR REPLACE FUNCTION public.video_job_rottama()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_jobs
  SET status = 'cancelled',
      original_delete_after = v_now,
      updated_at = v_now
  WHERE id = p_job_id;
END $$;`

    it('POSITIVO — un UPDATE che conclude senza scadenza viene riconosciuto come tale', () => {
        const [a] = aggiornamentiDiVideoJobs('finto.sql', CONCLUDE_SENZA_SCADENZA)
        expect(a.funzione).toBe('video_job_rottama')
        expect(toccaLoStato(a.set)).toBe(true)
        expect(daLaScadenza(a.set)).toBe(false)
    })

    it('NEGATIVO — lo stesso UPDATE con la scadenza NON viene segnalato', () => {
        const [a] = aggiornamentiDiVideoJobs('finto.sql', CONCLUDE_CON_SCADENZA)
        expect(toccaLoStato(a.set)).toBe(true)
        expect(daLaScadenza(a.set)).toBe(true)
    })

    it('la clausola SET finisce al FROM: un UPDATE con CTE non si porta dietro la WHERE', () => {
        // È la forma di `video_retention_scadenze`. Se il taglio fosse sbagliato, la
        // `WHERE … original_delete_after IS NULL` del candidato finirebbe dentro il
        // SET e `daLaScadenza` direbbe «sì» a un UPDATE che la scadenza non la scrive.
        const CON_CTE = `
CREATE OR REPLACE FUNCTION public.video_finta()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  WITH candidati AS (
    SELECT j.id FROM public.video_jobs AS j WHERE j.original_delete_after IS NULL
  )
  UPDATE public.video_jobs AS j
  SET status = 'failed'
  FROM candidati AS c
  WHERE j.id = c.id;
END $$;`
        const [a] = aggiornamentiDiVideoJobs('finto.sql', CON_CTE)
        expect(a.set).not.toMatch(/candidati/)
        expect(daLaScadenza(a.set)).toBe(false)
    })

    it('un nome citato in un COMMENTO non vale come codice', () => {
        const COMMENTATO = `
CREATE OR REPLACE FUNCTION public.video_finta()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- qui bisognerebbe scrivere original_delete_after = v_now, ma non lo facciamo
  UPDATE public.video_jobs SET status = 'failed' WHERE id = p_job_id;
END $$;`
        const [a] = aggiornamentiDiVideoJobs('finto.sql', senzaCommenti(COMMENTATO))
        expect(daLaScadenza(a.set)).toBe(false)
    })
})
