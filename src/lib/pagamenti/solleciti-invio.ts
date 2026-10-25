import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede, type ContestoSede } from '@/lib/email/contesto'
import { FRASE_PAGAMENTO_CONTANTI, messaggioSollecito, type LivelloSollecito } from '@/lib/email/messaggi/sollecito'
import { getGenitoriDiAlunno } from '@/lib/anagrafiche/legami'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { getModuleConfig } from '@/lib/settings/module-config'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { sanificaMessaggio } from '@/lib/logging/serialize'
import { formatEuro } from '@/lib/format/valuta'
import { isoToIt } from '@/lib/format/data'
import { residuoEffettivo } from './aging'
import { DEFAULT_CAUSALE_TEMPLATE, causaleBonifico, modelloCausale, rigaCausaleSollecito, type DatiCausale } from './causale'
// Il codice della voce si calcola QUI, nel chiamante: il motore delle causali riceve
// valori già formattati (come `importo` e `scadenza`) e non conosce gli id delle righe.
import { codiceVoce } from './codice-voce'
import { meseAnnoDaPeriodo } from './periodo'
import { coordinateBonificoSede } from './coordinate-bonifico'
import { ammetteBonifico } from './metodi-ammessi'
import {
    DEFAULT_SOLLECITI_CONFIG,
    livelliEffettivi,
    prossimoLivello,
    renderTemplate,
    type SollecitiConfig,
} from './solleciti'
import { formattaIstante } from '@/i18n/config'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'

// Motore d'invio dei solleciti (manuale e cron). Regole:
//  • anti-spam: mai due invii entro la cadenza minima (ultimo_sollecito_il);
//  • livelli sequenziali (mai saltare); in automatico il livello deve essere
//    "maturo" (giorni di ritardo ≥ soglia) e il 3° resta SOLO manuale;
//  • destinatari: titolari quota (split) oppure tutori del bambino;
//  • ogni invio reale → riga in `solleciti` (testo effettivo = audit) + push.
// Il registro può mancare (DB e2e CI): si degrada senza bloccare.
//
// FASE 8 DELLA ROADMAP DI ROBUSTEZZA (2026-10-11) — il giro può morire a metà:
//  • le letture vanno a BLOCCHI di `ID_PER_QUERY`. Con 500 voci un solo `.in()`
//    faceva un URL di ~19 KB, e la lettura dei livelli poteva superare le 1.000
//    righe di PostgREST, che tronca IN SILENZIO: un livello già inviato spariva e
//    alla famiglia ripartiva il sollecito precedente;
//  • una voce non letta non è «non trovata»: l'esito porta `guasto: true`, e il
//    giro automatico non chiude col battito «ok»;
//  • LA PRESA: `ultimo_sollecito_il` si scrive PRIMA dell'email, con un UPDATE
//    condizionato sul valore letto. Due giri sulla stessa voce (il cron e il bottone
//    della segreteria) non spediscono due volte: il secondo trova la data cambiata e
//    salta. Il prezzo, scelto: se il giro muore fra la presa e l'email, quel sollecito
//    slitta di una cadenza invece di partire due volte;
//  • ogni email porta una chiave d'idempotenza (voce, livello, destinatario, giorno):
//    un ritentativo nello stesso giorno Resend non lo rispedisce;
//  • un tetto di tempo (`scadenza`): oltre, le voci restanti escono `rinviato per
//    tempo` e le riprende il giro dopo, invece di morire col muro della Function.
//
// SESSIONE 9 DELLA SECONDA SERIE (email e fornitori senza successi finti):
//  • un sollecito è «inviato» solo se ALMENO UNA email è partita. Se non ne parte nessuna, la
//    presa si annulla con un UPDATE condizionato sulla presa stessa (se un altro giro l'ha già
//    ripresa, resta la sua), l'esito è `ok: false` e il giro dopo la riprende;
//  • se l'esito è INCERTO (scadenza senza risposta, 409 concorrente) la presa resta: il
//    sollecito slitta di una cadenza invece di partire due volte;
//  • il registro si scrive anche quando l'invio fallisce, con l'esito per destinatario; i
//    livelli contano solo le righe con almeno un `inviata: true` (`FILTRO_RECAPITATO`);
//  • niente push se nessuna email è partita: la push accompagna il sollecito, non lo sostituisce;
//  • nessun destinatario con un indirizzo ⇒ niente presa e niente registro, un `warn`;
//  • nel giro automatico l'email ritenta (429, 5xx, rete) dentro il tetto del giro.

