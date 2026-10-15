import type { ContestoStorico, SezioneStorico } from '../tipi'
import type { CategoriaStorico } from '../catalogo'
import { calcolaAttestazione } from '@/lib/pagamenti/attestazione'
import { dateRange, resolveMenuRange, type MenuGiorno, type RotazioneRow, type OverrideRow } from '@/lib/mensa/resolveMenu'
import { pdfAttestazione, pdfRicevute } from './servizi-documenti-contabili'
import { aggiungiAllegato, allegato, ammessa, euro, giorno, lista, nome, numero, oggetto, perAlunni, perIds, periodo, relazione, sezione, testo, tutte, type Riga } from './servizi-comuni'

const COL_PAGAMENTO = 'id,alunno_id,scuola_id,descrizione,importo,sconto,importo_pagato,scadenza,stato,tipo,categoria_id,periodo_competenza'
export async function addebiti(ctx: ContestoStorico): Promise<Riga[]> {
  const { dal, al } = ctx.richiesta
  const righe = await perIds(ctx, 'pagamenti', COL_PAGAMENTO, 'alunno_id', ctx.alunni.map(a => a.id), q => q.eq('scuola_id', ctx.richiesta.scuolaId).neq('tipo', 'padre').or(`and(periodo_competenza.gte.${dal},periodo_competenza.lte.${al}),and(periodo_competenza.is.null,scadenza.gte.${dal},scadenza.lte.${al})`))
  return righe.filter(r => r.tipo !== 'padre' && ammessa(ctx, r.alunno_id, r.periodo_competenza ?? r.scadenza))
}
export async function incassi(ctx: ContestoStorico): Promise<Riga[]> {
  const righe = await perIds(ctx, 'incassi', 'id,pagamento_id,importo,data_incasso,metodo,storno_di,pagamenti!inner(id,alunno_id,scuola_id,descrizione,tipo,payment_categories(slug))', 'pagamenti.alunno_id', ctx.alunni.map(a => a.id), q => periodo(q.eq('pagamenti.scuola_id', ctx.richiesta.scuolaId).neq('pagamenti.tipo', 'padre'), ctx, 'data_incasso'))
  return righe.filter(r => { const p = relazione(r.pagamenti); return p.tipo !== 'padre' && p.scuola_id === ctx.richiesta.scuolaId && ammessa(ctx, p.alunno_id, r.data_incasso) })
}

