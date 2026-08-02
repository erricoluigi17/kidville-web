import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'

/**
 * COSA SIGNIFICA UN `remove()` INCOMPLETO. Una regola sola, in un posto solo.
 *
 * ─── IL FATTO ───────────────────────────────────────────────────────────────
 *
 * `supabase.storage.from(b).remove(percorsi)` restituisce **gli oggetti che ha
 * davvero tolto**, e non fallisce sui percorsi che non esistono: per quelli
 * risponde semplicemente senza nominarli, con `error: null`. Da qui nascono due
 * modi opposti di sbagliare, e questo repo li ha fatti tutti e due nello stesso
 * giorno:
 *
 *  · guardare solo `error` → «zero file rimossi su tre» passa per un successo, e
 *    si cancella la riga lasciando il documento d'identità di un minore
 *    nell'archivio: invisibile, non cancellato;
 *  · contare, e fermarsi se i conti non tornano → un file GIÀ assente vale come
 *    un guasto. Ma un file mancante non torna: il confronto non tornerà mai più,
 *    e la cancellazione dell'intero lotto resta bloccata **per sempre**. Sui
 *    dati sanitari di minori, un lavoro che non cancella più niente non è un
 *    fastidio: è la violazione che il lavoro doveva impedire.
 *
 * ─── LA REGOLA ──────────────────────────────────────────────────────────────
 *
 * **Si verifica lo STATO, non il conteggio.** «Non rimosso» e «ancora lì» sono
 * due fatti diversi, e solo il secondo è un guasto:
 *
 *      uscito adesso   → fatto
 *      non c'è più     → fatto ANCHE QUESTO (l'esito voluto è già raggiunto):
 *                        si dice con un `info`, non si tratta da errore
 *      c'è ancora      → guasto: chi ha chiamato NON deve cancellare la riga
 *      non si sa       → guasto anche questo: «non so» non è «non c'è»
 *
 * ─── PERCHÉ STA QUI E NON DENTRO IL CHIAMANTE ───────────────────────────────
 *
 * Perché era già stata scritta due volte, in due file, e la seconda copia diceva
 * il contrario della prima: `rimuoviFileOblio` (oblio su richiesta) trattava
 * correttamente il file già assente come esito raggiunto, mentre la retention —
 * scritta poche ore dopo — sulla stessa condizione si bloccava. Una regola valida
 * per due strade deve vivere in un posto solo, altrimenti diverge in silenzio.
 *
 * Nei log MAI il percorso: contiene l'uuid di chi ha caricato e il nome del file
 * scelto dalla famiglia, che quasi sempre è il nome di una persona. Solo conteggi.
 */

export type EsitoRimozione = {
    /** Usciti adesso dall'archivio. */
    rimossi: string[]
    /** Non c'erano più: l'esito voluto era già raggiunto. NON è un guasto. */
    giaAssenti: string[]
    /** Non sono usciti e lo Storage conferma che ci sono ancora. */
    ancoraPresenti: string[]
    /** Non si è potuto sapere se ci sono ancora. Si tratta come «ci sono». */
    incerti: string[]
    /** `remove()` ha risposto con un errore: nessun file è uscito. */
    erroreRimozione: boolean
}

/** I percorsi su cui chi ha chiamato NON può considerare raggiunto l'obiettivo. */
export function bloccanti(e: EsitoRimozione): string[] {
    return [...e.ancoraPresenti, ...e.incerti]
}

const VUOTO: EsitoRimozione = {
    rimossi: [],
    giaAssenti: [],
    ancoraPresenti: [],
    incerti: [],
    erroreRimozione: false,
}

/** `iscrizioni/abc/uuid-doc.pdf` → `{ cartella: 'iscrizioni/abc', nome: 'uuid-doc.pdf' }`. */
function scomponi(percorso: string): { cartella: string; nome: string } {
    const barra = percorso.lastIndexOf('/')
    if (barra < 0) return { cartella: '', nome: percorso }
    return { cartella: percorso.slice(0, barra), nome: percorso.slice(barra + 1) }
}

/**
 * Chi è uscito davvero, senza dipendere dalla FORMA della risposta.
 *
 * Lo Storage nomina gli oggetti rimossi con il percorso pieno; ma è proprio
 * l'assunzione su cosa restituisce un'API il difetto che questo modulo esiste per
 * chiudere, quindi si accetta anche il solo nome del file — e solo quando il
 * riscontro è UNIVOCO: se due percorsi diversi finiscono con lo stesso nome, il
 * nome da solo non dice quale dei due sia uscito, e si preferisce verificare.
 * Un riscontro mancato costa un'interrogazione in più; un riscontro sbagliato
 * costerebbe una riga cancellata su un file ancora presente.
 */
function usciti(data: unknown, percorsi: string[]): Set<string> {
    const out = new Set<string>()
    if (!Array.isArray(data)) return out
    const perNome = new Map<string, string[]>()
    for (const p of percorsi) {
        const { nome } = scomponi(p)
        perNome.set(nome, [...(perNome.get(nome) ?? []), p])
    }
    const attesi = new Set(percorsi)
    for (const o of data) {
        const nome = (o as { name?: unknown } | null)?.name
        if (typeof nome !== 'string' || nome === '') continue
        if (attesi.has(nome)) {
            out.add(nome)
            continue
        }
        const candidati = perNome.get(nome)
        if (candidati && candidati.length === 1) out.add(candidati[0])
    }
    return out
}

