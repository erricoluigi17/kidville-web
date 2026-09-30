// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'

/**
 * LA MIGRAZIONE CHE SPEGNE LE NOTIFICHE DI CHAT GIÀ LETTE, eseguita in un
 * PostgreSQL vero e isolato.
 *
 * PERCHÉ PGlite E NON UN MOCK. L'oggetto in prova è un `UPDATE … WHERE NOT EXISTS`:
 * un finto che risponde «ho aggiornato N righe» sarebbe verde con la correzione e
 * senza. Qui gira Postgres davvero, sulle stesse colonne e sugli stessi tipi del
 * baseline (`notifiche` alla riga 2089, `chat_messages` alla 1295), e la prova è lo
 * stato delle righe dopo l'esecuzione.
 *
 * PERCHÉ I TIPI SONO LETTERALI DATATI e non importati da `@/lib/chat/notifiche-chat`.
 * Una migrazione applicata è storia: il suo `WHERE` non cambierà più. Legare il test
 * a una costante che invece può cambiare produrrebbe, il giorno in cui arriva un
 * terzo tipo di chat, soltanto un rosso che non descrive nessun difetto — e la
 * risposta sbagliata a quel rosso sarebbe modificare un file già applicato.
 * L'allineamento fra la costante e la route lo sorveglia già
 * `__tests__/lib/push-dispatch-presa.test.ts`; qui si fissano i due tipi vivi il
 * 29/09/2026, cioè quelli che la migrazione elenca.
 *
 * LA CRONOLOGIA È QUELLA VERA: in produzione un messaggio nasce PRIMA della notifica
 * che lo annuncia. Seminare il contrario sembra innocuo e non lo è — rende
 * indistinguibile dall'originale un `WHERE` che confronti le due date, e la
 * migrazione passerebbe un controllo che in produzione fallirebbe.
 *
 * NESSUNA GUARDIA `existsSync` sul file di migrazione: se manca, il test deve cadere.
 * Un test che si salta da solo quando il suo oggetto non c'è è un verde falso.
 */

const MIGRAZIONE = join(
    process.cwd(),
    'supabase/migrations/20260929180303_notifiche_chat_lette_su_conversazioni_lette.sql',
)

/**
 * I tipi vivi il 29/09/2026, come li elenca la migrazione. `chat_genitore` è la
 * notifica diretta AL GENITORE (l'ha scritta la docente), `chat_docente` quella
 * diretta ALLA DOCENTE: lo decide `src/app/api/chat/messages/route.ts`, con
 * `controparte.versoGenitore ? 'chat_genitore' : 'chat_docente'`.
 */
const TIPI_AL_2026_09_29 = ['chat_genitore', 'chat_docente'] as const
const [VERSO_GENITORE, VERSO_DOCENTE] = TIPI_AL_2026_09_29
const ENTITA_AL_2026_09_29 = 'chat_thread'

/** Uuid palesemente finti: un test non deve conoscere nessuna identità vera. */
function uuidFinto(prefisso: string, n: number): string {
    if (!Number.isInteger(n) || n < 0 || n > 999) {
        throw new Error(`uuid finto: n deve stare fra 0 e 999 per restare un uuid valido, ricevuto ${n}`)
    }
    return `aaaaaaaa-0000-4000-8000-${prefisso}${String(n).padStart(3, '0')}`
}
const MAESTRA = uuidFinto('000000000', 1)
const GENITORE = uuidFinto('000000000', 2)
const thread = (n: number) => uuidFinto('100000000', n)
const notifica = (n: number) => uuidFinto('200000000', n)

/**
 * Gli istanti, nell'ordine in cui accadono davvero: il messaggio, la notifica che lo
 * annuncia, la push. Tutti i campi sono seminati NON NULLI dove la colonna lo
 * consente, perché una colonna lasciata a `null` non può smascherare un mutante che
 * ci scrive dentro. Niente dati personali: il repository è pubblico.
 */
