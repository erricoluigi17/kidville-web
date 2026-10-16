import { allegatiRegistroVivi } from '@/lib/primaria/cestino-allegati-registro'
import { mediaGiudizi, giudiziSintetici, type ScalaVoce } from '@/lib/primaria/media'
import { COMPETENZE_CHIAVE } from '@/lib/competenze/modello'
import type { CategoriaStorico } from '../catalogo'
import type { ContestoStorico, SezioneStorico } from '../tipi'
import { leggiTutte } from '../db'
import { aggiungiAllegato, allegato, ammesso, cella, elenco, giorno, idsAlunni, nome, nuovaSezione, oggetto, perIds, persone, sezioni, testo, type Riga } from './scolastici-comune'

async function valutazioniLette(ctx: ContestoStorico, s: SezioneStorico): Promise<Riga[]> {
  const righe = await perIds(ctx, 'valutazioni', 'alunno_id', idsAlunni(ctx), q => q,
    '*,materie(nome),valutazione_obiettivi(obiettivo_id,obiettivi_apprendimento(codice,descrizione))')
  const ammesse = righe.filter(r => ammesso(ctx, testo(r.alunno_id), giorno(r.data_evento) || giorno(r.creato_il), testo(r.section_id) || undefined))
  if (ammesse.some(r => !r.data_evento)) s.avvisi.push('Per le valutazioni prive di data dell’evento è usato il giorno di registrazione nel fuso Europe/Rome.')
  return ammesse.sort((a, b) => (giorno(a.data_evento) || giorno(a.creato_il)).localeCompare(giorno(b.data_evento) || giorno(b.creato_il)) || testo(a.id).localeCompare(testo(b.id)))
}
function materia(r: Riga): string { return testo(oggetto(r.materie).nome) || testo(r.materia) }
function obiettivi(r: Riga): Riga[] {
  return elenco(r.valutazione_obiettivi).map(o => ({ id: o.obiettivo_id, ...oggetto(Array.isArray(o.obiettivi_apprendimento) ? o.obiettivi_apprendimento[0] : o.obiettivi_apprendimento) }))
}

export async function valutazioni(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data evento', alunno: 'Alunno', materia: 'Materia', docente: 'Docente', tipo: 'Tipo prova',
    argomento: 'Argomento', modalita: 'Modalità', giudizio: 'Giudizio sintetico', descrizione: 'Giudizio descrittivo', annotazione: 'Annotazione numerica',
    obiettivi: 'Obiettivi', autonomia: 'Autonomia', continuita: 'Continuità', situazione: 'Tipologia situazione', risorse: 'Risorse' })
  const righe = await valutazioniLette(ctx, s)
  const autori = await persone(ctx, righe.map(r => testo(r.maestra_id)))
  for (const r of righe) {
    const id = testo(r.alunno_id)
    s.righe.push({ _alunno_id: id, data: giorno(r.data_evento) || giorno(r.creato_il), alunno: nome(ctx, id), materia: materia(r),
      docente: autori.get(testo(r.maestra_id)) ?? '', tipo: testo(r.tipo), argomento: testo(r.argomento), modalita: testo(r.modalita),
      giudizio: testo(r.giudizio_sintetico), descrizione: testo(r.giudizio_testo), annotazione: cella(r.annotazione_numerica ?? r.voto_numerico),
      obiettivi: obiettivi(r).map(o => [testo(o.codice), testo(o.descrizione)].filter(Boolean).join(' — ')).join('; '),
      autonomia: cella(r.dim_autonomia), continuita: cella(r.dim_continuita), situazione: testo(r.dim_tipologia), risorse: testo(r.dim_risorse) })
  }
  return s
}

