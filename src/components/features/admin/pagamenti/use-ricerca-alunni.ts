'use client'

// ─── CERCARE UN BAMBINO, DAI DUE POSTI CHE LO CHIEDONO ───────────────────────
//
// La stessa domanda — «quali bambini, fra quelli che posso gestire, rispondono a
// questo nome?» — la fanno due schermate: la casella del popup del movimento
// (`MovimentoDialog`, gruppo «Alunni») e la casella «Aggiungi un altro bambino»
// del pannello di composizione (`ComposizioneBonifico`). Una sola rotta
// (`GET /api/pagamenti/riconciliazione/alunni`), quindi una sola regola su
// QUANDO si parte, CHI vince se due risposte si accavallano e che cosa vuol dire
// un elenco vuoto.
//
// ─── PERCHÉ UN MODULO SUO, E NON UN'ESPORTAZIONE DI UNO DEI DUE ──────────────
// `MovimentoDialog` importa già `ComposizioneBonifico`, quindi il verso naturale
// ci sarebbe. Non si può: `__tests__/components/MovimentoDialog-componi-riapertura.test.tsx`
// **mocka l'intero modulo** `ComposizioneBonifico` con una factory che espone il
// solo componente. Un hook esportato da lì arriverebbe `undefined` al popup e
// farebbe cadere prove che non c'entrano niente con questo lavoro.
//
// ─── LE TRE REGOLE CHE NON SI RISCRIVONO DUE VOLTE ──────────────────────────
//  1 · SOTTO I DUE CARATTERI NON PARTE NIENTE, e si dice perché. Non è
//      un'ottimizzazione di rete: la soglia è la stessa del server (§3 della
//      rotta), che su `%a%` leggerebbe l'anagrafica di tre plessi. Lo stato
//      `corta` esiste apposta per poterlo SCRIVERE a schermo — un elenco vuoto
//      senza spiegazione si legge «quel bambino non c'è».
//  2 · UNA RICERCA FALLITA NON DIVENTA UN ELENCO VUOTO. «Non l'ho trovato» e
//      «non ho potuto guardare» hanno rimedi opposti, e il secondo travestito da
//      primo manda a creare una scheda per un bambino che esiste già. Lo stato
//      `errore` è distinto, e porta il CORPO della risposta (vedi sotto).
//      ⚠️ I MODI DI FALLIRE SONO TRE, NON DUE, e per un giro qui ce n'erano due:
//      la rete che non risponde (`catch`), il server che rifiuta (`!res.ok`) e
//      — quello che mancava — il **200 col corpo illeggibile**, che cadeva nel
//      ramo del successo e usciva come elenco vuoto senza nemmeno una riga di
//      log. Cioè proprio la cosa che questa regola dichiara di impedire, dentro
//      il file che la dichiara. Adesso è un `if` esplicito (`ricerca-alunni-
//      senza-dati`), con la sua prova: «200 COL CORPO ILLEGGIBILE» in
//      `__tests__/components/ComposizioneBonifico-dall-alunno.test.tsx`, vista
//      rossa togliendo il ramo.
//  3 · GUARDIA DI SORPASSO: l'ultima risposta ad ARRIVARE non è l'ultima a essere
//      stata CHIESTA, e chi torna in ritardo non deve scrivere nello stato. Il
//      precedente è `RiconciliazionePanel` («Sorpassata da una richiesta più
//      recente: si esce senza scrivere niente»).
//      ⚠️ A TENERLA FERMA È IL CLEANUP DELL'EFFETTO, NON UN CONTATORE — e la
//      distinzione è stata misurata, non supposta. React esegue il cleanup
//      (`attivo = false`, `clearTimeout`) PRIMA di rieseguire l'effetto: quando la
//      `fetch` di un'esecuzione sorpassata torna, quell'esecuzione è già spenta
//      dalla propria chiusura. Qui c'è stato anche un `epocaRef` sul modello di
//      `DialogoAggiungiLegame`, e `mia !== epoca.current` NON POTEVA essere vero
//      con `attivo` ancora vera: una condizione che nessuno avrebbe mai visto
//      scattare, cioè esattamente la riga che in questo repo ha già fatto danno —
//      una spiegazione che attribuisce la protezione a un meccanismo che non
//      protegge. Tolta. Quella vera è provata: «SORPASSO» in
//      `__tests__/components/ComposizioneBonifico-dall-alunno.test.tsx` risolve
//      due risposte in ordine INVERSO e pretende a schermo la seconda.
//
// ─── L'ERRORE SI TIENE COME CORPO, E SI TRADUCE AL RENDER ───────────────────
// Stessa nota di `ComposizioneBonifico`: tenere qui una stringa già tradotta
// obbligherebbe l'effetto a dipendere da `t`, e `useTranslations` restituisce una
// funzione NUOVA a ogni render (nel doppio dei test, sempre). Con `t` fra le
// dipendenze l'effetto ripartirebbe a ogni render, cioè una ricerca per render.
//
// 🔴 PRIVACY. Nei log non entra MAI il termine cercato — è un cognome o il codice
// fiscale di un minore — né un uuid di bambino: solo lo stato HTTP e il nome
// della classe d'errore. `logClient` ammette i soli livelli `warn`/`error`, quindi
// il successo su questo canale non si logga: il conteggio del riuscito lo scrive
// la rotta (`esito: 'ricerca-alunni'`), che è dove «quante volte» si conta senza
// mandare in giro chi si cercava.

