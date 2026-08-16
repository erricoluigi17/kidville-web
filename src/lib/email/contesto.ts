import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvento } from '@/lib/logging/logger'
import { nomeSede } from '@/lib/scuole/reali'
import { componiIndirizzoSede, parseAnagraficaSede } from '@/lib/scuole/anagrafica'
import { appUrl } from './tema'

// =============================================================================
// L'identità della sede che sta scrivendo.
//
// ─── PERCHÉ È UN PARAMETRO E NON UNA COSTANTE ───────────────────────────────
// La fonte di design ha `SEDE` cablato su Giugliano — nome, indirizzo, recapiti.
// Dal 2026-07-29 «Kidville» non è il nome di una scuola: è il nome di tre
// (Giugliano, Aversa, Cesa). Un genitore che legge solo «Kidville» non sa a quale
// plesso è iscritto suo figlio, e non ha modo di accorgersi se lo hanno
// registrato in quello sbagliato — che è esattamente il difetto che l'audit
// multi-sede ha passato settimane a correggere lato server. Un'email che lo
// reintroduce nel testo lo rimette dove si vede di più.
//
// ─── LA REGOLA DELL'OMISSIONE ───────────────────────────────────────────────
// Ciò che manca si OMETTE, non si inventa e non si stampa vuoto. È già la regola
// scritta in `src/lib/scuole/anagrafica.ts`: «Tutti i campi opzionali: i
// documenti omettono ciò che manca, mai valori inventati». Qui vale due volte,
// perché un piè di pagina che stampa `Tel. ` seguito dal nulla, o un
// `mailto:` senza indirizzo, non è un dato mancante: è un difetto visibile in
// fondo a ogni email che la scuola manda.
//
// Conseguenza pratica per chi scrive un generatore: non si incolla un valore
// dentro una frase fissa. Si SCEGLIE la frase in base a ciò che c'è.
//
// ─── LE DUE COLONNE `indirizzo`, E QUALE DELLE DUE È LA FONTE ───────────────
// Esistono due tabelle di sede — `schools` e `scuole` — ed entrambe hanno una
// colonna `indirizzo`. La fonte è `scuole`. `schools.indirizzo` NON si legge, e
// la differenza non è pignoleria: fino al 2026-08-15 conteneva «Via Roma 1» per
// Giugliano, un SEGNAPOSTO, e stamparlo in fondo a ogni email del plesso più
// grande è peggio che non stampare niente — un dato falso non si distingue da
// uno vero, mentre un dato assente sì.
//
// ─── E `scuole.indirizzo` NON È PIÙ L'INDIRIZZO: È LA SOLA VIA ──────────────
// Fino al 2026-08-16 quella colonna conteneva la riga già scritta per esteso
// («Via Filippo Turati 2, 81030 Cesa (CE)»), e questo file la stampava tale e
// quale. Poi la spec §2.2 l'ha ridotta alla sola via — conteneva CAP, città e
// provincia, e `buildIntestazioneSede` ce li appendeva una seconda volta,
// producendo il «…Giugliano in Campania (NA) — Giugliano» finito stampato su un
// certificato vero.
//
// Quella riduzione ha spostato il problema qui: la riga completa da DATO è
// diventata CALCOLO, e questo file, leggendo la colonna grezza, avrebbe firmato
// tutte le email con mezzo indirizzo. Per questo si legge anche `citta` e si
// compone con `componiIndirizzoSede`, la stessa funzione che scrive la testata
// dei certificati: la scuola ha un indirizzo solo, e deve scriverlo in un modo
// solo.
// =============================================================================

export interface ContestoSede {
    /** Il nome del plesso. Mai indovinato: se non è risolvibile, «Kidville». */
    nome: string
    /** Indirizzo completo del plesso. Assente ⇒ la riga non compare. */
    indirizzo: string | null
    /** Casella del plesso. Assente ⇒ né la riga né il `mailto:`. */
    email: string | null
    /** Recapito telefonico del plesso. Assente ⇒ né la riga né il `tel:`. */
    telefono: string | null
    /** Indirizzo pubblico dell'app, senza barra finale. */
    app: string
    /** Informativa privacy: la pagina esiste, `src/app/privacy`. */
    privacy: string
}

/** Il ripiego quando la sede non è nota: generico, mai un plesso a caso. */
export const KIDVILLE_GENERICO = 'Kidville'

/**
 * Costruisce un contesto senza toccare il database.
 *
 * Serve a due casi legittimi: l'email di cancellazione account (che non ha una
 * sede — e nominarne una a chi sta ripudiando il rapporto sarebbe sbagliato
 * oltre che inutile) e l'anteprima locale, che non ha un database.
 */
export function contestoSenzaSede(nome: string = KIDVILLE_GENERICO): ContestoSede {
    const app = appUrl()
    return { nome, indirizzo: null, email: null, telefono: null, app, privacy: `${app}/privacy` }
}

/**
 * Risolve l'identità della sede da uno `scuola_id`.
 *
 * Due letture, entrambe con degrado dichiarato:
 *  · il nome da `nomeSede()` (`schools.nome`), che è già il punto unico del
 *    progetto per nominare una sede in un testo che esce dall'app;
 *  · i recapiti da `scuole.config.anagrafica`, via `parseAnagraficaSede()`, che
 *    normalizza le stringhe vuote a `null` — quindi un campo compilato con degli
 *    spazi non può produrre un `Tel. ` orfano.
 *
 * Non lancia mai: un'email deve poter partire anche se l'anagrafica non si legge.
 * Ma non tace nemmeno — PostgREST non lancia, ritorna `{ error }`, e un ramo che
 * non si vede è un ramo che non si corregge.
 */
export async function risolviContestoSede(
    supabase: SupabaseClient,
    scuolaId: string | null | undefined,
    operazione: string,
): Promise<ContestoSede> {
    const base = contestoSenzaSede()
    if (!scuolaId) return base

    const nome = (await nomeSede(supabase, scuolaId, operazione)) ?? KIDVILLE_GENERICO

    const { data, error } = await supabase
        .from('scuole')
        .select('indirizzo, citta, config')
        .eq('id', scuolaId)
        .maybeSingle()

    if (error) {
        // `info` e non `error`: il piano B — piè di pagina col solo nome e la
        // ragione sociale — è completo e vero. Ma la riga serve, perché senza
        // «nessun recapito nelle email» e «anagrafica mai compilata» hanno lo
        // stesso aspetto.
        logEvento('multi_sede', 'info', { operazione, esito: 'anagrafica-sede-non-letta', sede_id: scuolaId }, error)
        return { ...base, nome }
    }

    const riga = data as { indirizzo?: string | null; citta?: string | null; config?: unknown } | null
    const a = parseAnagraficaSede(riga?.config)
    return {
        ...base,
        nome,
        // La colonna da sola NON è più l'indirizzo: è la sola via. La riga
        // completa si compone, e si compone con la stessa funzione che scrive la
        // testata dei certificati — vedi il commento sopra.
        indirizzo: componiIndirizzoSede({
            indirizzo: riga?.indirizzo,
            cap: a.cap,
            citta: riga?.citta,
            provincia: a.provincia,
        }),
        email: nonVuoto(a.email),
        telefono: nonVuoto(a.telefono),
    }
}

/** Trim; stringa vuota ⇒ `null`. Un campo pieno di spazi non è un recapito. */
function nonVuoto(v: string | null | undefined): string | null {
    const t = (v ?? '').trim()
    return t === '' ? null : t
}
