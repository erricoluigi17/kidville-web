import type { ContestoStorico, SezioneStorico } from '../tipi'
import type { RiepilogoAttestazione } from '@/lib/pagamenti/attestazione'
import { buildAttestazionePdf, buildRicevutaFamigliaPdf } from '@/lib/pagamenti/pdf'
import { datiStruttura, type DatiStruttura, type FiscaleConfig, type ArubaFiscalConfig } from '@/lib/pagamenti/fiscale'
import { anagraficaDaScheda, nomeDaAnagrafica } from '@/lib/fatturazione/intestatario-scelto'
import { resolveParentRegistryEsito } from '@/lib/pagamenti/intestatari'
import { erroreQueryStorico } from '../db'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { aggiungiGenerato, ammessa, euro, giorno, lista, nome, numero, oggetto, perIds, periodo, testo, tutte, type Riga } from './servizi-comuni'

function strutturaSnapshot(v: unknown): Partial<DatiStruttura> {
  const r = oggetto(v)
  return Object.fromEntries(['denominazione', 'piva', 'codice_fiscale', 'indirizzo', 'cap', 'comune', 'provincia'].map(c => [c, testo(r[c])]))
}

/** PDF derivato solo da snapshot esistenti: nessuna RPC di numerazione/emissione. */
export async function pdfRicevute(ctx: ContestoStorico, s: SezioneStorico, dirette: Riga[]): Promise<void> {
  const ids = ctx.alunni.map(a => a.id)
  const incassi = await perIds(ctx, 'incassi', 'id,transazione_id,pagamenti!inner(alunno_id,scuola_id)', 'pagamenti.alunno_id', ids, q => q.eq('pagamenti.scuola_id', ctx.richiesta.scuolaId).not('transazione_id', 'is', null))
  const ticket = await perIds(ctx, 'mensa_ticket_movimenti', 'id,alunno_id,scuola_id,transazione_id', 'alunno_id', ids, q => q.eq('scuola_id', ctx.richiesta.scuolaId).not('transazione_id', 'is', null))
  const txIds = [...new Set([...incassi, ...ticket].map(r => testo(r.transazione_id)).filter(Boolean))]
  const familiari = await perIds(ctx, 'ricevute_emesse', 'id,alunno_id,scuola_id,pagamento_id,transazione_id,numero,anno,importo,periodo_competenza,metodi,tracciabile,bollo,annullata_il,creato_il,intestatario,dati_struttura,righe', 'transazione_id', txIds, q => periodo(q.eq('scuola_id', ctx.richiesta.scuolaId), ctx, 'creato_il', true))
  const txIncassi = await perIds(ctx, 'incassi', 'id,transazione_id,pagamenti!inner(alunno_id,scuola_id)', 'transazione_id', txIds)
  const txTicket = await perIds(ctx, 'mensa_ticket_movimenti', 'id,transazione_id,alunno_id,scuola_id', 'transazione_id', txIds)
  const tutteRicevute = [...new Map([...dirette, ...familiari].map(r => [testo(r.id), r])).values()]
  for (const r of tutteRicevute) {
    const tx = testo(r.transazione_id)
    const coinvolti = new Set<string>()
    if (r.alunno_id) coinvolti.add(testo(r.alunno_id))
    if (tx) {
      for (const i of txIncassi.filter(i => i.transazione_id === tx)) coinvolti.add(testo(oggetto(Array.isArray(i.pagamenti) ? i.pagamenti[0] : i.pagamenti).alunno_id))
      for (const m of txTicket.filter(m => m.transazione_id === tx)) coinvolti.add(testo(m.alunno_id))
    }
    if (!coinvolti.size || [...coinvolti].some(id => !ids.includes(id) || !ammessa(ctx, id, r.creato_il))) {
      s.avvisi.push('Una ricevuta familiare riguarda anche alunni fuori dalla selezione o privi di attribuzione certa: originale escluso dal dossier.'); continue
    }
    const intestatario = oggetto(r.intestatario), struttura = strutturaSnapshot(r.dati_struttura)
    const righeSnapshot = Array.isArray(r.righe) ? r.righe.map(oggetto) : []
    const righe = righeSnapshot.map(v => ({ figlio: testo(v.figlio), descrizione: testo(v.descrizione), importo: euro(v.importo), tipo: v.tipo === 'ricarica' ? 'ricarica' as const : 'voce' as const }))
    if (!righe.length) {
      // Gli snapshot legacy non conservavano la causale: non sostituirla con quella
      // mutabile di pagamenti. La ristampa espone soltanto importo e competenza salvati.
      righe.push({ figlio: nome(ctx, [...coinvolti][0]), descrizione: `Pagamento${r.periodo_competenza ? ` — competenza ${giorno(r.periodo_competenza)}` : ''}`, importo: euro(r.importo), tipo: 'voce' })
      s.avvisi.push('Una ricevuta legacy non conserva il dettaglio delle causali: la ristampa mantiene numero, importo, competenza e intestazione dello snapshot disponibile.')
    }
    let bytes: Uint8Array = buildRicevutaFamigliaPdf({ numero: numero(r.numero), anno: numero(r.anno), struttura, intestatario: { nome: testo(intestatario.nome), codice_fiscale: testo(intestatario.codice_fiscale) }, righe, importoTotale: euro(r.importo), metodo: lista(r.metodi).join(', '), tracciabile: r.tracciabile === true, bollo: r.bollo === true, dicituraBollo: testo(oggetto(r.dati_struttura).dicitura_bollo), emessaIl: giorno(r.creato_il) })
    if (r.annullata_il) {
      const doc = await PDFDocument.load(bytes), font = await doc.embedFont(StandardFonts.HelveticaBold)
      for (const page of doc.getPages()) page.drawText(`ANNULLATA IL ${giorno(r.annullata_il)} - COPIA DELLO SNAPSHOT`, { x: 35, y: 20, size: 11, font, color: rgb(0.7, 0, 0) })
      bytes = await doc.save()
    }
    for (const id of coinvolti) aggiungiGenerato(s, `Ricevuta-${numero(r.numero)}-${numero(r.anno)}${r.annullata_il ? '-annullata' : ''}.pdf`, bytes, id)
    if (r.annullata_il) s.avvisi.push('È presente la ristampa di una ricevuta annullata: fa fede lo stato di annullamento indicato nel registro, non costituisce una nuova ricevuta attiva.')
    if (!dirette.some(d => d.id === r.id)) for (const id of coinvolti) s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), data: testo(r.creato_il), numero: `${numero(r.numero)}/${numero(r.anno)}`, importo: euro(r.importo), competenza: giorno(r.periodo_competenza), metodi: lista(r.metodi).join(', '), tracciabile: r.tracciabile === true, bollo: r.bollo === true, annullata: testo(r.annullata_il) })
  }
}

