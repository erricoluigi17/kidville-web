'use client'

// ─── «COMPONI IL PAGAMENTO» — il pannello che ripartisce un bonifico ─────────
//
// Un bonifico di famiglia non paga quasi mai una voce sola: paga la retta, il
// pomeridiano e la ricarica dei ticket mensa, magari per due fratelli di plessi
// diversi. Finora un movimento bancario si abbinava a UNA voce. Questo pannello
// è la schermata che fa la ripartizione, e vive dentro il popup del movimento.
//
// ─── SI FA TUTTO DA SÉ, ED È IL CONTRATTO ───────────────────────────────────
// Chi lo monta non gli passa dati: legge `GET …/[id]/contesto` e registra con
// `POST …/[id]/componi`. Le uniche props sono l'identità del bonifico, i due
// numeri che servono prima che il contesto arrivi, e le due uscite.
//
// ⚠️ `alunniIniziali` NON È UN'ECCEZIONE A QUEL CONTRATTO, ed è la ragione per
// cui sta accanto a `movimentoId` e non fra i dati. Su un movimento ROSSO non ci
// sono suggerimenti, quindi il contesto non aveva bambini, quindi nessun genitore
// candidato, quindi la tendina dell'intestatario era vuota e «Conferma» restava
// spento: non c'era nessuna strada. Questa prop non è «un dato passato al
// pannello» — è l'IDENTITÀ DI CIÒ SU CUI SI STA LAVORANDO, esattamente come
// l'uuid del bonifico: dice SU QUALI BAMBINI si compone quando il bonifico non ne
// nomina nessuno. Tutto il resto — figli, voci, categorie, pacchetti, candidati —
// continua a leggerselo da sé, dalla stessa rotta di prima, che da oggi accetta
// `?alunni=` e verifica la sede PRIMA di usarli (404 fuori perimetro).
//
// ─── UN SOLO GATE, E NON È QUI ──────────────────────────────────────────────
// Per decidere se «Conferma» si può premere si chiama `puoConfermare(righe,
// importo)` di `@/lib/pagamenti/conciliazione-composita`, e nient'altro.
// Ricomporlo a mano — `violazioniRighe(...).length === 0 && quadra(...)` —
// compila, passa `tsc`, passa ogni lock, e lascia passare due righe sulla STESSA
// voce che insieme ne sforano il residuo. Le altre funzioni del motore servono a
// dire QUALE riga è sbagliata e perché, non a decidere.
// ⚠️ Nemmeno `proponiAllocazioneSuVoci` decide: può SOTTO-riempire la capienza
// (ogni id si consuma una volta sola), quindi una proposta non quadra per il
// fatto di essere una proposta. Quadra solo quando lo dice il gate.
//
// ─── LE DECISIONI DEL TITOLARE CHE QUESTO FILE ESEGUE ───────────────────────
//  2 · si agganciano voci esistenti E se ne creano di nuove, nella stessa schermata
//  3 · la categoria si sceglie solo fra quelle esistenti della sede
//  4 · le voci create nascono già saldate da questo bonifico (lo fa la RPC)
//  5 · la loro scadenza è la DATA DEL BONIFICO (`dataOperazione`)
//  6 · ticket: quantità × costo unitario, totale CALCOLATO e non digitabile
//  7 · il costo unitario è precompilato dal pacchetto della SEDE, modificabile
//  9 · l'alunno si sceglie riga per riga: nessuna preselezione, nemmeno con un
//      figlio solo — «indovinato» e «scelto» si assomigliano troppo su una riga
//      che mette a carico di una famiglia del denaro
// 10 · l'elenco mostra le voci aperte di TUTTI i figli della famiglia
// 11 · quadratura esatta e bloccante: niente eccedenza, niente residuo
// 12 · il pagante è dedotto e sempre modificabile
// 16 · una sola fattura, ancorata alla voce `retta`; senza retta, si sceglie
//
// ─── DUE COSE CHE IL SERVER SA E QUESTO PANNELLO NON DEVE RIFARE ────────────
//  · LA SEDE DI UNA RIGA SEGUE IL BAMBINO. La RPC deriva la sede della voce da
//    `alunni.scuola_id` e ignora apposta quella del payload: qui si fa lo stesso,
//    e la sede non è un campo che l'operatrice compila (il messaggio
//    `reconComponiErrSedeMancante` lo dice con le stesse parole). L'unica sede
//    che si SCEGLIE è quella del DOCUMENTO.
//  · IL NOME DI UN MINORE FUORI DALLE SEDI DELL'OPERATORE NON ESISTE. Il contesto
//    manda `nome: null` e il nome del PLESSO: si mostra il plesso, mai un nome
//    inventato, e la riga resta — due fratelli in due sedi sono il caso per cui
//    questa funzionalità esiste.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Search, Trash2, UserRoundPlus } from 'lucide-react'
import { cx } from '@/lib/ui/cx'
import { formatEuro } from '@/lib/format/valuta'
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { INPUT, SELECT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui'
import { DialogoAggiungiLegame } from '@/components/features/admin/legami/DialogoAggiungiLegame'
// Ricerca dei bambini, frasi della regione viva e «che cosa si legge accanto al
// nome» (classe, plesso, e `voci_aperte: null` che NON è zero): stanno tutte in
// `use-ricerca-alunni`, una volta sola, perché due copie divergono in silenzio.
import { dettaglioAlunno, fraseRicercaAlunni, useRicercaAlunni } from './use-ricerca-alunni'
import { CHIAVE_MOTIVO_PROPOSTA, MOTIVI_NOTI } from '@/lib/pagamenti/proposta-intestatario'
import {
    importoRiga,
    proponiAllocazioneSuVoci,
    proponiAncora,
    puoConfermare,
    rigaDaVoceAperta,
    scartoQuadratura,
    sediCoinvolte,
    totaleComposizione,
    totaleTicket,
    violazioniComposizione,
    violazioniRighe,
    type CodiceViolazione,
    type CodiceViolazioneComposizione,
    type RigaComposizione,
    type RigaNuova,
    type RigaTicket,
    type VoceApertaDb,
} from '@/lib/pagamenti/conciliazione-composita'

// ─── La forma della risposta di `…/contesto` ────────────────────────────────

interface FiglioCtx {
    alunno_id: string
    /** `null` per un figlio fuori dalle sedi dell'operatore: si mostra il PLESSO. */
    nome: string | null
    scuola_id: string | null
    in_sede: boolean
    /** Ancora iscritto? Su un `false` la scrittura rifiuta le voci NUOVE e i ticket. */
    attivo: boolean
    saldo_ticket: number
    voci_aperte: VoceApertaDb[]
}

interface CategoriaCtx {
    id: string
    nome: string
    slug: string | null
    scuola_id: string | null
}

interface PacchettoCtx {
    label: string
    pezzi: number
    costo: number
}

interface Contesto {
    movimento: {
        id: string
        importo: number
        data_operazione: string
        causale: string | null
        controparte: string | null
        stato: string
        scuola_id: string | null
    }
    pagante: {
        proposto: { parent_id: string; motivo: string } | null
        candidati: { parent_id: string; nome: string; relazione: string | null }[]
    }
    figli: FiglioCtx[]
    categorie: CategoriaCtx[]
    /** Una chiave per OGNI sede componibile, anche vuota: due sedi su tre lo sono. */
    pacchetti_ticket: Record<string, PacchettoCtx[]>
    sedi: Record<string, string>
}

// ─── Le righe in composizione, nella forma del FORM (stringhe, non numeri) ──

interface FormNuova {
    chiave: number
    alunnoId: string
    categoriaId: string
    descrizione: string
    importo: string
}

interface FormTicket {
    chiave: number
    alunnoId: string
    quantita: string
    costoUnitario: string
}

export interface RiepilogoComposizione {
    voci: number
    ticket: number
    totale: number
    /** `false` ⇒ incasso scritto, riga bancaria NON legata. Non è un successo pieno. */
    movimentoConfermato: boolean
}

interface Props {
    movimentoId: string
    importoMovimento: number
    /** La scadenza delle voci NUOVE (decisione n. 5): la data del bonifico. */
    dataOperazione: string
    /**
     * I bambini su cui puntare la composizione quando il bonifico non ne nomina
     * nessuno (vedi la testata: è IDENTITÀ, non dato). Viaggiano al contesto come
     * `?alunni=a,b`, che verifica la sede prima di usarli. Al massimo
     * `MAX_ALUNNI_COMPOSIZIONE`: oltre, la rotta risponde 400 con la sua `zod`.
     */
    alunniIniziali?: readonly string[]
    onFatto: (riepilogo: RiepilogoComposizione) => void
    onChiudi: () => void
}

/**
 * Quanti bambini può nominare una lettura del contesto. **Non è un numero scelto
 * qui**: è `MAX_ALUNNI_CHIESTI` della rotta `contesto`, dove lo impone uno
 * `z.array(...).max(...)`. Superarlo non «prende i primi cinque», fa 400 — quindi
 * il tetto si rispetta PRIMA, e a schermo si dice che si è arrivati in fondo.
 */
const MAX_ALUNNI_COMPOSIZIONE = 5

/** `alunno_mancante` → `reconComponiErrAlunnoMancante`. La stessa regola del lock. */
function chiaveDelCodice(codice: string): string {
    return `reconComponiErr${codice
        .split('_')
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join('')}`
}

const num = (v: string): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
}

/**
 * L'identità di una riga ticket ai fini della sede: la sede segue il bambino, e
 * finché il bambino non c'è la sede non si sa. Nessun ripiego «tanto la sede è
 * una sola»: un costo unitario preso dal plesso sbagliato è il prezzo di un'altra
 * mensa, e nessuno se ne accorgerebbe.
 */
function sedeDelFiglio(figli: FiglioCtx[], alunnoId: string): string | null {
    return figli.find((f) => f.alunno_id === alunnoId)?.scuola_id ?? null
}