const MESSAGGIO_IL = '2026-09-01T07:59:50.000Z'
const PROGRAMMATO_IL = '2026-09-01T07:59:55.000Z'
const CREATO_IL = '2026-09-01T08:00:00.000Z'
const PUSH_IL = '2026-09-01T08:00:05.000Z'
const LETTO_IL = '2026-09-02T09:00:00.000Z'
/** Una `letta_il` già scritta, che deve restare identica al carattere. */
const GIA_LETTA_IL = '2026-01-01T10:00:00.000Z'
const TITOLO = 'Nuovo messaggio in chat'
const CORPO = 'anteprima di prova'
const LINK = '/teacher/chat'

let db: PGlite

beforeAll(async () => {
    db = new PGlite()
    // Colonne e tipi copiati dal baseline. Il tipo di `entita_id` non è un dettaglio:
    // dichiararla `text` invece che `uuid` farebbe fallire il join `m.thread_id =
    // n.entita_id` con `42883 operator does not exist: uuid = text`, e i test
    // cadrebbero tutti per un motivo che non c'entra con la migrazione.
    await db.exec(`
        CREATE TABLE public.notifiche (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            utente_id uuid NOT NULL,
            tipo text NOT NULL,
            titolo text NOT NULL,
            corpo text,
            link text,
            entita_tipo text,
            entita_id uuid,
            letta_il timestamptz,
            push_inviata_il timestamptz,
            creato_il timestamptz DEFAULT now(),
            invio_programmato_il timestamptz
        );
        CREATE TABLE public.chat_messages (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            thread_id uuid NOT NULL,
            sender_id uuid NOT NULL,
            content text NOT NULL,
            attachment_url text,
            attachment_type character varying(20),
            read_at timestamptz,
            created_at timestamptz DEFAULT CURRENT_TIMESTAMP
        );
    `)
})

beforeEach(async () => {
    await db.exec('TRUNCATE public.notifiche, public.chat_messages')
})

afterAll(async () => {
    await db.close()
})

/**
 * Esegue la migrazione. Rilegge il file a ogni chiamata di proposito: è ciò che rende
 * possibile la prova dei mutanti — si altera l'SQL e si guarda quali test cadono.
 */
async function applicaMigrazione() {
    await db.exec(readFileSync(MIGRAZIONE, 'utf8'))
}

interface SemeNotifica {
    id: string
    utente: string
    tipo?: string
    entitaTipo?: string | null
    entitaId?: string | null
    lettaIl?: string | null
    creatoIl?: string
    pushIl?: string | null
}

async function seminaNotifica({
    id,
    utente,
    tipo = VERSO_DOCENTE,
    entitaTipo = ENTITA_AL_2026_09_29,
    entitaId = null,
    lettaIl = null,
    creatoIl = CREATO_IL,
    pushIl = PUSH_IL,
}: SemeNotifica) {
    await db.query(
        `INSERT INTO public.notifiche
           (id, utente_id, tipo, titolo, corpo, link, entita_tipo, entita_id,
            letta_il, push_inviata_il, creato_il, invio_programmato_il)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid,
                 $9::timestamptz, $10::timestamptz, $11::timestamptz, $12::timestamptz)`,
        [id, utente, tipo, TITOLO, CORPO, LINK, entitaTipo, entitaId,
            lettaIl, pushIl, creatoIl, PROGRAMMATO_IL],
    )
}

/**
 * Un messaggio nel thread. `letto` è il `read_at`, cioè se l'ha letto il
 * DESTINATARIO, non chi scrive. `creatoIl` sta per default PRIMA della notifica.
 */
async function seminaMessaggio(threadId: string, mittente: string, letto: boolean, creatoIl = MESSAGGIO_IL) {
    await db.query(
        `INSERT INTO public.chat_messages (thread_id, sender_id, content, read_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz)`,
        [threadId, mittente, 'testo di prova', letto ? LETTO_IL : null, creatoIl],
    )
}

/** La `letta_il` di una notifica. LANCIA se quell'id non è stato seminato. */
async function lettaIl(id: string): Promise<Date | null> {
    const { rows } = await db.query<{ letta_il: Date | null }>(
        'SELECT letta_il FROM public.notifiche WHERE id = $1::uuid',
        [id],
    )
    if (rows.length === 0) throw new Error(`notifica non seminata: ${id}`)
    return rows[0].letta_il
}

/** `true` = spenta (la campanella non la conta più). */
async function spenta(id: string): Promise<boolean> {
    return (await lettaIl(id)) !== null
}