async function menu(ctx: ContestoStorico): Promise<SezioneStorico> {
  const s = sezione('mensa_menu', [['alunno', 'Alunno'], ['data', 'Data'], ['classe', 'Classe documentata'], ['stato', 'Servizio'], ['primo', 'Primo'], ['secondo', 'Secondo'], ['contorno', 'Contorno'], ['frutta', 'Frutta'], ['ingredienti', 'Ingredienti'], ['allergeni', 'Allergeni'], ['note', 'Note']])
  s.avvisi.push('Menù ricostruito dalla configurazione disponibile oggi, dalle assegnazioni datate e dalle alternative salvate: non certifica il menù effettivamente servito in passato.')
  // I loader operativi ignorano gli errori e non paginano gli override. Qui le stesse
  // sorgenti sono lette interamente e con errori bloccanti, prima del resolver condiviso.
  const cfg = (await tutte(ctx, 'admin_settings', 'scuola_id,mensa_giorni_attivi,mensa_settimane_rotazione', q => q.eq('scuola_id', ctx.richiesta.scuolaId), 'scuola_id'))[0]
  if (!cfg) { s.avvisi.push('Configurazione mensa assente: nessun menù ricostruito.'); return s }
  const classi = await perIds(ctx, 'sections', 'id,name,school_type', 'id', ctx.appartenenze.map(a => a.section_id), q => q.eq('scuola_id', ctx.richiesta.scuolaId))
  const assegnazioni = await tutte(ctx, 'mensa_class_menu_assignment', 'id,classe,menu_config_id,attivo_dal', q => q.eq('scuola_id', ctx.richiesta.scuolaId).lte('attivo_dal', ctx.richiesta.al))
  const rotazioni = await tutte(ctx, 'mensa_menu_rotazione', 'id,settimana,giorno_settimana,portate,ingredienti,allergeni,note,menu_config_id', q => q.eq('scuola_id', ctx.richiesta.scuolaId))
  const alternative = await tutte(ctx, 'mensa_menu_override', 'id,data,chiuso,portate,ingredienti,allergeni,note,menu_config_id', q => periodo(q.eq('scuola_id', ctx.richiesta.scuolaId), ctx, 'data'))
  const giorni = dateRange(ctx.richiesta.dal, ctx.richiesta.al)
  const risolti = new Map<string, Map<string, MenuGiorno>>()
  function menuPerConfigurazione(menuId: unknown): Map<string, MenuGiorno> {
    const chiave = testo(menuId)
    let dati = risolti.get(chiave)
    if (!dati) {
      dati = new Map(resolveMenuRange(ctx.richiesta.dal, ctx.richiesta.al, {
        giorniAttivi: Array.isArray(cfg.mensa_giorni_attivi) ? cfg.mensa_giorni_attivi as number[] : [], settimaneRotazione: numero(cfg.mensa_settimane_rotazione) || 4,
        rotazione: rotazioni.filter(x => (x.menu_config_id ?? null) === (menuId ?? null)) as unknown as RotazioneRow[],
        override: alternative.filter(x => (x.menu_config_id ?? null) === (menuId ?? null)) as unknown as OverrideRow[],
      }).map(m => [m.data, m]))
      risolti.set(chiave, dati)
    }
    return dati
  }
  for (const a of ctx.alunni) {
    const appartenenze = ctx.appartenenze.filter(x => x.alunno_id === a.id)
    if (!appartenenze.length) { s.avvisi.push(`Menù non ricostruibile per un alunno senza appartenenze storiche documentate.`); continue }
    for (const data of giorni) {
      if (!ammessa(ctx, a.id, data)) continue
      const app = appartenenze.find(x => x.dal <= data && (!x.al || data < x.al))
      const classe = classi.find(c => c.id === app?.section_id)
      if (!classe) continue
      const ass = assegnazioni.filter(x => x.classe === classe.name && testo(x.attivo_dal) <= data).sort((x, y) => testo(y.attivo_dal).localeCompare(testo(x.attivo_dal)) || testo(x.id).localeCompare(testo(y.id)))[0]
      const menuId = ass?.menu_config_id ?? null
      const m = menuPerConfigurazione(menuId).get(data)!
      const portate = oggetto(m.portate), ingredienti = oggetto(m.ingredienti), allergeni = oggetto(m.allergeni)
      const campi = ['primo', 'secondo', 'contorno', 'frutta']
      s.righe.push({ _alunno_id: a.id, alunno: nome(ctx, a.id), data, classe: testo(classe.name), stato: m.chiuso ? 'Chiuso' : m.attivo ? 'Attivo' : 'Non attivo', primo: testo(portate.primo), secondo: testo(portate.secondo), contorno: testo(portate.contorno), frutta: testo(portate.frutta), ingredienti: campi.filter(c => ingredienti[c]).map(c => `${c}: ${testo(ingredienti[c])}`).join('; '), allergeni: campi.filter(c => lista(allergeni[c]).length).map(c => `${c}: ${lista(allergeni[c]).join(', ')}`).join('; '), note: m.note ?? '' })
    }
  }
  return s
}