export async function prospetti(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { alunno: 'Alunno', materia: 'Materia', obiettivo: 'Obiettivo', numero: 'Valutazioni', giudizi: 'Giudizi registrati', media: 'Media matematica interna' })
  const righe = await valutazioniLette(ctx, s)
  const scala = await leggiTutte<ScalaVoce>((dal, al) => ctx.db.from('giudizi_sintetici_scala').select('etichetta,valore_numerico')
    .eq('scuola_id', ctx.richiesta.scuolaId).order('id').range(dal, al), 'scolastici/scala-giudizi')
  const gruppi = new Map<string, { id: string; materia: string; obiettivo: string; righe: Riga[] }>()
  for (const r of righe) {
    const id = testo(r.alunno_id)
    for (const ob of [{ id: '', descrizione: 'Tutti gli obiettivi della materia' }, ...obiettivi(r)]) {
      const chiave = `${id}:${testo(r.materia_id) || materia(r)}:${testo(ob.id)}`
      const g = gruppi.get(chiave) ?? { id, materia: materia(r), obiettivo: [testo(ob.codice), testo(ob.descrizione)].filter(Boolean).join(' — '), righe: [] }
      g.righe.push(r); gruppi.set(chiave, g)
    }
  }
  for (const [, g] of [...gruppi.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const giudizi = giudiziSintetici(g.righe)
    s.righe.push({ _alunno_id: g.id, alunno: nome(ctx, g.id), materia: g.materia, obiettivo: g.obiettivo,
      numero: g.righe.length, giudizi: giudizi.join(', '), media: mediaGiudizi(scala, giudizi) })
  }
  s.avvisi.push('La media è un prospetto interno delle valutazioni del periodo e non sostituisce il giudizio di scrutinio. Usa la scala numerica attualmente configurata per la sede.')
  return s
}

async function noteLette(ctx: ContestoStorico, s: SezioneStorico): Promise<Riga[]> {
  const righe = await perIds(ctx, 'note_disciplinari', 'alunno_id', idsAlunni(ctx), q => q)
  const ammesse = righe.filter(r => ammesso(ctx, testo(r.alunno_id), giorno(r.data_evento) || giorno(r.creato_il), testo(r.section_id) || undefined))
  if (ammesse.some(r => !r.data_evento)) s.avvisi.push('Per le note prive di data dell’evento è usato il giorno di registrazione nel fuso Europe/Rome.')
  return ammesse.sort((a, b) => (giorno(a.data_evento) || giorno(a.creato_il)).localeCompare(giorno(b.data_evento) || giorno(b.creato_il)) || testo(a.id).localeCompare(testo(b.id)))
}
export async function note(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data evento', alunno: 'Alunno', docente: 'Docente', categoria: 'Categoria', testo: 'Nota', richiedeFirma: 'Richiede firma', firmataIl: 'Firmata il', firme: 'Prese visione' })
  const righe = await noteLette(ctx, s)
  const ricezioni = await perIds(ctx, 'nota_ricezioni', 'nota_id', righe.map(r => testo(r.id)))
  const autori = await persone(ctx, righe.map(r => testo(r.maestra_id)))
  for (const r of righe) {
    const id = testo(r.alunno_id)
    const proprie = ricezioni.filter(f => f.nota_id === r.id && f.alunno_id === id)
    s.righe.push({ _alunno_id: id, data: giorno(r.data_evento) || giorno(r.creato_il), alunno: nome(ctx, id), docente: autori.get(testo(r.maestra_id)) ?? '',
      categoria: testo(r.categoria), testo: testo(r.testo), richiedeFirma: r.richiede_firma === true, firmataIl: testo(r.firmata_il),
      firme: proprie.map(f => testo(f.firmato_il)).join('; ') })
  }
  return s
}