export function ComposizioneBonifico({
    movimentoId,
    importoMovimento,
    dataOperazione,
    alunniIniziali,
    onFatto,
    onChiudi,
}: Props) {
    const t = useTranslations('adminContabilita')
    const uid = useId()
    const idTitolo = `${uid}-titolo`
    const idVoci = `${uid}-voci`
    const idMotivi = `${uid}-motivi`
    const idAggiungi = `${uid}-aggiungi`
    const idSenzaGenitore = `${uid}-senza-genitore`

    const [ctx, setCtx] = useState<Contesto | null>(null)
    const [caricamento, setCaricamento] = useState(true)
    /**
     * ⚠️ L'ERRORE SI TIENE COME CORPO, E SI TRADUCE AL RENDER. Tenerci una stringa
     * già tradotta obbligherebbe l'effetto che la produce a dipendere da `t` — e
     * `useTranslations` restituisce una funzione NUOVA a ogni render. Misurato: con
     * `t` fra le dipendenze, l'effetto di caricamento ripartiva a ogni render, e il
     * `setSpunte({})` che accompagna il cambio di pagante CANCELLAVA le righe appena
     * composte. La spunta spariva un istante dopo averla messa.
     */
    const [erroreCtx, setErroreCtx] = useState<{ corpo: unknown } | null>(null)
    /** `null` = non ancora scelto a mano: vale la proposta del server. */
    const [paganteScelto, setPaganteScelto] = useState<string | null>(null)
    /** Chiave = POSIZIONE nell'elenco piatto delle voci, valore = importo digitato.
     *  NON il `pagamentoId`: lo stesso id può comparire due volte (le voci aperte di
     *  due fratelli si concatenano), e indicizzare per id le collasserebbe in una —
     *  cioè nasconderebbe al gate proprio il doppio incasso che deve vedere. */
    const [spunte, setSpunte] = useState<Record<number, string>>({})
    const [nuove, setNuove] = useState<FormNuova[]>([])
    const [ticket, setTicket] = useState<FormTicket[]>([])
    const [sedeScelta, setSedeScelta] = useState('')
    /**
     * `''` = àncora proposta dal motore. Altrimenti `specie:indiceLocale`.
     *
     * ⚠️ È UNA POSIZIONE, NON UN'IDENTITÀ, E VA AZZERATA DA OGNI GESTO CHE RIORDINA.
     * La forma `specie:indice` non è una scorciatoia: è quella che il payload manda,
     * perché una voce che NASCE qui non ha ancora un uuid (lo risolve la RPC dopo
     * l'INSERT). Il prezzo è che un riordino cambia il significato di quel numero
     * senza toccarlo — l'indice resta 1 e sotto l'1 c'è un'altra riga — e da lì il
     * server ricava `body.voci[indice].pagamento_id`, cioè `ancora_pagamento_id`,
     * cioè l'INTESTATARIO DEL DOCUMENTO FISCALE (e la detrazione 730 di qualcuno).
     *
     * Perciò i CINQUE gesti che riordinano gli elenchi la azzerano tutti, senza
     * eccezioni: `commutaVoce` (nei due versi), `aggiungiVoce`, `aggiungiTicket` e i
     * due «Rimuovi voce». Azzerata, torna a valere la proposta del motore, che è
     * SEMPRE coerente con l'elenco di adesso — e si vede nella tendina.
     * Un bounds-check non basterebbe e sarebbe peggio: `indice: 1` dopo il riordino
     * esiste ancora, punta solo a un'altra riga. Il presidio è
     * `__tests__/components/ComposizioneBonifico.test.tsx`, «i CINQUE gesti che
     * riordinano azzerano l’àncora» (il nome è cercabile così com'è scritto): una
     * prova per gesto, e togliendo la riga da UNO dei cinque diventa rossa quella del
     * gesto corrispondente — misurato una mutazione alla volta, tutte e cinque.
     */
    const [ancoraScelta, setAncoraScelta] = useState('')
    const [invio, setInvio] = useState(false)
    /** Come `erroreCtx`: si tiene il corpo, la frase la sceglie il render. */
    const [erroreInvio, setErroreInvio] = useState<{ corpo: unknown } | null>(null)
    const [esito, setEsito] = useState<RiepilogoComposizione | null>(null)
    const [contatore, setContatore] = useState(0)
    /**
     * I bambini aggiunti a mano dalla casella «Aggiungi un altro bambino». Si
     * SOMMANO a `alunniIniziali` invece di sostituirli, e la somma è il valore
     * derivato `alunniScelti`: così una prop che cambia (il popup apre la
     * composizione su un altro bambino senza smontare il pannello) arriva, e una
     * scelta dell'operatrice non si perde.
     */
    const [alunniAggiunti, setAlunniAggiunti] = useState<readonly string[]>([])
    /** Ciò che è digitato nella casella di ricerca dei bambini. Grezzo: ripulisce il server. */
    const [termineAlunni, setTermineAlunni] = useState('')
    /**
     * Il segnale di RILETTURA del contesto — la stessa forma del `ricarica` di
     * `MovimentoDialog`, e per lo stesso motivo. Collegato un genitore, i
     * CANDIDATI cambiano ma né `movimentoId` né `alunniScelti` si muovono: senza
     * un dito in più nelle dipendenze, la tendina dell'intestatario resterebbe
     * vuota accanto al legame appena scritto. Un contatore, non una seconda fetch
     * scritta dentro `onCollegato`: la lettura esiste già qui sotto, con la sua
     * guardia `vivo`, il suo `catch` che LOGGA e il suo `finally`.
     */
    const [ricaricaCtx, setRicaricaCtx] = useState(0)
    /** Il bambino per cui è aperto `DialogoAggiungiLegame`, col nome da mostrargli. */
    const [legameAperto, setLegameAperto] = useState<{ alunnoId: string; nome: string } | null>(null)

    // ── Il contesto ─────────────────────────────────────────────────────────
    //
    // L'identità viaggia come la manda il resto di Contabilità (`?userId=`), e
    // NON è una prop: il contratto di questo pannello non ne ha una, e la rotta
    // `contesto` ha tolto `.strict()` dalla sua `zod` apposta per quel parametro.
    // Quando non c'è — app in produzione, sessione vera — resta il cookie, che è
    // ciò che `resolveIdentity` preferisce comunque.
    const identita = useCallback((): string => {
        try {
            const daUrl = new URLSearchParams(window.location.search).get('userId')
            if (daUrl) return daUrl
            return window.localStorage.getItem('kv_user_id') ?? ''
        } catch {
            // Storage negato o URL illeggibile: si prosegue col solo cookie. Non è
            // un guasto da segnalare — è il caso normale dell'app in produzione.
            return ''
        }
    }, [])

    /**
     * ⚠️ A TENERE FERMA LA LETTURA È `alunniQuery`, CIOÈ UNA STRINGA — non il
     * `useMemo`.
     *
     * Il pericolo è uno: un array NUOVO a ogni render messo fra le dipendenze
     * dell'effetto che carica il contesto rifarebbe la GET a ogni render, e ogni
     * GET azzera le righe — cioè le spunte sparirebbero un istante dopo averle
     * messe, che è esattamente il difetto già misurato qui con `t`. È la stessa
     * trappola documentata più sotto su `figli` («`useMemo` E NON `ctx?.figli ??
     * []`: l'array vuoto del ripiego è NUOVO a ogni render»).
     *
     * A impedirlo è che nelle dipendenze ci sia `alunniQuery`, una STRINGA:
     * React confronta le dipendenze per valore, e due stringhe uguali sono
     * uguali comunque siano state costruite. Da chi arrivi l'array a monte —
     * memoizzato o no, ricreato dal chiamante a ogni SUO render o no — smette di
     * contare nel momento in cui nelle dipendenze entra il `join(',')`. Quella
     * riga la tiene ferma un lock testuale, che legge la riga `}, [ … ])` del
     * sorgente (`__tests__/components/ComposizioneBonifico-dall-alunno.test.tsx`,
     * «LOCK · nella riga delle dipendenze»).
     *
     * ⚠️ IL `useMemo` QUI SOTTO NON È UNA SECONDA CINTURA: è stabilità di render.
     * `alunniScelti` non compare in NESSUN elenco di dipendenze — lo si usa solo
     * al render (l'elenco a schermo e il tetto dei cinque) — quindi memoizzarlo
     * risparmia ricostruzioni, non previene riletture. Torna a essere portante
     * SOLO se qualcuno rimette l'array nelle dipendenze, cioè solo passando sopra
     * al lock. Un `useMemo` va tenuto per ciò che fa, non con la storia che
     * protegga qualcosa che protegge un'altra riga.
     *
     * 📏 MISURATO IL 2026-09-20. **Qui non c'è nessun denominatore, ed è una
     * scelta**: il totale della suite non è un dato della mutazione, invecchia a
     * ogni prova che chiunque aggiunge a uno dei tre file, e in questo punto è già
     * invecchiato DUE volte — la seconda dentro lo stesso lotto che lo aveva
     * appena riscritto: qui c'era scritto 128, in consegna la stessa riga di
     * comando ne misurava 127 (tolti due casi da un `it.each`, aggiunta una
     * prova), e nel giro che sta scrivendo questa frase sono già 129, perché due
     * prove nuove tengono fermo il taglio a cinque qui sotto. Tre valori in due
     * giorni per un numero che nessuna mutazione ha mai usato. Ciò che la
     * mutazione dimostra è QUANTE prove diventano rosse; il totale accanto non
     * aggiunge niente e mente da solo col tempo. Si rifà così:
     *   npx vitest run __tests__/components/ComposizioneBonifico-dall-alunno.test.tsx \
     *     __tests__/components/MovimentoDialog.test.tsx \
     *     __tests__/components/MovimentoDialog-componi-riapertura.test.tsx
     * Base: tutto verde. Scambiata la stringa con l'array nelle dipendenze
     * (`useMemo` in piedi): **1 rossa**, ed è il lock testuale — l'unica cosa che
     * sa vedere lo scambio, perché il comportamento non cambia. Tolto il solo
     * `useMemo` (dipendenze intatte): **nessuna rossa**, nessun difetto in piedi —
     * la prova che la protezione non è lì. Tolte tutt'e due: **5 rosse**, cioè la
     * rilettura a ogni render vista a schermo.
     *
     * `alunniScelti` esiste per l'elenco a schermo, `alunniQuery` per l'effetto.
     */
    const chiaveIniziali = (alunniIniziali ?? []).join(',')
    /**
     * Tutti i bambini chiesti, deduplicati e SENZA tetto: è la base da cui si
     * ricava quanti ne restano fuori. Serve separata da `alunniScelti` perché
     * `.slice()` da solo non lascia traccia di ciò che toglie — ed è un taglio
     * raggiungibile (vedi `esclusiDalTetto` qui sotto).
     */
    const alunniTutti = useMemo(
        () =>
            [...new Set([...(chiaveIniziali ? chiaveIniziali.split(',') : []), ...alunniAggiunti])].filter(
                (a) => a !== '',
            ),
        [chiaveIniziali, alunniAggiunti],
    )
    const alunniScelti = useMemo(
        () => alunniTutti.slice(0, MAX_ALUNNI_COMPOSIZIONE),
        [alunniTutti],
    )
    /**
     * ⚠️ IL TAGLIO A CINQUE NON PUÒ ESSERE MUTO, E IL CASO È RAGGIUNGIBILE.
     * `MovimentoDialog` passa `alunniDelVerdetto(movimento)`, che parte da
     * `alunni_senza_voci` — costruito in `src/lib/pagamenti/riconciliazione.ts` da
     * un `new Set(estraiCodiciFiscali(...))` **senza nessun tetto**. Un bonifico
     * che nomina sei bambini apriva il pannello puntato su CINQUE e il sesto
     * usciva dalla composizione senza che niente a schermo lo dicesse: il resto
     * del bonifico restava non allocato, e nessuna traccia del perché. Su denaro
     * quello è il fallire in silenzio che questo repo non ammette.
     *
     * Non basta `alPieno`: quella frase parla del limite ad AGGIUNGERNE un altro,
     * non di uno che è stato TOLTO — e i chip esistono solo per `alunniAggiunti`,
     * mai per gli iniziali. Perciò qui si conta, e sotto si dice.
     *
     * Si dice il NUMERO e non i nomi, e non è pigrizia: i bambini oltre il tetto
     * non vengono nemmeno chiesti alla rotta `contesto`, quindi di loro non
     * esiste un nome da mostrare. Un conteggio è vero; un nome inventato no.
     */
    const esclusiDalTetto = alunniTutti.length - alunniScelti.length
    const alunniQuery = alunniScelti.join(',')

    /**
     * L'identità, calcolata una volta: `identita` è un `useCallback` con l'elenco
     * di dipendenze vuoto, quindi questo valore è stabile e non fa ripartire la
     * ricerca a ogni render.
     */
    const utente = useMemo(() => identita(), [identita])
    /**
     * La ricerca dei bambini da aggiungere. Debounce, soglia, guardia di sorpasso
     * e stato d'errore distinto dall'elenco vuoto stanno tutti in
     * `use-ricerca-alunni.ts`, che serve anche la casella del popup: una sola
     * regola su quando si parte e su che cosa vuol dire un elenco vuoto.
     */
    const ricercaAlunni = useRicercaAlunni(termineAlunni, utente)

    useEffect(() => {
        let vivo = true
        const carica = async () => {
            setCaricamento(true)
            setErroreCtx(null)
            const user = identita()
            const q = new URLSearchParams()
            if (user) q.set('userId', user)
            if (paganteScelto) q.set('pagante', paganteScelto)
            // I bambini indicati a mano: la rotta li verifica CONTRO LA SEDE prima
            // di usarli, e risponde 404 `CONCILIAZIONE_ALUNNO_NON_TROVATO` su uno
            // solo fuori perimetro. Qui non si filtra niente: filtrare vorrebbe
            // dire un secondo criterio accanto a quello del server.
            if (alunniQuery) q.set('alunni', alunniQuery)
            const coda = q.toString()
            try {
                const res = await fetch(
                    `/api/pagamenti/riconciliazione/${movimentoId}/contesto${coda ? `?${coda}` : ''}`,
                    { headers: user ? { 'x-user-id': user } : undefined },
                )
                const corpo = await res.json().catch(() => null)
                if (!vivo) return
                if (!res.ok) {
                    setErroreCtx({ corpo })
                    logClient({
                        livello: 'error',
                        evento: 'fetch',
                        messaggio: 'conciliazione-contesto-non-letto',
                        route: '/admin/pagamenti',
                        stato: res.status,
                    })
                    return
                }
                const dati = (corpo as { data?: Contesto } | null)?.data ?? null
                if (!dati) {
                    setErroreCtx({ corpo: null })
                    logClient({
                        livello: 'error',
                        evento: 'fetch',
                        messaggio: 'conciliazione-contesto-senza-dati',
                        route: '/admin/pagamenti',
                        stato: res.status,
                    })
                    return
                }
                setCtx(dati)
                // Cambiando pagante cambiano i FIGLI, quindi le voci aperte e le sedi:
                // tenere le righe di prima vorrebbe dire incassare su bambini che
                // questa famiglia non ha. Si riparte, e lo si vede.
                //
                // ⚠️ VALE IDENTICO PER UN BAMBINO AGGIUNTO A MANO, e per la stessa
                // ragione: `?alunni=` allarga l'insieme dei figli, quindi le voci
                // aperte a schermo non sono più quelle su cui si era spuntato. Le
                // righe si azzerano perché l'elenco piatto delle voci — e con lui
                // l'INDICE con cui le spunte sono memorizzate — cambia sotto i piedi.
                setSpunte({})
                setNuove([])
                setTicket([])
                setSedeScelta('')
                setAncoraScelta('')
            } catch (err) {
                if (!vivo) return
                setErroreCtx({ corpo: null })
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: `conciliazione-contesto-rete: ${nomeErrore(err)}`,
                    route: '/admin/pagamenti',
                    stato: 0,
                })
            } finally {
                if (vivo) setCaricamento(false)
            }
        }
        void carica()
        return () => {
            vivo = false
        }
        // ⚠️ `t` NON sta qui, e non è una svista: vedi la nota su `erroreCtx`.
        // ⚠️ E qui c'è `alunniQuery`, la STRINGA, non `alunniScelti`: è QUESTA la
        // riga che impedisce la rilettura a ogni render, non il `useMemo` a monte.
        // Il perché, e i numeri che lo mostrano, stanno lassù su `chiaveIniziali`.
    }, [movimentoId, paganteScelto, identita, alunniQuery, ricaricaCtx])

    /**
     * ⚠️ IL RIENTRO DEL FUOCO, CHIUSO `DialogoAggiungiLegame` (WCAG 2.4.3).
     *
     * È lo schema che `MovimentoDialog` usa già per il proprio pannello
     * (`rientraSuComponi`), riusato e non reinventato: un `ref` e non uno stato,
     * perché non deve far ridisegnare niente — e perché un `setState` dentro
     * l'effetto che lo consuma è proprio ciò che `react-hooks/set-state-in-effect`
     * vieta in questo repo.
     *
     * ⚠️ IL BERSAGLIO LO DECIDE LA PORTA D'USCITA, NON L'ISTANTE DELLA CHIUSURA —
     * ed è una CORREZIONE, misurata con una sonda. Qui prima c'era
     * `document.contains(bottone)`: al ritorno il pulsante «Collega un genitore»
     * è ANCORA MONTATO (il contesto nuovo è in volo), quindi il controllo passava
     * e il fuoco ci finiva sopra; un istante dopo la rilettura portava i candidati,
     * il blocco spariva col suo pulsante e il fuoco cadeva su `<body>` — cioè
     * esattamente il difetto che quel ramo dichiarava di chiudere. Il ripiego su
     * `selPagante` non scattava mai nel caso riuscito, perché veniva valutato un
     * tick troppo presto.
     *
     * Le due porte sono due, e si distinguono alla fonte:
     *  · `onCollegato` → il blocco è CONDANNATO, e il fuoco va subito sulla tendina
     *    dell'intestatario: è dove il lavoro continua, esiste sempre a contesto
     *    caricato e non si smonta quando i candidati arrivano.
     *  · `onChiudi` (annullato) → non si è scritto niente, il blocco RESTA, e il
     *    posto giusto è il pulsante da cui si era entrati. Il controllo sul
     *    documento resta come rete: se quel nodo non c'è più, si ripiega.
     *
     * Prova: «tornato dal dialogo col legame scritto, il fuoco resta su un elemento
     * VIVO» in `ComposizioneBonifico-dall-alunno.test.tsx` — rossa sul ramo di prima.
     */
    const bottoneLegame = useRef<HTMLButtonElement | null>(null)
    const selPagante = useRef<HTMLSelectElement | null>(null)
    const rientraDaLegame = useRef<'collegato' | 'annullato' | null>(null)
    useEffect(() => {
        if (legameAperto || !rientraDaLegame.current) return
        const come = rientraDaLegame.current
        rientraDaLegame.current = null
        if (come === 'annullato') {
            const bottone = bottoneLegame.current
            if (bottone && document.contains(bottone)) {
                bottone.focus()
                return
            }
        }
        selPagante.current?.focus()
    }, [legameAperto])

    // ── I dati derivati: nessun `useEffect` che scriva stato ────────────────
    //
    // Tutto ciò che «si preseleziona» è un VALORE CALCOLATO, non uno stato
    // sincronizzato da un effetto: un `setState` dentro un effetto è un render in
    // più e una regola ESLint rossa (`set-state-in-effect`), e soprattutto è il
    // modo in cui una preselezione sopravvive al dato che l'ha giustificata.

    /**
     * ⚠️ `useMemo` E NON `ctx?.figli ?? []`: l'array vuoto del ripiego è NUOVO a ogni
     * render, e i quattro `useMemo` che dipendono da `figli` si ricalcolavano sempre
     * (quattro warning `react-hooks/exhaustive-deps`, e il gate del progetto è
     * `--max-warnings 0`). Memoizzato, l'identità cambia solo quando cambia il contesto.
     */
    const figli = useMemo(() => ctx?.figli ?? [], [ctx])
    const importo = ctx ? Number(ctx.movimento.importo) : importoMovimento

    /** L'elenco PIATTO delle voci aperte, nell'ordine in cui si mostrano. */
    const vociPiatte = useMemo(
        () =>
            figli.flatMap((f) =>
                (f.voci_aperte ?? []).map((v) => ({ figlio: f, voce: v })),
            ),
        [figli],
    )

    const righeEsistenti = useMemo(
        () =>
            vociPiatte
                .map((r, i) => ({ r, i }))
                .filter(({ i }) => spunte[i] !== undefined)
                .map(({ r, i }) => rigaDaVoceAperta(r.voce, num(spunte[i]))),
        [vociPiatte, spunte],
    )

    const righeNuove = useMemo<RigaNuova[]>(
        () =>
            nuove.map((n) => ({
                specie: 'nuova',
                alunnoId: n.alunnoId || null,
                scuolaId: n.alunnoId ? sedeDelFiglio(figli, n.alunnoId) : null,
                categoriaId: n.categoriaId || null,
                descrizione: n.descrizione,
                importo: num(n.importo),
            })),
        [nuove, figli],
    )

    const righeTicket = useMemo<RigaTicket[]>(
        () =>
            ticket.map((k) => ({
                specie: 'ticket',
                alunnoId: k.alunnoId || null,
                scuolaId: k.alunnoId ? sedeDelFiglio(figli, k.alunnoId) : null,
                quantita: num(k.quantita),
                costoUnitario: num(k.costoUnitario),
            })),
        [ticket, figli],
    )

    /** L'ORDINE è quello in cui la RPC incassa: esistenti → nuove → ticket. */
    const righe = useMemo<RigaComposizione[]>(
        () => [...righeEsistenti, ...righeNuove, ...righeTicket],
        [righeEsistenti, righeNuove, righeTicket],
    )

    const violazioni = useMemo(() => violazioniRighe(righe), [righe])
    const violazioniInsieme = useMemo(
        () => violazioniComposizione(righe, importo),
        [righe, importo],
    )
    /** IL GATE. Uno solo, e non si ricompone. */
    const quadraETiene = useMemo(() => puoConfermare(righe, importo), [righe, importo])
    const totale = useMemo(() => totaleComposizione(righe), [righe])
    const scarto = useMemo(() => scartoQuadratura(righe, importo), [righe, importo])

    // Le sedi fra cui si sceglie quella del DOCUMENTO: quelle toccate dalla
    // composizione, ristrette a quelle in cui l'operatore può scrivere (i figli
    // `in_sede`). Fuori di lì la scrittura risponde 403, e offrire una tendina che
    // porta a un rifiuto è mandare l'operatrice contro un muro che sappiamo dov'è.
    /**
     * I bambini a cui si può collegare un genitore DA QUI: quelli dentro le sedi
     * dell'operatore. Fuori di lì il nome non esce nemmeno (il contesto manda
     * `nome: null`), e la scrittura del legame risponderebbe di no: offrire il
     * pulsante sarebbe mandare l'operatrice contro un muro che sappiamo dov'è.
     */
    const figliCollegabili = useMemo(() => figli.filter((f) => f.in_sede), [figli])

    const sediComponibili = useMemo(
        () => new Set(figli.filter((f) => f.in_sede && f.scuola_id).map((f) => f.scuola_id as string)),
        [figli],
    )
    const sediSceglibili = useMemo(() => {
        const toccate = sediCoinvolte(righe)
        const dentro = toccate.filter((s) => sediComponibili.has(s))
        // Se la composizione tocca SOLO plessi che l'operatore non gestisce, si
        // mostrano lo stesso: il rifiuto del server, col suo codice, è più
        // informativo di una tendina vuota senza spiegazione.
        return dentro.length > 0 ? dentro : toccate
    }, [righe, sediComponibili])

    /**
     * Con una sede sola si preseleziona; con più d'una NON si indovina (400 lato server).
     *
     * ⚠️ E LA SCELTA VALE FINCHÉ È FRA LE OPZIONI, non per sempre. `sedeScelta` è uno
     * stato, `sediSceglibili` è derivato dalle righe: togliendo le righe di un plesso,
     * la scelta di prima resta in memoria mentre la tendina non la offre più. Misurato
     * prima di questa guardia, due figli in due plessi: scelta Aversa, tolta la riga di
     * Aversa → campo «Sede del documento» VUOTO a schermo (il valore non è fra le
     * opzioni), pulsante ACCESO, nessun motivo elencato, e nel payload
     * `scuola_id` = Aversa su una composizione di sola Giugliano. Il server non se ne
     * accorge: verifica che la sede sia ACCESSIBILE a chi la dichiara (§3 di
     * `componi`, decisione 15), non che c'entri con le righe. Risultato:
     * `pagamenti_transazioni.scuola_id` e `riconciliazione_movimenti.scuola_id` nel
     * plesso sbagliato, in silenzio — e «ogni scrittura dichiara la sua sede» smette
     * di essere vera proprio dove si decide un documento fiscale.
     *
     * Perché una GUARDIA sul valore derivato e non un `setSedeScelta('')` nei gesti
     * (come per `ancoraScelta`): l'àncora è una POSIZIONE, e una posizione dopo un
     * riordino non è più verificabile — si azzera e basta. La sede è un'IDENTITÀ: si
     * può chiedere se è ancora offerta, e finché lo è la scelta dell'operatrice resta
     * sua. Azzerarla a ogni riordino cancellerebbe la scelta legittima di un bonifico
     * cross-sede, che è il caso per cui questa schermata esiste. Le due prove
     * «la sede del DOCUMENTO non sopravvive alle righe» tengono ferme tutt'e due le
     * direzioni.
     */
    const sedeDocumento =
        (sedeScelta && sediSceglibili.includes(sedeScelta) ? sedeScelta : '') ||
        (sediSceglibili.length === 1 ? sediSceglibili[0] : '')

    const paganteCorrente = paganteScelto ?? ctx?.pagante.proposto?.parent_id ?? ''

    /** L'indice GLOBALE dell'àncora, tradotto in specie + indice locale del suo elenco. */
    const localizzaAncora = useCallback(
        (indiceGlobale: number): { specie: 'esistente' | 'nuova' | 'ticket'; indice: number } => {
            if (indiceGlobale < righeEsistenti.length) {
                return { specie: 'esistente', indice: indiceGlobale }
            }
            if (indiceGlobale < righeEsistenti.length + righeNuove.length) {
                return { specie: 'nuova', indice: indiceGlobale - righeEsistenti.length }
            }
            return {
                specie: 'ticket',
                indice: indiceGlobale - righeEsistenti.length - righeNuove.length,
            }
        },
        [righeEsistenti.length, righeNuove.length],
    )

    const ancoraProposta = useMemo(() => proponiAncora(righe), [righe])
    const ancoraCorrente =
        ancoraScelta ||
        (ancoraProposta
            ? `${localizzaAncora(ancoraProposta.indice).specie}:${localizzaAncora(ancoraProposta.indice).indice}`
            : '')

    // ── I motivi per cui «Conferma» è spento ────────────────────────────────
    //
    // Ogni codice del motore ha il suo testo in catalogo (lock
    // `pannello-componi-testi-completi`), e i due campi d'insieme che il motore non
    // conosce — pagante e sede del documento — si nominano con l'ETICHETTA del loro
    // campo: è il nome che l'operatrice legge due centimetri più sotto.
    const motivi = useMemo(() => {
        const out: string[] = []
        const visti = new Set<string>()
        for (const v of violazioni) {
            const chiave = chiaveDelCodice(v.codice as CodiceViolazione)
            if (visti.has(chiave)) continue
            visti.add(chiave)
            out.push(t(chiave))
        }
        for (const c of violazioniInsieme) {
            const chiave = chiaveDelCodice(c as CodiceViolazioneComposizione)
            if (visti.has(chiave)) continue
            visti.add(chiave)
            out.push(t(chiave))
        }
        if (righe.length > 0 && violazioni.length === 0 && violazioniInsieme.length === 0 && !quadraETiene) {
            // Resta un solo motivo possibile: la somma non fa l'importo del bonifico.
            out.push(scarto < 0 ? t('reconComponiQuadraturaManca', { importo: formatEuro(-scarto) }) : t('reconComponiQuadraturaAvanza', { importo: formatEuro(scarto) }))
        }
        if (!paganteCorrente) out.push(t('reconComponiIntestatario'))
        if (!sedeDocumento) out.push(t('reconComponiSedeDocumento'))
        return out
    }, [violazioni, violazioniInsieme, righe.length, quadraETiene, scarto, paganteCorrente, sedeDocumento, t])

    const pronto = quadraETiene && !!paganteCorrente && !!sedeDocumento && !invio

    // ── L'invio ─────────────────────────────────────────────────────────────

    const registra = useCallback(async () => {
        if (!pronto || !ctx) return
        setInvio(true)
        setErroreInvio(null)
        const user = identita()
        const [specie, indice] = ancoraCorrente.split(':')
        const corpo = {
            scuola_id: sedeDocumento,
            pagante_parent_id: paganteCorrente,
            // ⚠️ NESSUN FILTRO SULLE RIGHE, ED È UNA CORREZIONE. Scartare qui le righe
            // incomplete (`.filter((n) => n.alunnoId && n.categoriaId)`) manderebbe un
            // payload DIVERSO dalla composizione su cui si è quadrato: il totale non
            // tornerebbe più, e — peggio — l'indice dell'àncora, che è la posizione
            // dentro questi stessi elenchi, punterebbe a un'altra riga, cioè a un altro
            // intestatario del documento fiscale. A garantire che siano tutte complete
            // è il gate (`alunno_mancante`, `categoria_mancante`): senza di lui non si
            // arriva a questa funzione, e con lui il filtro non scarta mai niente. Un
            // filtro morto che, se vivesse, sposterebbe una fattura, è peggio di nessun
            // filtro.
            voci: righeEsistenti.map((r) => ({ pagamento_id: r.pagamentoId, importo: r.importo })),
            voci_nuove: nuove.map((n) => ({
                alunno_id: n.alunnoId,
                categoria_id: n.categoriaId,
                descrizione: n.descrizione.trim(),
                importo: num(n.importo),
                // Decisione n. 5: le voci create qui scadono il giorno del bonifico.
                scadenza: dataOperazione,
            })),
            voci_ticket: ticket.map((k) => ({
                alunno_id: k.alunnoId,
                quantita: num(k.quantita),
                costo_unitario: num(k.costoUnitario),
            })),
            ...(specie ? { ancora: { specie, indice: Number(indice) } } : {}),
        }
        try {
            const res = await fetch(
                `/api/pagamenti/riconciliazione/${movimentoId}/componi${user ? `?userId=${user}` : ''}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(user ? { 'x-user-id': user } : {}),
                    },
                    body: JSON.stringify(corpo),
                },
            )
            const body = await res.json().catch(() => null)
            if (!res.ok) {
                setErroreInvio({ corpo: body })
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: 'conciliazione-componi-rifiutata',
                    route: '/admin/pagamenti',
                    stato: res.status,
                })
                return
            }
            // ⚠️ UN 200 CHE NON È UN SUCCESSO PIENO. `CONCILIAZIONE_MOVIMENTO_NON_LEGATO`
            // significa: gli incassi ci sono, la riga dell'estratto conto no. Non è un
            // errore — un 500 direbbe «nulla è stato scritto», sarebbe falso, e
            // inviterebbe a ritentare, cioè a incassare due volte (al secondo giro le
            // voci nuove e i ticket rinascono, e il residuo riletto non li trattiene).
            // Perciò qui si DICE, e si toglie di mezzo il pulsante che invita a rifarlo.
            const dati = (body as { data?: { movimento_confermato?: boolean } } | null)?.data
            const confermato = dati?.movimento_confermato !== false
            const riepilogo: RiepilogoComposizione = {
                voci: corpo.voci.length + corpo.voci_nuove.length,
                // ⚠️ LA QUANTITÀ, NON IL NUMERO DI RIGHE. Una riga da 20 pasti è
                // «20 ticket», non «1 ticket»: `EsitoComposizione` lo dichiara, e la
                // formula sbagliata produce un numero PLAUSIBILE — il modo peggiore
                // di essere falso, perché nessuno lo mette in dubbio.
                ticket: corpo.voci_ticket.reduce((n, k) => n + k.quantita, 0),
                totale,
                movimentoConfermato: confermato,
            }
            setEsito(riepilogo)
            if (!confermato) {
                setErroreInvio({ corpo: body })
                logClient({
                    livello: 'warn',
                    evento: 'fetch',
                    messaggio: 'conciliazione-movimento-non-legato',
                    route: '/admin/pagamenti',
                    stato: res.status,
                })
            }
            onFatto(riepilogo)
        } catch (err) {
            setErroreInvio({ corpo: null })
            logClient({
                livello: 'error',
                evento: 'fetch',
                messaggio: `conciliazione-componi-rete: ${nomeErrore(err)}`,
                route: '/admin/pagamenti',
                stato: 0,
            })
        } finally {
            setInvio(false)
        }
    }, [
        pronto, ctx, identita, ancoraCorrente, sedeDocumento, paganteCorrente, righeEsistenti,
        nuove, ticket, dataOperazione, movimentoId, totale, onFatto,
    ])

    // ── Le azioni sulle righe ───────────────────────────────────────────────

    /**
     * Spuntare una voce propone **al più ciò che del bonifico resta da assegnare**,
     * non il suo intero residuo: è `proponiAllocazioneSuVoci`, la stessa funzione con
     * cui il registro propone l'allocazione di una transazione di famiglia.
     *
     * Perché non il residuo secco: un bonifico da 150 € su una retta da 200 € di
     * residuo scriverebbe 200, cioè un importo che il gate rifiuta due volte (sfora il
     * bonifico) e che l'operatrice deve correggere a mano ogni volta. Con la capienza,
     * il campo nasce già giusto nel caso più comune — il pagamento parziale.
     *
     * ⚠️ E NON QUADRA PER IL FATTO DI ESSERE UNA PROPOSTA: `proponiAllocazioneSuVoci`
     * può SOTTO-riempire (ogni id si consuma una volta sola), e con la capienza
     * esaurita non propone niente — lì si ricade sul residuo, che sfora in modo
     * VISIBILE invece di scrivere uno 0 muto. A decidere resta `puoConfermare`.
     *
     * ⚠️ E AZZERA L'ÀNCORA, come gli altri quattro gesti che riordinano (vedi la
     * regola sopra `ancoraScelta`). Questo era il quinto, ed era l'unico a non farlo:
     * misurato, tre voci da 50 contro un bonifico da 100, scelta la seconda come voce
     * da cui intestare la fattura e tolta la spunta alla PRIMA, il payload partiva con
     * `{ specie: 'esistente', indice: 1 }` su un elenco che nel frattempo era
     * scalato — cioè `body.voci[1]` = la GITA, e `ancora_pagamento_id` con lei.
     */
    const commutaVoce = (i: number, voceId: string, residuo: number) => {
        setSpunte((prec) => {
            const dopo = { ...prec }
            if (dopo[i] !== undefined) {
                delete dopo[i]
                return dopo
            }
            const capienza = importo - totale
            const [proposta] = proponiAllocazioneSuVoci([{ id: voceId, residuo }], capienza)
            dopo[i] = String(proposta?.importo ?? residuo)
            return dopo
        })
        setAncoraScelta('')
    }

    const aggiungiVoce = () => {
        setNuove((p) => [
            ...p,
            { chiave: contatore, alunnoId: '', categoriaId: '', descrizione: '', importo: '' },
        ])
        setContatore((c) => c + 1)
        setAncoraScelta('')
    }

    const aggiungiTicket = () => {
        setTicket((p) => [...p, { chiave: contatore, alunnoId: '', quantita: '1', costoUnitario: '' }])
        setContatore((c) => c + 1)
        setAncoraScelta('')
    }

    /**
     * Scelto il bambino, il costo unitario si propone dal pacchetto della SUA sede
     * (decisione 7) — e solo se il campo è ancora vuoto: un valore già digitato non
     * si sovrascrive, o cambiare bambino cancellerebbe in silenzio una correzione.
     */
    const scegliBambinoTicket = (idx: number, alunnoId: string) =>
        setTicket((p) =>
            p.map((k, i) => {
                if (i !== idx) return k
                const sede = alunnoId ? sedeDelFiglio(figli, alunnoId) : null
                const pacchetti = sede ? (ctx?.pacchetti_ticket?.[sede] ?? []) : []
                const proposto = pacchetti[0]
                return {
                    ...k,
                    alunnoId,
                    costoUnitario:
                        k.costoUnitario === '' && proposto ? String(proposto.costo) : k.costoUnitario,
                }
            }),
        )

    // ── Le etichette ────────────────────────────────────────────────────────

    /** Come si nomina un bambino: il suo nome, o il PLESSO se è fuori dalle sedi. */
    const nomeFiglio = (f: FiglioCtx): string => {
        if (f.nome) return f.nome
        const sede = f.scuola_id ? ctx?.sedi?.[f.scuola_id] : null
        // Senza nemmeno il nome del plesso resta «Altra sede»: vero, e mai un uuid.
        return t('reconComponiFuoriSede', { sede: sede ?? t('reconChipAltraSede') })
    }

    const nomeSede = (id: string): string => ctx?.sedi?.[id] ?? t('reconChipAltraSede')

    /** Si è arrivati al tetto che la rotta del contesto impone con la sua `zod`. */
    const alPieno = alunniScelti.length >= MAX_ALUNNI_COMPOSIZIONE

    /**
     * La riga della regione viva (`aria-live`, NON `role="status"`: il perché sta
     * nel commento sul JSX, ed è che in questo pannello lo `status` è uno solo —
     * la barra di quadratura). È l'unica cosa che dice a chi non guarda lo schermo
     * che l'elenco è cambiato.
     *
     * ⚠️ QUALI FRASI — quattro, non tre — STA IN `use-ricerca-alunni`, e non qui.
     * Era scritta due volte, identica, anche nel popup (`MovimentoDialog`): le due
     * copie divergevano già in silenzio (misurato: cambiato «Sto cercando» in
     * tutt'e due, centodiciannove prove restavano verdi), che è esattamente ciò
     * che quel modulo esiste per impedire. Si chiama al render e prende `t`, che
     * quindi non entra in nessuna dipendenza di effetto.
     */
    const fraseRicerca = fraseRicercaAlunni(ricercaAlunni, t)

    /** Le categorie scegliibili per una riga: globali + quelle della sede del bambino. */
    const categoriePer = (alunnoId: string): CategoriaCtx[] => {
        const sede = alunnoId ? sedeDelFiglio(figli, alunnoId) : null
        return (ctx?.categorie ?? []).filter((c) => !c.scuola_id || !sede || c.scuola_id === sede)
    }

    /** Il testo con cui una riga si riconosce nella tendina dell'àncora. */
    const etichettaRiga = (r: RigaComposizione, i: number): string => {
        if (r.specie === 'ticket') {
            return `${r.quantita} × ${formatEuro(r.costoUnitario)}`
        }
        const desc = r.descrizione?.trim()
        return desc ? `${desc} · ${formatEuro(importoRiga(righe[i]))}` : formatEuro(importoRiga(righe[i]))
    }

    const motivoPagante = ((): string | null => {
        const proposto = ctx?.pagante.proposto
        if (!proposto) return null
        if (proposto.motivo === 'scelto') return t('reconComponiPaganteScelto')
        if (proposto.motivo === 'pagante_comune') return t('reconComponiPaganteComune')
        // I quattro motivi del riconoscimento dell'ordinante hanno già la loro frase,
        // ed è la stessa che spiega la proposta d'intestatario in fattura: due frasi
        // per lo stesso riconoscimento sarebbero due spiegazioni dello stesso fatto.
        if ((MOTIVI_NOTI as readonly string[]).includes(proposto.motivo)) {
            const nome =
                ctx?.pagante.candidati.find((c) => c.parent_id === proposto.parent_id)?.nome ?? ''
            return t(CHIAVE_MOTIVO_PROPOSTA[proposto.motivo as keyof typeof CHIAVE_MOTIVO_PROPOSTA], {
                ordinante: ctx?.movimento.controparte ?? '',
                nome,
            })
        }
        // Un motivo che non si sa spiegare non si spiega: mai la chiave grezza a schermo.
        return null
    })()

    const frasseQuadratura =
        scarto === 0
            ? t('reconComponiQuadraturaOk')
            : scarto < 0
                ? t('reconComponiQuadraturaManca', { importo: formatEuro(-scarto) })
                : t('reconComponiQuadraturaAvanza', { importo: formatEuro(scarto) })

    const ETICHETTA = 'mb-1 block font-maven text-xs font-bold text-kidville-sub'
    const SEZIONE = 'rounded-card border border-kidville-line bg-kidville-white p-3'

    return (
        /**
         * ⚠️ UNA SEZIONE, NON UN SECONDO DIALOGO — ed è una correzione, non una
         * semplificazione. Questo pannello lo monta INLINE il popup del movimento
         * (`MovimentoDialog.tsx`), che è già un `Modal`: renderne un altro qui
         * significherebbe due veli sfocati sovrapposti e due `aria-modal` annidati
         * sullo stesso compito. Il contratto lo diceva già e conviene saperlo leggere:
         * non ha un `open` — un componente che possiede il proprio dialogo ce l'ha
         * sempre — e `onChiudi` di chi monta rimette a schermo l'abbinamento, cioè
         * chiude il PANNELLO, non una finestra.
         *
         * Quel che serve a un dialogo — focus-trap, Escape, inerzia dello sfondo,
         * ripristino del focus (WCAG 2.4.3) — resta quello del `Modal` che ci contiene,
         * e non si duplica. Qui resta il nome accessibile della regione, che è ciò che
         * un lettore di schermo annuncia entrando.
         */
        <section
            aria-labelledby={idTitolo}
            className="rounded-card bg-kidville-cream p-3"
        >
            <div>
                <h2 id={idTitolo} className="mb-3 font-barlow text-lg font-extrabold text-kidville-ink">
                    {t('reconComponiTitolo')}
                </h2>

                {caricamento && !ctx && (
                    <p className="py-6 text-center font-maven text-sm text-kidville-sub">
                        {t('reconCaricamento')}
                    </p>
                )}

                {erroreCtx && (
                    <p
                        role="alert"
                        className="mb-3 rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong"
                    >
                        {messaggioDaCorpo(erroreCtx.corpo, t('reconComponiErroreCaricamento'))}
                    </p>
                )}

                {ctx && (
                    <div className="space-y-3">
                        {/* ── Le voci già aperte della famiglia (decisione 10) ── */}
                        <section className={SEZIONE} aria-labelledby={idVoci}>
                            <h3
                                id={idVoci}
                                className="mb-2 font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green"
                            >
                                {t('reconComponiVociAperte')}
                            </h3>
                            {vociPiatte.length === 0 ? (
                                <p className="font-maven text-sm text-kidville-sub">
                                    {t('reconComponiVociAperteVuoto')}
                                </p>
                            ) : (
                                <ul className="space-y-2">
                                    {vociPiatte.map(({ figlio, voce }, i) => {
                                        const residuo = rigaDaVoceAperta(voce).residuo
                                        const idSpunta = `${uid}-voce-${i}`
                                        const idImporto = `${uid}-voce-imp-${i}`
                                        const scelta = spunte[i] !== undefined
                                        return (
                                            <li key={`${voce.id}-${i}`} className="flex flex-wrap items-center gap-2">
                                                <input
                                                    id={idSpunta}
                                                    type="checkbox"
                                                    checked={scelta}
                                                    onChange={() => commutaVoce(i, voce.id, residuo)}
                                                    className="h-5 w-5 accent-kidville-green"
                                                />
                                                <label
                                                    htmlFor={idSpunta}
                                                    className="flex-1 font-maven text-sm text-kidville-ink"
                                                >
                                                    {/* ⚠️ LA DESCRIZIONE ARRIVA COM'È, ANCHE PER UN FIGLIO FUORI SEDE,
                                                        e qui si dichiara invece di lasciarlo scoprire. Del bambino di
                                                        un altro plesso il contesto manda `nome: null` (lo fa apposta:
                                                        «il nome di un minore esce solo per le sedi dell'operatore»),
                                                        ma `voci_aperte` lo passa con uno spread e la `descrizione` —
                                                        testo libero scritto dalla segreteria — non è redatta da
                                                        nessuno. Una descrizione che contenesse il nome del bambino
                                                        aggirerebbe quel `nome: null` da sotto (e qui non se ne scrive
                                                        uno d'esempio: in questo repository, pubblico, un nome
                                                        «inventato» in un commento è già corrisposto a un bambino vero).
                                                        MISURATO il 2026-09-13 in produzione, con un `count` (nessuna
                                                        riga letta): 410 voci aperte, tutte con descrizione, e
                                                        **0** contengono il nome o il cognome del bambino a cui sono
                                                        intestate. Oggi non perde niente.
                                                        E NON SI REDIGE QUI. Il criterio di ciò che esce è della
                                                        rotta, che è l'unica a sapere chi sta guardando: inventarne
                                                        uno nel pannello vorrebbe dire due criteri, e il giorno in cui
                                                        divergono vince quello che nessuno ha scritto apposta. Se un
                                                        giorno servirà, si taglia là — e questo punto la seguirà
                                                        senza modifiche. */}
                                                    {voce.descrizione || '—'}
                                                    <span className="ml-2 text-kidville-sub">
                                                        {nomeFiglio(figlio)} · {formatEuro(residuo)}
                                                    </span>
                                                </label>
                                                {scelta && (
                                                    <span className="flex items-center gap-1">
                                                        <label htmlFor={idImporto} className={ETICHETTA}>
                                                            {t('reconComponiCampoImporto')}
                                                        </label>
                                                        <input
                                                            id={idImporto}
                                                            type="number"
                                                            step="0.01"
                                                            min="0"
                                                            className={cx(INPUT, 'w-28')}
                                                            value={spunte[i]}
                                                            onChange={(e) =>
                                                                setSpunte((p) => ({ ...p, [i]: e.target.value }))
                                                            }
                                                        />
                                                    </span>
                                                )}
                                            </li>
                                        )
                                    })}
                                </ul>
                            )}
                        </section>

                        {/* ── «Aggiungi un altro bambino» ────────────────────────
                            IL CASO PER CUI ESISTE: il bonifico che paga due fratelli
                            NON legati allo stesso genitore. Il contesto parte dai
                            bambini che il bonifico nomina (o da quelli indicati a
                            mano): il secondo fratello, se nessun adulto lo tiene
                            insieme al primo, non ci entra da nessuna strada — e oggi
                            quel bonifico non si compone affatto.

                            ⚠️ OGNI AGGIUNTA RILEGGE IL CONTESTO E AZZERA LE RIGHE,
                            esattamente come il cambio di pagante e per la stessa
                            ragione, che sta scritta sopra `setSpunte({})`: le spunte
                            sono memorizzate per POSIZIONE nell'elenco piatto delle
                            voci, e quell'elenco cambia appena i figli cambiano.
                            Tenerle vorrebbe dire incassare su una voce diversa da
                            quella che si era scelta. */}
                        <section className={SEZIONE} aria-labelledby={idAggiungi}>
                            <h3
                                id={idAggiungi}
                                className="mb-2 font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green"
                            >
                                {t('reconComponiAggiungiBambino')}
                            </h3>
                            <p className="mb-2 font-maven text-xs text-kidville-sub">
                                {t('reconComponiAggiungiBambinoAiuto')}
                            </p>

                            {/* I bambini aggiunti a mano, con la via per toglierli:
                                un tetto a cinque senza marcia indietro lascerebbe
                                l'operatrice bloccata su una scelta sbagliata. Gli
                                altri — quelli che il bonifico nomina — non si
                                tolgono da qui: non li ha messi lei. */}
                            {alunniAggiunti.length > 0 && (
                                <ul className="mb-2 flex flex-wrap gap-2">
                                    {alunniAggiunti.map((id) => {
                                        const f = figli.find((x) => x.alunno_id === id)
                                        /* ⚠️ IL RIPIEGO NON È UN'ETICHETTA DI PLESSO. Qui
                                           `f` manca nell'unico istante in cui il bambino è
                                           già scelto e la rilettura del contesto è ancora
                                           in volo — e se quella rilettura fallisce, ci
                                           resta. Prima ripiegava su «Altra sede», cioè il
                                           NOME DI UN PLESSO usato come nome di persona:
                                           il chip e la sua `aria-label` diventavano «Togli
                                           dalla composizione Altra sede». Il vero «fuori
                                           dalle mie sedi» lo dice `nomeFiglio`, che qui
                                           sotto ha il dato per dirlo. */
                                        const nome = f ? nomeFiglio(f) : t('reconComponiBambinoInArrivo')
                                        return (
                                            <li key={id}>
                                                <button
                                                    type="button"
                                                    aria-label={`${t('reconComponiTogliBambino')} ${nome}`}
                                                    onClick={() =>
                                                        setAlunniAggiunti((p) => p.filter((x) => x !== id))
                                                    }
                                                    className="inline-flex min-h-11 items-center gap-1 rounded-pill border-[1.5px] border-kidville-green px-4 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-white"
                                                >
                                                    {nome}
                                                    <Trash2 size={14} aria-hidden="true" />
                                                </button>
                                            </li>
                                        )
                                    })}
                                </ul>
                            )}

                            {/* ⚠️ IL TAGLIO A CINQUE SI VEDE — il perché sta su
                                `esclusiDalTetto`. Non è la frase di `alPieno`, che
                                parla del limite ad AGGIUNGERNE un altro: questa dice
                                che dei bambini NOMINATI DAL BONIFICO sono rimasti
                                fuori, cioè che una parte dell'importo non si può
                                allocare da qui. Le due frasi convivono, perché
                                quando questa compare `alPieno` è vero per forza, e
                                dicono due cose diverse.

                                `role="alert"` e non una nota: compare al montaggio
                                del pannello, una volta, e chi non guarda lo schermo
                                non ha nessun altro modo di sapere che la
                                composizione è già incompleta in partenza. */}
                            {esclusiDalTetto > 0 && (
                                <p
                                    role="alert"
                                    data-testid="componi-alunni-esclusi"
                                    className="mb-2 rounded-input bg-kidville-warn-soft px-3 py-2 font-maven text-xs font-bold text-kidville-warn-strong"
                                >
                                    {t('reconComponiAlunniEsclusi', { n: esclusiDalTetto })}
                                </p>
                            )}

                            {alPieno ? (
                                <p className="font-maven text-xs text-kidville-sub">
                                    {t('reconComponiAlunniMax', { n: MAX_ALUNNI_COMPOSIZIONE })}
                                </p>
                            ) : (
                                <>
                                    {/* ⚠️ Un'etichetta SUA, diversa dal titolo del
                                        riquadro: il titolo etichetta già la sezione
                                        (`aria-labelledby`), e ripeterlo sul campo
                                        darebbe due elementi con lo stesso nome
                                        accessibile a due centimetri di distanza. */}
                                    <label htmlFor={`${uid}-cerca-alunno`} className={ETICHETTA}>
                                        {t('reconComponiCercaBambino')}
                                    </label>
                                    <div className="relative">
                                        <Search
                                            size={15}
                                            aria-hidden="true"
                                            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub"
                                        />
                                        <input
                                            id={`${uid}-cerca-alunno`}
                                            type="text"
                                            value={termineAlunni}
                                            onChange={(e) => setTermineAlunni(e.target.value)}
                                            placeholder={t('reconRicercaAlunniPlaceholder')}
                                            className={cx(INPUT, 'pl-9')}
                                        />
                                    </div>

                                    {/* L'UNICA COSA CHE DICE A CHI NON VEDE LO SCHERMO CHE
                                        L'ELENCO È CAMBIATO: senza, la lista si riempie e
                                        si svuota in silenzio.

                                        ⚠️ `aria-live="polite"` + `aria-atomic`, e NON un
                                        secondo `role="status"`. Non è un ripiego: sono la
                                        stessa cosa per un lettore di schermo (`status`
                                        implica esattamente questi due attributi), ma in
                                        questo pannello il `role="status"` è UNO ed è la
                                        barra di quadratura — l'unica cosa che dice se si
                                        può confermare. Un secondo `status` accanto
                                        renderebbe ambiguo «lo stato del pannello», che è
                                        ciò che chi non vede lo schermo va a cercare.

                                        ⚠️ E L'INVARIANTE VALE SULLA SUPERFICIE, non solo
                                        dentro questo file: la casella di ricerca del popup
                                        (`MovimentoDialog`) resta a schermo mentre questo
                                        pannello è aperto, e per un giorno la sua riga di
                                        stato è stata un SECONDO `role="status"` accanto
                                        alla barra qui sotto — con questo commento che
                                        giurava di no. Adesso anche quella porta
                                        `aria-live`, e a contare la coppia è una prova che
                                        monta i due componenti VERI (`…-dall-alunno`): i
                                        due file, ciascuno col mock dell'altro, non
                                        potevano vederla. */}
                                    <p
                                        aria-live="polite"
                                        aria-atomic="true"
                                        data-testid="componi-ricerca-stato"
                                        className="mt-2 font-maven text-xs text-kidville-sub"
                                    >
                                        {fraseRicerca}
                                    </p>

                                    {ricercaAlunni.stato === 'errore' && (
                                        <p
                                            role="alert"
                                            className="mt-2 rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong"
                                        >
                                            {messaggioDaCorpo(
                                                ricercaAlunni.errore?.corpo,
                                                t('reconRicercaAlunniErrore'),
                                            )}
                                        </p>
                                    )}

                                    {ricercaAlunni.stato === 'pronta' && ricercaAlunni.righe.length > 0 && (
                                        <ul className="mt-2 space-y-2">
                                            {ricercaAlunni.righe.map((a) => {
                                                const gia = alunniScelti.includes(a.alunno_id)
                                                return (
                                                    <li
                                                        key={a.alunno_id}
                                                        className="flex flex-wrap items-center justify-between gap-2 rounded-input bg-kidville-cream px-3 py-2"
                                                    >
                                                        <span className="min-w-0 font-maven text-sm text-kidville-ink">
                                                            {a.nome}
                                                            <span className="ml-2 text-kidville-sub">
                                                                {dettaglioAlunno(a, ricercaAlunni.sedi, t)}
                                                            </span>
                                                        </span>
                                                        <button
                                                            type="button"
                                                            disabled={gia}
                                                            aria-label={`${t('reconComponiAggiungi')} ${a.nome}`}
                                                            onClick={() =>
                                                                setAlunniAggiunti((p) =>
                                                                    p.includes(a.alunno_id) ? p : [...p, a.alunno_id],
                                                                )
                                                            }
                                                            className={cx(BTN_SECONDARY, 'min-h-11')}
                                                        >
                                                            <Plus size={15} aria-hidden="true" />
                                                            {gia
                                                                ? t('reconComponiGiaScelto')
                                                                : t('reconComponiAggiungi')}
                                                        </button>
                                                    </li>
                                                )
                                            })}
                                        </ul>
                                    )}
                                </>
                            )}
                        </section>

                        <div className="flex flex-wrap gap-2">
                            <button type="button" className={BTN_SECONDARY} onClick={aggiungiVoce}>
                                <Plus size={16} aria-hidden="true" />
                                {t('reconComponiAggiungiVoce')}
                            </button>
                            <button type="button" className={BTN_SECONDARY} onClick={aggiungiTicket}>
                                <Plus size={16} aria-hidden="true" />
                                {t('reconComponiAggiungiTicket')}
                            </button>
                        </div>

                        {/* ── Le voci NUOVE (decisione 2, 3, 4, 5) ── */}
                        {nuove.map((n, idx) => {
                            const base = `${uid}-nuova-${n.chiave}`
                            return (
                                <div key={n.chiave} data-testid={`riga-nuova-${idx}`} className={SEZIONE}>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <div>
                                            <label htmlFor={`${base}-alunno`} className={ETICHETTA}>
                                                {t('reconComponiCampoBambino')}
                                            </label>
                                            <select
                                                id={`${base}-alunno`}
                                                className={SELECT}
                                                value={n.alunnoId}
                                                onChange={(e) =>
                                                    setNuove((p) =>
                                                        p.map((x, i) =>
                                                            i === idx ? { ...x, alunnoId: e.target.value, categoriaId: '' } : x,
                                                        ),
                                                    )
                                                }
                                            >
                                                <option value="">—</option>
                                                {figli.map((f) => (
                                                    <option key={f.alunno_id} value={f.alunno_id} disabled={!f.attivo}>
                                                        {nomeFiglio(f)}
                                                        {f.attivo ? '' : ` — ${t('reconComponiAlunnoNonAttivo')}`}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label htmlFor={`${base}-cat`} className={ETICHETTA}>
                                                {t('reconComponiCampoCategoria')}
                                            </label>
                                            <select
                                                id={`${base}-cat`}
                                                className={SELECT}
                                                value={n.categoriaId}
                                                onChange={(e) =>
                                                    setNuove((p) =>
                                                        p.map((x, i) => (i === idx ? { ...x, categoriaId: e.target.value } : x)),
                                                    )
                                                }
                                            >
                                                <option value="">—</option>
                                                {categoriePer(n.alunnoId).map((c) => (
                                                    <option key={c.id} value={c.id}>
                                                        {c.nome}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="sm:col-span-2">
                                            <label htmlFor={`${base}-desc`} className={ETICHETTA}>
                                                {t('reconComponiCampoDescrizione')}
                                            </label>
                                            <input
                                                id={`${base}-desc`}
                                                type="text"
                                                maxLength={200}
                                                className={INPUT}
                                                value={n.descrizione}
                                                onChange={(e) =>
                                                    setNuove((p) =>
                                                        p.map((x, i) => (i === idx ? { ...x, descrizione: e.target.value } : x)),
                                                    )
                                                }
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor={`${base}-imp`} className={ETICHETTA}>
                                                {t('reconComponiCampoImporto')}
                                            </label>
                                            <input
                                                id={`${base}-imp`}
                                                type="number"
                                                step="0.01"
                                                min="0"
                                                className={INPUT}
                                                value={n.importo}
                                                onChange={(e) =>
                                                    setNuove((p) =>
                                                        p.map((x, i) => (i === idx ? { ...x, importo: e.target.value } : x)),
                                                    )
                                                }
                                            />
                                        </div>
                                        <div className="flex items-end">
                                            <button
                                                type="button"
                                                className={BTN_SECONDARY}
                                                aria-label={`${t('reconComponiRimuoviVoce')} ${idx + 1}`}
                                                onClick={() => {
                                                    setNuove((p) => p.filter((_, i) => i !== idx))
                                                    setAncoraScelta('')
                                                }}
                                            >
                                                <Trash2 size={16} aria-hidden="true" />
                                                {t('reconComponiRimuoviVoce')}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )
                        })}

                        {/* ── Le ricariche di ticket mensa (decisione 6, 7) ── */}
                        {ticket.map((k, idx) => {
                            const base = `${uid}-ticket-${k.chiave}`
                            const sede = k.alunnoId ? sedeDelFiglio(figli, k.alunnoId) : null
                            const pacchetti = sede ? (ctx.pacchetti_ticket?.[sede] ?? []) : []
                            return (
                                <div key={k.chiave} data-testid={`riga-ticket-${idx}`} className={SEZIONE}>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        <div>
                                            <label htmlFor={`${base}-alunno`} className={ETICHETTA}>
                                                {t('reconComponiCampoBambino')}
                                            </label>
                                            <select
                                                id={`${base}-alunno`}
                                                className={SELECT}
                                                value={k.alunnoId}
                                                onChange={(e) => scegliBambinoTicket(idx, e.target.value)}
                                            >
                                                <option value="">—</option>
                                                {figli.map((f) => (
                                                    <option key={f.alunno_id} value={f.alunno_id} disabled={!f.attivo}>
                                                        {nomeFiglio(f)}
                                                        {f.attivo ? '' : ` — ${t('reconComponiAlunnoNonAttivo')}`}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        {pacchetti.length > 0 ? (
                                            <div>
                                                <label htmlFor={`${base}-pac`} className={ETICHETTA}>
                                                    {t('reconComponiCampoPacchetto')}
                                                </label>
                                                {/* ⚠️ IL PACCHETTO È UN'AZIONE, NON UNO STATO: riempie
                                                    quantità e costo e torna a «—». Tenerlo selezionato
                                                    mentirebbe appena l'operatrice corregge uno dei due
                                                    campi — direbbe «10 pasti» sopra una riga da 12. */}
                                                <select
                                                    id={`${base}-pac`}
                                                    className={SELECT}
                                                    value=""
                                                    onChange={(e) => {
                                                        const p = pacchetti[Number(e.target.value)]
                                                        if (!p) return
                                                        setTicket((prec) =>
                                                            prec.map((x, i) =>
                                                                i === idx
                                                                    ? { ...x, quantita: String(p.pezzi), costoUnitario: String(p.costo) }
                                                                    : x,
                                                            ),
                                                        )
                                                    }}
                                                >
                                                    <option value="">—</option>
                                                    {pacchetti.map((p, i) => (
                                                        <option key={`${p.label}-${i}`} value={i}>
                                                            {p.label || `${p.pezzi} × ${formatEuro(p.costo)}`}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        ) : (
                                            sede && (
                                                <p className="self-end font-maven text-xs text-kidville-sub">
                                                    {t('reconComponiPacchettiAssenti')}
                                                </p>
                                            )
                                        )}
                                        <div>
                                            <label htmlFor={`${base}-qta`} className={ETICHETTA}>
                                                {t('reconComponiCampoQuantita')}
                                            </label>
                                            <input
                                                id={`${base}-qta`}
                                                type="number"
                                                step="1"
                                                min="1"
                                                className={INPUT}
                                                value={k.quantita}
                                                onChange={(e) =>
                                                    setTicket((p) =>
                                                        p.map((x, i) => (i === idx ? { ...x, quantita: e.target.value } : x)),
                                                    )
                                                }
                                            />
                                        </div>
                                        <div>
                                            <label htmlFor={`${base}-costo`} className={ETICHETTA}>
                                                {t('reconComponiCampoCostoUnitario')}
                                            </label>
                                            <input
                                                id={`${base}-costo`}
                                                type="number"
                                                step="0.01"
                                                min="0"
                                                className={INPUT}
                                                value={k.costoUnitario}
                                                onChange={(e) =>
                                                    setTicket((p) =>
                                                        p.map((x, i) => (i === idx ? { ...x, costoUnitario: e.target.value } : x)),
                                                    )
                                                }
                                            />
                                        </div>
                                        <div>
                                            {/* ⚠️ IL TOTALE È CALCOLATO, NON DIGITABILE (decisione 6): un totale
                                                scritto a mano accanto a quantità e costo è un terzo numero che
                                                può smentire gli altri due, e il saldo mensa del bambino
                                                seguirebbe quello sbagliato. `<output>` e non `<input>`. */}
                                            <span id={`${base}-tot-l`} className={ETICHETTA}>
                                                {t('reconComponiCampoTotale')}
                                            </span>
                                            <output
                                                htmlFor={`${base}-qta ${base}-costo`}
                                                aria-labelledby={`${base}-tot-l`}
                                                data-testid={`ticket-totale-${idx}`}
                                                className="block font-maven text-sm font-bold text-kidville-ink"
                                            >
                                                {formatEuro(totaleTicket(num(k.quantita), num(k.costoUnitario)))}
                                            </output>
                                        </div>
                                        <div className="flex items-end">
                                            <button
                                                type="button"
                                                className={BTN_SECONDARY}
                                                aria-label={`${t('reconComponiRimuoviVoce')} ${nuove.length + idx + 1}`}
                                                onClick={() => {
                                                    setTicket((p) => p.filter((_, i) => i !== idx))
                                                    setAncoraScelta('')
                                                }}
                                            >
                                                <Trash2 size={16} aria-hidden="true" />
                                                {t('reconComponiRimuoviVoce')}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )
                        })}

                        {/* ── La barra di quadratura (decisione 11) ──
                            `role="status"` (live region cortese) e non un testo muto: è
                            l'unica cosa che dice se si può confermare, e chi non guarda lo
                            schermo non ha altro modo di saperlo. Cambia a ogni cifra
                            digitata — è verboso, ed è il compromesso giusto: l'alternativa
                            è che «adesso quadra» non venga annunciato mai. */}
                        <div
                            role="status"
                            className={cx(
                                'rounded-card px-3 py-2 font-maven text-sm font-bold',
                                scarto === 0
                                    ? 'bg-kidville-success-soft text-kidville-success-strong'
                                    : 'bg-kidville-warn-soft text-kidville-warn-strong',
                            )}
                        >
                            {t('reconComponiCampoTotale')} {formatEuro(totale)} · {frasseQuadratura}
                        </div>

                        {/* ── Pagante, sede del documento, àncora della fattura ── */}
                        <section className={cx(SEZIONE, 'grid gap-2 sm:grid-cols-3')}>
                            <div>
                                <label htmlFor={`${uid}-pagante`} className={ETICHETTA}>
                                    {t('reconComponiIntestatario')}
                                </label>
                                <select
                                    id={`${uid}-pagante`}
                                    ref={selPagante}
                                    className={SELECT}
                                    value={paganteCorrente}
                                    onChange={(e) => setPaganteScelto(e.target.value || null)}
                                >
                                    <option value="">—</option>
                                    {ctx.pagante.candidati.map((c) => (
                                        <option key={c.parent_id} value={c.parent_id}>
                                            {c.nome}
                                        </option>
                                    ))}
                                </select>
                                {motivoPagante && (
                                    <p
                                        data-testid="componi-motivo-pagante"
                                        className="mt-1 font-maven text-xs text-kidville-sub"
                                    >
                                        {motivoPagante}
                                    </p>
                                )}

                                {/* ── NESSUN GENITORE COLLEGATO ───────────────────
                                    Zero candidati non è «scegline uno»: è «non ce n'è
                                    nessuno», e senza un adulto collegato non esiste
                                    nessun intestatario possibile per la fattura. A
                                    Giugliano ne esistono due, di bambini così.

                                    🔴 QUI NON SI INVENTA UN PAGANTE, e non si offre
                                    «un genitore qualunque»: da quell'uuid la RPC
                                    ricava l'INTESTATARIO DI UNA FATTURA VERA — cioè la
                                    detrazione 730 di una persona — e la scrittura in
                                    questo caso NON protegge, perché degrada in
                                    apertura (fail-open) invece di rifiutare. La
                                    protezione dev'essere qui: «Conferma» resta spento
                                    (`paganteCorrente` è vuoto, e il motivo è già
                                    elencato), e al posto di una scorciatoia si dice
                                    COSA MANCA e COME SI RIMEDIA.

                                    ⚠️ Il dialogo è `DialogoAggiungiLegame`, che è già
                                    un `Modal` della primitiva: lo stack di modali
                                    regge l'annidamento, e non se ne scrive un secondo
                                    qui. L'avviso sull'email non è una nota di stile —
                                    sta scritto nella sua testata: con un indirizzo,
                                    quel dialogo crea l'IDENTITÀ DI ACCESSO e MANDA LE
                                    CREDENZIALI a una famiglia vera. Chi preme lo legge
                                    prima, non lo scopre dopo. */}
                                {/* ⚠️ E SOLO SE C'È UN BAMBINO A CUI COLLEGARLO. Su un
                                    contesto senza figli — il rosso non ancora puntato
                                    su nessuno — «questo bambino non ha nessun genitore
                                    collegato» sarebbe falso: non c'è nessun bambino. Lì
                                    la strada è la casella «Aggiungi un altro bambino»,
                                    e il motivo «Genitore intestatario» resta elencato
                                    sotto, dov'è sempre stato. */}
                                {ctx.pagante.candidati.length === 0 && figliCollegabili.length > 0 && (
                                    <div
                                        id={idSenzaGenitore}
                                        data-testid="componi-senza-genitore"
                                        /* ⚠️ `kv-recon-avviso-sede` NON PARLA DI SEDI, ed è l'unico
                                           gancio che questo filetto ha in Alto Contrasto.
                                           `globals.css` lo dice a lettere accanto alla regola:
                                           `warn-strong` NON è coperto da nessuna delle regole
                                           generiche del popup — quelle riguardano `ink`, `sub`,
                                           `green` e `error-strong`. Senza la classe, dentro
                                           `.kv-recon-dialog` la superficie diventa quasi nera e
                                           l'inchiostro `warn-strong` inlinato da `@theme inline`
                                           resta com'è: **3,10:1**, sotto i 4,5:1 di WCAG 1.4.3 — su
                                           un riquadro il cui unico mestiere è essere letto, e che
                                           avvisa che di lì partono le CREDENZIALI a una famiglia
                                           vera. Con la classe, filetto e titolo passano all'ambra:
                                           **10,12:1**, già misurata e tenuta ferma dal lock
                                           `__tests__/pagamenti/riconciliazione-a11y-css.test.ts`.
                                           ⚠️ La coppia si riusa, non si ridipinge qui: un hex in
                                           questo file — commenti compresi — è rosso al lock
                                           `design-tokens-admin`, che scansiona tutto
                                           `src/components/features/admin/**` senza togliere i
                                           commenti. */
                                        className="kv-recon-avviso-sede mt-2 border-l-4 border-kidville-warn-strong pl-3"
                                    >
                                        <p className="font-maven text-xs font-bold text-kidville-warn-strong">
                                            {t('reconComponiNessunGenitoreTitolo')}
                                        </p>
                                        <p className="mt-1 font-maven text-xs text-kidville-sub">
                                            {t('reconComponiNessunGenitoreSpiega')}
                                        </p>
                                        <p className="mt-2 font-maven text-xs text-kidville-sub">
                                            {t('reconComponiNessunGenitoreEmail')}
                                        </p>
                                        <ul className="mt-2 space-y-2">
                                            {figliCollegabili.map((f) => (
                                                <li key={f.alunno_id}>
                                                    <button
                                                        type="button"
                                                        aria-label={`${t('reconComponiCollegaGenitore')} ${nomeFiglio(f)}`}
                                                        onClick={(e) => {
                                                            bottoneLegame.current = e.currentTarget
                                                            setLegameAperto({
                                                                alunnoId: f.alunno_id,
                                                                nome: nomeFiglio(f),
                                                            })
                                                        }}
                                                        className={cx(BTN_SECONDARY, 'min-h-11')}
                                                    >
                                                        <UserRoundPlus size={15} aria-hidden="true" />
                                                        {figliCollegabili.length > 1
                                                            ? `${t('reconComponiCollegaGenitore')} — ${nomeFiglio(f)}`
                                                            : t('reconComponiCollegaGenitore')}
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                            <div>
                                <label htmlFor={`${uid}-sede`} className={ETICHETTA}>
                                    {t('reconComponiSedeDocumento')}
                                </label>
                                <select
                                    id={`${uid}-sede`}
                                    className={SELECT}
                                    value={sedeDocumento}
                                    onChange={(e) => setSedeScelta(e.target.value)}
                                >
                                    <option value="">—</option>
                                    {sediSceglibili.map((s) => (
                                        <option key={s} value={s}>
                                            {nomeSede(s)}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label htmlFor={`${uid}-ancora`} className={ETICHETTA}>
                                    {t('reconComponiAncora')}
                                </label>
                                <select
                                    id={`${uid}-ancora`}
                                    className={SELECT}
                                    value={ancoraCorrente}
                                    onChange={(e) => setAncoraScelta(e.target.value)}
                                >
                                    <option value="">—</option>
                                    {righe.map((r, i) => {
                                        const loc = localizzaAncora(i)
                                        return (
                                            <option key={`${loc.specie}-${loc.indice}`} value={`${loc.specie}:${loc.indice}`}>
                                                {etichettaRiga(r, i)}
                                            </option>
                                        )
                                    })}
                                </select>
                            </div>
                        </section>

                        {/* ── Perché «Conferma» è spento ── */}
                        {motivi.length > 0 && !esito && (
                            <div
                                id={idMotivi}
                                data-testid="componi-motivi"
                                className="rounded-card bg-kidville-white px-3 py-2 font-maven text-xs text-kidville-sub"
                            >
                                <p className="font-bold">{t('reconComponiNonConfermabile')}</p>
                                <ul className="list-disc pl-4">
                                    {motivi.map((m) => (
                                        <li key={m}>{m}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                    </div>
                )}

                {erroreInvio && (
                    <p
                        role="alert"
                        className="mt-3 rounded-input bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong"
                    >
                        {messaggioDaCorpo(erroreInvio.corpo, t('reconComponiErroreCaricamento'))}
                    </p>
                )}

                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <button type="button" className={BTN_SECONDARY} onClick={onChiudi}>
                        {t('reconComponiChiudi')}
                    </button>
                    {/* Il pulsante sparisce appena l'incasso è scritto. Sul riuscito il
                        pannello viene SMONTATO da chi lo monta (il riepilogo compare
                        nell'elenco, nella fascia dell'import), quindi qui non si
                        festeggia niente: due formulazioni della stessa notizia possono
                        divergere, e una delle due non la vedrebbe nessuno. Quando invece
                        la riga bancaria NON si è legata il pannello RESTA, perché quella
                        frase dice «non ripetere» — e un avviso che se ne va con la
                        finestra è un avviso non letto. */}
                    {ctx && !esito && (
                        <button
                            type="button"
                            className={BTN_PRIMARY_AA}
                            disabled={!pronto}
                            aria-describedby={motivi.length > 0 ? idMotivi : undefined}
                            onClick={() => void registra()}
                        >
                            {t('reconComponiConferma')}
                        </button>
                    )}
                </div>
            </div>

            {/* ── Il dialogo che collega un genitore ──────────────────────────
                È il dialogo dell'anagrafica, montato tale e quale: il legame che
                serve qui è lo stesso che si scrive dalla scheda del bambino, e una
                seconda schermata per scriverlo sarebbe un secondo criterio su chi
                può essere un genitore.

                ⚠️ AL RITORNO SI RILEGGE IL CONTESTO, sempre — anche quando il corpo
                della risposta non si è potuto leggere (`esito === null`). Il legame
                può essere stato scritto lo stesso, e una tendina che resta vuota
                accanto a un legame appena creato manda a rifarlo. La rilettura è una
                GET; il costo di non farla è un doppione in anagrafica. */}
            {legameAperto && (
                <DialogoAggiungiLegame
                    verso="genitori"
                    alunnoId={legameAperto.alunnoId}
                    nomeFisso={legameAperto.nome}
                    onChiudi={() => {
                        // Annullato: non si è scritto niente, il blocco resta a
                        // schermo e il fuoco torna sul pulsante da cui si è entrati.
                        rientraDaLegame.current = 'annullato'
                        setLegameAperto(null)
                    }}
                    onCollegato={() => {
                        // Scritto: il blocco — pulsante compreso — sparirà appena la
                        // rilettura porta i candidati. Il fuoco NON si posa su un nodo
                        // condannato (v. il commento sul rientro del fuoco).
                        rientraDaLegame.current = 'collegato'
                        setLegameAperto(null)
                        setRicaricaCtx((n) => n + 1)
                    }}
                />
            )}
        </section>
    )
}
