// Cancellazione degli allegati — la metà mancante di `storage.ts`.
//
// PERCHÉ ESISTE. Fino al 2026-08-01 in tutto `src/lib/allegati/**` non c'era una
// sola `.remove()`: si sapeva firmare un allegato, non liberarsene. Cancellato
// l'avviso, il file restava archiviato per sempre — il collaudo del 31/07 ha
// trovato in `avvisi_allegati` un oggetto che nessuna riga referenziava. Il
// bucket è privato da quel giorno, quindi non è materiale scaricabile da
// chiunque; ma un allegato di una comunicazione scolastica — il modulo di una
// gita coi nomi dei bambini, un certificato, un verbale — conservato dopo che la
// comunicazione non esiste più è un dato tenuto senza più uno scopo.
//
// PERCHÉ È UN FILE A PARTE E NON IN `storage.ts`. Perché il 2026-08-01
// `storage.ts` è in mano a un altro intervento in corso (l'uscita della chat dal
// link eterno). Due mani sullo stesso file si cancellano a vicenda. Quando quel
// lavoro è chiuso, queste funzioni vanno riportate accanto alle loro gemelle:
// stanno alla firma come il `delete` sta al `select`, e il commento in testa a
// `storage.ts` avverte già che «una seconda forma inventata altrove sarebbe una
// seconda cosa da tenere allineata».

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { BUCKET_AVVISI_ALLEGATI, percorsoNelBucket } from '@/lib/allegati/storage'

/**
 * Il minimo indispensabile del client per CANCELLARE. Tenuto separato da quello
 * che firma: chi ha in mano un client per firmare non deve poter cancellare per
 * distrazione di tipi.
 */
export type ClientStorageRimozione = {
    storage: {
        from: (bucket: string) => {
            remove: (percorsi: string[]) => Promise<{ data: unknown; error: unknown }>
        }
    }
}

/**
 * Il PERCORSO nel bucket dell'allegato di un avviso, o `null` se non c'è niente
 * di nostro da cancellare.
 *
 * `avvisi.attachment_url` ha tre forme, tutte vive nel dato: il JSON
 * `{"file": …, "link": …}` prodotto dal modulo di oggi, la stringa nuda delle
 * righe più vecchie, e l'URL intero (pubblico o firmato) di quando il bucket era
 * aperto. Il `link` è un indirizzo altrui — il sito del Comune, un modulo online
 * — e non si tocca: `percorsoNelBucket` risponde `null` per tutto ciò che non
 * appartiene a questo bucket.
 *
 * SUL JSON MALFORMATO QUESTA FUNZIONE È PIÙ PRUDENTE DELLA SUA GEMELLA che
 * firma: `decodificaAllegatoAvviso` lo tratta come stringa nuda e prova a
 * firmarlo lo stesso (al peggio esce un link rotto, e l'errore si vede); qui
 * invece non si cancella niente. Firmare un percorso sbagliato produce un
 * allegato che non si apre; cancellare un percorso sbagliato produce un file
 * perso, e un file perso non si recupera.
 */
export function percorsoAllegatoAvviso(valore: string | null | undefined): string | null {
    const v = (valore ?? '').trim()
    if (!v) return null

    let file: string | null = v
    if (v.startsWith('{')) {
        try {
            const p = JSON.parse(v) as { file?: unknown }
            file = typeof p.file === 'string' && p.file.trim() !== '' ? p.file : null
        } catch (err) {
            // Un catch che non logga è un bug (AGENTS §6). `info` e non `error`:
            // non è un guasto, è un dato storico malformato — ma la riga ci vuole,
            // perché la conseguenza è che un file NON viene cancellato e nessuno
            // se ne accorgerebbe mai. Il valore non esce: `attachment_url` è un
            // percorso, e in questo repo un percorso è una credenziale. Esce la
            // sola lunghezza.
            logEvento('storage', 'info', {
                operazione: 'percorsoAllegatoAvviso',
                esito: 'json-malformato-nessuna-rimozione',
                lunghezza: v.length,
            }, err)
            return null
        }
    }
    return percorsoNelBucket(BUCKET_AVVISI_ALLEGATI, file)
}

