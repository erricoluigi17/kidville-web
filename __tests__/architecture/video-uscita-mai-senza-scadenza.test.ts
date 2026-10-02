import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { versioneDelFile } from './soglia-fotografia'

/**
 * LOCK · L'USCITA DI UN VIDEO NON PUÒ RESTARE SENZA UNA DATA DI MORTE.
 *
 * ─── IL DIFETTO, E PERCHÉ È IL GEMELLO DI `video-originale-mai-senza-scadenza` ──────────
 *
 * Quel lock protegge l'ORIGINALE: `video_jobs_retention_originali_idx` è parziale
 * (`original_delete_after IS NOT NULL`), e una riga senza scadenza è fuori dall'indice —
 * il video di un bambino resta per sempre nel bucket privato. Lo stesso identico schema vale
 * per l'USCITA, il file convertito che sta in `video_processing`: dal 2026-10-02 la colonna
 * `output_delete_after` e il suo indice parziale
 * (`WHERE output_deleted_at IS NULL AND output_delete_after IS NOT NULL`) sono l'unico modo
 * in cui la conservazione sa che un'uscita va tolta.
 *
 * Misurato il 01/10, prima che la colonna esistesse: `video_processing` aveva 87 oggetti e
 * 2.571 MiB, di cui 39 uscite di video GIÀ pubblicati (copie doppie), 26 orfani, 11 di job
 * annullati e 11 `ready` mai pubblicati. Nessuno di loro aveva un termine, perché lo schema
 * non sapeva esprimerlo. Era la forma esatta del difetto dell'originale, in un bucket
 * accanto.
 *
 * ─── LA REGOLA, che si legge senza conoscere il dominio ─────────────────────────────────
 *
 *  1. **ogni `UPDATE public.video_jobs` che tocca `status` tocca anche `output_delete_after`**
 *     nello stesso `SET` — oppure la funzione che lo contiene sta in
 *     `SENZA_USCITA_GIUSTIFICATE`, con la ragione. Il lock guarda il SET e non lo stato
 *     finale, come il suo gemello: `video_job_ready` scrive `status = 'ready'` e la scadenza
 *     dentro un `CASE` (per una News l'uscita vive sette giorni dalla verifica, per una
 *     Galleria no), e un rilevatore che cercasse i letterali non la vedrebbe;
 *  2. **ogni funzione che PUBBLICA un intento** — chiama `video_intent_finalize` oppure scrive
 *     `status = 'published'` su `video_intents` — scrive la scadenza dell'uscita dei suoi job
 *     in un `UPDATE public.video_jobs`: a pubblicazione fatta la copia in galleria esiste e
 *     l'uscita in `video_processing` non serve più. Oppure è dichiarata.
 *
 * ─── IL PERIMETRO, E PERCHÉ NON È «DAL FILE A IN POI» ────────────────────────────
 *
 * Il file A è nato col nome provvisorio `20261002150000_…` ed è stato RINOMINATO (T16) con l'istante
 * dell'applicazione, `20261002215600_…`: un nome che può cambiare, e in un altro rilascio essere ANTERIORE a quello provvisorio. Un perimetro
 * espresso con quella data lascerebbe fuori, in silenzio, proprio il file che il lock esiste
 * per guardare — e un lock che scandisce zero file è verde. Il perimetro parte quindi dalla
 * ULTIMA migrazione della PR 1 (`20261002065952`, già in produzione, esclusa): tutto ciò che
 * viene dopo — le tre migrazioni della PR 2 e quelle che seguiranno — ricade nella regola.
 * Le funzioni vecchie (`video_job_fail`, `video_job_cancel`, `video_intent_revoke`, …) non
 * sono nel perimetro: la rete che copre le loro uscite è `video_retention_scadenze`, che il
 * file C (T2c) ha esteso, e che ha la sua prova dedicata (`reteDelleUsciteDi`) e le sue
 * esenzioni dichiarate (`SENZA_USCITA_GIUSTIFICATE`).
 *
 * ⚠️ Il lock legge SQL SENZA commenti, anche dentro i corpi `$$ … $$` (dove un `--` è un
 * commento vero): una regola citata in un commento non è codice, e un lock può immunizzarsi
 * da solo perché la stringa che cerca compare nel commento che la spiega.
 */

const MIGRAZIONI = join(process.cwd(), 'supabase', 'migrations')

/** L'ultima migrazione della PR 1, GIÀ IN PRODUZIONE. Il perimetro comincia subito dopo. */
const ULTIMA_DELLA_PR_1 = '20261002065952'

const FILE_NEL_PERIMETRO = readdirSync(MIGRAZIONI)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
        const v = versioneDelFile(f)
        return v !== null && v > ULTIMA_DELLA_PR_1
    })
    .sort()