export interface EsitoSollecito {
    pagamento_id: string
    ok: boolean
    livello?: number
    oggetto?: string
    corpo?: string
    destinatari?: { id: string; email?: string | null }[]
    motivo?: string
    /** `true` = non inviato per un GUASTO (lettura fallita, presa non scritta), non per una
     *  regola: il giro automatico non lo può chiudere con il battito «ok». */
    guasto?: boolean
    /** `true` = non tentato perché il giro ha raggiunto il suo tetto di tempo. */
    rinviato?: boolean
    /** Sessione 9: le email partite e quelle tentate (i destinatari con un indirizzo). */
    inviate?: number
    tentate?: number
}

interface PagRow {
    id: string
    alunno_id: string
    scuola_id: string
    descrizione: string
    importo: number
    importo_pagato: number | null
    sconto?: number | null
    stato: string
    scadenza: string | null
    tipo: string
    periodo_competenza: string | null
    ultimo_sollecito_il: string | null
    /** Assente (DB non migrato) o `null` ⇒ tutti e due i metodi: lo decide `normalizzaMetodiAmmessi`. */
    metodi_ammessi?: string[] | null
    alunni?: { nome?: string; cognome?: string; codice_fiscale?: string | null } | null
    payment_categories?: { slug?: string | null } | null
}

const MS_GIORNO = 86_400_000

/** Il registro `solleciti` assente (DB E2E della CI non migrato): Postgres e PostgREST. */
const REGISTRO_ASSENTE = new Set(['42P01', 'PGRST205'])

/**
 * Il filtro dei livelli (sessione 9): solo le righe del registro con ALMENO un destinatario
 * raggiunto. Da questa sessione il registro scrive anche i tentativi falliti; senza il filtro
 * una riga non recapitata farebbe salire il livello, e alla famiglia arriverebbe il 3° sollecito
 * senza aver mai ricevuto il 2°. Stringa JSON e non array: postgrest-js tradurrebbe un array JS
 * nel letterale Postgres `cs.{…}`, che su una colonna jsonb non vale; con la stringa esce
 * `cs.[{"inviata":true}]`, cioè `destinatari @> '[{"inviata":true}]'`.
 */
const FILTRO_RECAPITATO = '[{"inviata":true}]'

/** Un destinatario nel registro: l'esito del suo invio. */
interface DestinatarioRegistrato {
    id: string
    email?: string | null
    inviata: boolean
    /** Il provider potrebbe averla presa (vedi `SendEmailResult.incerto`). */
    incerta?: true
}

/** La riga del registro `solleciti`, senza il canale (lo aggiunge `registraSollecito`). */
interface RigaRegistro {
    pagamento_id: string
    scuola_id: string
    alunno_id: string
    livello: number
    destinatari: DestinatarioRegistrato[]
    oggetto: string
    corpo: string
    automatico: boolean
    inviato_da: string | null
}