/**
 * TUTTE le righe, TUTTE le colonne tranne `letta_il`, in ordine stabile. Elencare a
 * mano le colonne da controllare è il modo sicuro di non accorgersi di quelle che non
 * si sono elencate; `to_jsonb(n)` prende la riga intera, così una colonna aggiunta
 * domani entra nel confronto da sé.
 */
async function righeSenzaLettaIl(): Promise<unknown[]> {
    const { rows } = await db.query<{ riga: unknown }>(
        "SELECT to_jsonb(n) - 'letta_il' AS riga FROM public.notifiche n ORDER BY n.id",
    )
    return rows.map((r) => r.riga)
}

/**
 * La VERSIONE di ogni riga (`xmin`, la transazione che l'ha scritta per ultima).
 * Confrontare i valori non basta a dire «non ho riscritto niente»: un UPDATE che
 * riscrive lo stesso valore è invisibile nei dati e visibile qui.
 */
async function versioniRighe(): Promise<{ id: string; v: string }[]> {
    const { rows } = await db.query<{ id: string; v: string }>(
        'SELECT id, xmin::text AS v FROM public.notifiche ORDER BY id',
    )
    return rows
}

async function contaAccese(): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM public.notifiche WHERE letta_il IS NULL',
    )
    return rows[0].n
}