import { useEffect, useState } from 'react'
import { formatEuro } from '@/lib/format/valuta'
import { logClient, nomeErrore } from '@/lib/logging/client'

/** Sotto questo non si interroga il server: è la stessa soglia della rotta. */
export const MINIMO_RICERCA_ALUNNI = 2

/** Il respiro fra un tasto e la richiesta. Lo stesso di `DialogoAggiungiLegame`. */
export const RITARDO_RICERCA_MS = 300

/** La pagina dell'incidente per il log: dove sta l'operatore, non dove va la fetch. */
const PAGINA = '/admin/pagamenti'

/**
 * Una riga di `GET …/riconciliazione/alunni`, nella forma esatta in cui esce
 * (`AlunnoRicerca`). I tre `null` sono l'unica cosa da leggere con attenzione, e
 * la rotta li spiega: `null` **non è zero**, è «non ho potuto guardare».
 */
export interface AlunnoTrovato {
    alunno_id: string
    /** «Cognome Nome», e solo per le sedi del perimetro. */
    nome: string
    classe_sezione: string | null
    scuola_id: string | null
    /** Ancora iscritto. Un `false` non toglie la riga: si incassa anche un arretrato. */
    attivo: boolean
    /** Quante voci con residuo. `null` = non letto, ≠ «nessuna». */
    voci_aperte: number | null
    /** Quanto residuo in totale. `null` come sopra. */
    residuo_aperto: number | null
    /** C'è un adulto che può pagare. `null` = non si è potuto stabilire. */
    ha_pagante: boolean | null
    /** Trovato per CODICE FISCALE, non per nome. Il codice non esce mai. */
    trovato_per_cf: boolean
}

/**
 * `inattiva` = campo vuoto · `corta` = meno di due caratteri (e lo si scrive) ·
 * `caricamento` · `pronta` · `errore`. Cinque, non quattro: «vuoto» e «troppo
 * corto» chiedono due frasi diverse, e «troppo corto» è quello che spiega perché
 * non sta succedendo niente.
 */
export type StatoRicercaAlunni = 'inattiva' | 'corta' | 'caricamento' | 'pronta' | 'errore'

export interface RisultatoRicercaAlunni {
    stato: StatoRicercaAlunni
    righe: readonly AlunnoTrovato[]
    /** uuid della sede → nome. Assente = plesso da non nominare, mai un uuid a schermo. */
    sedi: Record<string, string>
    /** L'elenco è tagliato: ci sono altri bambini oltre a questi. Si SCRIVE. */
    troncato: boolean
    /** Il corpo della risposta rifiutata: la frase la sceglie il render. */
    errore: { corpo: unknown } | null
}

interface CorpoRicerca {
    data?: unknown
    troncato?: unknown
    sedi?: unknown
}