export async function sollecitaPagamenti(
    supabase: SupabaseClient,
    pagamentoIds: string[],
    opts: {
        livello?: number
        anteprima?: boolean
        automatico?: boolean
        attoreId?: string | null
        /** Scoping multi-sede: pagamenti fuori da queste sedi vengono saltati. */
        sediAmmesse?: string[]
        /** Tetto di tempo (epoch ms): oltre, le voci restanti escono `rinviato`. */
        scadenza?: number
    } = {},
): Promise<EsitoSollecito[]> {
    const COLONNE_PAG_BASE = 'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, stato, scadenza, tipo, periodo_competenza, ultimo_sollecito_il, alunni:alunno_id ( nome, cognome, codice_fiscale ), payment_categories:categoria_id ( slug )'
    const COLONNE_PAG = 'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, sconto, stato, scadenza, tipo, periodo_competenza, ultimo_sollecito_il, alunni:alunno_id ( nome, cognome, codice_fiscale ), payment_categories:categoria_id ( slug )'
    const COLONNE_PAG_METODI = `${COLONNE_PAG}, metodi_ammessi`
    const pags: PagRow[] = []
    // Le voci il cui blocco non si è letto: «non letta» non è «non trovata».
    const nonLetti = new Set<string>()
    for (const blocco of aBlocchi(pagamentoIds, ID_PER_QUERY)) {
        let { data: pagRows, error: errPag } = await supabase.from('pagamenti').select(COLONNE_PAG_METODI).in('id', blocco)
        // DB E2E CI non migrato, una colonna nuova alla volta (42703 ⇒ un gradino giù):
        //   `metodi_ammessi` assente → senza: ogni voce ammette entrambi i metodi, come prima della colonna;
        //   `sconto` assente         → senza: residuo = importo − pagato.
        // Ogni gradino lascia un `warn`: in produzione la colonna c'è, e una degradazione
        // muta nasconderebbe una migrazione mai applicata.
        for (const colonne of [COLONNE_PAG, COLONNE_PAG_BASE]) {
            if (!errPag || (errPag as { code?: string }).code !== '42703') break
            logEvento('pagamento', 'warn', { operazione: 'solleciti:pagamenti', esito: 'select-in-degradazione' })
            const retry = await supabase.from('pagamenti').select(colonne).in('id', blocco)
            pagRows = retry.data as unknown as typeof pagRows
            errPag = retry.error
        }
        // PostgREST non lancia: un errore residuo (≠ colonna mancante) va tracciato, non
        // ingoiato — e le voci del blocco escono come GUASTO, non come «non trovate».
        if (errPag) {
            logErrore({ operazione: 'solleciti:pagamenti', evento: 'db' }, errPag)
            for (const id of blocco) nonLetti.add(id)
            continue
        }
        pags.push(...((pagRows || []) as unknown as PagRow[]))
    }

    // livello già raggiunto (registro; degrade → si riparte da 1)
    //
    // Il degrado resta quello di sempre, ma ora SI DICE. Il `catch` qui sotto aveva
    // soltanto un commento, e non scattava nemmeno: PostgREST non lancia, l'errore
    // torna in `{ error }` e `data` resta `null` — cioè «nessuno storico», in silenzio.
    // Per il registro assente (DB della CI non migrato) è giusto ripartire da 1, e
    // basta un `info`; per un guasto vero è un `error`, perché vuol dire rimandare il
    // 1° sollecito a chi ha già ricevuto il 2°.
    //
    // A BLOCCHI (fase 8): tre livelli per voce, e un `.in()` di 500 voci poteva tornare
    // più delle 1.000 righe che PostgREST restituisce — troncate senza dirlo.
    const maxLivello = new Map<string, number>()
    try {
        for (const blocco of aBlocchi(pagamentoIds, ID_PER_QUERY)) {
            const { data, error: errLivelli } = await supabase.from('solleciti').select('pagamento_id, livello').in('pagamento_id', blocco).contains('destinatari', FILTRO_RECAPITATO)
            if (errLivelli) {
                const assente = REGISTRO_ASSENTE.has((errLivelli as { code?: string }).code ?? '')
                logEvento('pagamento', assente ? 'info' : 'error', {
                    operazione: 'solleciti:livelli',
                    esito: assente ? 'registro-solleciti-assente' : 'livelli-non-letti',
                    n: blocco.length,
                }, errLivelli)
                // Il registro assente lo è per tutti i blocchi: una riga sola basta.
                if (assente) break
                continue
            }
            for (const s of (data || []) as { pagamento_id: string; livello: number }[]) {
                maxLivello.set(s.pagamento_id, Math.max(maxLivello.get(s.pagamento_id) ?? 0, s.livello))
            }
        }
    } catch (err) {
        logEvento('pagamento', 'error', {
            operazione: 'solleciti:livelli',
            esito: 'livelli-non-letti',
            n: pagamentoIds.length,
        }, err)
    }

    const cfgCache = new Map<string, {
        cfg: SollecitiConfig
        scuolaNome: string
        sedeNome: string
        causaliCfg: Partial<Record<string, string>>
        iban: string | null
        intestatario: string | null
        contestoSede: ContestoSede
    }>()
    const esiti: EsitoSollecito[] = []
    const adesso = Date.now()

    let rinviati = 0
    for (const id of pagamentoIds) {
        // Il tetto di tempo: si guarda PRIMA della presa, così una voce rinviata resta
        // intatta per il giro dopo.
        if (opts.scadenza !== undefined && Date.now() >= opts.scadenza) {
            rinviati++
            esiti.push({ pagamento_id: id, ok: false, motivo: 'rinviato per tempo', rinviato: true }); continue
        }
        if (nonLetti.has(id)) {
            esiti.push({ pagamento_id: id, ok: false, motivo: 'pagamento non letto: sollecito non inviato', guasto: true }); continue
        }
        const pag = pags.find((p) => p.id === id)
        if (!pag) { esiti.push({ pagamento_id: id, ok: false, motivo: 'pagamento non trovato' }); continue }
        if (opts.sediAmmesse && !opts.sediAmmesse.includes(pag.scuola_id)) {
            esiti.push({ pagamento_id: id, ok: false, motivo: 'fuori dalle sedi attive' }); continue
        }
        const residuo = residuoEffettivo(pag)
        if (pag.stato === 'pagato' || residuo <= 0) { esiti.push({ pagamento_id: id, ok: false, motivo: 'già saldato' }); continue }
        if (pag.tipo === 'padre') { esiti.push({ pagamento_id: id, ok: false, motivo: 'contenitore rateale: sollecitare le rate' }); continue }

        let scuolaCtx = cfgCache.get(pag.scuola_id)
        if (!scuolaCtx) {
            const cfg = (await getModuleConfig(supabase, 'solleciti_config', pag.scuola_id)) as SollecitiConfig
            // IBAN e intestatario del riquadro «Dati per il bonifico» vengono da
            // `coordinateBonificoSede`, lo STESSO motore che riempie la card
            // «Come pagare» del genitore: sono le due righe che la famiglia
            // copia nell'home banking, e leggerle due volte significa poterle
            // dire diverse nei due posti senza che nessuno se ne accorga.
            // L'IBAN esce già a gruppi di quattro — e `null` se le cifre di
            // controllo non tornano: un IBAN sbagliato non si manda mai.
            const coordinate = await coordinateBonificoSede(supabase, pag.scuola_id, {
                operazione: 'solleciti-invio',
            })
            // Modelli di causale per-categoria (per slug, con eventuale `default`).
            // `getModuleConfig` degrada da solo (config/colonna assente → `{}` → predefinito).
            const causaliCfg = await getModuleConfig<Record<string, string>>(supabase, 'causali_config', pag.scuola_id)
            // Nome sede per la causale consigliata (best-effort): `scuole.nome`
            // («Kidville Giugliano» → «GIUGLIANO» via sedeCausale nel builder).
            const { data: sede, error: errSede } = await supabase.from('scuole').select('nome').eq('id', pag.scuola_id).maybeSingle()
            // Best-effort davvero (la causale esce senza il nome della sede), ma non più muto.
            if (errSede) logEvento('pagamento', 'warn', { operazione: 'solleciti-invio', esito: 'nome-sede-non-letto', scuola_id: pag.scuola_id }, errSede)
            scuolaCtx = {
                cfg,
                // La firma della prosa (`{scuola}` nei modelli): resta com'era,
                // col ripiego «La Segreteria» quando la denominazione non è
                // configurata. ⚠️ Il ripiego NON può decidere l'intestatario del
                // conto: è una stringa sentinella, e finché l'intestatario si
                // deduceva da lui una sede davvero chiamata «La Segreteria»
                // perdeva la riga «Intestato a».
                scuolaNome: coordinate.intestatario ?? 'La Segreteria',
                sedeNome: ((sede?.nome as string | null | undefined) ?? '') || '',
                causaliCfg,
                // Vuoto finché qualcuno non compila l'IBAN in Impostazioni:
                // allora il riquadro mostra importo, causale e intestatario —
                // cioè esattamente ciò che questo sollecito manda da sempre.
                iban: coordinate.iban,
                intestatario: coordinate.intestatario,
                // L'identità della sede per il piè di pagina dell'email.
                contestoSede: await risolviContestoSede(supabase, pag.scuola_id, 'solleciti-invio'),
            }
            cfgCache.set(pag.scuola_id, scuolaCtx)
        }
        const { cfg, scuolaNome, sedeNome, causaliCfg, iban, intestatario, contestoSede } = scuolaCtx

        const cadenza = cfg.cadenza_min_giorni ?? DEFAULT_SOLLECITI_CONFIG.cadenza_min_giorni
        if (pag.ultimo_sollecito_il && adesso - Date.parse(pag.ultimo_sollecito_il) < cadenza * MS_GIORNO) {
            esiti.push({ pagamento_id: id, ok: false, motivo: `cadenza minima di ${cadenza}gg non ancora trascorsa` })
            continue
        }

        const giorniRitardo = pag.scadenza ? Math.max(0, Math.floor((adesso - Date.parse(pag.scadenza)) / MS_GIORNO)) : 0
        const giaInviato = maxLivello.get(id) ?? 0
        const livello = opts.livello
            ?? (opts.automatico
                ? prossimoLivello(cfg, giorniRitardo, giaInviato)
                : Math.min(giaInviato + 1, 3))
        if (!livello) { esiti.push({ pagamento_id: id, ok: false, motivo: 'nessun livello maturo' }); continue }
        if (opts.automatico && livello >= 3) {
            esiti.push({ pagamento_id: id, ok: false, motivo: 'il 3° sollecito si invia solo manualmente' })
            continue
        }

        const liv = livelliEffettivi(cfg)[livello - 1]
        const ctx = {
            alunno: [pag.alunni?.nome, pag.alunni?.cognome].filter(Boolean).join(' ') || 'vostro figlio/a',
            descrizione: pag.descrizione ?? '—',
            importo: formatEuro(pag.importo),
            residuo: formatEuro(residuo),
            scadenza: pag.scadenza ? formattaIstante(new Date(pag.scadenza), 'it') : '—',
            scuola: scuolaNome,
            giorni_ritardo: giorniRitardo,
        }
        const oggetto = renderTemplate(liv.oggetto, ctx)
        // Modello di causale per la categoria della voce (per slug) → `default` → predefinito.
        // La regola sta in `modelloCausale`: era scritta qui e nell'elenco pagamenti, e le
        // due copie potevano divergere sulla cosa che il genitore ricopia nel bonifico.
        const slug = pag.payment_categories?.slug ?? undefined
        const templateCausale = modelloCausale(causaliCfg, slug, DEFAULT_CAUSALE_TEMPLATE)
        const { mese, anno } = meseAnnoDaPeriodo(pag.periodo_competenza)
        // I DATI DELLA CAUSALE, COMPOSTI UNA VOLTA SOLA PER QUESTA VOCE.
        //
        // La stessa email li stampa DUE volte: nel corpo testuale (`rigaCausaleSollecito`,
        // che è anche l'anteprima dell'operatore e la colonna d'audit `solleciti.corpo`) e
        // nel riquadro «Dati per il bonifico» dell'HTML. Erano due oggetti gemelli scritti
        // di seguito, cioè due posti da aggiornare: il giorno in cui se ne tocca uno solo
        // la famiglia legge due causali diverse dentro lo stesso messaggio — senza un
        // errore, senza un log, e con la riconciliazione che torna a indovinare.
        const datiCausale: DatiCausale = {
            descrizione: pag.descrizione,
            nome: pag.alunni?.nome,
            cognome: pag.alunni?.cognome,
            codiceFiscale: pag.alunni?.codice_fiscale,
            sede: sedeNome,
            mese,
            anno,
            importo: formatEuro(pag.importo),
            scadenza: isoToIt(pag.scadenza ?? ''),
            // L'id della VOCE che si sta sollecitando, lo stesso da cui l'elenco pagamenti
            // ricava il codice della stessa riga: il genitore ne ricopia UNA sola di
            // causale — quella dell'app o quella dell'email — e la riconciliazione legge
            // ciò che è finito nel bonifico. Se le due strade calcolassero il codice da
            // due campi diversi, metà delle famiglie pagherebbe con un codice che non
            // nomina la voce che stanno saldando.
            codice: codiceVoce(pag.id),
        }
        // Il CF del bambino va SOLO nel corpo dell'email (destinatario = tutore →
        // dato lecito), MAI nei log: `corpo` non viene passato a nessun logger, e
        // `sendEmail`/`externalFetch` non loggano il body della richiesta. Lo stesso
        // vale per il `codice`, che nella causale viaggia accanto a quel CF.
        //
        // VOCE «SOLO CONTANTI» (2026-10-05): niente causale e niente codice. Una
        // causale mandata per una voce che non ammette il bonifico è un invito a
        // fare un bonifico che la segreteria non si aspetta; al suo posto, la stessa
        // frase che il riquadro HTML mette sotto «Come pagare».
        const bonificoAmmesso = ammetteBonifico(pag.metodi_ammessi)
        const rigaPagamento = bonificoAmmesso
            ? rigaCausaleSollecito(datiCausale, templateCausale)
            : FRASE_PAGAMENTO_CONTANTI
        const corpo = `${renderTemplate(liv.testo, ctx)}\n\n${rigaPagamento}`

        // destinatari: titolari quota (split) oppure tutori del bambino
        let adultIds: string[] = []
        //
        // Fase 5 robustezza, sesto pezzo: un guasto su queste letture NON è «nessuna quota»
        // né «nessun destinatario». Il primo ripiegava su TUTTI i tutori, cioè mandava il
        // sollecito della quota di un genitore separato all'altro genitore.
        if (pag.tipo === 'split') {
            const { data, error: errQuote } = await supabase.from('pagamenti_quote').select('adult_id').eq('pagamento_id', id)
            if (errQuote) {
                logEvento('pagamento', 'error', { operazione: 'solleciti-invio', esito: 'quote-non-lette', pagamento_id: id }, errQuote)
                esiti.push({ pagamento_id: id, ok: false, motivo: 'quote non lette: sollecito non inviato' }); continue
            }
            adultIds = ((data || []) as { adult_id: string }[]).map((q) => q.adult_id)
        }
        if (adultIds.length === 0) {
            // Unione runtime (`legame_genitori_alunni`) + anagrafica
            // (`student_parents` via ponte `parents.auth_user_id`): con la sola
            // runtime il sollecito di una retta scaduta non raggiungeva nessuno
            // e l'esito restava «nessun destinatario collegato» — la morosità
            // cresceva senza che la famiglia ricevesse mai una riga.
            adultIds = await getGenitoriDiAlunno(supabase, pag.alunno_id)
        }
        let destinatari: { id: string; email?: string | null }[] = []
        if (adultIds.length > 0) {
            const { data, error: errUtenti } = await supabase.from('utenti').select('id, email').in('id', adultIds)
            if (errUtenti) {
                logEvento('pagamento', 'error', { operazione: 'solleciti-invio', esito: 'destinatari-non-letti', pagamento_id: id }, errUtenti)
                esiti.push({ pagamento_id: id, ok: false, motivo: 'destinatari non letti: sollecito non inviato' }); continue
            }
            destinatari = (data || []) as { id: string; email?: string | null }[]
        }
        if (destinatari.length === 0) { esiti.push({ pagamento_id: id, ok: false, motivo: 'nessun destinatario collegato' }); continue }
        if (!destinatari.some((d) => !!d.email)) {
            // Sessione 9: nessuno dei destinatari ha un indirizzo. Prima si prendeva la cadenza,
            // si mandava la sola push e si registrava un sollecito senza nessuna email partita: la
            // voce risultava «sollecitata» e il livello saliva. Ora si dice, e la voce resta com'è.
            if (!opts.anteprima) {
                logEvento('pagamento', 'warn', {
                    operazione: 'solleciti-invio', esito: 'nessun-indirizzo-email', pagamento_id: id,
                    n_destinatari: destinatari.length,
                    msg: 'sollecito non inviato: nessun destinatario collegato ha un indirizzo email',
                })
            }
            esiti.push({ pagamento_id: id, ok: false, motivo: 'nessun destinatario con un indirizzo email' }); continue
        }

        if (opts.anteprima) {
            esiti.push({ pagamento_id: id, ok: true, livello, oggetto, corpo, destinatari })
            continue
        }

        // ─── L'EMAIL: la STRUTTURA la dà il design, la PROSA la dà la sede ───
        // `corpo` resta ciò che è sempre stato — testo semplice — perché è tre
        // cose insieme: il gemello testuale dell'email, l'anteprima che
        // l'operatore legge prima di inviare, e la colonna `solleciti.corpo`
        // che è l'audit di ciò che è partito. Metterci dentro l'HTML renderebbe
        // illeggibile l'audit e romperebbe l'anteprima.
        //
        // L'HTML si compone a parte, dagli stessi dati strutturati: la prosa
        // configurata entra nella scheda bianca, i riquadri (voci, totale,
        // bonifico) li mette il modulo.
        const messaggio = messaggioSollecito({
            livello: livello as LivelloSollecito,
            oggetto,
            prosa: renderTemplate(liv.testo, ctx),
            alunno: ctx.alunno,
            voci: [{
                descrizione: pag.descrizione ?? '—',
                scadenza: ctx.scadenza,
                giorniRitardo,
                importo: residuo,
            }],
            // La STESSA stringa del corpo testuale qui sopra: stessi dati, stesso
            // modello, stessa porta (`causaleBonifico`, l'unica che applica
            // `conCodiceVoce`). Il riquadro è ciò che la famiglia copia davvero.
            // `null` per la voce «solo contanti»: il modulo toglie riquadro e IBAN.
            causale: bonificoAmmesso ? causaleBonifico(datiCausale, templateCausale) : null,
            intestatario,
            iban,
        }, contestoSede)

        // LA PRESA (fase 8). La cadenza anti-ripetizione si scrive PRIMA dell'email, e solo
        // se nessun altro l'ha cambiata dopo la lettura: un UPDATE condizionato è atomico
        // nel database. Zero righe = un altro giro (il cron, o la segreteria dal bottone)
        // ha appena sollecitato questa voce: qui si salta. Fino al 2026-10-11 la data si
        // scriveva DOPO email, push e registro: un giro morto in mezzo lasciava la voce
        // «mai sollecitata», e il giro dopo rispediva.
        const presaIl = new Date().toISOString()
        const aggiorna = supabase.from('pagamenti').update({ ultimo_sollecito_il: presaIl }).eq('id', id)
        const { data: presa, error: errPresa } = await (pag.ultimo_sollecito_il
            ? aggiorna.eq('ultimo_sollecito_il', pag.ultimo_sollecito_il)
            : aggiorna.is('ultimo_sollecito_il', null)
        ).select('id')
        if (errPresa) {
            // Senza la data scritta, non si sa se un altro giro sta spedendo: non si spedisce.
            logEvento('pagamento', 'error', { operazione: 'solleciti-invio', esito: 'cadenza-non-scritta', pagamento_id: id }, errPresa)
            esiti.push({ pagamento_id: id, ok: false, motivo: 'cadenza non scritta: sollecito non inviato', guasto: true }); continue
        }
        if ((presa ?? []).length === 0) {
            logEvento('pagamento', 'info', {
                operazione: 'solleciti-invio', esito: 'sollecito-gia-in-corso', pagamento_id: id,
                msg: 'la cadenza della voce è cambiata dopo la lettura: un altro giro l’ha appena sollecitata',
            })
            esiti.push({ pagamento_id: id, ok: false, motivo: 'sollecito già inviato da un altro giro' }); continue
        }

        const giorno = presaIl.slice(0, 10)
        const registrati: DestinatarioRegistrato[] = []
        let inviate = 0
        let tentate = 0
        let incerte = 0
        let ultimoErrore: string | null = null
        for (const d of destinatari) {
            if (!d.email) {
                registrati.push({ id: d.id, email: d.email, inviata: false })
                continue
            }
            tentate++
            const invio = await sendEmailDetailed({
                to: d.email, subject: oggetto, text: corpo, html: messaggio.html,
                // voce + livello + destinatario + giorno: lo stesso sollecito ritentato
                // lo stesso giorno Resend non lo rispedisce. Solo uuid e una data.
                chiaveIdempotenza: `sollecito:${id}:L${livello}:${d.id}:${giorno}`,
                // Sessione 9: i ritentativi (429, 5xx, rete) solo nel giro AUTOMATICO e dentro il
                // suo tetto di tempo. Dal bottone la segreteria aspetta davanti allo schermo: un
                // fallimento lo vede subito, e decide lei.
                ...(opts.automatico ? { ritentativi: opts.scadenza !== undefined ? { scadenza: opts.scadenza } : {} } : {}),
            })
            if (invio.ok) {
                inviate++
            } else {
                ultimoErrore = invio.error
                if (invio.incerto) incerte++
            }
            registrati.push({ id: d.id, email: d.email, inviata: invio.ok, ...(invio.incerto ? { incerta: true as const } : {}) })
        }
        // Il registro è l'AUDIT di ciò che si è TENTATO, con l'esito per destinatario, e la fonte
        // dei livelli qui sopra (che però contano solo le righe recapitate: `FILTRO_RECAPITATO`).
        const riga: RigaRegistro = {
            pagamento_id: id,
            scuola_id: pag.scuola_id,
            alunno_id: pag.alunno_id,
            livello,
            destinatari: registrati,
            oggetto,
            corpo,
            automatico: !!opts.automatico,
            inviato_da: opts.attoreId ?? null,
        }
        if (inviate === 0) {
            // NESSUNA EMAIL È PARTITA (sessione 9). Prima: presa scritta, push mandata, registro
            // scritto ed esito `ok: true` — la voce risultava sollecitata e la famiglia non aveva
            // ricevuto niente. Ora:
            //  · esito certo ⇒ la presa si annulla, e il giro dopo riprende la voce;
            //  · esito incerto ⇒ la presa resta: meglio slittare di una cadenza che partire due volte.
            // In entrambi i casi niente push, e il registro dice com'è andata.
            const presaAnnullata = incerte === 0
                ? await annullaPresa(supabase, id, presaIl, pag.ultimo_sollecito_il)
                : false
            await registraSollecito(supabase, riga)
            if (incerte > 0) {
                logEvento('pagamento', 'warn', {
                    operazione: 'solleciti-invio', esito: 'sollecito-esito-incerto', pagamento_id: id,
                    livello_sollecito: livello, tentate, incerte,
                    msg: 'nessuna email confermata dal provider, ma una potrebbe essere partita: la cadenza resta e il sollecito slitta di una cadenza',
                })
                esiti.push({
                    pagamento_id: id, ok: false, livello, inviate: 0, tentate,
                    motivo: 'esito incerto presso il provider: nessun nuovo invio prima della prossima cadenza',
                })
                continue
            }
            logEvento('pagamento', 'error', {
                operazione: 'solleciti-invio', esito: 'sollecito-non-recapitato', pagamento_id: id,
                livello_sollecito: livello, tentate, presa_annullata: presaAnnullata,
            }, erroreNonRecapitato(ultimoErrore))
            esiti.push({
                pagamento_id: id, ok: false, livello, inviate: 0, tentate,
                motivo: presaAnnullata
                    ? 'nessuna email partita: il sollecito resta per il giro successivo'
                    : 'nessuna email partita, e la cadenza non è tornata indietro: il sollecito slitta di una cadenza',
            })
            continue
        }
        try {
            await enqueueNotifiche(supabase, {
                utenteIds: destinatari.map((d) => d.id),
                tipo: 'pagamento',
                titolo: oggetto,
                corpo: `Residuo ${ctx.residuo} — ${ctx.descrizione}`,
                link: '/parent/pagamenti',
                scuolaId: pag.scuola_id,
            })
        } catch (err) {
            // Best-effort: l'email è già partita e il registro qui sotto si scrive lo
            // stesso. Ma una push persa si DICE — il commento «best-effort» era l'unica
            // traccia, e non finiva in `app_log`. Solo l'uuid della voce.
            logEvento('notifica', 'error', {
                operazione: 'solleciti:push',
                esito: 'push-non-accodata',
                pagamento_id: id,
            }, err)
        }
        await registraSollecito(supabase, riga)
        // La cadenza è già scritta: è la presa, qui sopra, prima dell'email.
        esiti.push({ pagamento_id: id, ok: true, livello, oggetto, destinatari, inviate, tentate })
    }
    if (rinviati > 0) {
        logEvento('pagamento', 'warn', {
            operazione: 'solleciti-invio', esito: 'rinviati-per-tempo', rinviati,
            msg: `solleciti: ${rinviati} voci rinviate al giro successivo per il tetto di tempo`,
        })
    }
    return esiti
}

