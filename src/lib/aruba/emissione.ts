/**
 * Orchestratore emissione fattura elettronica (DL-017/018/019 + quote separati).
 *
 * Carica il pagamento saldato, DETERMINA LE QUOTE di fatturazione (una sola nel
 * caso normale; N per i genitori separati o gli ordini divise), e per ciascuna
 * quota risolve l'intestatario (parents, via bridge), assegna un numero interno,
 * genera l'XML FatturaPA e lo invia ad Aruba. Le quote sono INDIPENDENTI: quelle
 * valide partono anche se un'altra fallisce (es. CF mancante), e ciascuna è
 * idempotente (skip se esiste già una riga `fatture_emesse` non-scartata per
 * quella quota). Nessun mock: senza credenziali Aruba ritorna `non_configurato`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { arubaSignin, arubaUpload, arubaUltimoNumeroFattura, resolveArubaCredentials, type ArubaConfig } from './client'
import { buildFatturaElettronicaXml } from './fatturapa-xml'
import { mapStatoAruba } from './stato'
import { determinaQuoteFatturazione, resolveParentRegistry } from '@/lib/pagamenti/intestatari'
import { bolloDovuto, type FiscaleConfig } from '@/lib/pagamenti/fiscale'
import { getModuleConfig } from '@/lib/settings/module-config'
import { annoFiscale, oggiFiscaleISO } from '@/lib/format/fiscal-date'

export interface AttoreEmissione {
  id: string
}

/** Esito di una singola quota (riportato al chiamante per il caso multi-quota). */
export interface EsitoQuota {
  adultId: string
  label: string
  ok: boolean
  numero?: number
  uploadFileName?: string
  motivo?: 'intestatario_mancante' | 'scartata' | 'idempotente' | 'errore'
  messaggio?: string
}

export type EsitoEmissione =
  | { ok: true; fatturaStato: 'in_attesa'; uploadFileName: string; numero: number; quote?: EsitoQuota[] }
  | {
      ok: false
      motivo: 'non_saldato' | 'non_configurato' | 'intestatario_mancante' | 'scartata' | 'errore'
      messaggio: string
      httpStatus: number
      quote?: EsitoQuota[]
    }

interface AlunnoNested {
  id?: string
  nome?: string
  cognome?: string
  genitori_separati?: boolean | null
  retta_split_config?: { quote?: { adult_id: string; importo: number | string; etichetta?: string | null }[] } | null
  intestatario_fatture?: { tipo?: string; nome?: string; adult_id?: string } | null
}

function s(v: unknown): string {
  return v == null ? '' : String(v)
}

