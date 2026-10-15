import type { ContestoStorico, SezioneStorico } from '../tipi'
import type { CategoriaStorico } from '../catalogo'
import { haUnRuolo } from '@/lib/auth/predicati-ruolo'
import { aggiungiAllegato, allegato, ammessa, euro, filtroDateEvento, nome, numero, perAlunni, perIds, periodo, relazione, sezione, testo, type Riga } from './servizi-comuni'

export async function raccogliOperativi(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico | null> {
  if (categoria === 'servizi_armadietto') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Data'], ['tipo', 'Registrazione'], ['materiale', 'Materiale'], ['quantita', 'Quantità'], ['stato', 'Stato'], ['livello', 'Livello'], ['presa', 'Presa in carico il'], ['evasa', 'Evasa il']])
    const materiali = await perAlunni(ctx, 'armadietto', 'id,alunno_id,scuola_id,date,materiale,nome_oggetto,quantita,quantita_residua,portato', 'date')
    for (const r of materiali) s.righe.push({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: testo(r.date), tipo: 'Materiale', materiale: testo(r.materiale) || testo(r.nome_oggetto), quantita: numero(r.quantita), stato: r.portato ? 'Portato' : 'Non portato', livello: '', presa: '', evasa: '' })
    const richieste = await perAlunni(ctx, 'armadietto_richieste', 'id,alunno_id,scuola_id,creato_il,materiale,quantita_residua,stato,livello,presa_in_carico_il,evasa_il', 'creato_il', true)
    for (const r of richieste) s.righe.push({ _alunno_id: testo(r.alunno_id), alunno: nome(ctx, r.alunno_id), data: testo(r.creato_il), tipo: 'Richiesta reintegro', materiale: testo(r.materiale), quantita: numero(r.quantita_residua), stato: testo(r.stato), livello: testo(r.livello), presa: testo(r.presa_in_carico_il), evasa: testo(r.evasa_il) })
    s.avvisi.push('Materiali e richieste selezionati per data della registrazione; stato, quantità residue e date di evasione sono i valori conservati oggi, non un inventario storico ricostruito.')
    return s
  }
  if (categoria === 'servizi_ordini') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['ordine', 'Ordine'], ['data', 'Data evento'], ['evento', 'Evento documentato'], ['articolo', 'Articolo'], ['taglia', 'Taglia'], ['quantita', 'Quantità'], ['prezzo', 'Prezzo unitario (€)'], ['subtotale', 'Totale riga (€)'], ['stato', 'Stato documentato dall’evento']])
    const ordini = await perAlunni(ctx, 'divise_ordini', 'id,alunno_id,scuola_id,creato_il,stato,totale', 'creato_il', true)
    const campiRiga = 'id,ordine_id,articolo_nome,taglia,quantita,prezzo_unitario,ordinato_il,arrivato_il,consegnato_il'
    const righe = await perIds(ctx, 'divise_ordini_righe', campiRiga, 'ordine_id', ordini.map(o => testo(o.id)))
    const avanzamenti = await perIds(ctx, 'divise_ordini_righe', `${campiRiga},ordine:divise_ordini!inner(id,alunno_id,scuola_id)`, 'ordine.alunno_id', ctx.alunni.map(a => a.id), q => q.eq('ordine.scuola_id', ctx.richiesta.scuolaId).or(filtroDateEvento(ctx, ['ordinato_il', 'arrivato_il', 'consegnato_il'])))
    function aggiungiRiga(o: Riga, r: Riga, data: unknown, evento: string, stato: string): void {
      if (!ammessa(ctx, o.alunno_id, data)) return
      s.righe.push({ _alunno_id: testo(o.alunno_id), alunno: nome(ctx, o.alunno_id), ordine: testo(o.id), data: testo(data), evento, articolo: testo(r.articolo_nome), taglia: testo(r.taglia), quantita: numero(r.quantita), prezzo: euro(r.prezzo_unitario), subtotale: euro(numero(r.prezzo_unitario) * numero(r.quantita)), stato })
    }
    for (const o of ordini) {
      const voci = righe.filter(r => r.ordine_id === o.id)
      if (!voci.length) s.avvisi.push('Un ordine non conserva righe articolo: non sono stati inventati dettagli dal catalogo corrente.')
      for (const r of voci) aggiungiRiga(o, r, o.creato_il, 'Ordine registrato', 'Registrato')
    }
    const eventi = [['ordinato_il', 'Ordinato al fornitore', 'Ordinato'], ['arrivato_il', 'Arrivo del materiale', 'Arrivato'], ['consegnato_il', 'Consegna alla famiglia', 'Consegnato']] as const
    for (const r of avanzamenti) for (const [campo, evento, stato] of eventi) if (r[campo]) aggiungiRiga(relazione(r.ordine), r, r[campo], evento, stato)
    s.avvisi.push('I nomi, le taglie e i prezzi sono gli snapshot delle righe disponibili oggi. Sono riportati solo gli eventi datati nel periodo; cambiamenti non datati e stati successivi non sono ricostruiti. Gli importi ripetuti sugli avanzamenti descrivono la stessa riga articolo e non sono nuovi addebiti.')
    return s
  }
  if (categoria === 'documenti_protocolli') return protocolli(ctx)
  if (categoria === 'servizi_audit') return audit(ctx)
  return null
}