/** Una firma indipendente appartiene esclusivamente ai suoi destinatari, mai all’intera classe. */
export async function registro(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data', alunno: 'Alunno', classe: 'Classe', ora: 'Ora', materia: 'Materia', ambito: 'Destinazione',
    argomento: 'Argomento', compiti: 'Compiti', consegna: 'Consegna', docente: 'Docente', tipoFirma: 'Tipo firma', firmatoIl: 'Firmato il', allegati: 'Allegati' })
  s._versione_raccolta = 1
  const classi = await sezioni(ctx)
  const lezioni = await perIds(ctx, 'registro_orario', 'section_id', classi.map(c => testo(c.id)), q => q.gte('data', ctx.richiesta.dal).lte('data', ctx.richiesta.al)
    .or(`scuola_id.is.null,scuola_id.eq.${ctx.richiesta.scuolaId}`), '*,materie(nome)')
  lezioni.sort((a, b) => testo(a.data).localeCompare(testo(b.data)) || Number(a.ora_lezione) - Number(b.ora_lezione) || testo(a.id).localeCompare(testo(b.id)))
  const ids = lezioni.map(r => testo(r.id))
  const firme = await perIds(ctx, 'firme_docenti', 'registro_id', ids)
  const destinatari = await perIds(ctx, 'registro_destinatari', 'registro_id', ids)
  const files = await perIds(ctx, 'allegati_registro', 'registro_id', ids, q => allegatiRegistroVivi(q))
  const autori = await persone(ctx, firme.map(f => testo(f.maestra_id)))
  for (const r of lezioni) {
    const data = giorno(r.data), sectionId = testo(r.section_id)
    const ammessi = ctx.alunni.filter(a => ammesso(ctx, a.id, data, sectionId))
    if (!ammessi.length) continue
    const proprie = firme.filter(f => f.registro_id === r.id)
    const filesLezione = files.filter(f => f.registro_id === r.id)
    const base = { _ambito: 'classe', _registro_id: testo(r.id), _classe_id: sectionId, data, alunno: '',
      classe: testo(classi.find(c => c.id === sectionId)?.name), ora: cella(r.ora_lezione), materia: materia(r),
      consegna: giorno(r.data_consegna_compiti), allegati: filesLezione.map(f => testo(f.file_name)).join('; ') }
    const firmaClasse = proprie.filter(f => !destinatari.some(d => d.firma_id === f.id))
    if (!['primaria_firme', 'documenti_didattici'].includes(categoria) && (testo(r.argomento) || testo(r.compiti)) && (categoria !== 'primaria_compiti' || testo(r.compiti))) {
      s.righe.push({ ...base, ambito: 'Classe', argomento: testo(r.argomento), compiti: testo(r.compiti),
        docente: firmaClasse.map(f => autori.get(testo(f.maestra_id)) ?? '').filter(Boolean).join(', '), tipoFirma: '', firmatoIl: '' })
    }
    for (const f of proprie) {
      if (categoria === 'documenti_didattici') continue
      const ds = destinatari.filter(d => d.firma_id === f.id)
      const destinata = ds.length > 0
      // Le vecchie righe con destinatario senza firma non autorizzano contenuti propri di una firma.
      if (categoria !== 'primaria_firme' && !destinata) continue
      if (categoria === 'primaria_compiti' && !testo(f.compiti_propri)) continue
      const firma = { ...base, _firma_id: testo(f.id), ambito: destinata ? 'Destinatario individuale' : 'Classe',
        argomento: destinata ? testo(f.argomento_proprio) : testo(r.argomento), compiti: destinata ? testo(f.compiti_propri) : testo(r.compiti),
        docente: autori.get(testo(f.maestra_id)) ?? '', tipoFirma: testo(f.tipo_compresenza), firmatoIl: testo(f.firmato_il) }
      if (!destinata) s.righe.push(firma)
      else for (const a of ammessi.filter(a => ds.some(d => d.alunno_id === a.id))) {
        s.righe.push({ ...firma, _ambito: 'alunno', _alunno_id: a.id, alunno: nome(ctx, a.id) })
      }
    }
    if (categoria !== 'primaria_firme') for (const f of filesLezione.filter(f => categoria !== 'primaria_compiti' || f.ambito === 'compiti')) {
      aggiungiAllegato(s, allegato('registro-allegati', f.storage_path || f.file_url, testo(f.file_name), undefined, f.tipo === 'pdf' ? 'application/pdf' : undefined))
    }
    if (categoria === 'documenti_didattici' && filesLezione.length) s.righe.push({ ...base, ambito: 'Classe', argomento: testo(r.argomento), compiti: testo(r.compiti) })
  }
  return s
}

export async function firme(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = await registro(ctx, categoria)
  const ns = await noteLette(ctx, s)
  const ricezioni = await perIds(ctx, 'nota_ricezioni', 'nota_id', ns.map(n => testo(n.id)))
  const genitori = await persone(ctx, ricezioni.map(f => testo(f.genitore_id)))
  s.colonne.push({ chiave: 'tipoDocumento', titolo: 'Documento' })
  for (const r of s.righe) r.tipoDocumento = 'Lezione'
  for (const n of ns) {
    const id = testo(n.alunno_id)
    const proprie = ricezioni.filter(f => f.nota_id === n.id && f.alunno_id === id)
    for (const f of proprie) s.righe.push({ _alunno_id: id, data: giorno(n.data_evento) || giorno(n.creato_il), alunno: nome(ctx, id),
      tipoDocumento: 'Nota', argomento: testo(n.testo), docente: genitori.get(testo(f.genitore_id)) ?? '', firmatoIl: testo(f.firmato_il), tipoFirma: 'Presa visione genitore' })
    if (!proprie.length && n.firmata_il) s.righe.push({ _alunno_id: id, data: giorno(n.data_evento) || giorno(n.creato_il), alunno: nome(ctx, id),
      tipoDocumento: 'Nota', argomento: testo(n.testo), docente: '', firmatoIl: testo(n.firmata_il), tipoFirma: 'Firma storica genitore' })
  }
  return s
}