/**
 * Riporta la cadenza al valore di prima, SOLO se è ancora la nostra presa (sessione 9).
 *
 * È lo stesso UPDATE condizionato della presa, al contrario: `… where ultimo_sollecito_il =
 * <presa>`. Zero righe = un altro giro (il cron, o la segreteria dal bottone) ha ripreso la voce
 * dopo di noi: la cadenza è sua, e non si tocca. `true` solo se la cadenza è tornata indietro.
 */
async function annullaPresa(
    supabase: SupabaseClient,
    id: string,
    presaIl: string,
    precedente: string | null,
): Promise<boolean> {
    try {
        const { data, error } = await supabase
            .from('pagamenti')
            .update({ ultimo_sollecito_il: precedente })
            .eq('id', id)
            .eq('ultimo_sollecito_il', presaIl)
            .select('id')
        if (error) {
            logEvento('pagamento', 'error', {
                operazione: 'solleciti-invio', esito: 'presa-non-annullata', pagamento_id: id,
                msg: 'nessuna email partita e la cadenza non è tornata indietro: il sollecito slitta di una cadenza',
            }, error)
            return false
        }
        if ((data ?? []).length === 0) {
            logEvento('pagamento', 'info', {
                operazione: 'solleciti-invio', esito: 'presa-gia-ripresa', pagamento_id: id,
                msg: 'la cadenza è cambiata dopo la presa: un altro giro ha ripreso la voce, e resta la sua',
            })
            return false
        }
        return true
    } catch (err) {
        logEvento('pagamento', 'error', {
            operazione: 'solleciti-invio', esito: 'presa-non-annullata', pagamento_id: id,
        }, err)
        return false
    }
}

