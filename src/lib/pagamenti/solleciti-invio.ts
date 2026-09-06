import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmailDetailed } from '@/lib/email/send'
import { risolviContestoSede, type ContestoSede } from '@/lib/email/contesto'
import { messaggioSollecito, type LivelloSollecito } from '@/lib/email/messaggi/sollecito'
import { getGenitoriDiAlunno } from '@/lib/anagrafiche/legami'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { getModuleConfig } from '@/lib/settings/module-config'
import { logErrore } from '@/lib/logging/logger'
import { formatEuro } from '@/lib/format/valuta'
import { isoToIt } from '@/lib/format/data'
import { residuoEffettivo } from './aging'
import { DEFAULT_CAUSALE_TEMPLATE, causaleBonifico, modelloCausale, rigaCausaleSollecito } from './causale'
import { meseAnnoDaPeriodo } from './periodo'
import { coordinateBonificoSede } from './coordinate-bonifico'
import {
    DEFAULT_SOLLECITI_CONFIG,
    livelliEffettivi,
    prossimoLivello,
    renderTemplate,
    type SollecitiConfig,
} from './solleciti'
import { formattaIstante } from '@/i18n/config'

// Motore d'invio dei solleciti (manuale e cron). Regole:
//  • anti-spam: mai due invii entro la cadenza minima (ultimo_sollecito_il);
//  • livelli sequenziali (mai saltare); in automatico il livello deve essere
//    "maturo" (giorni di ritardo ≥ soglia) e il 3° resta SOLO manuale;
//  • destinatari: titolari quota (split) oppure tutori del bambino;
//  • ogni invio reale → riga in `solleciti` (testo effettivo = audit) + push.
// Il registro può mancare (DB e2e CI): si degrada senza bloccare.

export interface EsitoSollecito {
    pagamento_id: string
    ok: boolean
    livello?: number
    oggetto?: string
    corpo?: string
    destinatari?: { id: string; email?: string | null }[]
    motivo?: string
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
    alunni?: { nome?: string; cognome?: string; codice_fiscale?: string | null } | null
    payment_categories?: { slug?: string | null } | null
}

const MS_GIORNO = 86_400_000

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
    } = {},
): Promise<EsitoSollecito[]> {
    const COLONNE_PAG_BASE = 'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, stato, scadenza, tipo, periodo_competenza, ultimo_sollecito_il, alunni:alunno_id ( nome, cognome, codice_fiscale ), payment_categories:categoria_id ( slug )'
    const COLONNE_PAG = 'id, alunno_id, scuola_id, descrizione, importo, importo_pagato, sconto, stato, scadenza, tipo, periodo_competenza, ultimo_sollecito_il, alunni:alunno_id ( nome, cognome, codice_fiscale ), payment_categories:categoria_id ( slug )'
    let { data: pagRows, error: errPag } = await supabase.from('pagamenti').select(COLONNE_PAG).in('id', pagamentoIds)
    // DB E2E CI non migrato: `sconto` assente → 42703, ritenta senza (residuo = importo − pagato).
    if (errPag && (errPag as { code?: string }).code === '42703') {
        const retry = await supabase.from('pagamenti').select(COLONNE_PAG_BASE).in('id', pagamentoIds)
        pagRows = retry.data as unknown as typeof pagRows
        errPag = retry.error
    }
    // PostgREST non lancia: un errore residuo (≠ colonna mancante) va tracciato, non ingoiato.
    if (errPag) logErrore({ operazione: 'solleciti:pagamenti', evento: 'db' }, errPag)
    const pags = (pagRows || []) as unknown as PagRow[]

    // livello già raggiunto (registro; degrade → si riparte da 1)
    const maxLivello = new Map<string, number>()
    try {
        const { data } = await supabase.from('solleciti').select('pagamento_id, livello').in('pagamento_id', pagamentoIds)
        for (const s of (data || []) as { pagamento_id: string; livello: number }[]) {
            maxLivello.set(s.pagamento_id, Math.max(maxLivello.get(s.pagamento_id) ?? 0, s.livello))
        }
    } catch {
        // registro assente: nessuno storico livelli
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

    for (const id of pagamentoIds) {
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
            const { data: sede } = await supabase.from('scuole').select('nome').eq('id', pag.scuola_id).maybeSingle()
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
        // Il CF del bambino va SOLO nel corpo dell'email (destinatario = tutore →
        // dato lecito), MAI nei log: `corpo` non viene passato a nessun logger, e
        // `sendEmail`/`externalFetch` non loggano il body della richiesta.
        const corpo = `${renderTemplate(liv.testo, ctx)}\n\n${rigaCausaleSollecito({
            descrizione: pag.descrizione,
            nome: pag.alunni?.nome,
            cognome: pag.alunni?.cognome,
            codiceFiscale: pag.alunni?.codice_fiscale,
            sede: sedeNome,
            mese,
            anno,
            importo: formatEuro(pag.importo),
            scadenza: isoToIt(pag.scadenza ?? ''),
        }, templateCausale)}`

        // destinatari: titolari quota (split) oppure tutori del bambino
        let adultIds: string[] = []
        if (pag.tipo === 'split') {
            const { data } = await supabase.from('pagamenti_quote').select('adult_id').eq('pagamento_id', id)
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
            const { data } = await supabase.from('utenti').select('id, email').in('id', adultIds)
            destinatari = (data || []) as { id: string; email?: string | null }[]
        }
        if (destinatari.length === 0) { esiti.push({ pagamento_id: id, ok: false, motivo: 'nessun destinatario collegato' }); continue }

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
            causale: causaleBonifico({
                descrizione: pag.descrizione,
                nome: pag.alunni?.nome,
                cognome: pag.alunni?.cognome,
                codiceFiscale: pag.alunni?.codice_fiscale,
                sede: sedeNome,
                mese,
                anno,
                importo: formatEuro(pag.importo),
                scadenza: isoToIt(pag.scadenza ?? ''),
            }, templateCausale),
            intestatario,
            iban,
        }, contestoSede)

        const esitiInvio: { id: string; email?: string | null; inviata: boolean }[] = []
        for (const d of destinatari) {
            const inviata = d.email
                ? (await sendEmailDetailed({ to: d.email, subject: oggetto, text: corpo, html: messaggio.html })).ok
                : false
            esitiInvio.push({ id: d.id, email: d.email, inviata })
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
        } catch {
            // push best-effort
        }
        try {
            await supabase.from('solleciti').insert({
                pagamento_id: id,
                scuola_id: pag.scuola_id,
                alunno_id: pag.alunno_id,
                livello,
                canale: 'email',
                destinatari: esitiInvio,
                oggetto,
                corpo,
                automatico: !!opts.automatico,
                inviato_da: opts.attoreId ?? null,
            })
        } catch {
            // registro assente (CI): l'invio resta comunque valido
        }
        await supabase.from('pagamenti').update({ ultimo_sollecito_il: new Date().toISOString() }).eq('id', id)
        esiti.push({ pagamento_id: id, ok: true, livello, oggetto, destinatari })
    }
    return esiti
}