async function sessioni(ctx: ContestoStorico): Promise<{ classi: Riga[]; periodi: Riga[]; scrutini: Riga[] }> {
  const classi = await sezioni(ctx)
  const periodi = await leggiTutte<Riga>((dal, al) => ctx.db.from('scrutinio_periodi').select('*').eq('scuola_id', ctx.richiesta.scuolaId).order('id').range(dal, al), 'scolastici/periodi')
  const scrutini = await perIds(ctx, 'scrutini', 'section_id', classi.map(c => testo(c.id)), q => q.in('periodo_id', periodi.map(p => testo(p.id))))
  return { classi, periodi, scrutini }
}
function dataScrutinio(r: Riga, periodi: Riga[], fallback?: unknown): string {
  return giorno(periodi.find(p => p.id === r.periodo_id)?.data_fine) || giorno(r.chiuso_il) || giorno(fallback) || giorno(r.creato_il)
}
export async function scrutini(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Fine periodo', alunno: 'Alunno', classe: 'Classe', anno: 'Anno scolastico', periodo: 'Periodo', stato: 'Stato scrutinio',
    materia: 'Materia', giudizio: 'Giudizio', comportamento: 'Comportamento', globale: 'Giudizio globale' })
  const sc = await sessioni(ctx)
  const ids = sc.scrutini.map(r => testo(r.id))
  const giudizi = await perIds(ctx, 'scrutinio_giudizi', 'scrutinio_id', ids, q => q.in('alunno_id', idsAlunni(ctx)), '*,materie(nome)')
  const comportamenti = await perIds(ctx, 'scrutinio_comportamento', 'scrutinio_id', ids, q => q.in('alunno_id', idsAlunni(ctx)))
  for (const r of sc.scrutini) {
    const data = dataScrutinio(r, sc.periodi), p = sc.periodi.find(p => p.id === r.periodo_id)
    for (const a of ctx.alunni.filter(a => ammesso(ctx, a.id, data, testo(r.section_id)))) {
      const c = comportamenti.find(c => c.scrutinio_id === r.id && c.alunno_id === a.id)
      const base = { _alunno_id: a.id, data, alunno: nome(ctx, a.id), classe: testo(sc.classi.find(c => c.id === r.section_id)?.name),
        anno: testo(p?.anno_scolastico), periodo: testo(p?.nome), stato: testo(r.stato), comportamento: testo(c?.giudizio_testo) || testo(c?.scala_valore), globale: testo(c?.giudizio_globale) }
      const propri = giudizi.filter(g => g.scrutinio_id === r.id && g.alunno_id === a.id)
      for (const g of propri) s.righe.push({ ...base, materia: materia(g), giudizio: testo(g.giudizio_sintetico) })
      if (!propri.length && c) s.righe.push({ ...base, materia: '', giudizio: '' })
    }
  }
  return s
}

export async function pagelle(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Fine periodo', alunno: 'Alunno', anno: 'Anno scolastico', periodo: 'Periodo', stato: 'Stato scrutinio', generataIl: 'Generata il', originale: 'Originale archiviato' })
  const sc = await sessioni(ctx)
  const righe = await perIds(ctx, 'pagelle', 'alunno_id', idsAlunni(ctx), q => q.in('scrutinio_id', sc.scrutini.map(r => testo(r.id))))
  for (const r of righe) {
    const sessione = sc.scrutini.find(sc => sc.id === r.scrutinio_id)
    if (!sessione) continue
    const data = dataScrutinio(sessione, sc.periodi, r.generata_il), id = testo(r.alunno_id)
    if (!ammesso(ctx, id, data, testo(sessione.section_id))) continue
    const p = sc.periodi.find(p => p.id === sessione.periodo_id)
    const originale = allegato('pagelle', r.file_url, `Pagella ${nome(ctx, id)} ${testo(p?.nome)}.pdf`, id, 'application/pdf')
    aggiungiAllegato(s, originale)
    s.righe.push({ _alunno_id: id, data, alunno: nome(ctx, id), anno: testo(p?.anno_scolastico), periodo: testo(p?.nome),
      stato: testo(sessione.stato), generataIl: testo(r.generata_il), originale: Boolean(originale) })
    if (!originale) s.avvisi.push('Una pagella del periodo non dispone di un originale archiviato leggibile; il riepilogo non ne ricostruisce la firma.')
  }
  return s
}