/** Una riga qualunque ridotta alla forma che serve: mai un `as` cieco sul JSON. */
function rigaValida(v: unknown): AlunnoTrovato | null {
    const r = v as Partial<AlunnoTrovato> | null
    if (!r || typeof r.alunno_id !== 'string' || r.alunno_id === '') return null
    const numeroOpzionale = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
    return {
        alunno_id: r.alunno_id,
        nome: typeof r.nome === 'string' && r.nome !== '' ? r.nome : '',
        classe_sezione: typeof r.classe_sezione === 'string' ? r.classe_sezione : null,
        scuola_id: typeof r.scuola_id === 'string' ? r.scuola_id : null,
        // Assente = attivo: è il degrado APERTO che la rotta dichiara quando la
        // colonna `stato` non esiste (DB E2E della CI, non migrato). Chiudere qui
        // direbbe «non più iscritto» di ogni bambino perché uno schema è indietro.
        attivo: r.attivo !== false,
        voci_aperte: numeroOpzionale(r.voci_aperte),
        residuo_aperto: numeroOpzionale(r.residuo_aperto),
        ha_pagante: typeof r.ha_pagante === 'boolean' ? r.ha_pagante : null,
        trovato_per_cf: r.trovato_per_cf === true,
    }
}

function sediValide(v: unknown): Record<string, string> {
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [k, nome] of Object.entries(v as Record<string, unknown>)) {
        if (typeof nome === 'string' && nome !== '') out[k] = nome
    }
    return out
}

/**
 * Il `t` di next-intl come PARAMETRO, non come import: questo modulo non è un
 * componente e non può chiamare `useTranslations`. La forma è quella che il repo
 * usa già per `timeAgo` in `ChatThreadList.tsx`; l'unica differenza è che qui fra
 * i valori c'è anche una stringa — l'importo già formattato — e non solo numeri.
 */
export type TraduciRicerca = (chiave: string, valori?: Record<string, string | number>) => string

/**
 * Che cosa si legge accanto al nome di un bambino trovato: classe, plesso (solo
 * se i plessi in elenco sono più d'uno — altrimenti è la stessa parola su ogni
 * riga), le voci aperte e le due note che cambiano la decisione di chi incassa.
 *
 * 🔴 `voci_aperte: null` NON È ZERO, e questa è la riga per cui la funzione sta
 * QUI e non in due copie dentro i due componenti. La rotta lo dichiara: `null`
 * vuol dire «non ho potuto contare», e scrivere «nessuna voce aperta» al suo
 * posto direbbe a chi sta incassando che quella famiglia non deve niente.
 * ⚠️ Finché la regola è stata scritta due volte, le due copie potevano divergere
 * in silenzio — e la mutazione l'ha dimostrato: sostituito il ramo `null` con
 * «nessuna voce aperta», settantun prove restavano verdi. Il posto adesso è uno
 * solo, e ha la sua prova: «`voci_aperte: null` NON È ZERO» in
 * `__tests__/components/MovimentoDialog.test.tsx`, che è rossa se questo ramo
 * cambia. `attivo: false` e `trovato_per_cf` sono coperti dalla stessa.
 *
 * ⚠️ `t` NON entra in nessuna dipendenza di effetto: `useTranslations` restituisce
 * una funzione nuova a ogni render, e questa si chiama al RENDER (vedi la nota
 * sull'errore tenuto come corpo, in testata).
 */
export function dettaglioAlunno(
    a: AlunnoTrovato,
    sedi: Record<string, string>,
    t: TraduciRicerca,
): string {
    const pezzi: string[] = []
    if (a.classe_sezione) pezzi.push(a.classe_sezione)
    if (Object.keys(sedi).length > 1 && a.scuola_id && sedi[a.scuola_id]) {
        pezzi.push(sedi[a.scuola_id])
    }
    if (a.voci_aperte === null || a.residuo_aperto === null) {
        pezzi.push(t('reconRicercaAlunniVociIgnote'))
    } else if (a.voci_aperte === 0) {
        pezzi.push(t('reconRicercaAlunniNessunaVoce'))
    } else {
        pezzi.push(
            t('reconRicercaAlunniVoci', {
                n: a.voci_aperte,
                totale: formatEuro(a.residuo_aperto),
            }),
        )
    }
    if (!a.attivo) pezzi.push(t('reconRicercaAlunniRitirato'))
    if (a.trovato_per_cf) pezzi.push(t('reconRicercaAlunniPerCf'))
    return pezzi.join(' · ')
}