/**
 * Cancella oggetti da un bucket, e lo DICE — sia quando riesce sia quando no.
 *
 * BEST-EFFORT, MAI SILENZIOSA. Nessun guasto qui deve far fallire l'operazione
 * che l'ha chiamata: quando si arriva a cancellare il file, la riga è già stata
 * cancellata dal database, e rispondere 500 direbbe a chi ha premuto «Elimina»
 * una cosa falsa — lo farebbe riprovare, ottenendo un 404. Ma nessun guasto resta
 * senza riga: qui è l'unico posto in cui quel fatto può esistere. L'errore del
 * provider si passa INTERO (AGENTS §3): «rimozione non riuscita» non dice niente,
 * «Object not found» dice tutto.
 *
 * NEI LOG SOLO CONTEGGI E IL NOME DEL BUCKET: il nome di un allegato dice di che
 * comunicazione si tratta, e non è materia da riga di log.
 *
 * @returns quanti oggetti lo Storage dichiara di aver rimosso (0 su guasto).
 */
export async function rimuoviDalBucket(
    supabase: ClientStorageRimozione,
    bucket: string,
    percorsi: string[],
    operazione: string,
): Promise<number> {
    if (percorsi.length === 0) return 0
    try {
        const { data, error } = await supabase.storage.from(bucket).remove(percorsi)
        if (error) {
            logEvento('storage', 'error', {
                operazione,
                esito: 'rimozione-non-riuscita',
                bucket,
                n_percorsi: percorsi.length,
            }, error)
            return 0
        }
        // Un percorso inesistente NON è un errore per lo Storage: esce
        // semplicemente dalla lista dei rimossi. Il conteggio serve proprio a
        // distinguere «cancellato adesso» da «non c'era già più».
        const rimossi = Array.isArray(data) ? data.length : 0
        logEvento('storage', 'info', {
            operazione,
            esito: 'allegati-rimossi',
            bucket,
            n_percorsi: percorsi.length,
            n_rimossi: rimossi,
        })
        return rimossi
    } catch (e) {
        // Guasto di TRASPORTO: `remove` non ritorna, lancia. Senza questo ramo una
        // cancellazione andata a buon fine risponderebbe 500.
        logEvento('storage', 'error', {
            operazione,
            esito: 'rimozione-non-eseguita',
            bucket,
            n_percorsi: percorsi.length,
        }, e)
        return 0
    }
}

/**
 * Il percorso nel bucket dell'allegato ARCHIVIATO su un avviso, cioè il file che
 * resterebbe orfano. `null` se non c'è niente di nostro da cancellare (nessun
 * allegato, o solo un link esterno).
 *
 * Va letto PRIMA di cancellare o di sovrascrivere la riga: dopo, quale file
 * fosse non lo sa più nessuno.
 *
 * ⚠️ NON È UN GATE, e non deve essere scambiata per tale: legge una riga per
 * `id`, e basta. Chi la chiama ha già verificato che quell'avviso sia suo
 * (`assertAvvisoInScope`, nelle tre rotte di `avvisi/[id]`). Sta qui e non nella
 * route perché il lock dell'isolamento (`isolamento-sede-coverage`) ragiona per
 * HANDLER: una funzione di modulo dentro `src/app/api/**` gli risulterebbe priva
 * di scope pur essendo chiamata solo dietro al gate — e un lock che segnala il
 * falso si impara a ignorare.
 */
export async function percorsoAllegatoArchiviatoAvviso(
    supabase: SupabaseClient,
    avvisoId: string,
    operazione: string,
): Promise<string | null> {
    const { data, error } = await supabase
        .from('avvisi')
        .select('attachment_url')
        .eq('id', avvisoId)
        .maybeSingle()
    if (error) {
        // PostgREST non lancia: senza questo controllo il guasto passerebbe per
        // «nessun allegato». `warn` e non `error`: la cancellazione dell'avviso —
        // che è quello che l'utente ha chiesto — va avanti lo stesso; l'unica
        // conseguenza è un file che resta, cioè lo stato di prima.
        logEvento('storage', 'warn', { operazione, esito: 'allegato-non-letto' }, error)
        return null
    }
    return percorsoAllegatoAvviso((data as { attachment_url?: string | null } | null)?.attachment_url)
}