async function protocolli(ctx: ContestoStorico): Promise<SezioneStorico> {
  const s = sezione('documenti_protocolli', [['alunno', 'Alunno'], ['numero', 'Numero/anno'], ['data', 'Registrato il'], ['tipo', 'Tipo'], ['oggetto', 'Oggetto'], ['mittente', 'Mittente'], ['destinatario', 'Destinatario'], ['annullato', 'Annullato il']])
  if (!haUnRuolo(ctx.utente, ['admin', 'segreteria'])) { s.avvisi.push('Registro protocolli riservato ad amministrazione e segreteria. Nessun protocollo incluso per questo ruolo.'); return s }
  const links = await perIds(ctx, 'storici_collegamenti', 'id,alunno_id,scuola_id,tipo,entita_id', 'alunno_id', ctx.alunni.map(a => a.id), q => q.eq('scuola_id', ctx.richiesta.scuolaId).eq('tipo', 'protocollo'))
  if (!links.length) { s.avvisi.push('Non risultano collegamenti espliciti fra gli alunni selezionati e i protocolli. Non viene dedotta alcuna associazione da nomi o testo libero.'); return s }
  const records = await perIds(ctx, 'protocolli', 'id,scuola_id,numero,anno,data_registrazione,tipo,oggetto,mittente,destinatario,annullata_at,file_originale,file_timbrato,file_nome_originale,file_mime', 'id', links.map(l => testo(l.entita_id)), q => periodo(q.eq('scuola_id', ctx.richiesta.scuolaId), ctx, 'data_registrazione', true))
  const files = await perIds(ctx, 'protocolli_allegati', 'id,protocollo_id,path,nome,mime,ordine', 'protocollo_id', records.map(r => testo(r.id)))
  for (const p of records) for (const l of links.filter(l => l.entita_id === p.id)) {
    const id = testo(l.alunno_id)
    if (!ammessa(ctx, id, p.data_registrazione)) continue
    s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), numero: `${numero(p.numero)}/${numero(p.anno)}`, data: testo(p.data_registrazione), tipo: testo(p.tipo), oggetto: testo(p.oggetto), mittente: testo(p.mittente), destinatario: testo(p.destinatario), annullato: testo(p.annullata_at) })
    const originali = [allegato('protocollo', p.file_originale, testo(p.file_nome_originale) || `Protocollo-${numero(p.numero)}-${numero(p.anno)}-originale`, id, testo(p.file_mime)), allegato('protocollo', p.file_timbrato, `Protocollo-${numero(p.numero)}-${numero(p.anno)}-timbrato.pdf`, id, 'application/pdf')]
    for (const f of originali) { aggiungiAllegato(s, f); if (!f) s.avvisi.push('Un originale o un timbrato di protocollo non è disponibile come percorso conservato.') }
    for (const f of files.filter(f => f.protocollo_id === p.id)) aggiungiAllegato(s, allegato('protocollo', f.path, testo(f.nome), id, testo(f.mime)))
  }
  return s
}

async function audit(ctx: ContestoStorico): Promise<SezioneStorico> {
  const s = sezione('servizi_audit', [['alunno', 'Alunno'], ['data', 'Modifica il'], ['tipo', 'Tipo entità'], ['entita', 'Identificativo entità'], ['azione', 'Operazione'], ['ruolo', 'Ruolo operatore']])
  const collegamenti = new Map<string, string>()
  for (const a of ctx.alunni) for (const tipo of ['alunni', 'alunno', 'diario']) collegamenti.set(`${tipo}:${a.id}`, a.id)
  const fonti = [
    { tabella: 'presenze', tipi: ['presenze'], scope: 'scuola' },
    { tabella: 'pagamenti', tipi: ['pagamento', 'pagamenti'], scope: 'scuola' },
    { tabella: 'armadietto', tipi: ['armadietto'], scope: 'scuola' },
    { tabella: 'note_disciplinari', tipi: ['nota'], scope: 'sezione' },
    { tabella: 'valutazioni', tipi: ['valutazione'], scope: 'sezione' },
    { tabella: 'eventi_diario', tipi: ['diario'], scope: 'appartenenza' },
  ]
  for (const f of fonti) {
    const rows = await perIds(ctx, f.tabella, `id,alunno_id${f.scope === 'sezione' ? ',section_id,sections!inner(scuola_id)' : f.scope === 'scuola' ? ',scuola_id' : ',orario_inizio'}`, 'alunno_id', ctx.alunni.map(a => a.id), q => f.scope === 'appartenenza' ? q : q.eq(f.scope === 'sezione' ? 'sections.scuola_id' : 'scuola_id', ctx.richiesta.scuolaId))
    for (const r of rows) {
      if (f.scope === 'appartenenza' && !ammessa(ctx, r.alunno_id, r.orario_inizio)) continue
      for (const tipo of f.tipi) collegamenti.set(`${tipo}:${testo(r.id)}`, testo(r.alunno_id))
    }
  }
  const records: Riga[] = []
  for (const tipo of new Set([...collegamenti.keys()].map(k => k.split(':')[0]))) {
    const ids = [...collegamenti.keys()].filter(k => k.startsWith(`${tipo}:`)).map(k => k.slice(tipo.length + 1))
    records.push(...await perIds(ctx, 'audit_scritture_docente', 'id,scuola_id,entita_tipo,entita_id,azione,attore_ruolo,creato_il', 'entita_id', ids, q => periodo(q.eq('scuola_id', ctx.richiesta.scuolaId).eq('entita_tipo', tipo), ctx, 'creato_il', true)))
  }
  for (const r of records) {
    const id = collegamenti.get(`${testo(r.entita_tipo)}:${testo(r.entita_id)}`)
    if (!id || !ammessa(ctx, id, r.creato_il)) continue
    s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), data: testo(r.creato_il), tipo: testo(r.entita_tipo), entita: testo(r.entita_id), azione: testo(r.azione), ruolo: testo(r.attore_ruolo) })
  }
  s.avvisi.push('Registro limitato a entità individuali ancora attribuibili con certezza agli alunni. Escluse operazioni di classe, entità cancellate non risolvibili e contenuti prima/dopo, che possono includere dati personali di terzi.')
  return s
}
