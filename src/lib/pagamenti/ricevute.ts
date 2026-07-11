import type { SupabaseClient } from '@supabase/supabase-js'
import { getModuleConfig } from '@/lib/settings/module-config'
import {
    DICITURA_BOLLO_DEFAULT,
    bolloDovuto,
    datiStruttura,
    isTracciabile,
    type ArubaFiscalConfig,
    type DatiStruttura,
    type FiscaleConfig,
} from './fiscale'
import { determinaQuoteFatturazione, resolveParentRegistry } from './intestatari'

// Emissione ricevute NUMERATE (registro ricevute_emesse):
//  • idempotente: una sola ricevuta ATTIVA per pagamento (indice parziale DB);
//    il download ripetuto rigenera il PDF dallo snapshot, stesso numero.
//  • lo storno/modifica di un incasso ANNULLA la ricevuta (numero bruciato,
//    registro coerente): al prossimo download si emette un numero nuovo.
//  • degrada con grazia dove il registro non esiste (DB e2e CI non migrato):
//    si torna al PDF di cortesia senza numero.

export interface RicevutaIntestatario { nome: string; codice_fiscale?: string | null }

export interface RicevutaRecord {
    id: string
    pagamento_id: string
    scuola_id: string
    alunno_id: string | null
    numero: number
    anno: number
    importo: number
    periodo_competenza: string | null
    metodi: string[]
    tracciabile: boolean
    bollo: boolean
    intestatario: RicevutaIntestatario | null
    dati_struttura: (DatiStruttura & { dicitura_bollo?: string }) | null
    creato_il: string
}

export interface PagamentoPerRicevuta {
    id: string
    alunno_id: string
    scuola_id: string
    importo: number | string
    importo_pagato?: number | string | null
    descrizione?: string | null
    periodo_competenza?: string | null
}

export type EsitoRicevuta =
    | { ok: true; legacy: false; record: RicevutaRecord }
    | { ok: true; legacy: true }
    | { ok: false; messaggio: string }

// Registro/colonne assenti (DB non migrato) → fallback di cortesia, mai crash.
const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

export async function emettiORecuperaRicevuta(
    supabase: SupabaseClient,
    pagamento: PagamentoPerRicevuta,
    opts: { creatoDa?: string | null } = {},
): Promise<EsitoRicevuta> {
    const attiva = await supabase
        .from('ricevute_emesse')
        .select('*')
        .eq('pagamento_id', pagamento.id)
        .is('annullata_il', null)
        .maybeSingle()
    if (attiva.error) {
        if (SCHEMA_MANCANTE.has(attiva.error.code ?? '')) return { ok: true, legacy: true }
        return { ok: false, messaggio: attiva.error.message }
    }
    if (attiva.data) return { ok: true, legacy: false, record: attiva.data as RicevutaRecord }

    // Snapshot metodi/tracciabilità dagli incassi correnti (coerente: ogni
    // storno/modifica annulla la ricevuta, quindi qui sono quelli del saldo).
    const { data: incassi } = await supabase
        .from('incassi')
        .select('importo, data_incasso, metodo')
        .eq('pagamento_id', pagamento.id)
    const positivi = (incassi || []).filter((i) => Number(i.importo) > 0)
    const metodi = Array.from(new Set(positivi.map((i) => String(i.metodo || 'altro'))))
    const tracciabile = isTracciabile(positivi.map((i) => i.metodo as string | null))

    // Intestatario: stesso motore della fatturazione (quota principale).
    const { data: alunno } = await supabase
        .from('alunni')
        .select('id, nome, cognome, genitori_separati, retta_split_config, intestatario_fatture')
        .eq('id', pagamento.alunno_id)
        .maybeSingle()
    let intestatario: RicevutaIntestatario | null = null
    if (alunno) {
        const quote = await determinaQuoteFatturazione(
            supabase,
            { id: pagamento.id, importo: Number(pagamento.importo) },
            alunno,
        )
        const reg = quote.length > 0 ? await resolveParentRegistry(supabase, quote[0].adultId) : null
        if (reg) {
            intestatario = {
                nome: [reg.first_name, reg.last_name].filter(Boolean).join(' '),
                codice_fiscale: reg.fiscal_code,
            }
        } else {
            intestatario = { nome: `Famiglia ${alunno.cognome ?? ''}`.trim() }
        }
    }

    const fiscale = (await getModuleConfig(supabase, 'fiscale_config', pagamento.scuola_id)) as FiscaleConfig
    const aruba = (await getModuleConfig(supabase, 'aruba_config', pagamento.scuola_id)) as ArubaFiscalConfig
    const struttura = datiStruttura(fiscale, aruba)
    const importo = Number(pagamento.importo_pagato ?? pagamento.importo)
    const bollo = bolloDovuto(importo, fiscale) > 0
    const anno = new Date().getFullYear()

    const num = await supabase.rpc('prossimo_numero_ricevuta', { p_scuola: pagamento.scuola_id, p_anno: anno })
    if (num.error || typeof num.data !== 'number') return { ok: true, legacy: true }

    const riga = {
        pagamento_id: pagamento.id,
        scuola_id: pagamento.scuola_id,
        alunno_id: pagamento.alunno_id,
        numero: num.data,
        anno,
        importo,
        periodo_competenza: pagamento.periodo_competenza ?? null,
        metodi,
        tracciabile,
        bollo,
        intestatario,
        dati_struttura: { ...struttura, dicitura_bollo: fiscale?.dicitura_bollo_ricevuta || DICITURA_BOLLO_DEFAULT },
        creato_da: opts.creatoDa ?? null,
    }
    const ins = await supabase.from('ricevute_emesse').insert(riga).select('*').single()
    if (ins.error) {
        // corsa fra due download: l'indice parziale ha fatto vincere l'altro → riusala
        if (ins.error.code === '23505') {
            const retry = await supabase
                .from('ricevute_emesse')
                .select('*')
                .eq('pagamento_id', pagamento.id)
                .is('annullata_il', null)
                .maybeSingle()
            if (retry.data) return { ok: true, legacy: false, record: retry.data as RicevutaRecord }
        }
        if (SCHEMA_MANCANTE.has(ins.error.code ?? '')) return { ok: true, legacy: true }
        return { ok: false, messaggio: ins.error.message }
    }
    return { ok: true, legacy: false, record: ins.data as RicevutaRecord }
}

/** Annulla (best-effort) la ricevuta attiva del pagamento: numero bruciato, motivo a registro. */
export async function annullaRicevutaAttiva(
    supabase: SupabaseClient,
    pagamentoId: string,
    opts: { da?: string | null; motivo: string },
): Promise<void> {
    try {
        await supabase
            .from('ricevute_emesse')
            .update({
                annullata_il: new Date().toISOString(),
                annullata_da: opts.da ?? null,
                annullo_motivo: opts.motivo,
            })
            .eq('pagamento_id', pagamentoId)
            .is('annullata_il', null)
    } catch {
        // registro assente (CI) o errore transitorio: lo storno non deve fallire per questo
    }
}