export async function raccogliContabilita(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico | null> {
  if (categoria === 'mensa_menu') return menu(ctx)
  if (categoria === 'mensa_pasti') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Data pasto'], ['stato', 'Stato'], ['origine', 'Origine'], ['ticket', 'Ticket scalati']])
    const righe = await perAlunni(ctx, 'mensa_prenotazioni', 'id,alunno_id,scuola_id,data,stato,origine,ticket_scalato', 'data')
    s.righe = righe.map(r => ({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: giorno(r.data), stato: testo(r.stato), origine: testo(r.origine), ticket: numero(r.ticket_scalato) }))
    return s
  }
  if (categoria === 'mensa_ticket') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Data'], ['tipo', 'Movimento'], ['delta', 'Variazione ticket'], ['saldo', 'Saldo dopo il movimento'], ['origine', 'Origine'], ['note', 'Note']])
    s.righe = (await perAlunni(ctx, 'mensa_ticket_movimenti', 'id,alunno_id,scuola_id,data,tipo,delta,saldo_dopo,origine,note', 'data')).map(r => ({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: giorno(r.data), tipo: testo(r.tipo), delta: numero(r.delta), saldo: r.saldo_dopo == null ? null : numero(r.saldo_dopo), origine: testo(r.origine), note: testo(r.note) }))
    return s
  }
  if (categoria === 'contabilita_addebiti') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['descrizione', 'Voce'], ['competenza', 'Competenza'], ['scadenza', 'Scadenza'], ['importo', 'Importo (€)'], ['sconto', 'Sconto (€)'], ['netto', 'Netto (€)'], ['stato', 'Stato corrente']])
    s.righe = (await addebiti(ctx)).map(r => ({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), descrizione: testo(r.descrizione), competenza: giorno(r.periodo_competenza), scadenza: giorno(r.scadenza), importo: euro(r.importo), sconto: euro(r.sconto), netto: euro(numero(r.importo) - numero(r.sconto)), stato: testo(r.stato) }))
    s.avvisi.push('Le voci padre sono escluse. Selezione per competenza, oppure scadenza quando manca la competenza; stato e importi riflettono i dati salvati oggi.')
    return s
  }
  if (categoria === 'contabilita_incassi') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Data incasso'], ['descrizione', 'Voce'], ['importo', 'Importo con segno (€)'], ['metodo', 'Metodo'], ['storno', 'Storno di']])
    s.righe = (await incassi(ctx)).map(r => { const p = relazione(r.pagamenti); return { _alunno_id: testo(p.alunno_id), alunno: nome(ctx, p.alunno_id), data: giorno(r.data_incasso), descrizione: testo(p.descrizione), importo: euro(r.importo), metodo: testo(r.metodo), storno: testo(r.storno_di) } })
    return s
  }
  if (categoria === 'contabilita_situazione') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['addebiti', 'Addebiti del periodo (€)'], ['incassi', 'Incassi netti del periodo (€)'], ['differenza', 'Differenza dei flussi (€)']])
    const pag = await addebiti(ctx), inc = await incassi(ctx)
    s.righe = ctx.alunni.map(a => {
      const addebitato = euro(pag.filter(p => p.alunno_id === a.id && p.stato !== 'annullato').reduce((sum, p) => sum + numero(p.importo) - numero(p.sconto), 0))
      const incassato = euro(inc.filter(i => relazione(i.pagamenti).alunno_id === a.id).reduce((sum, i) => sum + numero(i.importo), 0))
      return { _alunno_id: a.id, alunno: nome(ctx, a.id), addebiti: addebitato, incassi: incassato, differenza: euro(addebitato - incassato) }
    })
    s.avvisi.push('Prospetto dei flussi del periodo: gli incassi possono riguardare competenze precedenti. La differenza non è il debito residuo né un saldo contabile storico; i dati degli addebiti sono quelli disponibili oggi.')
    return s
  }
  if (categoria === 'contabilita_attestazioni') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['descrizione', 'Voce'], ['categoria', 'Categoria fiscale'], ['importo', 'Versato netto (€)'], ['tracciabile', 'Tracciabile'], ['escluso', 'Categoria esclusa']])
    const inc = await incassi(ctx)
    for (const a of ctx.alunni) {
      const riepilogo = calcolaAttestazione(inc.filter(i => relazione(i.pagamenti).alunno_id === a.id).map(i => ({ importo: euro(i.importo), metodo: testo(i.metodo), descrizione: testo(relazione(i.pagamenti).descrizione), categoria_slug: testo(relazione(relazione(i.pagamenti).payment_categories).slug) || null })))
      for (const r of riepilogo.righe) s.righe.push({ _alunno_id: a.id, alunno: nome(ctx, a.id), descrizione: r.descrizione, categoria: r.categoria, importo: r.importo, tracciabile: r.tracciabile, escluso: r.escluso })
      await pdfAttestazione(ctx, s, a.id, riepilogo)
    }
    s.avvisi.push('Attestazione derivata dagli incassi del periodo, storni inclusi con il segno, secondo il criterio di cassa e le regole fiscali condivise. Non emette documenti né modifica ricevute.')
    return s
  }
  if (categoria === 'contabilita_ricevute') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Emessa il'], ['numero', 'Numero/anno'], ['importo', 'Importo (€)'], ['competenza', 'Competenza'], ['metodi', 'Metodi'], ['tracciabile', 'Tracciabile'], ['bollo', 'Bollo'], ['annullata', 'Annullata il']])
    // Lo snapshot ha un alunno_id ma NON una FK ad alunni: nessun join ipotizzato.
    const righe = await perAlunni(ctx, 'ricevute_emesse', 'id,alunno_id,scuola_id,pagamento_id,transazione_id,numero,anno,importo,periodo_competenza,metodi,tracciabile,bollo,annullata_il,creato_il,intestatario,dati_struttura,righe', 'creato_il', true)
    s.righe = righe.map(r => ({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: testo(r.creato_il), numero: `${numero(r.numero)}/${numero(r.anno)}`, importo: euro(r.importo), competenza: giorno(r.periodo_competenza), metodi: lista(r.metodi).join(', '), tracciabile: r.tracciabile === true, bollo: r.bollo === true, annullata: testo(r.annullata_il) }))
    await pdfRicevute(ctx, s, righe)
    s.avvisi.push('Ristampe dagli snapshot già emessi, senza nuova numerazione. Le ricevute familiari con dati di alunni fuori dalla selezione sono escluse.')
    return s
  }
  if (categoria === 'contabilita_fatture') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Emessa il'], ['numero', 'Sezionale/numero/anno'], ['causale', 'Causale'], ['importo', 'Importo (€)'], ['sdi', 'Stato SDI'], ['originale', 'PDF originale']])
    const righe = await perIds(ctx, 'fatture_emesse', 'id,pagamento_id,scuola_id,sezionale,numero,anno,causale,importo,sdi_stato_label,pdf_path,creato_il,pagamenti!inner(alunno_id,scuola_id)', 'pagamenti.alunno_id', ctx.alunni.map(a => a.id), q => periodo(q.eq('scuola_id', ctx.richiesta.scuolaId).eq('pagamenti.scuola_id', ctx.richiesta.scuolaId), ctx, 'creato_il', true))
    for (const r of righe) {
      const p = relazione(r.pagamenti), id = testo(p.alunno_id)
      if (!ammessa(ctx, id, r.creato_il)) continue
      const identificativo = `${testo(r.sezionale)}/${numero(r.numero)}/${numero(r.anno)}`
      const file = allegato('fatture', r.pdf_path, `Fattura-${testo(r.sezionale)}-${numero(r.numero)}-${numero(r.anno)}.pdf`, id, 'application/pdf')
      aggiungiAllegato(s, file)
      if (!file) s.avvisi.push('Una fattura non dispone del PDF originale conservato: verificare il registro fatture.')
      s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), data: testo(r.creato_il), numero: identificativo, causale: testo(r.causale), importo: euro(r.importo), sdi: testo(r.sdi_stato_label), originale: file ? 'Allegato' : 'Non disponibile' })
    }
    return s
  }
  if (categoria === 'contabilita_solleciti') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Inviato il'], ['livello', 'Livello'], ['canale', 'Canale'], ['oggetto', 'Oggetto'], ['corpo', 'Testo inviato'], ['automatico', 'Automatico']])
    s.righe = (await perAlunni(ctx, 'solleciti', 'id,alunno_id,scuola_id,inviato_il,livello,canale,oggetto,corpo,automatico', 'inviato_il', true)).map(r => ({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: testo(r.inviato_il), livello: numero(r.livello), canale: testo(r.canale), oggetto: testo(r.oggetto), corpo: testo(r.corpo), automatico: r.automatico === true }))
    return s
  }
  return null
}