/**
 * `true` se il file è ANCORA nel bucket, `false` se non c'è più, `null` se non si
 * è potuto sapere.
 *
 * Si usa `list(cartella, { search: nome })` e non una richiesta sul singolo
 * oggetto: quando il file non c'è, `list` risponde **200 con l'elenco vuoto**,
 * mentre una `HEAD` risponderebbe 404 — e in questo repo ogni 4xx dello Storage
 * finisce nel canale degli errori (`supabase-fetch`, l'invariante «un 4xx qui è
 * una richiesta sbagliata scritta da noi»). Verificare un file legittimamente
 * assente non deve produrre una riga d'errore: sommergere il canale è il modo
 * più efficace di non vedere più i guasti veri.
 *
 * `search` non è una ricerca a sottostringa: il server lo CONCATENA al prefisso
 * (`storage.search`: `prefix || search`), quindi qui vale «i nomi che cominciano
 * per…», ordinati per nome crescente — e il nome esatto, essendo il più corto di
 * quel gruppo, è sempre il primo. Il confronto resta comunque per uguaglianza:
 * `documento.pdf` non deve valere per `documento.pdf.bak`.
 */
async function ancoraNelBucket(
    supabase: SupabaseClient,
    bucket: string,
    percorso: string,
): Promise<{ presente: boolean | null; errore?: unknown }> {
    const { cartella, nome } = scomponi(percorso)
    try {
        const { data, error } = await supabase.storage
            .from(bucket)
            .list(cartella, { limit: 100, search: nome })
        if (error) return { presente: null, errore: error }
        const righe = Array.isArray(data) ? data : []
        return { presente: righe.some((o) => (o as { name?: unknown } | null)?.name === nome) }
    } catch (e) {
        // Guasto di TRASPORTO: `list()` non ritorna, lancia. Stesso trattamento —
        // e soprattutto stessa VISIBILITÀ — dell'errore restituito.
        return { presente: null, errore: e }
    }
}

/**
 * Toglie i file dall'archivio e **verifica lo stato di quelli che non risultano
 * usciti**, invece di contarli. Non cancella righe e non decide per il chiamante:
 * restituisce i fatti, e il chiamante decide cosa trattenere.
 */
export async function rimuoviEVerifica(
    supabase: SupabaseClient,
    bucket: string,
    percorsi: (string | null | undefined)[],
    op: string,
): Promise<EsitoRimozione> {
    const unici = [
        ...new Set(
            percorsi.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p.length > 0),
        ),
    ]
    if (unici.length === 0) return { ...VUOTO }

    let riferiti: Set<string>
    try {
        const { data, error } = await supabase.storage.from(bucket).remove(unici)
        if (error) {
            logEvento(
                'storage',
                'error',
                { operazione: op, esito: 'file-non-rimossi', bucket, n_file: unici.length },
                error,
            )
            return { ...VUOTO, erroreRimozione: true }
        }
        riferiti = usciti(data, unici)
    } catch (e) {
        logEvento(
            'storage',
            'error',
            { operazione: op, esito: 'file-non-rimossi', bucket, n_file: unici.length },
            e,
        )
        return { ...VUOTO, erroreRimozione: true }
    }

    const rimossi = unici.filter((p) => riferiti.has(p))
    const daVerificare = unici.filter((p) => !riferiti.has(p))
    const giaAssenti: string[] = []
    const ancoraPresenti: string[] = []
    const incerti: string[] = []
    let primoErrore: unknown

    // A LOTTI, non una alla volta. Nel caso normale non c'è niente da verificare;
    // ma il caso che conta è quello anomalo — centinaia di percorsi da controllare
    // — e lì una richiesta dietro l'altra sfonderebbe il tempo massimo della
    // funzione. Un lavoro che SCADE non cancella niente e si ripresenta identico il
    // mese dopo: sarebbe di nuovo un blocco permanente, per un'altra strada.
    // Le risposte si consumano nell'ORDINE dei percorsi, non in ordine d'arrivo:
    // così l'esito non dipende da chi risponde prima.
    const LOTTO = 8
    for (let i = 0; i < daVerificare.length; i += LOTTO) {
        const gruppo = daVerificare.slice(i, i + LOTTO)
        const esiti = await Promise.all(gruppo.map((p) => ancoraNelBucket(supabase, bucket, p)))
        for (let k = 0; k < gruppo.length; k++) {
            const { presente, errore } = esiti[k]
            if (presente === null) {
                incerti.push(gruppo[k])
                if (primoErrore === undefined) primoErrore = errore
            } else if (presente) ancoraPresenti.push(gruppo[k])
            else giaAssenti.push(gruppo[k])
        }
    }

    if (giaAssenti.length > 0) {
        // Non è un guasto — ma va DETTO: è il segnale di una cancellazione già
        // avvenuta, o di un percorso scritto in tabella e mai caricato.
        logEvento('gdpr', 'info', {
            operazione: op,
            esito: 'file-gia-assenti',
            bucket,
            n_file: giaAssenti.length,
        })
    }
    if (ancoraPresenti.length > 0) {
        logEvento('storage', 'error', {
            operazione: op,
            esito: 'file-ancora-presenti',
            bucket,
            n_file: ancoraPresenti.length,
            msg: `${op}: ${ancoraPresenti.length} file non sono usciti dall'archivio e ci sono ancora`,
        })
    }
    if (incerti.length > 0) {
        // Una sola riga per chiamata, con il primo errore: N righe identiche non
        // aggiungono niente e affogano il canale.
        logEvento(
            'storage',
            'error',
            {
                operazione: op,
                esito: 'verifica-file-non-riuscita',
                bucket,
                n_file: incerti.length,
                msg: `${op}: non si è potuto sapere se ${incerti.length} file siano ancora nell'archivio`,
            },
            primoErrore,
        )
    }

    return { rimossi, giaAssenti, ancoraPresenti, incerti, erroreRimozione: false }
}
