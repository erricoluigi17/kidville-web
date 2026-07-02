/**
 * Orchestratore emissione fattura elettronica (DL-017/018/019).
 *
 * Carica il pagamento saldato + l'intestatario + la config Aruba, assegna il
 * numero interno (sequenza per scuola/anno), genera l'XML FatturaPA, lo invia ad
 * Aruba (signin + upload) e persiste l'esito su `fatture_emesse` + `pagamenti`.
 * Nessun mock: se Aruba non è configurato/credenziali assenti ritorna un esito
 * `non_configurato` (HTTP 503) — niente più "successo finto".
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { arubaSignin, arubaUpload, resolveArubaCredentials, type ArubaConfig } from './client'
import { buildFatturaElettronicaXml } from './fatturapa-xml'

export interface AttoreEmissione {
  id: string
}

export type EsitoEmissione =
  | { ok: true; fatturaStato: 'in_attesa'; uploadFileName: string; numero: number }
  | {
      ok: false
      motivo: 'non_saldato' | 'non_configurato' | 'intestatario_mancante' | 'scartata' | 'errore'
      messaggio: string
      httpStatus: number
    }

interface AlunnoNested {
  nome?: string
  cognome?: string
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
  // 1. pagamento
  const { data: pag } = await supabase
    .from('pagamenti')
    .select(
      'id, descrizione, importo, stato, scuola_id, fattura_causale, alunno_id, alunni:alunno_id ( nome, cognome, intestatario_fatture )'
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
  if (!cfg.abilitato || !creds)
    return {
      ok: false,
      motivo: 'non_configurato',
      messaggio: 'Fatturazione Aruba non configurata o credenziali mancanti',
      httpStatus: 503,
    }

  // 3. intestatario (persona fisica) dai parents
  const alunno = (Array.isArray(pag.alunni) ? pag.alunni[0] : pag.alunni) as AlunnoNested | null
  const adultId = alunno?.intestatario_fatture?.adult_id
  if (!adultId)
    return {
      ok: false,
      motivo: 'intestatario_mancante',
      messaggio: 'Intestatario fattura non impostato sull’anagrafica',
      httpStatus: 422,
    }
  const { data: parent } = await supabase
    .from('parents')
    .select('first_name, last_name, fiscal_code, residence_address, residence_city, zip_code')
    .eq('id', adultId)
    .maybeSingle()
  if (!parent?.fiscal_code)
    return {
      ok: false,
      motivo: 'intestatario_mancante',
      messaggio: 'Dati fiscali intestatario incompleti (codice fiscale mancante)',
      httpStatus: 422,
    }

  // 4. numero interno (sequenza per scuola/anno)
  const anno = new Date().getFullYear()
  const { data: numeroData } = await supabase.rpc('prossimo_numero_fattura', {
    p_scuola: pag.scuola_id,
    p_anno: anno,
  })
  const numero = Number(numeroData ?? 1)

  // 5. causale + XML
  const causale = s(pag.fattura_causale) || s(pag.descrizione)
  const importo = Number(pag.importo)
  const xml = buildFatturaElettronicaXml({
    progressivoInvio: String(numero).padStart(5, '0'),
    numero: String(numero),
    data: new Date().toISOString().slice(0, 10),
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
      codiceFiscale: s(parent.fiscal_code),
      nome: s(parent.first_name),
      cognome: s(parent.last_name),
      sede: {
        indirizzo: s(parent.residence_address),
        cap: s(parent.zip_code),
        comune: s(parent.residence_city),
        nazione: 'IT',
      },
    },
    righe: [{ descrizione: causale, prezzoUnitario: importo }],
    causale,
  })

  // 6. invio Aruba
  const tokens = await arubaSignin(cfg.ambiente, creds)
  const up = await arubaUpload(cfg.ambiente, tokens.accessToken, {
    dataFileBase64: Buffer.from(xml, 'utf-8').toString('base64'),
    senderPIVA: s(fiscal.piva),
  })

  const baseRow = {
    pagamento_id: pagamentoId,
    scuola_id: pag.scuola_id,
    numero,
    anno,
    progressivo_invio: String(numero).padStart(5, '0'),
    causale,
    importo,
    intestatario: { nome: parent.first_name, cognome: parent.last_name, codice_fiscale: parent.fiscal_code },
    xml_inviato: xml,
    creato_da: attore.id,
  }

  // 7. esito
  if (!up.ok) {
    await supabase
      .from('fatture_emesse')
      .insert({ ...baseRow, sdi_stato: 2, sdi_stato_label: 'Errore upload', sdi_scarto_motivo: up.errorDescription ?? up.errorCode })
    await supabase.from('pagamenti').update({ fattura_stato: 'scartata', fattura_causale: causale }).eq('id', pagamentoId)
    return {
      ok: false,
      motivo: 'scartata',
      messaggio: up.errorDescription || `Emissione scartata (${up.errorCode})`,
      httpStatus: 502,
    }
  }

  const nowIso = new Date().toISOString()
  await supabase
    .from('fatture_emesse')
    .insert({ ...baseRow, aruba_filename: up.uploadFileName, sdi_stato: 1, sdi_stato_label: 'Presa in carico', inviata_il: nowIso })
  await supabase
    .from('pagamenti')
    .update({
      fattura_stato: 'in_attesa',
      fattura_aruba_id: up.uploadFileName,
      fattura_causale: causale,
      fattura_emessa_il: nowIso,
    })
    .eq('id', pagamentoId)

  return { ok: true, fatturaStato: 'in_attesa', uploadFileName: up.uploadFileName!, numero }
}
