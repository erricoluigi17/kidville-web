import type { ContestoStorico, SezioneStorico } from '../tipi'
import type { CategoriaStorico } from '../catalogo'
import { ErroreStorico } from '../db'
import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit'
import { normalizzaAllegatoChat } from '@/lib/chat/allegati'
import { soloVive } from '@/lib/gallery/cestino'
import { BUCKET_AVVISI_ALLEGATI } from '@/lib/allegati/storage'
import { logEvento } from '@/lib/logging/logger'
import { postVisibileAiFigli, type PostTarget, type FiglioTarget } from '@/lib/news/target'
import { aggiungiAllegato, allegato, ammessa, dataCompetenza, filtroPeriodoCompetenza, giorno, lista, nelPeriodo, nome, perIds, periodo, periodoCompetenza, sezione, testo, tutte, type Riga } from './servizi-comuni'

function fileAvviso(valore: unknown): string | null {
  const v = testo(valore).trim()
  if (!v.startsWith('{')) return v || null
  try { return testo((JSON.parse(v) as { file?: unknown }).file) || null }
  catch { logEvento('registro', 'warn', { operazione: 'storici/allegato-avviso', esito: 'formato-non-riconosciuto' }); return null }
}

export async function classiStoriche(ctx: ContestoStorico): Promise<Riga[]> {
  return perIds(ctx, 'sections', 'id,name,school_type', 'id', ctx.appartenenze.map(a => a.section_id), q => q.eq('scuola_id', ctx.richiesta.scuolaId))
}
function targetAlunno(ctx: ContestoStorico, id: string, data: unknown, classi: Riga[]): FiglioTarget[] {
  const d = giorno(data)
  if (!ammessa(ctx, id, d)) return []
  return ctx.appartenenze.filter(a => a.scuola_id === ctx.richiesta.scuolaId && a.alunno_id === id && a.dal <= d && (!a.al || d < a.al)).map(a => {
    const c = classi.find(x => x.id === a.section_id), grado = c?.school_type
    return { scuola_id: ctx.richiesta.scuolaId, classe_sezione: testo(c?.name) || null, grado: grado === 'nido' || grado === 'infanzia' || grado === 'primaria' ? grado : null }
  })
}
function destinatari(ctx: ContestoStorico, r: Riga, data: unknown, classi: Riga[], news = false): string[] {
  return ctx.alunni.filter(a => {
    if (!ammessa(ctx, a.id, data)) return false
    const target = targetAlunno(ctx, a.id, data, classi)
    if (!news && r.target_scope === 'globale') return r.scuola_id === ctx.richiesta.scuolaId && target.length > 0
    return postVisibileAiFigli({ scuola_id: r.scuola_id == null ? null : testo(r.scuola_id), target_scope: r.target_scope as PostTarget['target_scope'], target_classes: lista(r.target_classes), target_gradi: (Array.isArray(r.target_gradi) ? r.target_gradi : []) as PostTarget['target_gradi'] }, target)
  }).map(a => a.id)
}
export async function threads(ctx: ContestoStorico): Promise<Riga[]> {
  // La tabella non conserva una sede: il legame è con l'alunno già autorizzato.
  // La sede pertinente si verifica sulla sua appartenenza alla data del messaggio,
  // senza usare la sede corrente (che cambierebbe retroattivamente lo storico).
  const rows = await perIds(ctx, 'chat_threads', 'id,student_id,teacher_id,parent_id', 'student_id', ctx.alunni.map(a => a.id))
  return rows.filter(r => ctx.alunni.some(a => a.id === r.student_id))
}