export async function competenze(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data', alunno: 'Alunno', anno: 'Anno scolastico', stato: 'Stato', competenza: 'Competenza', livello: 'Livello', note: 'Note', originale: 'Originale archiviato' })
  const righe = await perIds(ctx, 'certificati_competenze', 'alunno_id', idsAlunni(ctx), q => q.eq('scuola_id', ctx.richiesta.scuolaId))
  const livelli = await perIds(ctx, 'certificato_competenza_livelli', 'certificato_id', righe.map(r => testo(r.id)))
  const sc = await sessioni(ctx)
  for (const r of righe) {
    const sessione = sc.scrutini.find(sc => sc.id === r.scrutinio_id)
    const data = sessione ? dataScrutinio(sessione, sc.periodi, r.generato_il) : giorno(r.generato_il) || giorno(r.created_at)
    const id = testo(r.alunno_id)
    if (!ammesso(ctx, id, data, testo(r.section_id) || undefined)) continue
    const originale = allegato('certificati-competenze', r.file_url, `Certificato competenze ${nome(ctx, id)} ${testo(r.anno_scolastico)}.pdf`, id, 'application/pdf')
    aggiungiAllegato(s, originale)
    const base = { _alunno_id: id, data, alunno: nome(ctx, id), anno: testo(r.anno_scolastico), stato: testo(r.stato), originale: Boolean(originale) }
    const propri = livelli.filter(l => l.certificato_id === r.id).sort((a, b) => Number(a.ordine) - Number(b.ordine) || testo(a.id).localeCompare(testo(b.id)))
    for (const l of propri) s.righe.push({ ...base, competenza: COMPETENZE_CHIAVE.find(c => c.codice === l.competenza_codice)?.etichetta ?? testo(l.competenza_codice), livello: testo(l.livello), note: testo(l.note) })
    if (!propri.length) s.righe.push({ ...base, competenza: '', livello: '', note: '' })
    if (!originale) s.avvisi.push('Un certificato del periodo non dispone di un originale archiviato; sono riportati i livelli salvati senza ricostruire firme.')
  }
  return s
}

export async function orario(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { classe: 'Classe', giorno: 'Giorno', ordine: 'Ora', inizio: 'Inizio', fine: 'Fine', tipo: 'Tipo', materia: 'Materia', docente: 'Docente', note: 'Note' })
  const classi = await sezioni(ctx), ids = classi.map(c => testo(c.id))
  const campanelle = await perIds(ctx, 'campanelle', 'section_id', ids)
  const slots = await perIds(ctx, 'orario_settimanale', 'section_id', ids, q => q, '*,materie(nome),utenti(nome,cognome)')
  campanelle.sort((a, b) => testo(a.section_id).localeCompare(testo(b.section_id)) || Number(a.giorno_settimana) - Number(b.giorno_settimana) || Number(a.ordine) - Number(b.ordine))
  for (const c of campanelle) {
    const slot = slots.find(o => o.campanella_id === c.id && o.section_id === c.section_id && o.giorno_settimana === c.giorno_settimana)
    s.righe.push({ classe: testo(classi.find(s => s.id === c.section_id)?.name), giorno: ['', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'][Number(c.giorno_settimana)] ?? '',
      ordine: cella(c.ordine), inizio: testo(c.ora_inizio), fine: testo(c.ora_fine), tipo: testo(c.tipo), materia: testo(oggetto(slot?.materie).nome),
      docente: [testo(oggetto(slot?.utenti).cognome), testo(oggetto(slot?.utenti).nome)].filter(Boolean).join(' '), note: testo(slot?.note) })
  }
  s.avvisi.push('Questa sezione riproduce l’orario attualmente salvato delle classi frequentate nel periodo. Le configurazioni storiche non sono versionate e non si può attestare che questo fosse l’orario in vigore nelle date richieste.')
  return s
}