describe('migrazione · le notifiche di chat di una conversazione già letta si spengono', () => {
    it('conversazione letta: tutti i messaggi dell’altra parte hanno read_at → notifica spenta', async () => {
        await seminaNotifica({ id: notifica(1), utente: MAESTRA, entitaId: thread(1) })
        await seminaMessaggio(thread(1), GENITORE, true)
        await seminaMessaggio(thread(1), GENITORE, true)

        await applicaMigrazione()

        expect(await spenta(notifica(1))).toBe(true)
    })

    it('vale per entrambi i tipi di notifica di chat vivi il 29/09/2026', async () => {
        for (const [i, tipo] of TIPI_AL_2026_09_29.entries()) {
            await seminaNotifica({ id: notifica(10 + i), utente: MAESTRA, tipo, entitaId: thread(2) })
        }
        await seminaMessaggio(thread(2), GENITORE, true)

        await applicaMigrazione()

        for (const [i, tipo] of TIPI_AL_2026_09_29.entries()) {
            expect(await spenta(notifica(10 + i)), `tipo «${tipo}» non spento`).toBe(true)
        }
    })

    it('un messaggio dell’altra parte ancora non letto → la notifica resta accesa', async () => {
        // Il messaggio non letto è ANTERIORE alla notifica, come in produzione: un
        // `WHERE` che guardasse solo i messaggi arrivati dopo la notifica lo
        // ignorerebbe e spegnerebbe una conversazione che ha ancora roba da leggere.
        await seminaNotifica({ id: notifica(2), utente: MAESTRA, entitaId: thread(3) })
        await seminaMessaggio(thread(3), GENITORE, true)
        await seminaMessaggio(thread(3), GENITORE, false)

        await applicaMigrazione()

        expect(await spenta(notifica(2))).toBe(false)
    })

    it('l’unico non letto è un messaggio del destinatario stesso → notifica spenta', async () => {
        // Che la controparte non abbia letto ciò che ho scritto io non dice niente su
        // cosa ho letto io: senza `m.sender_id <> n.utente_id` questa riga resterebbe
        // accesa per sempre.
        await seminaNotifica({ id: notifica(3), utente: MAESTRA, entitaId: thread(4) })
        await seminaMessaggio(thread(4), GENITORE, true)
        await seminaMessaggio(thread(4), MAESTRA, false)

        await applicaMigrazione()

        expect(await spenta(notifica(3))).toBe(true)
    })

    it('stesso thread, due destinatari: ciascuno è valutato sui messaggi dell’ALTRA parte', async () => {
        // La maestra ha un messaggio del genitore non letto → resta accesa.
        // Il genitore ha letto tutto ciò che la maestra ha scritto → si spegne.
        await seminaNotifica({ id: notifica(4), utente: MAESTRA, tipo: VERSO_DOCENTE, entitaId: thread(5) })
        await seminaNotifica({ id: notifica(5), utente: GENITORE, tipo: VERSO_GENITORE, entitaId: thread(5) })
        await seminaMessaggio(thread(5), GENITORE, false)
        await seminaMessaggio(thread(5), MAESTRA, true)

        await applicaMigrazione()

        expect(await spenta(notifica(4))).toBe(false)
        expect(await spenta(notifica(5))).toBe(true)
    })

    it('non tocca gli altri tipi, un entita_tipo diverso, né le righe con entita_id nullo', async () => {
        await seminaNotifica({ id: notifica(6), utente: MAESTRA, tipo: 'diario', entitaId: thread(6) })
        await seminaNotifica({ id: notifica(7), utente: MAESTRA, entitaTipo: 'diario_voce', entitaId: thread(6) })
        await seminaNotifica({ id: notifica(8), utente: MAESTRA, entitaId: null })
        await seminaNotifica({ id: notifica(9), utente: MAESTRA, entitaTipo: null, entitaId: thread(6) })
        await seminaMessaggio(thread(6), GENITORE, true)

        await applicaMigrazione()

        for (const id of [notifica(6), notifica(7), notifica(8), notifica(9)]) {
            expect(await spenta(id), `la riga ${id} non doveva essere toccata`).toBe(false)
        }
    })

    it('una letta_il già valorizzata resta identica: non viene riscritta', async () => {
        await seminaNotifica({ id: notifica(20), utente: MAESTRA, entitaId: thread(7), lettaIl: GIA_LETTA_IL })
        await seminaMessaggio(thread(7), GENITORE, true)

        await applicaMigrazione()

        expect((await lettaIl(notifica(20)))?.toISOString()).toBe(GIA_LETTA_IL)
    })

    it('thread senza nessun messaggio → spenta, ed è voluto: non c’è niente da leggere', async () => {
        await seminaNotifica({ id: notifica(21), utente: MAESTRA, entitaId: thread(8) })

        await applicaMigrazione()

        expect(await spenta(notifica(21))).toBe(true)
    })

    it('una notifica con push_inviata_il NULL si spegne come le altre', async () => {
        // La push non partita è un fatto della push, non della lettura: se la
        // conversazione è letta, la campanella si spegne comunque. Escluderla
        // lascerebbe accese proprio le righe di chi non ha ricevuto nessun avviso.
        await seminaNotifica({ id: notifica(25), utente: MAESTRA, entitaId: thread(11), pushIl: null })
        await seminaMessaggio(thread(11), GENITORE, true)

        await applicaMigrazione()

        expect(await spenta(notifica(25))).toBe(true)
    })

    it('l’accumulo di un thread si spegne INTERO, comprese le notifiche più recenti', async () => {
        // È la forma del caso da 661: mesi di notifiche dello stesso tipo, per la
        // stessa persona, sullo stesso thread. Spegnere solo la più recente, o solo
        // quelle prima di una certa data, lascerebbe la campanella gonfia — cioè non
        // risolverebbe niente.
        const storia = [
            { n: 60, creato: '2026-07-10T09:00:00.000Z', messaggio: '2026-07-10T08:59:50.000Z' },
            { n: 61, creato: '2026-08-05T11:00:00.000Z', messaggio: '2026-08-05T10:59:50.000Z' },
            { n: 62, creato: '2026-09-10T15:00:00.000Z', messaggio: '2026-09-10T14:59:50.000Z' },
            { n: 63, creato: '2026-09-20T16:00:00.000Z', messaggio: '2026-09-20T15:59:50.000Z' },
        ]
        for (const r of storia) {
            await seminaNotifica({ id: notifica(r.n), utente: MAESTRA, entitaId: thread(60), creatoIl: r.creato })
            await seminaMessaggio(thread(60), GENITORE, true, r.messaggio)
        }

        await applicaMigrazione()

        for (const r of storia) {
            expect(await spenta(notifica(r.n)), `la notifica del ${r.creato} è rimasta accesa`).toBe(true)
        }
        expect(await contaAccese()).toBe(0)
    })

    it('stesso accumulo, ma l’ULTIMO messaggio dell’altra parte non è letto → restano accese TUTTE', async () => {
        // Il gemello del precedente: a contare è QUALUNQUE messaggio non letto
        // dell'altra parte, non solo quelli nati prima (o dopo) di una notifica.
        const storia = [
            { n: 70, creato: '2026-07-10T09:00:00.000Z', messaggio: '2026-07-10T08:59:50.000Z' },
            { n: 71, creato: '2026-08-05T11:00:00.000Z', messaggio: '2026-08-05T10:59:50.000Z' },
            { n: 72, creato: '2026-09-10T15:00:00.000Z', messaggio: '2026-09-10T14:59:50.000Z' },
            { n: 73, creato: '2026-09-20T16:00:00.000Z', messaggio: '2026-09-20T15:59:50.000Z' },
        ]
        for (const [i, r] of storia.entries()) {
            await seminaNotifica({ id: notifica(r.n), utente: MAESTRA, entitaId: thread(70), creatoIl: r.creato })
            await seminaMessaggio(thread(70), GENITORE, i < storia.length - 1, r.messaggio)
        }

        await applicaMigrazione()

        expect(await contaAccese()).toBe(storia.length)
    })

    it('non tocca NESSUNA altra colonna: la riga intera, tranne letta_il, è identica', async () => {
        // Si semina una riga per OGNI tipo: con un tipo solo, un mutante che scrivesse
        // `tipo = '<quel tipo>'` riscriverebbe il valore esattamente dov'era già, e
        // nessun confronto potrebbe vederlo.
        const daSpegnere = TIPI_AL_2026_09_29.map((tipo, i) => ({ tipo, id: notifica(22 + i), th: thread(20 + i) }))
        for (const r of daSpegnere) {
            await seminaNotifica({ id: r.id, utente: MAESTRA, tipo: r.tipo, entitaId: r.th })
            await seminaMessaggio(r.th, GENITORE, true)
        }
        await seminaNotifica({ id: notifica(28), utente: MAESTRA, entitaId: thread(29) })
        await seminaMessaggio(thread(29), GENITORE, false)
        await seminaNotifica({ id: notifica(29), utente: MAESTRA, tipo: 'avviso', entitaId: thread(20) })

        const prima = await righeSenzaLettaIl()
        await applicaMigrazione()
        const dopo = await righeSenzaLettaIl()

        expect(dopo).toEqual(prima)
        // …e la migrazione ha comunque fatto il suo lavoro: senza queste righe il test
        // sarebbe verde anche per un SQL che non spegne più niente.
        for (const r of daSpegnere) {
            expect(await spenta(r.id), `${r.tipo} doveva spegnersi`).toBe(true)
        }
        expect(await spenta(notifica(28))).toBe(false)
        expect(await spenta(notifica(29))).toBe(false)
    })

    it('le righe spente portano l’istante della TRANSAZIONE, non quello della riga', async () => {
        // `now()` vale per tutta la transazione; `clock_timestamp()` avanza a ogni riga
        // e `statement_timestamp()` riparte a ogni statement. Contare i valori distinti
        // non li distingue: su poche righe l'orologio non fa in tempo a cambiare. Qui
        // si apre la transazione, si legge `now()`, si aspettano 50 ms e si applica —
        // un orologio diverso arriverebbe 50 ms dopo t0. È la proprietà su cui si
        // regge la verifica dopo il deploy: le righe spente hanno tutte lo stesso
        // istante, quindi si ritrovano.
        for (const n of [30, 31, 32]) {
            await seminaNotifica({ id: notifica(n), utente: MAESTRA, entitaId: thread(n) })
            await seminaMessaggio(thread(n), GENITORE, true)
        }

        let esito: { diverse: number; spente: number } | undefined
        await db.exec('BEGIN')
        try {
            await db.exec('CREATE TEMP TABLE t0 ON COMMIT DROP AS SELECT now() AS istante')
            await db.query('SELECT pg_sleep(0.05)')
            await applicaMigrazione()
            // Il confronto lo fa il DATABASE: passare l'istante in JavaScript e
            // riportarlo indietro perderebbe i microsecondi, cioè la precisione che
            // distingue i due orologi.
            const { rows } = await db.query<{ diverse: number; spente: number }>(`
                SELECT count(*) FILTER (WHERE n.letta_il <> t.istante)::int AS diverse,
                       count(*) FILTER (WHERE n.letta_il IS NOT NULL)::int AS spente
                  FROM public.notifiche n CROSS JOIN t0 t
            `)
            esito = rows[0]
        } finally {
            await db.exec('COMMIT')
        }

        expect(esito).toEqual({ diverse: 0, spente: 3 })
    })

    it('è idempotente: il secondo passaggio non riscrive NESSUNA riga', async () => {
        // Il confronto è sulla versione della riga (`xmin`), non sui valori: un UPDATE
        // che riscrive lo stesso `letta_il` non si vede nei dati, ma fa una tupla nuova
        // — e su una tabella di produzione è lavoro inutile e bloat evitabile.
        await seminaNotifica({ id: notifica(40), utente: MAESTRA, entitaId: thread(40) })
        await seminaMessaggio(thread(40), GENITORE, true)
        await seminaNotifica({ id: notifica(41), utente: MAESTRA, entitaId: thread(41), lettaIl: GIA_LETTA_IL })
        await seminaMessaggio(thread(41), GENITORE, true)
        await seminaNotifica({ id: notifica(42), utente: MAESTRA, entitaId: thread(42) })
        await seminaMessaggio(thread(42), GENITORE, false)

        await applicaMigrazione()
        const versioniDopoIlPrimo = await versioniRighe()
        const valoriDopoIlPrimo = await righeSenzaLettaIl()
        const letteDopoIlPrimo = [
            (await lettaIl(notifica(40)))?.toISOString(),
            (await lettaIl(notifica(41)))?.toISOString(),
            await lettaIl(notifica(42)),
        ]

        await applicaMigrazione()

        expect(await versioniRighe()).toEqual(versioniDopoIlPrimo)
        expect(await righeSenzaLettaIl()).toEqual(valoriDopoIlPrimo)
        expect([
            (await lettaIl(notifica(40)))?.toISOString(),
            (await lettaIl(notifica(41)))?.toISOString(),
            await lettaIl(notifica(42)),
        ]).toEqual(letteDopoIlPrimo)
        expect(letteDopoIlPrimo[1]).toBe(GIA_LETTA_IL)
        expect(letteDopoIlPrimo[2]).toBeNull()
    })

    it('su un insieme misto spegne esattamente le righe attese e nessun’altra', async () => {
        // 4 da spegnere: conversazione letta, thread vuoto, non-letto del destinatario,
        // secondo tipo di chat. 3 da lasciare accese: non-letto dell'altra parte, tipo
        // estraneo, entita_id nullo. Più 1 già letta, che non si conta due volte.
        await seminaNotifica({ id: notifica(50), utente: MAESTRA, entitaId: thread(50) })
        await seminaMessaggio(thread(50), GENITORE, true)

        await seminaNotifica({ id: notifica(51), utente: MAESTRA, entitaId: thread(51) })

        await seminaNotifica({ id: notifica(52), utente: MAESTRA, entitaId: thread(52) })
        await seminaMessaggio(thread(52), MAESTRA, false)

        await seminaNotifica({ id: notifica(53), utente: GENITORE, tipo: VERSO_GENITORE, entitaId: thread(53) })
        await seminaMessaggio(thread(53), MAESTRA, true)

        await seminaNotifica({ id: notifica(54), utente: MAESTRA, entitaId: thread(54) })
        await seminaMessaggio(thread(54), GENITORE, false)

        await seminaNotifica({ id: notifica(55), utente: MAESTRA, tipo: 'avviso', entitaId: thread(50) })
        await seminaNotifica({ id: notifica(56), utente: MAESTRA, entitaId: null })

        await seminaNotifica({ id: notifica(57), utente: MAESTRA, entitaId: thread(50), lettaIl: GIA_LETTA_IL })

        expect(await contaAccese()).toBe(7)

        await applicaMigrazione()

        expect(await contaAccese()).toBe(3)
        for (const id of [notifica(50), notifica(51), notifica(52), notifica(53)]) {
            expect(await spenta(id), `${id} doveva spegnersi`).toBe(true)
        }
        for (const id of [notifica(54), notifica(55), notifica(56)]) {
            expect(await spenta(id), `${id} doveva restare accesa`).toBe(false)
        }
    })
})