export async function raccogliComunicazioni(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico | null> {
  if (categoria === 'comunicazioni_avvisi') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Data evento'], ['registrata', 'Pubblicazione reale'], ['titolo', 'Titolo'], ['contenuto', 'Testo'], ['tipo', 'Tipo'], ['scadenza', 'Scadenza'], ['allegato', 'Allegato']])
    const classi = await classiStoriche(ctx)
    const avvisi = await tutte(ctx, 'avvisi', 'id,scuola_id,target_scope,target_classes,created_at,giorno_competenza,titolo,contenuto,tipo,scadenza,attachment_url', q => periodoCompetenza(q.eq('scuola_id', ctx.richiesta.scuolaId), ctx, 'created_at'))
    for (const r of avvisi) for (const id of destinatari(ctx, r, dataCompetenza(r, 'created_at'), classi)) {
      const file = allegato(BUCKET_AVVISI_ALLEGATI, fileAvviso(r.attachment_url), `Avviso-${testo(r.id)}`, id)
      aggiungiAllegato(s, file)
      if (r.attachment_url && !file) s.avvisi.push('Un allegato dell’avviso è un collegamento esterno o non riconoscibile: non è incorporato.')
      s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), data: dataCompetenza(r, 'created_at'), registrata: testo(r.created_at), titolo: testo(r.titolo), contenuto: testo(r.contenuto), tipo: testo(r.tipo), scadenza: testo(r.scadenza), allegato: file ? 'Allegato' : '' })
    }
    s.avvisi.push('Sono inclusi anche gli avvisi scaduti. Il targeting per classe usa le appartenenze storiche e il nome della classe conservato oggi.')
    s.avvisi.push('Gli avvisi comuni alla scuola sono attribuiti solo nei giorni con appartenenza storica documentata dell’alunno.')
    return s
  }
  if (categoria === 'comunicazioni_risposte') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['avviso', 'Avviso'], ['letto', 'Preso visione il'], ['risposta', 'Risposta'], ['risposto', 'Risposto il'], ['genitore', 'Identificativo genitore']])
    const risposte = await perIds(ctx, 'avvisi_risposte', 'id,avviso_id,student_id,parent_id,letto_il,risposta,risposto_il,avvisi!inner(scuola_id,titolo)', 'student_id', ctx.alunni.map(a => a.id), q => q.eq('avvisi.scuola_id', ctx.richiesta.scuolaId))
    for (const r of risposte) {
      // Le due date possono cadere in periodi diversi: non esportare una risposta futura
      // insieme alla presa visione del periodo richiesto.
      const letto = ammessa(ctx, r.student_id, r.letto_il), risposto = ammessa(ctx, r.student_id, r.risposto_il)
      if (!letto && !risposto) continue
      const avviso = Array.isArray(r.avvisi) ? r.avvisi[0] as Riga : r.avvisi as Riga
      s.righe.push({ _alunno_id: testo(r.student_id), alunno: nome(ctx, r.student_id), avviso: testo(avviso?.titolo), letto: letto ? testo(r.letto_il) : '', risposta: risposto ? testo(r.risposta) : '', risposto: risposto ? testo(r.risposto_il) : '', genitore: testo(r.parent_id) })
    }
    return s
  }
  if (categoria === 'comunicazioni_chat') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['conversazione', 'Conversazione'], ['data', 'Data messaggio'], ['mittente', 'Mittente'], ['testo', 'Messaggio originale'], ['rettifica', 'Rettifica dello staff'], ['rettificato', 'Rettificato il'], ['allegato', 'Allegato']])
    const conversazioni = await threads(ctx)
    for (const t of conversazioni) {
      const id = testo(t.student_id)
      // Nessun contenuto viene nemmeno letto prima dell'esito del registro.
      const { tracciato } = await registraAccessoVigilanza(ctx.db, { operatore: ctx.utente, azione: 'lettura', threadId: testo(t.id), alunnoId: id, scuolaId: ctx.richiesta.scuolaId })
      if (!tracciato) throw new ErroreStorico(503, 'VIGILANZA_NON_TRACCIABILE', 'La lettura della conversazione non è stata registrata: contenuto non esportato.')
      const messaggi = await tutte(ctx, 'chat_messages', 'id,thread_id,sender_id,content,attachment_url,attachment_type,created_at,rettifica_staff,rettifica_staff_il', q => periodo(q.eq('thread_id', testo(t.id)), ctx, 'created_at', true))
      for (const r of messaggi) {
        if (!ammessa(ctx, id, r.created_at)) continue
        const path = normalizzaAllegatoChat(testo(r.attachment_url)), file = allegato('chat-allegati', path, `Chat-${testo(r.id)}`, id)
        aggiungiAllegato(s, file)
        if (r.attachment_url && !file) s.avvisi.push('Un allegato chat non è più riconoscibile nel bucket privato e non è incorporato.')
        s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), conversazione: testo(t.id), data: testo(r.created_at), mittente: r.sender_id === t.parent_id ? 'Genitore' : r.sender_id === t.teacher_id ? 'Docente' : 'Operatore', testo: testo(r.content), rettifica: testo(r.rettifica_staff), rettificato: testo(r.rettifica_staff_il), allegato: file ? testo(r.attachment_type) || 'Allegato' : '' })
      }
    }
    return s
  }
  if (categoria === 'comunicazioni_galleria') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Data evento'], ['registrata', 'Caricamento reale'], ['didascalia', 'Didascalia'], ['tipo', 'Tipo'], ['originale', 'Originale']])
    const media = ctx.alunni.length ? await tutte(ctx, 'galleria_media_v2', 'id,scuola_id,tag_students,caption,file_url,file_type,created_at,giorno_competenza,eliminato_il,file_rimosso_il', q => periodoCompetenza(soloVive(q.eq('scuola_id', ctx.richiesta.scuolaId).is('file_rimosso_il', null).overlaps('tag_students', ctx.alunni.map(a => a.id))), ctx, 'created_at')) : []
    for (const r of media) for (const id of lista(r.tag_students).filter(id => ammessa(ctx, id, dataCompetenza(r, 'created_at')))) {
      const file = allegato('gallery', r.file_url, `Galleria-${testo(r.id)}`, id)
      aggiungiAllegato(s, file)
      if (!file) s.avvisi.push('Un media della galleria non dispone di un originale riconoscibile e non è incorporato.')
      s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), data: dataCompetenza(r, 'created_at'), registrata: testo(r.created_at), didascalia: testo(r.caption), tipo: testo(r.file_type), originale: file ? 'Allegato' : 'Non disponibile' })
    }
    s.avvisi.push('Sono inclusi soltanto media vivi con tag esplicito dell’alunno, esclusi broadcast senza tag e file rimossi.')
    return s
  }
  if (categoria === 'comunicazioni_news') {
    const s = sezione(categoria, [['alunno', 'Alunno'], ['data', 'Data evento'], ['registrata', 'Pubblicazione reale'], ['titolo', 'Titolo'], ['contenuto', 'Contenuto'], ['stato', 'Stato corrente']])
    const classi = await classiStoriche(ctx)
    const posts = await tutte(ctx, 'news_posts', 'id,scuola_id,target_scope,target_gradi,target_classes,pubblicata_il,giorno_competenza,titolo,contenuto_testo,stato,copertina_url', q => q.in('stato', ['pubblicata', 'nascosta']).or(`and(or(scuola_id.eq.${ctx.richiesta.scuolaId},scuola_id.is.null),or(${filtroPeriodoCompetenza(ctx, 'pubblicata_il')}))`))
    const pertinenti = posts.map(r => ({ r, ids: destinatari(ctx, r, dataCompetenza(r, 'pubblicata_il'), classi, true) })).filter(x => x.ids.length)
    const media = await perIds(ctx, 'news_media', 'id,post_id,tipo,url,ordine', 'post_id', pertinenti.map(x => testo(x.r.id)))
    for (const { r, ids } of pertinenti) for (const id of ids) {
      s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), data: dataCompetenza(r, 'pubblicata_il'), registrata: testo(r.pubblicata_il), titolo: testo(r.titolo), contenuto: testo(r.contenuto_testo), stato: testo(r.stato) })
      for (const m of [...media.filter(m => m.post_id === r.id), ...(r.copertina_url ? [{ id: `${testo(r.id)}-copertina`, url: r.copertina_url, tipo: 'immagine' }] : [])]) {
        const file = allegato('news', m.url, `News-${testo(m.id)}`, id)
        aggiungiAllegato(s, file)
        if (!file) s.avvisi.push('Un media news è esterno (ad esempio YouTube/Vimeo) e non può essere incorporato come originale.')
      }
    }
    s.avvisi.push('Target ricostruito con le appartenenze storiche e i nomi/gradi delle classi conservati oggi; sono comprese le news già pubblicate e poi nascoste.')
    return s
  }
  if (categoria === 'comunicazioni_notifiche') return notifiche(ctx)
  return null
}

