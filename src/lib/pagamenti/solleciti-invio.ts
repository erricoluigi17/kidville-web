import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/email/send'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { getModuleConfig } from '@/lib/settings/module-config'
import { datiStruttura, type ArubaFiscalConfig, type FiscaleConfig } from './fiscale'
import {
    DEFAULT_SOLLECITI_CONFIG,
    livelliEffettivi,
    prossimoLivello,
    renderTemplate,
    type SollecitiConfig,
} from './solleciti'

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
    stato: string
    scadenza: string | null
    tipo: string
    ultimo_sollecito_il: string | null
    alunni?: { nome?: string; cognome?: string } | null
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
    const { data: pagRows } = await supabase
        .from('pagamenti')
        .select('id, alunno_id, scuola_id, descrizione, importo, importo_pagato, stato, scadenza, tipo, ultimo_sollecito_il, alunni:alunno_id ( nome, cognome )')
        .in('id', pagamentoIds)
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

    const cfgCache = new Map<string, { cfg: SollecitiConfig; scuolaNome: string }>()
    const esiti: EsitoSollecito[] = []
    const adesso = Date.now()

    for (const id of pagamentoIds) {
        const pag = pags.find((p) => p.id === id)
        if (!pag) { esiti.push({ pagamento_id: id, ok: false, motivo: 'pagamento non trovato' }); continue }
        if (opts.sediAmmesse && !opts.sediAmmesse.includes(pag.scuola_id)) {
            esiti.push({ pagamento_id: id, ok: false, motivo: 'fuori dalle sedi attive' }); continue
        }
        const residuo = Number(pag.importo) - Number(pag.importo_pagato || 0)
        if (pag.stato === 'pagato' || residuo <= 0) { esiti.push({ pagamento_id: id, ok: false, motivo: 'già saldato' }); continue }
        if (pag.tipo === 'padre') { esiti.push({ pagamento_id: id, ok: false, motivo: 'contenitore rateale: sollecitare le rate' }); continue }

        let scuolaCtx = cfgCache.get(pag.scuola_id)
        if (!scuolaCtx) {
            const cfg = (await getModuleConfig(supabase, 'solleciti_config', pag.scuola_id)) as SollecitiConfig
            const fiscale = (await getModuleConfig(supabase, 'fiscale_config', pag.scuola_id)) as FiscaleConfig
            const aruba = (await getModuleConfig(supabase, 'aruba_config', pag.scuola_id)) as ArubaFiscalConfig
            scuolaCtx = { cfg, scuolaNome: datiStruttura(fiscale, aruba).denominazione || 'La Segreteria' }
            cfgCache.set(pag.scuola_id, scuolaCtx)
        }
        const { cfg, scuolaNome } = scuolaCtx

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
            importo: `€ ${Number(pag.importo).toFixed(2)}`,
            residuo: `€ ${residuo.toFixed(2)}`,
            scadenza: pag.scadenza ? new Date(pag.scadenza).toLocaleDateString('it-IT') : '—',
            scuola: scuolaNome,
            giorni_ritardo: giorniRitardo,
        }
        const oggetto = renderTemplate(liv.oggetto, ctx)
        const corpo = renderTemplate(liv.testo, ctx)

        // destinatari: titolari quota (split) oppure tutori del bambino
        let adultIds: string[] = []
        if (pag.tipo === 'split') {
            const { data } = await supabase.from('pagamenti_quote').select('adult_id').eq('pagamento_id', id)
            adultIds = ((data || []) as { adult_id: string }[]).map((q) => q.adult_id)
        }
        if (adultIds.length === 0) {
            const { data } = await supabase.from('legame_genitori_alunni').select('genitore_id').eq('alunno_id', pag.alunno_id)
            adultIds = ((data || []) as { genitore_id: string }[]).map((l) => l.genitore_id)
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

        const esitiInvio: { id: string; email?: string | null; inviata: boolean }[] = []
        for (const d of destinatari) {
            const inviata = d.email ? await sendEmail({ to: d.email, subject: oggetto, text: corpo }) : false
            esitiInvio.push({ id: d.id, email: d.email, inviata })
        }
        try {
            await enqueueNotifiche(supabase, {
                utenteIds: destinatari.map((d) => d.id),
                tipo: 'pagamento',
                titolo: oggetto,
                corpo: `Residuo ${ctx.residuo} — ${ctx.descrizione}`,
                link: '/parent/pagamenti',
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