/**
 * Il registro è l'AUDIT di ciò che si è tentato (e la fonte dei livelli). Se non si scrive il
 * sollecito resta quello che è, ma il prossimo ripartirebbe dallo stesso livello: si dice, `info`
 * se il registro non esiste (DB della CI), `error` altrimenti. PostgREST non lancia: si legge
 * `{ error }`. Mai oggetto né corpo nella riga di log.
 */
async function registraSollecito(supabase: SupabaseClient, riga: RigaRegistro): Promise<void> {
    try {
        const { error: errRegistro } = await supabase.from('solleciti').insert({ ...riga, canale: 'email' })
        if (errRegistro) {
            const assente = REGISTRO_ASSENTE.has((errRegistro as { code?: string }).code ?? '')
            logEvento('pagamento', assente ? 'info' : 'error', {
                operazione: 'solleciti:registro',
                esito: assente ? 'registro-solleciti-assente' : 'registro-sollecito-non-scritto',
                pagamento_id: riga.pagamento_id,
            }, errRegistro)
        }
    } catch (err) {
        logEvento('pagamento', 'error', {
            operazione: 'solleciti:registro',
            esito: 'registro-sollecito-non-scritto',
            pagamento_id: riga.pagamento_id,
        }, err)
    }
}

/**
 * L'ultimo motivo del provider come Error VERO, per la riga `sollecito-non-recapitato`: il
 * messaggio arriva sanificato (un indirizzo dentro il rifiuto esce come `[email]`), così la
 * colonna `app_log.messaggio` dice PERCHÉ senza dire A CHI.
 */
function erroreNonRecapitato(motivo: string | null): Error {
    const err = new Error(sanificaMessaggio(motivo ?? 'nessun esito dal provider email'))
    err.name = 'SollecitoNonRecapitato'
    return err
}
