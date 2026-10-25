import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { aBlocchi } from '@/lib/db/blocchi'
import { fascicoloAncheNelCestino } from '@/lib/primaria/cestino-fascicolo'

/**
 * GLI ALLEGATI DI UNA DOMANDA CHE QUALCUN ALTRO NOMINA ANCORA — robustezza 2, sessione 1 (D9).
 *
 * L'import di una domanda copia il percorso del documento d'identità nell'anagrafica
 * (`alunni.documento_path`, `parents.documento_path`): domanda e anagrafica puntano allo STESSO
 * file di `form_attachments`. Misurato il 20/10: 243 alunni su 243 con un documento hanno lo
 * stesso file della loro domanda. Chi toglie gli allegati di una domanda deve quindi chiedere
 * prima se un'anagrafica, o un documento del fascicolo, li nomina ancora.
 *
 * «NON LO SO» NON È «NESSUNO». Una lettura fallita restituisce `verificato: false` e chi chiama
 * non toglie niente. È lo stesso verso di `documentoCondiviso` (`src/lib/alunni/elimina-definitivo.ts`)
 * e di `percorsiCitatiDaAltriPost` (`src/lib/news/permanenza-consenso.ts`).
 *
 * A BLOCCHI. `.in()` finisce nell'URL: 25 percorsi di un centinaio di caratteri stanno larghi nei
 * limiti di una richiesta. Una risposta per blocco resta lontana dalle 1000 righe di PostgREST,
 * perché ogni percorso nasce con un uuid suo (`src/app/api/iscrizione/upload/route.ts:103`) e lo
 * nominano poche righe.
 *
 * SOLO `select` e `in`. Niente `order`, `limit` o `eq`: i test della conservazione che usano un
 * doppio piatto contano proprio quelle chiamate, e qui non servono.
 *
 * UN PERCORSO CHE IL FILTRO NON SA PORTARE NON VA ALLA QUERY. `documento_path` arriva dal modulo
 * pubblico senza vincoli di forma. postgrest-js (`in()`) mette fra virgolette solo i valori con
 * `,` `(` `)` e non fa l'escape di `"` né di `\`; PostgREST, dentro le virgolette, legge `"` come
 * fine del valore e `\` come escape del carattere dopo. Così `x")` rompe il filtro (errore di
 * parsing, e il giro mensile resterebbe a 500 per sempre) e `x\(1)` diventa `x(1)`, che non trova
 * più il file e lo farebbe sembrare di nessuno. Un `NUL` lo rifiuta Postgres; gli altri caratteri
 * di controllo restano fuori per prudenza. Parentesi, virgole, spazi e `[ ]` invece arrivano
 * intatti, e vanno alla query come tutti.
 * Un percorso con `"`, `\` o un carattere di controllo non l'ha scritto l'upload
 * (`src/app/api/iscrizione/upload/route.ts` tiene solo `[a-zA-Z0-9._-]`): non si sa che cosa sia,
 * quindi si tratta come CITATO, cioè non si toglie dal bucket. Il log ne porta solo il numero.
 *
 * NEL LOG, DI UN ERRORE DI POSTGREST, SOLO IL CODICE. Il suo messaggio può ripetere il filtro, cioè
 * fino a 25 percorsi di altre famiglie, e `sanificaMessaggio` toglie email e codici fiscali, non i
 * nomi che un file caricato può portare.
 */

export const PERCORSI_PER_QUERY = 25

export type EsitoCitazioni =
    | { verificato: true; citati: ReadonlySet<string> }
    | { verificato: false }

type Lettura = PromiseLike<{ data: unknown; error: unknown }>

interface Sorgente {
    tabella: 'alunni' | 'parents' | 'student_documents'
    colonna: 'documento_path' | 'storage_path' | 'file_url'
    leggi: (supabase: SupabaseClient, blocco: string[]) => Lettura
}

const MOTIVO_FASCICOLO =
    'la conservazione delle domande non toglie dal bucket un file che un documento del fascicolo nomina ancora, anche dal cestino: il Ripristina restituirebbe un documento senza file'

function leggiFascicolo(supabase: SupabaseClient, colonna: 'storage_path' | 'file_url', blocco: string[]): Lettura {
    return fascicoloAncheNelCestino(
        supabase.from('student_documents').select(colonna).in(colonna, blocco),
        MOTIVO_FASCICOLO,
    )
}