/**
 * CHE COSA ANNUNCIA LA REGIONE VIVA — una regola sola, per tutt'e due le caselle.
 *
 * ⚠️ QUATTRO FRASI, NON TRE, e ciascuna esiste perché la sua assenza fa concludere
 * una cosa falsa: «almeno due caratteri» spiega perché non sta succedendo niente
 * (senza, un elenco vuoto si legge «quel bambino non c'è»), «sto cercando» dice
 * che l'attesa è attesa e non un esito, «non ho potuto guardare» non è «non
 * l'ho trovato» — i rimedi sono opposti — e «elenco troncato» è l'unica cosa che
 * impedisce di concludere «non c'è» da una lista tagliata al ventesimo nome.
 * Il `'inattiva'` non ha frase apposta: campo vuoto, niente da annunciare.
 *
 * ⚠️ È QUI PER LA STESSA RAGIONE DI `dettaglioAlunno`, E LA RAGIONE È STATA
 * MISURATA. Questa funzione era scritta DUE volte, identica, nei due componenti —
 * `fraseRicerca` in `ComposizioneBonifico` e `fraseRicercaAlunni` in
 * `MovimentoDialog` — nello stesso lavoro che estraeva `dettaglioAlunno` proprio
 * per non tenerne due copie. Le due copie divergevano già in silenzio: sostituito
 * `reconRicercaAlunniInCorso` con una stringa qualunque in TUTT'E DUE i file,
 * centodiciannove prove restavano verdi; collassato il ramo del troncamento nel
 * solo pannello, idem. Il posto adesso è uno, e i due rami che nessuno teneva
 * fermi hanno la loro prova in
 * `__tests__/components/ComposizioneBonifico-dall-alunno.test.tsx` — i nomi si
 * cercano così come sono scritti: «LA REGIONE VIVA DICE CHE STA CERCANDO» e
 * «ELENCO TRONCATO nel pannello» — entrambe viste fallire sulla mutazione.
 *
 * ⚠️ `t` come parametro e non fra le dipendenze di un effetto: vedi la testata.
 */
export function fraseRicercaAlunni(r: RisultatoRicercaAlunni, t: TraduciRicerca): string {
    if (r.stato === 'corta') return t('reconRicercaAlunniMinimo', { n: MINIMO_RICERCA_ALUNNI })
    if (r.stato === 'caricamento') return t('reconRicercaAlunniInCorso')
    if (r.stato === 'errore') return t('reconRicercaAlunniNonRiuscita')
    if (r.stato === 'pronta') {
        return r.troncato
            ? t('reconRicercaAlunniTroncata', { n: r.righe.length })
            : t('reconRicercaAlunniTrovati', { n: r.righe.length })
    }
    return ''
}

/**
 * La ricerca dei bambini, con debounce, soglia, guardia di sorpasso e stato
 * d'errore distinto dall'elenco vuoto.
 *
 * @param termine  ciò che è stato digitato, grezzo: la ripulitura è del server.
 * @param userId   l'identità come la manda il resto di Contabilità; `''` = solo cookie.
 */