// ─────────────────────────────────────────────────────────────────────────────
// L'ANALISI DELL'SQL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il testo senza i commenti `--` e `/* … *\/`, con le stringhe `'…'` intatte e i corpi `$$ … $$`
 * trattati come CODICE (il loro `--` è un commento di plpgsql, e va tolto).
 *
 * Un apice dentro un commento non apre una stringa: i commenti si saltano PRIMA di guardare gli
 * apici, ed è per questo che i commenti italiani (`l'uscita`, `un'altra`) non rompono niente.
 */
export function senzaCommentiSql(sql: string): string {
    let fuori = ''
    let i = 0
    let inStringa = false
    while (i < sql.length) {
        const c = sql[i]
        if (inStringa) {
            fuori += c
            if (c === "'") {
                if (sql[i + 1] === "'") {
                    fuori += "'"
                    i += 2
                    continue
                }
                inStringa = false
            }
            i += 1
            continue
        }
        if (c === '-' && sql[i + 1] === '-') {
            const fine = sql.indexOf('\n', i)
            i = fine < 0 ? sql.length : fine
            continue
        }
        if (c === '/' && sql[i + 1] === '*') {
            const fine = sql.indexOf('*/', i + 2)
            i = fine < 0 ? sql.length : fine + 2
            fuori += ' '
            continue
        }
        if (c === "'") inStringa = true
        fuori += c
        i += 1
    }
    return fuori
}

type Funzione = { nome: string; inizio: number; fine: number }

/** Le funzioni dichiarate in un testo, col tratto `AS $tag$ … $tag$` del loro corpo. */
export function funzioniDi(sql: string): Funzione[] {
    const trovate: Funzione[] = []
    const intestazione = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi
    let m: RegExpExecArray | null
    while ((m = intestazione.exec(sql)) !== null) {
        const resto = sql.slice(m.index)
        const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(resto)
        if (!as) continue
        const inizio = m.index + as.index + as[0].length
        const fine = sql.indexOf(as[1], inizio)
        if (fine < 0) continue
        trovate.push({ nome: m[1], inizio, fine })
    }
    return trovate
}

/** Dall'apertura di un `SET` al primo `FROM`, `WHERE`, `RETURNING` o `;` FUORI da parentesi e stringhe. */
function clausolaSet(sql: string, dopoSet: number): string {
    let profondita = 0
    let inStringa = false
    for (let i = dopoSet; i < sql.length; i++) {
        const c = sql[i]
        if (inStringa) {
            if (c === "'") inStringa = false
            continue
        }
        if (c === "'") {
            inStringa = true
            continue
        }
        if (c === '(') profondita += 1
        else if (c === ')') profondita -= 1
        else if (profondita === 0) {
            if (c === ';') return sql.slice(dopoSet, i)
            if (/[A-Za-z]/.test(c) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? ' ')) {
                if (/^(FROM|WHERE|RETURNING)\b/i.test(sql.slice(i, i + 10))) return sql.slice(dopoSet, i)
            }
        }
    }
    return sql.slice(dopoSet)
}

type Aggiornamento = { tabella: 'video_jobs' | 'video_intents'; funzione: string; set: string }

/** Ogni `UPDATE public.video_jobs|video_intents` del testo (già senza commenti), con la sua funzione e il suo SET. */
export function aggiornamentiDi(sql: string): Aggiornamento[] {
    const funzioni = funzioniDi(sql)
    const trovati: Aggiornamento[] = []
    const inizio = /UPDATE\s+public\.(video_jobs|video_intents)\b/gi
    let m: RegExpExecArray | null
    while ((m = inizio.exec(sql)) !== null) {
        const posSet = /\bSET\b/i.exec(sql.slice(m.index))
        if (!posSet) continue
        const dopoSet = m.index + posSet.index + posSet[0].length
        const funzione = funzioni.find((f) => m!.index >= f.inizio && m!.index < f.fine)
        trovati.push({
            tabella: m[1].toLowerCase() as Aggiornamento['tabella'],
            funzione: funzione ? funzione.nome : '(fuori da una funzione)',
            set: clausolaSet(sql, dopoSet),
        })
    }
    return trovati
}

/** Il SET tocca lo stato? */
export const toccaLoStato = (set: string): boolean => /\bstatus\s*=/i.test(set)

/** Il SET assegna la scadenza dell'USCITA? (`output_delete_after = …`, mai `original_…`) */
export const daLaScadenzaDellUscita = (set: string): boolean => /\boutput_delete_after\s*=/i.test(set)

/** Il SET porta un intento a `published`? */
export const pubblicaUnIntento = (set: string): boolean => /\bstatus\s*=\s*'published'/i.test(set)