/**
 * Cancella l'allegato di un avviso, ma solo se non lo sta usando NESSUN ALTRO
 * avviso.
 *
 * PERCHÉ IL CONTROLLO ESISTE. `PUT /api/avvisi/<id>` accetta `attachment_url`
 * dal client: nulla vieta di far puntare il proprio avviso al percorso
 * dell'allegato di un altro (il percorso si legge dal link firmato che la
 * bacheca restituisce). Senza questa verifica, cancellare il proprio avviso
 * cancellerebbe il file di quell'altro — e un file cancellato non si recupera.
 * Nel dubbio, compresa la ricerca che non riesce, il file RESTA: l'errore
 * reversibile è tenere un oggetto di troppo, non perderne uno.
 *
 * ⚠️ LA RICERCA È DELIBERATAMENTE SENZA FILTRO DI SEDE, ed è l'unica riga di
 * questo modulo per cui vale la pena fermarsi. Il bucket è UNO per tutte e tre
 * le sedi: se un avviso di Aversa punta a questo oggetto, cancellarlo perché
 * l'attore è di Giugliano romperebbe l'allegato di Aversa. Filtrare per plesso
 * qui renderebbe il controllo MENO sicuro, non più. Non esce niente: della
 * riga trovata si usa solo l'esistenza (`limit(1)`), mai un campo — nessun
 * titolo, nessun contenuto, nessun uuid di un'altra sede.
 *
 * @returns quanti oggetti sono stati rimossi (0 anche quando è giusto non farlo).
 */
export async function rimuoviAllegatoAvvisoSeOrfano(
    supabase: SupabaseClient,
    avvisoId: string,
    percorso: string | null,
    operazione: string,
): Promise<number> {
    return await rimuoviSeNessunAvvisoLoUsa(supabase, percorso, operazione, avvisoId)
}

/**
 * Cancella un allegato CARICATO E MAI PUBBLICATO: la bozza abbandonata (S35).
 *
 * È la gemella di sopra senza l'avviso da escludere, perché qui un avviso non c'è
 * ancora: il file è stato messo nel bucket dall'upload e il modulo è stato chiuso
 * (o l'allegato tolto) prima di pubblicare. Il controllo «nessuno lo referenzia»
 * resta identico, e resta indispensabile: fra il caricamento e la chiusura la
 * bozza può essere stata pubblicata in un'altra scheda, e allora quel file è
 * l'allegato di una comunicazione viva.
 *
 * ⚠️ NON È UN GATE DI IDENTITÀ. Questa funzione non sa CHI sta chiedendo la
 * rimozione: quello lo dimostra il sigillo (`./sigillo.ts`), che la route verifica
 * prima di arrivare qui. Chiamarla senza quel controllo significa offrire a
 * chiunque la cancellazione di qualunque file non ancora pubblicato.
 *
 * @returns quanti oggetti sono stati rimossi (0 anche quando è giusto non farlo).
 */
export async function rimuoviAllegatoNonPubblicato(
    supabase: SupabaseClient,
    percorso: string | null,
    operazione: string,
): Promise<number> {
    return await rimuoviSeNessunAvvisoLoUsa(supabase, percorso, operazione, null)
}

/**
 * Il corpo comune: si cancella solo se NESSUN avviso (escluso quello indicato)
 * punta a quel percorso. Una copia della query per ciascuna delle due gemelle
 * sarebbe una seconda cosa da tenere allineata, e quella che diverge sbaglia dal
 * lato che perde un file.
 */
async function rimuoviSeNessunAvvisoLoUsa(
    supabase: SupabaseClient,
    percorso: string | null,
    operazione: string,
    escludiAvvisoId: string | null,
): Promise<number> {
    if (!percorso) return 0

    // `ilike` copre tutte e tre le forme in cui il percorso può stare in tabella
    // (JSON `{file,link}`, stringa nuda, URL storico). I caratteri jolly di LIKE
    // non si neutralizzano: i nomi li genera l'upload (`<timestamp>-<rnd>.<ext>`)
    // e un jolly di troppo allarga la ricerca, cioè fa trovare un riferimento in
    // più — e un riferimento in più significa NON cancellare. Sbaglia dal lato
    // giusto.
    const base = supabase.from('avvisi').select('id')
    const conEsclusione = escludiAvvisoId ? base.neq('id', escludiAvvisoId) : base
    const { data: altri, error } = await conEsclusione
        .ilike('attachment_url', `%${percorso}%`)
        .limit(1)

    if (error) {
        // PostgREST non lancia: senza questo controllo un guasto di lettura
        // passerebbe per «nessun altro lo usa» e il file sparirebbe.
        logEvento('storage', 'warn', { operazione, esito: 'allegato-non-verificabile' }, error)
        return 0
    }
    if ((altri ?? []).length > 0) {
        logEvento('storage', 'info', { operazione, esito: 'allegato-ancora-riferito' })
        return 0
    }
    return await rimuoviDalBucket(supabase, BUCKET_AVVISI_ALLEGATI, [percorso], operazione)
}