export function useRicercaAlunni(termine: string, userId: string): RisultatoRicercaAlunni {
    const [stato, setStato] = useState<StatoRicercaAlunni>('inattiva')
    const [righe, setRighe] = useState<readonly AlunnoTrovato[]>([])
    const [sedi, setSedi] = useState<Record<string, string>>({})
    const [troncato, setTroncato] = useState(false)
    const [errore, setErrore] = useState<{ corpo: unknown } | null>(null)

    useEffect(() => {
        // `attivo` è la guardia di sorpasso per intero (vedi la regola 3 in
        // testata): vive quanto questa esecuzione dell'effetto, e la chiusura qui
        // sotto la spegne prima che ne parta un'altra.
        let attivo = true
        const q = termine.trim()
        // ⚠️ NIENTE `setState` NEL CORPO DELL'EFFETTO — nemmeno la guardia della
        // soglia: `react-hooks/set-state-in-effect` è un ERRORE del gate in questo
        // repo. Sta tutto dentro il timer, come in `DialogoAggiungiLegame`.
        const timer = setTimeout(() => {
            if (q.length < MINIMO_RICERCA_ALUNNI) {
                if (!attivo) return
                setRighe([])
                setSedi({})
                setTroncato(false)
                setErrore(null)
                setStato(q.length === 0 ? 'inattiva' : 'corta')
                return
            }
            if (attivo) setStato('caricamento')
            void (async () => {
                try {
                    const coda = new URLSearchParams({ q })
                    if (userId) coda.set('userId', userId)
                    const res = await fetch(
                        `/api/pagamenti/riconciliazione/alunni?${coda.toString()}`,
                        { headers: userId ? { 'x-user-id': userId } : undefined },
                    )
                    // `null` qui non è ingoiato (AGENTS.md, regola 6): è il
                    // segnale «corpo illeggibile», e lo raccoglie — loggandolo —
                    // il ramo «200 senza dati» qui sotto. Il `catch` non logga
                    // perché a questo punto non si sa ancora se la risposta era
                    // un rifiuto (che ha già il suo log, col corpo) o un 200.
                    const corpo = (await res.json().catch(() => null)) as CorpoRicerca | null
                    // Sorpassata da una richiesta più recente — cioè chiusa dal
                    // cleanup prima di questo `await`: si esce senza scrivere
                    // niente. Non è un'ottimizzazione, è correttezza.
                    if (!attivo) return
                    if (!res.ok) {
                        setRighe([])
                        setSedi({})
                        setTroncato(false)
                        setErrore({ corpo })
                        setStato('errore')
                        logClient({
                            livello: 'error',
                            evento: 'fetch',
                            messaggio: 'ricerca-alunni-rifiutata',
                            route: PAGINA,
                            stato: res.status,
                        })
                        return
                    }
                    // ⚠️ 200 CON IL CORPO ILLEGGIBILE — la regola 2 della testata
                    // applicata dove la si sbagliava. Connessione che cade a metà
                    // body su rete mobile, o un proxy che risponde 200 con una
                    // pagina che non è JSON: `corpo` è `null`, oppure `data` non è
                    // un array. Costruire l'elenco lo stesso lo farebbe uscire
                    // VUOTO, e un elenco vuoto a schermo si legge «quel bambino non
                    // c'è» — cioè «non ho potuto guardare» travestito da «non l'ho
                    // trovato», col rimedio opposto: si va a creare la scheda di un
                    // bambino che esiste già. La stessa forma che
                    // `ComposizioneBonifico` usa sul contesto senza dati
                    // (`conciliazione-contesto-senza-dati`).
                    if (!corpo || !Array.isArray(corpo.data)) {
                        setRighe([])
                        setSedi({})
                        setTroncato(false)
                        setErrore({ corpo: null })
                        setStato('errore')
                        logClient({
                            livello: 'error',
                            evento: 'fetch',
                            messaggio: 'ricerca-alunni-senza-dati',
                            route: PAGINA,
                            stato: res.status,
                        })
                        return
                    }
                    const elenco = (corpo.data as unknown[])
                        .map(rigaValida)
                        .filter((r): r is AlunnoTrovato => r !== null)
                    setRighe(elenco)
                    setSedi(sediValide(corpo.sedi))
                    setTroncato(corpo.troncato === true)
                    setErrore(null)
                    setStato('pronta')
                } catch (err) {
                    if (!attivo) return
                    setRighe([])
                    setSedi({})
                    setTroncato(false)
                    // Corpo `null`: non c'è niente da leggere, la frase è il ripiego
                    // del chiamante. Ciò che NON si fa è lasciare l'elenco di prima.
                    setErrore({ corpo: null })
                    setStato('errore')
                    logClient({
                        livello: 'error',
                        evento: 'fetch',
                        messaggio: `ricerca-alunni-rete: ${nomeErrore(err)}`,
                        route: PAGINA,
                        stato: 0,
                    })
                }
            })()
        }, RITARDO_RICERCA_MS)
        return () => {
            attivo = false
            clearTimeout(timer)
        }
        // ⚠️ `t` NON sta qui: vedi la nota sull'errore tenuto come corpo.
    }, [termine, userId])

    return { stato, righe, sedi, troncato, errore }
}