/** Le funzioni del testo che CHIAMANO `video_intent_finalize`. */
export function chiamanoFinalize(sql: string): string[] {
    return funzioniDi(sql)
        .filter((f) => /\bpublic\.video_intent_finalize\s*\(/i.test(sql.slice(f.inizio, f.fine)))
        .map((f) => f.nome)
}

type Rilievo = { funzione: string; file: string; perche: 'stato-senza-uscita' | 'pubblica-senza-uscita' }

/**
 * I rilievi di UN testo: gli aggiornamenti di stato senza la scadenza dell'uscita e le funzioni
 * che pubblicano un intento senza scriverla. Pura: la usano le prove sul repo e quelle su testi
 * scritti qui.
 */
export function rilieviDi(file: string, sqlGrezzo: string): Rilievo[] {
    const sql = senzaCommentiSql(sqlGrezzo)
    const aggiornamenti = aggiornamentiDi(sql)
    const rilievi: Rilievo[] = []

    for (const a of aggiornamenti) {
        if (a.tabella === 'video_jobs' && toccaLoStato(a.set) && !daLaScadenzaDellUscita(a.set)) {
            rilievi.push({ funzione: a.funzione, file, perche: 'stato-senza-uscita' })
        }
    }

    const scrivonoLUscita = new Set(
        aggiornamenti
            .filter((a) => a.tabella === 'video_jobs' && daLaScadenzaDellUscita(a.set))
            .map((a) => a.funzione),
    )
    const pubblicanti = new Set<string>([
        ...chiamanoFinalize(sql),
        ...aggiornamenti.filter((a) => a.tabella === 'video_intents' && pubblicaUnIntento(a.set)).map((a) => a.funzione),
    ])
    for (const funzione of pubblicanti) {
        if (!scrivonoLUscita.has(funzione)) rilievi.push({ funzione, file, perche: 'pubblica-senza-uscita' })
    }
    return rilievi
}

/**
 * LA RETE DELLE USCITE di una funzione: il testo che sceglie i candidati di ogni suo
 * `UPDATE public.video_jobs` che scrive la scadenza dell'uscita SENZA toccare lo stato — cioè
 * un'annotazione, non una transizione. Un elemento per ogni UPDATE di quella forma; vuoto se non ce ne
 * sono (la rete non c'è, o è tutta in un commento).
 *
 * Esiste per una ragione precisa: le due mappe qui sopra ragionano per FUNZIONE, e
 * `video_retention_scadenze` è una funzione sola con due nature — i suoi `UPDATE` di STATO (un upload
 * abbandonato, una coda incagliata) non hanno un'uscita e sono esenti, e la RETE sì, e non tocca lo
 * stato. Un'esenzione per funzione non vede la rete tolta: la regola generale resterebbe verde. Qui
 * si cerca, per `UPDATE`, quello che scrive la scadenza dell'uscita senza toccare lo stato.
 *
 * I candidati sono il tratto fra l'ultimo `WITH` e l'`UPDATE`: la selezione dei job. Pura: la usano la
 * prova sul repo e quelle su testi scritti qui.
 */
export function reteDelleUsciteDi(sqlGrezzo: string, nome: string): string[] {
    const sql = senzaCommentiSql(sqlGrezzo)
    const funzione = funzioniDi(sql).find((f) => f.nome === nome)
    if (!funzione) return []
    const reti: string[] = []
    const inizio = /UPDATE\s+public\.video_jobs\b/gi
    let m: RegExpExecArray | null
    while ((m = inizio.exec(sql)) !== null) {
        if (m.index < funzione.inizio || m.index >= funzione.fine) continue
        const posSet = /\bSET\b/i.exec(sql.slice(m.index))
        if (!posSet) continue
        const set = clausolaSet(sql, m.index + posSet.index + posSet[0].length)
        if (!daLaScadenzaDellUscita(set) || toccaLoStato(set)) continue
        const cte = sql.lastIndexOf('WITH', m.index)
        reti.push(cte >= funzione.inizio ? sql.slice(cte, m.index) : '')
    }
    return reti
}

/** Ciò che i candidati della rete devono nominare: i tre stati conclusi, l'intento pubblicato, l'uscita e l'assenza della scadenza. */
const SENTINELLE_DELLA_RETE = [
    "'failed'",
    "'rejected'",
    "'cancelled'",
    "'published'",
    'output_path IS NOT NULL',
    'output_deleted_at IS NULL',
    'output_delete_after IS NULL',
] as const

/** Quali sentinelle mancano ai candidati di una rete. */
export const sentinelleMancanti = (candidati: string): string[] =>
    SENTINELLE_DELLA_RETE.filter((s) => !candidati.includes(s))

// ─────────────────────────────────────────────────────────────────────────────
// LE DICHIARAZIONI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le funzioni che toccano lo stato di un job, o pubblicano un intento, e NON scrivono la
 * scadenza dell'uscita — con la ragione.
 *
 * Non è una scappatoia: è l'elenco di ciò che **non concludi niente** o che **non ha un'uscita**.
 * Una transizione verso `queued` o `processing` ha ancora davanti tutta la sua vita, e dare
 * all'uscita una data di distruzione prima ancora che esista sarebbe un numero senza senso. La
 * ragione va scritta perché fra un anno «lo so io» non si rilegge.
 *
 * ⚠️ CHI AGGIUNGE UNA VOCE QUI SI FERMI E RILEGGA: se la funzione porta un job a `failed`,
 * `rejected` o `cancelled` e PUÒ avere un'uscita (un `ready` ripudiato, un job annullato dopo la
 * conversione), questa non è la lista giusta — è la scadenza che manca.
 *
 * VUOTA dal 2026-10-02 al file C: il file A scrive la scadenza dove serve (`video_job_ready`,
 * `video_galleria_pubblica`). I file B (trigger d'arrivo) e C (conservazione) aggiungono le loro
 * voci qui solo se un loro aggiornamento di stato non può avere un'uscita. Il file C ne ha una:
 * i due passi vecchi di `video_retention_scadenze`.
 */
const SENZA_USCITA_GIUSTIFICATE: Record<string, string> = {
    video_retention_scadenze:
        'I passi (a) e (b), un upload abbandonato e una coda incagliata, portano a `failed` un job che non è mai arrivato a `ready`: `output_path` lo scrive solo `video_job_ready`, quindi su quella riga un’uscita NON esiste e non c’è una data da scrivere (il file che un Sandbox morto avesse lasciato in video_processing senza che nessuna riga lo nomini lo toglie la spazzata degli orfani). Il passo (c) non cambia lo stato: lo LEGGE, dentro un `CASE` della scadenza dell’originale (`j.status = \'cancelled\'`), e il rilevatore non distingue una lettura da una scrittura. Le uscite dei job conclusi o di intenti pubblicati le data il passo (d), un `UPDATE` che non tocca `status` e che ha la sua prova dedicata, `reteDelleUsciteDi`, rossa se la rete sparisce: l’esenzione è per funzione e non vedrebbe un passo (d) tolto.',
}

/**
 * Le funzioni che DEVONO scrivere la scadenza dell'uscita, per nome: la prova che la regola
 * generale non basta da sola a garantire. Se qualcuno le togliesse l'assegnazione, la regola
 * generale le segnalerebbe lo stesso; ma se togliesse la funzione, o la rinominasse, il lock
 * verrebbe verde su un perimetro che non contiene più ciò che deve proteggere.
 *
 * ⚠️ `video_retention_scadenze` NON è qui, ed è una scelta (T2c, file C). La funzione è la RETE sotto
 * tutti — dà `output_delete_after = adesso` a ogni job concluso o di intento pubblicato che ha
 * un'uscita e nessuna scadenza, con un `UPDATE` che non tocca `status` — ma ha anche i suoi due
 * `UPDATE` di STATO (un upload abbandonato, una coda incagliata) che l'uscita non ce l'hanno, e
 * sono dichiarati in `SENZA_USCITA_GIUSTIFICATE`: le due liste non si sovrappongono (una funzione o è
 * esente o deve scriverla), e l'esenzione è per FUNZIONE, quindi non vedrebbe il passo (d) tolto. La
 * rete ha la sua prova dedicata, che ragiona per `UPDATE` e non per funzione: `reteDelleUsciteDi`,
 * più sotto, rossa se la rete sparisce.
 */
const FUNZIONI_CHE_LA_SCRIVONO: Record<string, string> = {
    video_job_ready:
        'Porta il job a `ready`: per una News fissa l’uscita a verified_at + 7 giorni (poi la conservazione la toglie). Per una Galleria la lascia com’è, perché serve alla pubblicazione, ma l’assegnazione deve esserci: senza, l’uscita di una News non avrebbe nessun termine.',
    video_galleria_pubblica:
        'Pubblica l’intento e inserisce la riga di galleria: a copia fatta l’uscita in video_processing non serve più e riceve subito la scadenza. Senza, le 39 «copie doppie» del 01/10 tornerebbero a formarsi a ogni pubblicazione.',
}

// ─────────────────────────────────────────────────────────────────────────────
// LE PROVE SUL REPO
// ─────────────────────────────────────────────────────────────────────────────

const CONTENUTO = new Map(FILE_NEL_PERIMETRO.map((f) => [f, readFileSync(join(MIGRAZIONI, f), 'utf8')]))
const FUNZIONI = FILE_NEL_PERIMETRO.flatMap((f) =>
    funzioniDi(senzaCommentiSql(CONTENUTO.get(f) ?? '')).map((fn) => ({ ...fn, file: f })),
)
const RILIEVI = FILE_NEL_PERIMETRO.flatMap((f) => rilieviDi(f, CONTENUTO.get(f) ?? ''))

describe('lock architettura · nessuna uscita video resta senza una scadenza', () => {
    it('le fonti sono piene (se cade questa, tutto il resto è verde sul vuoto)', () => {
        expect(
            FILE_NEL_PERIMETRO.some((f) => f.endsWith('_video_pubblicazione_automatica.sql')),
            'Il file A della PR 2 non è nel perimetro del lock. Si cerca per SUFFISSO e dopo ' +
                `${ULTIMA_DELLA_PR_1}: o è stato rinominato con un suffisso diverso, o con una version ` +
                'anteriore all’ultima migrazione della PR 1. In entrambi i casi questo file direbbe «verde» ' +
                'senza aver guardato la migrazione che esiste per sorvegliare.',
        ).toBe(true)
        expect(
            FUNZIONI.length,
            'Lo scanner non trova funzioni nel perimetro: la convenzione `CREATE OR REPLACE FUNCTION ' +
                'public.<nome>(` o il corpo `AS $$ … $$` è cambiato, e il lock non guarda più niente.',
        ).toBeGreaterThanOrEqual(10)
        const nomiScanditi = new Set(FUNZIONI.map((f) => f.nome))
        for (const nome of Object.keys(FUNZIONI_CHE_LA_SCRIVONO)) {
            expect(
                nomiScanditi.has(nome),
                `\`${nome}\` non è definita in nessuna migrazione del perimetro: o è stata rinominata o è ` +
                    'sparita. Il lock deve sorvegliare la funzione che scrive la scadenza dell’uscita, non ' +
                    'un perimetro da cui è uscita.',
            ).toBe(true)
        }
    })

    it('🔴 ogni funzione che chiude o sposta un job, o pubblica un intento, scrive la scadenza dell’uscita (o è dichiarata)', () => {
        const scoperti = RILIEVI.filter((r) => SENZA_USCITA_GIUSTIFICATE[r.funzione] === undefined).map(
            (r) => `${r.funzione}  ←  ${r.file}  (${r.perche === 'stato-senza-uscita' ? 'cambia lo stato di un job' : 'pubblica un intento'})`,
        )
        expect(
            [...new Set(scoperti)],
            `Queste funzioni cambiano lo stato di un job video, o pubblicano un intento, e NON danno all’USCITA ` +
                `una data di cancellazione (\`output_delete_after = …\` in un \`UPDATE public.video_jobs\`):\n  ` +
                `${[...new Set(scoperti)].join('\n  ')}\n` +
                `Senza, la riga resta fuori da \`video_jobs_uscite_da_togliere_idx\` — che filtra ` +
                `\`output_delete_after IS NOT NULL\` — e il video di un minore resta in \`video_processing\` per ` +
                `sempre, invisibile a ogni conteggio. Se la transizione CONCLUDE il job o PUBBLICA, scrivi ` +
                `la scadenza dell’uscita (anche condizionata: un \`CASE\` va bene). Se invece la funzione non ` +
                `può avere un’uscita (verso queued o processing, o prima della conversione), dichiarala in ` +
                `\`SENZA_USCITA_GIUSTIFICATE\` con la ragione.`,
        ).toEqual([])
    })

    it('le funzioni che devono scrivere la scadenza la scrivono davvero (e la regola le vede)', () => {
        for (const [nome, ragione] of Object.entries(FUNZIONI_CHE_LA_SCRIVONO)) {
            const scritture = FILE_NEL_PERIMETRO.flatMap((f) =>
                aggiornamentiDi(senzaCommentiSql(CONTENUTO.get(f) ?? '')).filter(
                    (a) => a.funzione === nome && a.tabella === 'video_jobs' && daLaScadenzaDellUscita(a.set),
                ),
            )
            expect(
                scritture.length,
                `\`${nome}\` non scrive \`output_delete_after\` in nessun \`UPDATE public.video_jobs\`. ${ragione}`,
            ).toBeGreaterThan(0)
        }
    })

    it('🔴 la RETE delle uscite di video_retention_scadenze c’è: un UPDATE che scrive la scadenza SENZA toccare lo stato, su concluso o pubblicato', () => {
        // Il file C (T2c) la scrive. Le altre due prove di questo file ragionano per FUNZIONE: la regola generale
        // dà gli stessi rilievi con e senza la rete (l'esenzione di `video_retention_scadenze` copre i passi di
        // stato), e `FUNZIONI_CHE_LA_SCRIVONO` non nomina questa funzione. Qui si cerca, per UPDATE, quello che
        // scrive la scadenza dell'uscita senza toccare lo stato, e si pretende che scelga i candidati giusti.
        const reti = FILE_NEL_PERIMETRO.flatMap((f) =>
            reteDelleUsciteDi(CONTENUTO.get(f) ?? '', 'video_retention_scadenze').map((candidati) => ({ file: f, candidati })),
        )
        expect(
            reti.length,
            '`video_retention_scadenze` non ha più la rete delle uscite: nessun `UPDATE public.video_jobs` che scriva ' +
                '`output_delete_after` senza toccare `status`. Senza, le uscite dei job conclusi e degli intenti pubblicati ' +
                'senza scadenza (le 39 «copie doppie» e le 11 di job annullati del 01/10, e ogni annullamento futuro) ' +
                'restano per sempre in `video_processing`, fuori da `video_jobs_uscite_da_togliere_idx`.',
        ).toBe(1)
        expect(
            sentinelleMancanti(reti[0].candidati),
            `La rete in ${reti[0].file} non sceglie più tutti i candidati giusti: i tre stati conclusi, un intento ` +
                'pubblicato, un\'uscita presente e non ancora tolta, e la scadenza assente.',
        ).toEqual([])
    })

    it('le voci dichiarate sono VIVE e portano una ragione (un’esenzione morta è un buco dimenticato)', () => {
        const sopprimono = new Set(RILIEVI.map((r) => r.funzione))
        for (const [funzione, ragione] of Object.entries(SENZA_USCITA_GIUSTIFICATE)) {
            expect(
                sopprimono.has(funzione),
                `\`${funzione}\` è dichiarata fra le funzioni senza scadenza dell’uscita, ma nessun rilievo ` +
                    'la riguarda: o è stata rinominata, o ora la scadenza la scrive. Toglila — un’esenzione che ' +
                    'sopravvive al suo motivo è un buco che nessuno ricorda di aver aperto.',
            ).toBe(true)
            expect(
                ragione.length,
                `\`${funzione}\` è esente senza dire perché: la lista esiste per distinguere «lasciato fuori ` +
                    'apposta» da «dimenticato».',
            ).toBeGreaterThan(80)
        }
    })

    it('le due liste non si sovrappongono (una funzione o è esente o deve scriverla)', () => {
        const comuni = Object.keys(FUNZIONI_CHE_LA_SCRIVONO).filter((n) => SENZA_USCITA_GIUSTIFICATE[n] !== undefined)
        expect(comuni, 'funzioni dichiarate sia «devono scriverla» sia «esenti»').toEqual([])
    })

    it('il perimetro parte dopo la PR 1 e quella migrazione esiste ancora', () => {
        // Se la migrazione di confine sparisse o venisse rinominata, il perimetro si
        // sposterebbe senza che nessuno se ne accorga.
        expect(
            readdirSync(MIGRAZIONI).some((f) => f.startsWith(ULTIMA_DELLA_PR_1 + '_')),
            `Non esiste più una migrazione ${ULTIMA_DELLA_PR_1}_*: il confine del perimetro non è più una ` +
                'cosa che esiste, e il lock non sa da dove cominciare.',
        ).toBe(true)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Un lock verde perché non trova violazioni e un lock verde perché non guarda più niente si
// somigliano moltissimo. Queste prove tengono ferme le forme che il rilevatore DEVE vedere e
// quelle che NON deve segnalare, su testi scritti qui e non sul repo.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore vede ciò che deve vedere', () => {
    const CHIUDE_SENZA_USCITA = `
CREATE OR REPLACE FUNCTION public.video_job_rottama()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_jobs
  SET status = 'cancelled',
      original_delete_after = v_now,
      updated_at = v_now
  WHERE id = p_job_id;
END $$;`

    const CHIUDE_CON_USCITA = `
CREATE OR REPLACE FUNCTION public.video_job_rottama()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_jobs
  SET status = 'cancelled',
      original_delete_after = v_now,
      output_delete_after = v_now,
      updated_at = v_now
  WHERE id = p_job_id;
END $$;`

    const PUBBLICA_SENZA_USCITA = `
CREATE OR REPLACE FUNCTION public.video_pubblica_male()
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.video_intent_finalize(p_intent, p_owner, 1, p_scuola, 'gallery', p_media, 'gallery.published', '{}'::jsonb);
END $$;`

    const PUBBLICA_CON_USCITA = `
CREATE OR REPLACE FUNCTION public.video_pubblica_bene()
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.video_intent_finalize(p_intent, p_owner, 1, p_scuola, 'gallery', p_media, 'gallery.published', '{}'::jsonb);
  UPDATE public.video_jobs SET output_delete_after = v_now WHERE intent_id = p_intent;
  RETURN '{}'::jsonb;
END $$;`

    it('POSITIVO — chiude un job senza scadenza dell’uscita (anche se dà quella dell’originale)', () => {
        // Il caso insidioso: la scadenza dell'ORIGINALE c'è, e la regex ingenua
        // `delete_after\\s*=` la scambierebbe per quella dell'uscita.
        expect(rilieviDi('finto.sql', CHIUDE_SENZA_USCITA)).toEqual([
            { funzione: 'video_job_rottama', file: 'finto.sql', perche: 'stato-senza-uscita' },
        ])
    })

    it('NEGATIVO — la stessa funzione con la scadenza dell’uscita NON viene segnalata', () => {
        expect(rilieviDi('finto.sql', CHIUDE_CON_USCITA)).toEqual([])
    })

    it('POSITIVO — pubblica un intento (chiama il finalize) senza scrivere la scadenza', () => {
        expect(rilieviDi('finto.sql', PUBBLICA_SENZA_USCITA)).toEqual([
            { funzione: 'video_pubblica_male', file: 'finto.sql', perche: 'pubblica-senza-uscita' },
        ])
    })

    it('NEGATIVO — pubblica e scrive la scadenza dell’uscita: nessun rilievo', () => {
        expect(rilieviDi('finto.sql', PUBBLICA_CON_USCITA)).toEqual([])
    })

    it('POSITIVO — pubblica scrivendo `status = published` direttamente su video_intents', () => {
        const DIRETTO = `
CREATE OR REPLACE FUNCTION public.video_pubblica_a_mano()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_intents SET status = 'published', published_at = v_now WHERE id = p_intent;
END $$;`
        expect(rilieviDi('finto.sql', DIRETTO).map((r) => r.perche)).toEqual(['pubblica-senza-uscita'])
    })

    // La rete di video_retention_scadenze, nella forma del file C: un UPDATE di STATO senza uscita (un upload
    // abbandonato: il job non è mai arrivato a `ready`) e, per ultimo, l'UPDATE che scrive la scadenza dell'uscita
    // SENZA toccare lo stato, con i suoi candidati.
    const CON_RETE = `
CREATE OR REPLACE FUNCTION public.video_retention_scadenze(a integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  WITH candidati AS (
    SELECT j.id FROM public.video_jobs AS j WHERE j.status = 'awaiting_upload'
  ), aggiornati AS (
    UPDATE public.video_jobs AS j
    SET status = 'failed', fence_epoch = j.fence_epoch + 1
    FROM candidati AS c WHERE j.id = c.id RETURNING j.id
  )
  SELECT count(*) INTO v_a FROM aggiornati;

  WITH candidati AS (
    SELECT j.id
    FROM public.video_jobs AS j
    INNER JOIN public.video_intents AS i ON i.id = j.intent_id
    WHERE j.output_path IS NOT NULL
      AND j.output_deleted_at IS NULL
      AND j.output_delete_after IS NULL
      AND (j.status IN ('failed', 'rejected', 'cancelled') OR i.status = 'published')
  ), aggiornati AS (
    UPDATE public.video_jobs AS j
    SET output_delete_after = v_now, updated_at = v_now
    FROM candidati AS c WHERE j.id = c.id RETURNING j.id
  )
  SELECT count(*) INTO v_b FROM aggiornati;
END $$;`

    it('POSITIVO — la rete di video_retention_scadenze viene riconosciuta, con tutti i suoi candidati', () => {
        const reti = reteDelleUsciteDi(CON_RETE, 'video_retention_scadenze')
        expect(reti).toHaveLength(1)
        expect(sentinelleMancanti(reti[0])).toEqual([])
        // L'UPDATE di stato senza uscita resta un rilievo della regola generale: è quello che l'esenzione dichiara.
        expect(rilieviDi('finto.sql', CON_RETE).map((r) => r.funzione)).toEqual(['video_retention_scadenze'])
    })

    it('NEGATIVO — senza l’UPDATE che non tocca lo stato la rete NON c’è, e l’esenzione per funzione non lo vedrebbe', () => {
        // Il difetto che questa prova esiste per vedere: la regola generale dà gli STESSI rilievi con e senza la
        // rete (l'esenzione è per funzione, e copre i passi di stato), quindi da sola non si accorge che la rete
        // è sparita. Solo `reteDelleUsciteDi`, che ragiona per UPDATE, lo vede.
        const SENZA_RETE = CON_RETE.slice(0, CON_RETE.indexOf('  WITH candidati AS (\n    SELECT j.id\n    FROM public.video_jobs')) + 'END $$;'
        expect(reteDelleUsciteDi(SENZA_RETE, 'video_retention_scadenze')).toEqual([])
        expect(rilieviDi('finto.sql', SENZA_RETE), 'la regola generale NON distingue la rete sparita').toEqual(
            rilieviDi('finto.sql', CON_RETE),
        )
    })

    it('NEGATIVO — una rete a cui manca un candidato (i pubblicati, o i rifiutati) è riconosciuta ma incompleta', () => {
        const senzaPubblicati = CON_RETE.replace(" OR i.status = 'published'", '')
        const [rete] = reteDelleUsciteDi(senzaPubblicati, 'video_retention_scadenze')
        expect(sentinelleMancanti(rete)).toEqual(["'published'"])
        const senzaRifiutati = CON_RETE.replace("'failed', 'rejected', 'cancelled'", "'failed', 'cancelled'")
        expect(sentinelleMancanti(reteDelleUsciteDi(senzaRifiutati, 'video_retention_scadenze')[0])).toEqual(["'rejected'"])
        const senzaAssenza = CON_RETE.replace('AND j.output_delete_after IS NULL', 'AND j.output_delete_after IS NOT NULL')
        expect(sentinelleMancanti(reteDelleUsciteDi(senzaAssenza, 'video_retention_scadenze')[0])).toEqual(['output_delete_after IS NULL'])
    })

    it('NEGATIVO — la rete scritta in un COMMENTO non c’è, e la rete di un’altra funzione non vale per questa', () => {
        const da = CON_RETE.indexOf('  WITH candidati AS (\n    SELECT j.id\n    FROM public.video_jobs')
        const a = CON_RETE.indexOf('END $$;')
        const COMMENTATA =
            CON_RETE.slice(0, da) +
            CON_RETE.slice(da, a)
                .split('\n')
                .map((riga) => (riga.trim() === '' ? riga : `  -- ${riga.trim()}`))
                .join('\n') +
            CON_RETE.slice(a)
        expect(COMMENTATA).toContain('-- UPDATE public.video_jobs AS j')
        expect(reteDelleUsciteDi(COMMENTATA, 'video_retention_scadenze')).toEqual([])
        expect(reteDelleUsciteDi(CON_RETE, 'video_un_altra_funzione')).toEqual([])
    })

    it('un UPDATE di job che NON tocca lo stato non è un rilievo (la sorveglianza, il token)', () => {
        const NON_TOCCA_LO_STATO = `
CREATE OR REPLACE FUNCTION public.video_job_guarda()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_jobs SET sorvegliato_da = p_inv, sorvegliato_fino_a = v_now WHERE id = p_job_id AND status = 'queued';
END $$;`
        // `status` compare nella WHERE: la clausola SET si ferma prima, e non lo vede.
        expect(rilieviDi('finto.sql', NON_TOCCA_LO_STATO)).toEqual([])
    })

    it('un nome citato in un COMMENTO non vale come codice (né per scrivere né per pubblicare)', () => {
        const COMMENTATO = `
CREATE OR REPLACE FUNCTION public.video_job_rottama()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- qui bisognerebbe scrivere output_delete_after = v_now, ma non lo facciamo
  UPDATE public.video_jobs
  SET status = 'failed' -- output_delete_after = v_now
  WHERE id = p_job_id;
END $$;`
        expect(rilieviDi('finto.sql', COMMENTATO)).toHaveLength(1)
    })

    it('la clausola SET non si ferma a una FROM dentro parentesi (una sottoquery nel SET)', () => {
        const SOTTOQUERY = `
CREATE OR REPLACE FUNCTION public.video_job_rottama()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_jobs
  SET status = 'failed',
      output_delete_after = (SELECT min(t.quando) FROM public.altra AS t WHERE t.k = 1)
  WHERE id = p_job_id;
END $$;`
        expect(rilieviDi('finto.sql', SOTTOQUERY)).toEqual([])
    })

    it('la scadenza dentro un CASE (la forma di video_job_ready) conta come scritta', () => {
        const CON_CASE = `
CREATE OR REPLACE FUNCTION public.video_job_pronto()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.video_jobs
  SET status = 'ready',
      output_delete_after = CASE WHEN v_canale = 'news' THEN v_now + interval '7 days' ELSE output_delete_after END
  WHERE id = p_job_id;
END $$;`
        expect(rilieviDi('finto.sql', CON_CASE)).toEqual([])
    })

    it('un UPDATE fuori da una funzione (un DO, una correzione dei dati) è sorvegliato come gli altri', () => {
        const FUORI = `
UPDATE public.video_jobs SET status = 'failed', original_delete_after = now() WHERE status = 'queued';`
        expect(rilieviDi('finto.sql', FUORI)).toEqual([
            { funzione: '(fuori da una funzione)', file: 'finto.sql', perche: 'stato-senza-uscita' },
        ])
    })

    it('i commenti italiani con un apice non rompono lo scanner (l’uscita, un’altra)', () => {
        const APICI = `
-- l'uscita e' un'altra cosa
CREATE OR REPLACE FUNCTION public.video_job_pronto()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- l'originale e' gia' lì, e l'uscita no
  UPDATE public.video_jobs SET status = 'failed' WHERE id = p_job_id; -- un'altra riga
END $$;`
        expect(rilieviDi('finto.sql', APICI).map((r) => r.funzione)).toEqual(['video_job_pronto'])
    })
})