export async function pdfAttestazione(ctx: ContestoStorico, s: SezioneStorico, alunnoId: string, riepilogo: RiepilogoAttestazione): Promise<void> {
  const anno = Number(ctx.richiesta.dal.slice(0, 4))
  if (ctx.richiesta.dal !== `${anno}-01-01` || ctx.richiesta.al !== `${anno}-12-31`) {
    s.avvisi.push('Il PDF fiscale annuale si genera selezionando un anno solare completo. Per questo intervallo è disponibile il prospetto analitico dei versamenti.'); return
  }
  if (ctx.richiesta.sectionId && !ctx.appartenenze.some(a => a.alunno_id === alunnoId && a.section_id === ctx.richiesta.sectionId && a.dal <= ctx.richiesta.dal && (!a.al || a.al > ctx.richiesta.al))) {
    s.avvisi.push('L’appartenenza alla classe non copre l’intero anno solare: il prospetto riporta i movimenti pertinenti, senza emettere un’attestazione annuale incompleta.'); return
  }
  const alunno = (await perIds(ctx, 'alunni', 'id,nome,cognome,codice_fiscale,intestatario_fatture,scuola_id', 'id', [alunnoId], q => q.eq('scuola_id', ctx.richiesta.scuolaId)))[0]
  if (!alunno) { s.avvisi.push('Dati fiscali dell’alunno non disponibili: PDF attestazione non generato.'); return }
  const impostazioni = (await tutte(ctx, 'admin_settings', 'scuola_id,fiscale_config,aruba_config', q => q.eq('scuola_id', ctx.richiesta.scuolaId), 'scuola_id'))[0]
  if (!impostazioni) { s.avvisi.push('Configurazione fiscale della sede assente: PDF attestazione non generato.'); return }
  const digitata = anagraficaDaScheda(alunno.intestatario_fatture)
  const registro = digitata ? null : await resolveParentRegistryEsito(ctx.db, testo(oggetto(alunno.intestatario_fatture).adult_id) || null)
  if (registro && !registro.ok) erroreQueryStorico('attestazione/intestatario', registro.error)
  const reg = registro?.ok ? registro.reg : null
  const intestatario = digitata ? { nome: nomeDaAnagrafica(digitata), codice_fiscale: digitata.codice_fiscale } : reg ? { nome: `${reg.first_name ?? ''} ${reg.last_name ?? ''}`.trim(), codice_fiscale: reg.fiscal_code } : null
  if (!intestatario?.nome) { s.avvisi.push('Intestatario fiscale non determinabile con certezza: resta disponibile il prospetto senza attestazione fiscale annuale.'); return }
  const struttura = datiStruttura(impostazioni.fiscale_config as FiscaleConfig, impostazioni.aruba_config as ArubaFiscalConfig, { operazione: 'storici/attestazione', scuolaId: ctx.richiesta.scuolaId })
  const bytes = buildAttestazionePdf({ anno, struttura, intestatario, alunno: nome(ctx, alunnoId), codiceFiscaleAlunno: testo(alunno.codice_fiscale), ...riepilogo })
  aggiungiGenerato(s, `Attestazione-${anno}-${alunnoId}.pdf`, bytes, alunnoId)
}