const SORGENTI: readonly Sorgente[] = [
    {
        tabella: 'alunni',
        colonna: 'documento_path',
        leggi: (s, b) => s.from('alunni').select('documento_path').in('documento_path', b),
    },
    {
        tabella: 'parents',
        colonna: 'documento_path',
        leggi: (s, b) => s.from('parents').select('documento_path').in('documento_path', b),
    },
    { tabella: 'student_documents', colonna: 'storage_path', leggi: (s, b) => leggiFascicolo(s, 'storage_path', b) },
    { tabella: 'student_documents', colonna: 'file_url', leggi: (s, b) => leggiFascicolo(s, 'file_url', b) },
]

/** `"`, `\` e i caratteri di controllo: quello che `in.(…)` non porta intatto (vedi in testa). */
function interrogabile(percorso: string): boolean {
    for (let i = 0; i < percorso.length; i++) {
        const c = percorso.charCodeAt(i)
        if (c < 0x20 || c === 0x7f || c === 0x22 || c === 0x5c) return false
    }
    return true
}

/** L'errore di PostgREST ridotto al codice (e allo status, se c'è): il messaggio resta fuori. */
function soloIlCodice(error: unknown): Error {
    const o = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; status?: unknown }
    const codice = typeof o.code === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(o.code) ? o.code : 'senza-codice'
    const status = typeof o.status === 'number' && Number.isInteger(o.status) ? o.status : undefined
    const testo = status === undefined ? `postgrest:${codice}` : `postgrest:${codice}:${status}`
    return Object.assign(new Error(testo), status === undefined ? { code: codice } : { code: codice, status })
}

/**
 * Quali di questi percorsi sono ancora nominati da un'anagrafica o dal fascicolo.
 *
 * @param percorsi i percorsi degli allegati, nel bucket `form_attachments`.
 * @param op       l'operazione che chiede, per il log (la costante `JOB` della route).
 */
export async function percorsiCitati(
    supabase: SupabaseClient,
    percorsi: readonly string[],
    op: string,
): Promise<EsitoCitazioni> {
    const cercati = [
        ...new Set(percorsi.map((p) => (typeof p === 'string' ? p.trim() : '')).filter((p) => p !== '')),
    ]
    const citati = new Set<string>()
    if (cercati.length === 0) return { verificato: true, citati }

    // Quelli che il filtro non porterebbe intatti restano dove sono, senza chiederlo a nessuno.
    const interrogabili = cercati.filter(interrogabile)
    const nonInterrogabili = cercati.filter((p) => !interrogabile(p))
    for (const p of nonInterrogabili) citati.add(p)
    if (nonInterrogabili.length > 0) {
        logEvento('gdpr', 'info', {
            operazione: op,
            esito: 'percorsi-non-interrogabili',
            n_file: nonInterrogabili.length,
            msg: `${op}: ${nonInterrogabili.length} allegati hanno un percorso con " o \\ o un carattere di controllo, che il filtro di PostgREST non porta intatto: non si chiedono e non si tolgono`,
        })
    }
    const cercatiInsieme = new Set(interrogabili)

    for (const sorgente of SORGENTI) {
        for (const blocco of aBlocchi(interrogabili, PERCORSI_PER_QUERY)) {
            const { data, error } = await sorgente.leggi(supabase, blocco)
            // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo un guasto di
            // lettura diventerebbe «nessuno lo cita», e il file uscirebbe proprio quando se ne
            // sa di meno.
            if (error || !Array.isArray(data)) {
                logEvento(
                    'gdpr',
                    'error',
                    {
                        operazione: op,
                        esito: 'citazioni-non-lette',
                        entita_tipo: sorgente.tabella,
                        n_file: cercati.length,
                        msg: `${op}: non si è potuto sapere se ${sorgente.tabella}.${sorgente.colonna} nomina ancora questi allegati, quindi non si toglie niente`,
                    },
                    error ? soloIlCodice(error) : new Error('risposta senza righe'),
                )
                return { verificato: false }
            }
            for (const riga of data as Record<string, unknown>[]) {
                const valore = riga?.[sorgente.colonna]
                if (typeof valore === 'string' && cercatiInsieme.has(valore.trim())) citati.add(valore.trim())
            }
        }
    }
    return { verificato: true, citati }
}