async function notifiche(ctx: ContestoStorico): Promise<SezioneStorico> {
  const s = sezione('comunicazioni_notifiche', [['alunno', 'Alunno'], ['data', 'Creata il'], ['tipo', 'Tipo'], ['titolo', 'Titolo'], ['corpo', 'Testo'], ['letta', 'Letta il'], ['push', 'Push inviata il']])
  // Gli id degli account da soli NON autorizzano il contenuto: un genitore può avere
  // altri figli. Si selezionano solo entità con un collegamento certo all'alunno.
  const fonti: { tipo: string; tabella?: string; campo?: string; sezione?: boolean }[] = [
    { tipo: 'diario' }, { tipo: 'alunni' },
    { tipo: 'nota', tabella: 'note_disciplinari', campo: 'alunno_id', sezione: true },
    { tipo: 'valutazione', tabella: 'valutazioni', campo: 'alunno_id', sezione: true },
    { tipo: 'armadietto_richiesta', tabella: 'armadietto_richieste', campo: 'alunno_id' },
    { tipo: 'merch_ordine', tabella: 'divise_ordini', campo: 'alunno_id' },
  ]
  const collegamenti = new Map<string, string>()
  for (const f of fonti) {
    if (!f.tabella) { for (const a of ctx.alunni) collegamenti.set(`${f.tipo}:${a.id}`, a.id); continue }
    const rows = await perIds(ctx, f.tabella, `id,${f.campo}${f.sezione ? ',section_id,sections!inner(scuola_id)' : ',scuola_id'}`, f.campo!, ctx.alunni.map(a => a.id), q => q.eq(f.sezione ? 'sections.scuola_id' : 'scuola_id', ctx.richiesta.scuolaId))
    for (const r of rows) collegamenti.set(`${f.tipo}:${testo(r.id)}`, testo(r[f.campo!]))
  }
  for (const t of await threads(ctx)) collegamenti.set(`chat_thread:${testo(t.id)}`, testo(t.student_id))
  const raccolte: Riga[] = []
  for (const tipo of new Set([...collegamenti.keys()].map(k => k.split(':')[0]))) {
    const ids = [...collegamenti.keys()].filter(k => k.startsWith(`${tipo}:`)).map(k => k.slice(tipo.length + 1))
    raccolte.push(...await perIds(ctx, 'notifiche', 'id,utente_id,tipo,titolo,corpo,entita_tipo,entita_id,letta_il,push_inviata_il,creato_il', 'entita_id', ids, q => periodo(q.eq('entita_tipo', tipo), ctx, 'creato_il', true)))
  }
  // Anche i destinatari si verificano: i thread hanno notifiche allo staff e alla famiglia.
  const utenti = await perIds(ctx, 'utenti', 'id,ruolo', 'id', raccolte.map(r => testo(r.utente_id)), q => q.eq('ruolo', 'genitore'))
  const genitori = new Set(utenti.map(r => testo(r.id)))
  for (const r of raccolte) {
    const id = collegamenti.get(`${testo(r.entita_tipo)}:${testo(r.entita_id)}`)
    if (!id || !genitori.has(testo(r.utente_id)) || !ammessa(ctx, id, r.creato_il) || !nelPeriodo(ctx, r.creato_il)) continue
    s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), data: testo(r.creato_il), tipo: testo(r.tipo), titolo: testo(r.titolo), corpo: testo(r.corpo), letta: testo(r.letta_il), push: testo(r.push_inviata_il) })
  }
  s.avvisi.push('Incluse solo notifiche attribuibili tramite entità individuali documentate. Escluse notifiche generiche, di classe o senza collegamento certo al figlio; i destinatari sono verificati sul ruolo attuale.')
  return s
}