export async function emettiFatturaPagamento(
  supabase: SupabaseClient,
  pagamentoId: string,
  attore: AttoreEmissione
): Promise<EsitoEmissione> {
  // 1. pagamento + alunno (con i campi split)
  const { data: pag } = await supabase
    .from('pagamenti')
    .select(
      'id, descrizione, importo, stato, scuola_id, fattura_causale, alunno_id, alunni:alunno_id ( id, nome, cognome, genitori_separati, retta_split_config, intestatario_fatture )'
    )
    .eq('id', pagamentoId)
    .single()
  if (!pag) return { ok: false, motivo: 'errore', messaggio: 'Pagamento non trovato', httpStatus: 404 }
  if (pag.stato !== 'pagato')
    return {
      ok: false,
      motivo: 'non_saldato',
      messaggio: 'La fattura può essere emessa solo per pagamenti saldati',
      httpStatus: 400,
    }

  // 2. config Aruba + credenziali (lato server)
  const { data: settings } = await supabase
    .from('admin_settings')
    .select('aruba_config, fattura_causale_template')
    .eq('scuola_id', pag.scuola_id)
    .maybeSingle()
  const cfg = (settings?.aruba_config ?? {}) as ArubaConfig
  const fiscal = (cfg.fiscal ?? {}) as Record<string, unknown>
  const creds = resolveArubaCredentials(cfg)
  if (!cfg.abilitato || !creds) {
    console.warn(
      `[ARUBA] emissione fattura gated per scuola ${pag.scuola_id}: credenziali_non_configurate (abilitato=${Boolean(cfg.abilitato)})`
    )
    return {
      ok: false,
      motivo: 'non_configurato',
      messaggio: 'Fatturazione Aruba non configurata o credenziali mancanti',
      httpStatus: 503,
    }
  }

  // Bollo virtuale (A8): dovuto sui documenti esenti sopra soglia, se attivato
  // in fiscale_config. getModuleConfig è fail-closed ({} se assente) → nessun
  // cambiamento finché la scuola non lo configura.
  const fiscaleCfg = (await getModuleConfig(supabase, 'fiscale_config', pag.scuola_id)) as FiscaleConfig

  // 3. determina le quote di fatturazione
  const alunno = (Array.isArray(pag.alunni) ? pag.alunni[0] : pag.alunni) as AlunnoNested | null
  const quote = await determinaQuoteFatturazione(
    supabase,
    { id: pag.id, importo: pag.importo },
    {
      id: alunno?.id ?? pag.alunno_id,
      genitori_separati: alunno?.genitori_separati,
      retta_split_config: alunno?.retta_split_config,
      intestatario_fatture: alunno?.intestatario_fatture,
    }
  )
  if (quote.length === 0)
    return {
      ok: false,
      motivo: 'intestatario_mancante',
      messaggio: 'Intestatario fattura non impostato sull’anagrafica',
      httpStatus: 422,
    }
  const multi = quote.length > 1

  // 4. righe fatture_emesse già presenti (per l'idempotenza per-quota)
  const { data: esistenti } = await supabase
    .from('fatture_emesse')
    .select('id, numero, aruba_filename, sdi_stato, quota_adult_id')
    .eq('pagamento_id', pagamentoId)
  const righeEsistenti = (esistenti ?? []) as {
    id: string
    numero: number
    aruba_filename: string | null
    sdi_stato: number | null
    quota_adult_id: string | null
  }[]

  // 5. emissione indipendente per quota
  const anno = annoFiscale()
  const causaleBase = s(pag.fattura_causale) || s(pag.descrizione)
  let tokenCache: string | null = null
  const ensureToken = async () => {
    if (!tokenCache) tokenCache = (await arubaSignin(cfg.ambiente, creds)).accessToken
    return tokenCache
  }

  // Allineamento con Aruba: leggi l'ultimo numero già emesso per l'anno, così il
  // progressivo non si accavalla con fatture emesse anche fuori dalla web app.
  // Best-effort: se fallisce si usa solo il contatore interno.
  let ultimoAruba = 0
  try {
    const token = await ensureToken()
    ultimoAruba =
      (await arubaUltimoNumeroFattura(cfg.ambiente, token, {
        username: creds.username,
        anno,
        vatcodeSender: s(fiscal.piva) || undefined,
      })) || 0
  } catch (e) {
    console.warn(`[ARUBA] lettura ultimo numero fattura fallita per scuola ${pag.scuola_id}, uso il contatore interno:`, e)
  }

  const esiti: EsitoQuota[] = []
  for (const q of quote) {
    // idempotenza: esiste già una riga non-scartata per questa quota?
    const gia = righeEsistenti.find((r) => {
      const scartata = r.sdi_stato != null && mapStatoAruba(r.sdi_stato).isScarto
      if (scartata) return false
      return r.quota_adult_id === q.adultId || (!multi && r.quota_adult_id == null)
    })
    if (gia) {
      esiti.push({ adultId: q.adultId, label: q.label, ok: true, numero: gia.numero, uploadFileName: gia.aruba_filename ?? undefined, motivo: 'idempotente' })
      continue
    }

    // intestatario (persona fisica) risolto dal registry
    const reg = await resolveParentRegistry(supabase, q.adultId)
    if (!reg?.fiscal_code) {
      const nome = [reg?.first_name, reg?.last_name].filter(Boolean).join(' ') || q.label || 'intestatario'
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        motivo: 'intestatario_mancante',
        messaggio: `Dati fiscali incompleti (codice fiscale mancante) per ${nome}`,
      })
      continue
    }

    // numero (sequenza per scuola/anno) allineato ad Aruba: la RPC restituisce
    // GREATEST(contatore interno, ultimoAruba) + 1, così non si accavalla mai.
    // Nessun fallback a un numero fisso: un errore RPC duplicherebbe la numerazione.
    const numRes = await supabase.rpc('prossimo_numero_fattura_sync', { p_scuola: pag.scuola_id, p_anno: anno, p_min: ultimoAruba })
    if (numRes.error || typeof numRes.data !== 'number') {
      esiti.push({ adultId: q.adultId, label: q.label, ok: false, motivo: 'errore', messaggio: 'Numerazione fattura non disponibile' })
      continue
    }
    const numero = numRes.data

    const causale = multi ? `${causaleBase} — quota ${q.label || reg.first_name || 'genitore'}` : causaleBase
    const importoQuota = Number(q.importo)

    // IVA per causale da aruba_config.iva[] (match per inclusione, case-insensitive);
    // nessun match → default esente art. 10. Il bollo riguarda solo gli esenti.
    const ivaEntry = (cfg.iva || []).find(
      (v) => v.causale && causale.toLowerCase().includes(String(v.causale).toLowerCase())
    )
    const aliquota = ivaEntry ? Number(ivaEntry.aliquota) : 0
    const esente = aliquota === 0
    const bolloImporto = esente ? bolloDovuto(importoQuota, fiscaleCfg) : 0
    // importoQuota è il LORDO incassato: con IVA>0 va scorporato l'imponibile,
    // così ImportoTotaleDocumento (imponibile+imposta) torna pari all'incassato.
    const imponibile = aliquota > 0 ? Math.round((importoQuota / (1 + aliquota / 100)) * 100) / 100 : importoQuota

    const xml = buildFatturaElettronicaXml({
      progressivoInvio: String(numero).padStart(5, '0'),
      numero: String(numero),
      data: oggiFiscaleISO(),
      cedente: {
        piva: s(fiscal.piva),
        codiceFiscale: fiscal.cf ? s(fiscal.cf) : undefined,
        denominazione: s(fiscal.ragione_sociale),
        regimeFiscale: s(fiscal.regime) || 'RF01',
        sede: {
          indirizzo: s(fiscal.indirizzo) || s(fiscal.sede),
          cap: s(fiscal.cap),
          comune: s(fiscal.comune),
          provincia: fiscal.provincia ? s(fiscal.provincia) : undefined,
          nazione: 'IT',
        },
      },
      cessionario: {
        codiceFiscale: s(reg.fiscal_code),
        nome: s(reg.first_name),
        cognome: s(reg.last_name),
        sede: {
          indirizzo: s(reg.residence_address),
          cap: s(reg.zip_code),
          comune: s(reg.residence_city),
          nazione: 'IT',
        },
      },
      righe: [{ descrizione: causale, prezzoUnitario: imponibile }],
      causale,
      iva: ivaEntry ? { aliquota, natura: ivaEntry.natura || undefined } : undefined,
      bollo: bolloImporto > 0 ? { importo: bolloImporto } : undefined,
    })

    const baseRow = {
      pagamento_id: pagamentoId,
      scuola_id: pag.scuola_id,
      numero,
      anno,
      progressivo_invio: String(numero).padStart(5, '0'),
      causale,
      importo: importoQuota,
      intestatario: { nome: reg.first_name, cognome: reg.last_name, codice_fiscale: reg.fiscal_code },
      xml_inviato: xml,
      creato_da: attore.id,
      quota_adult_id: q.adultId,
      quota_label: q.label || null,
      parent_registry_id: reg.id,
      bollo_virtuale: bolloImporto > 0,
    }

    // invio Aruba (token condiviso fra le quote)
    const token = await ensureToken()
    const up = await arubaUpload(cfg.ambiente, token, {
      dataFileBase64: Buffer.from(xml, 'utf-8').toString('base64'),
      senderPIVA: s(fiscal.piva),
    })

    if (!up.ok) {
      await supabase
        .from('fatture_emesse')
        .insert({ ...baseRow, sdi_stato: 2, sdi_stato_label: 'Errore upload', sdi_scarto_motivo: up.errorDescription ?? up.errorCode })
      esiti.push({
        adultId: q.adultId,
        label: q.label,
        ok: false,
        motivo: 'scartata',
        messaggio: up.errorDescription || `Emissione scartata (${up.errorCode})`,
      })
      continue
    }

    await supabase
      .from('fatture_emesse')
      .insert({ ...baseRow, aruba_filename: up.uploadFileName, sdi_stato: 1, sdi_stato_label: 'Presa in carico', inviata_il: new Date().toISOString() })
    esiti.push({ adultId: q.adultId, label: q.label, ok: true, numero, uploadFileName: up.uploadFileName ?? undefined })
  }

  // 6. aggregato lato pagamento
  const okEsiti = esiti.filter((e) => e.ok)
  const nowIso = new Date().toISOString()
  if (okEsiti.length === 0) {
    await supabase.from('pagamenti').update({ fattura_stato: 'scartata', fattura_causale: causaleBase }).eq('id', pagamentoId)
    const first = esiti[0]
    const motivoAgg = first?.motivo === 'intestatario_mancante' ? 'intestatario_mancante' : first?.motivo === 'errore' ? 'errore' : 'scartata'
    return {
      ok: false,
      motivo: motivoAgg,
      messaggio: first?.messaggio ?? 'Emissione non riuscita',
      httpStatus: motivoAgg === 'intestatario_mancante' ? 422 : motivoAgg === 'errore' ? 500 : 502,
      quote: multi ? esiti : undefined,
    }
  }

  // Almeno una quota emessa → il pagamento va in attesa (lo SDI conferma via sync).
  await supabase
    .from('pagamenti')
    .update({
      fattura_stato: 'in_attesa',
      fattura_aruba_id: okEsiti[0].uploadFileName ?? null,
      fattura_causale: causaleBase,
      fattura_emessa_il: nowIso,
    })
    .eq('id', pagamentoId)

  return {
    ok: true,
    fatturaStato: 'in_attesa',
    uploadFileName: okEsiti[0].uploadFileName ?? '',
    numero: okEsiti[0].numero ?? 0,
    quote: multi ? esiti : undefined,
  }
}
