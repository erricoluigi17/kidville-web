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
import { annoFiscale } from '@/lib/format/fiscal-date'

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
    const anno = annoFiscale()

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

/** Annulla (best-effort) la ricevuta famiglia attiva di una TRANSAZIONE (Contabilità v2). */
export async function annullaRicevutaTransazioneAttiva(
    supabase: SupabaseClient,
    transazioneId: string,
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
            .eq('transazione_id', transazioneId)
            .is('annullata_il', null)
    } catch {
        // registro assente (CI) o errore transitorio: l'annullo transazione non deve fallire per questo
    }
}

// ── Ricevuta UNICA di famiglia per una transazione (Contabilità v2 S4) ─────────

export interface RicevutaTransazioneRiga {
    /** Nome leggibile del figlio (o "Mensa" per le ricariche). */
    figlio: string
    descrizione: string
    importo: number
    tipo: 'voce' | 'ricarica'
}

export interface TransazionePerRicevuta {
    id: string
    scuola_id: string
    pagante_parent_id: string
    importo_totale: number | string
    metodo: string
    data_valuta?: string | null
    riferimento?: string | null
    creato_il?: string | null
}

export interface RicevutaTransazioneRecord extends Omit<RicevutaRecord, 'pagamento_id'> {
    transazione_id: string
    righe: RicevutaTransazioneRiga[]
}

export type EsitoRicevutaTransazione =
    | { ok: true; legacy: false; record: RicevutaTransazioneRecord }
    | { ok: true; legacy: true }
    | { ok: false; messaggio: string }

/**
 * Emette (o recupera) la ricevuta UNICA di famiglia di una transazione:
 *  • numerata dal registro esistente (`prossimo_numero_ricevuta`), SENZA toccare
 *    la numerazione né l'indice «una attiva per pagamento»: qui l'indice è «una
 *    attiva per transazione»;
 *  • intestata al pagante (`parents` via resolveParentRegistry);
 *  • con dettaglio per figlio nelle `righe` jsonb.
 * Degrada dove il registro/colonne non esistono (DB E2E CI): ok+legacy.
 */
export async function emettiORecuperaRicevutaTransazione(
    supabase: SupabaseClient,
    transazione: TransazionePerRicevuta,
    opts: { creatoDa?: string | null } = {},
): Promise<EsitoRicevutaTransazione> {
    const attiva = await supabase
        .from('ricevute_emesse')
        .select('*')
        .eq('transazione_id', transazione.id)
        .is('annullata_il', null)
        .maybeSingle()
    if (attiva.error) {
        if (SCHEMA_MANCANTE.has(attiva.error.code ?? '')) return { ok: true, legacy: true }
        return { ok: false, messaggio: attiva.error.message }
    }
    if (attiva.data) return { ok: true, legacy: false, record: attiva.data as RicevutaTransazioneRecord }

    // Righe per figlio: incassi (voci) + ricariche mensa collegati alla transazione.
    const righe: RicevutaTransazioneRiga[] = []
    const { data: incassi } = await supabase
        .from('incassi')
        .select('importo, pagamento_id, pagamenti:pagamento_id ( descrizione, alunni:alunno_id ( nome, cognome ) )')
        .eq('transazione_id', transazione.id)
    for (const inc of (incassi ?? []) as {
        importo: number | string
        pagamenti?: { descrizione?: string | null; alunni?: { nome?: string | null; cognome?: string | null } | null } | null
    }[]) {
        if (Number(inc.importo) <= 0) continue
        const al = inc.pagamenti?.alunni
        const figlio = `${al?.nome ?? ''} ${al?.cognome ?? ''}`.trim() || 'Alunno'
        righe.push({ figlio, descrizione: inc.pagamenti?.descrizione ?? 'Pagamento', importo: Number(inc.importo), tipo: 'voce' })
    }
    const { data: ricariche } = await supabase
        .from('mensa_ticket_movimenti')
        .select('delta, alunni:alunno_id ( nome, cognome )')
        .eq('transazione_id', transazione.id)
    for (const r of (ricariche ?? []) as { delta: number; alunni?: { nome?: string | null; cognome?: string | null } | null }[]) {
        const al = r.alunni
        const figlio = `${al?.nome ?? ''} ${al?.cognome ?? ''}`.trim() || 'Alunno'
        righe.push({ figlio, descrizione: `Ricarica mensa (${r.delta} ticket)`, importo: 0, tipo: 'ricarica' })
    }

    // Intestatario = pagante (parents.id → riga fatturabile).
    const reg = await resolveParentRegistry(supabase, transazione.pagante_parent_id)
    const intestatario: RicevutaIntestatario | null = reg
        ? { nome: [reg.first_name, reg.last_name].filter(Boolean).join(' '), codice_fiscale: reg.fiscal_code }
        : null

    const fiscale = (await getModuleConfig(supabase, 'fiscale_config', transazione.scuola_id)) as FiscaleConfig
    const aruba = (await getModuleConfig(supabase, 'aruba_config', transazione.scuola_id)) as ArubaFiscalConfig
    const struttura = datiStruttura(fiscale, aruba)
    const importo = Number(transazione.importo_totale)
    const tracciabile = isTracciabile([transazione.metodo])
    const bollo = bolloDovuto(importo, fiscale) > 0
    const anno = annoFiscale()

    const num = await supabase.rpc('prossimo_numero_ricevuta', { p_scuola: transazione.scuola_id, p_anno: anno })
    if (num.error || typeof num.data !== 'number') return { ok: true, legacy: true }

    const riga = {
        transazione_id: transazione.id,
        pagamento_id: null,
        scuola_id: transazione.scuola_id,
        alunno_id: null,
        numero: num.data,
        anno,
        importo,
        periodo_competenza: null,
        metodi: [transazione.metodo],
        tracciabile,
        bollo,
        intestatario,
        righe,
        dati_struttura: { ...struttura, dicitura_bollo: fiscale?.dicitura_bollo_ricevuta || DICITURA_BOLLO_DEFAULT },
        creato_da: opts.creatoDa ?? null,
    }
    const ins = await supabase.from('ricevute_emesse').insert(riga).select('*').single()
    if (ins.error) {
        if (ins.error.code === '23505') {
            const retry = await supabase
                .from('ricevute_emesse')
                .select('*')
                .eq('transazione_id', transazione.id)
                .is('annullata_il', null)
                .maybeSingle()
            if (retry.data) return { ok: true, legacy: false, record: retry.data as RicevutaTransazioneRecord }
        }
        if (SCHEMA_MANCANTE.has(ins.error.code ?? '')) return { ok: true, legacy: true }
        return { ok: false, messaggio: ins.error.message }
    }
    return { ok: true, legacy: false, record: ins.data as RicevutaTransazioneRecord }
}
