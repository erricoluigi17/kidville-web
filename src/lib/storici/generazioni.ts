import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { loadAppUser } from '@/lib/auth/require-staff'
import { haUnRuolo } from '@/lib/auth/predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'
import { CATALOGO_STORICI, espandiCategorie, richiestaStoricoSchema, type CategoriaStorico } from './catalogo'
import { BUCKET_STORICI, type DocumentoStorico, type GenerazioneStorico, type SezioneStorico, type ContestoStorico } from './tipi'
import { preparaContestoStorico } from './scope'
import { erroreQueryStorico, ErroreStorico, leggiTutte } from './db'
import { raccogliScolastico } from './adattatori/scolastici'
import { raccogliServizio } from './adattatori/servizi'
import { creaExcelStorico, creaPdfStorico } from './render'
import { firmaRuoliStorico, utenteStaffStorico } from './permessi'

export async function raccogliCategoria(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const sezione = await raccogliScolastico(ctx, categoria) ?? await raccogliServizio(ctx, categoria)
  if (!sezione) throw new ErroreStorico(500, 'ADATTATORE_ASSENTE', 'La categoria scelta non ha un generatore disponibile.')
  return sezione
}

export async function leggiGenerazione(db: SupabaseClient, user: AppUser, id: string): Promise<GenerazioneStorico> {
  const { data, error } = await db.from('storici_generazioni').select('*').eq('id', id).eq('richiesto_da', user.id).maybeSingle()
  if (error) erroreQueryStorico('generazione', error)
  if (!data) throw new ErroreStorico(404, 'GENERAZIONE_NON_TROVATA', 'Generazione non trovata.')
  const job = data as GenerazioneStorico
  if (new Date(job.scade_il).getTime() <= Date.now()) throw new ErroreStorico(410, 'GENERAZIONE_SCADUTA', 'Il file è scaduto. Genera nuovamente la stampa.')
  if (job.ruolo_richiedente !== firmaRuoliStorico(user)) throw new ErroreStorico(403, 'PERMESSI_MODIFICATI', 'I permessi sono cambiati. Genera nuovamente la stampa.')
  const ctx = await preparaContestoStorico(db, user, richiestaStoricoSchema.parse(job.richiesta))
  if (ctx.alunni.map(a => a.id).sort().join(',') !== [...job.alunni_ids].sort().join(',')) throw new ErroreStorico(403, 'PERIMETRO_MODIFICATO', 'Il perimetro degli alunni è cambiato. Genera nuovamente la stampa.')
  return job
}

function basePath(job: GenerazioneStorico): string { return `${job.scuola_id}/${job.id}` }
const DURATA_LEASE_MS = 330_000 // superiore al maxDuration HTTP di 300 secondi
async function salvaParte(db: SupabaseClient, path: string, contenuto: unknown): Promise<void> {
  const { error } = await db.storage.from(BUCKET_STORICI).upload(path, Buffer.from(JSON.stringify(contenuto)), { contentType: 'application/json', upsert: true })
  if (error) erroreQueryStorico('salva-parte', error)
}
async function leggiParte(db: SupabaseClient, path: string): Promise<SezioneStorico> {
  const { data, error } = await db.storage.from(BUCKET_STORICI).download(path)
  if (error || !data) erroreQueryStorico('leggi-parte', error ?? new Error('Parte assente'))
  return JSON.parse(await data.text()) as SezioneStorico
}

export function raggruppaPerAlunno(sezioni: SezioneStorico[], ctx: ContestoStorico): SezioneStorico[] {
  if (ctx.richiesta.raggruppamento !== 'alunno' || ctx.richiesta.alunnoId) return sezioni
  return ctx.alunni.flatMap(a => sezioni.map(s => ({
    ...s, titolo: `${a.cognome} ${a.nome} — ${s.titolo}`,
    righe: s.righe.filter(r => !r._alunno_id || r._alunno_id === a.id),
    allegati: s.allegati.filter(f => !f.alunnoId || f.alunnoId === a.id),
    generati: s.generati?.filter(f => !f.alunnoId || f.alunnoId === a.id),
  })))
}

/** Lease a confronto atomico: polling e cron non eseguono lo stesso lavoro. */
export async function eseguiGenerazione(db: SupabaseClient, id: string, tempoMassimoMs = 180_000): Promise<void> {
  const inizio = Date.now()
  const { data, error } = await db.from('storici_generazioni').select('*').eq('id', id).in('stato', ['in_coda', 'in_corso']).maybeSingle()
  if (error) erroreQueryStorico('lavoro', error)
  if (!data) return
  const job = data as GenerazioneStorico
  if (new Date(job.scade_il).getTime() <= inizio) return
  const lease = new Date().toISOString()
  const scaduto = new Date(inizio - DURATA_LEASE_MS).toISOString()
  const { data: preso, error: errPresa } = await db.from('storici_generazioni').update({ stato: 'in_corso', preso_il: lease, tentativi: job.tentativi + 1 }).eq('id', id).eq('cursore', job.cursore).in('stato', ['in_coda', 'in_corso']).gt('scade_il', lease).or(`preso_il.is.null,preso_il.lt.${scaduto}`).select('id').maybeSingle()
  if (errPresa) erroreQueryStorico('presa', errPresa)
  if (!preso) return
  let cursore = job.cursore
  let fallimenti = job.tentativi
  const aggiorna = async (patch: Record<string, unknown>) => {
    const { data: aggiornato, error: err } = await db.from('storici_generazioni').update(patch).eq('id', id).eq('preso_il', lease).gt('scade_il', new Date().toISOString()).select('id').maybeSingle()
    if (err) erroreQueryStorico('avanzamento', err)
    if (!aggiornato) throw new ErroreStorico(410, 'GENERAZIONE_INTERROTTA', 'La generazione è scaduta o non appartiene più a questo processo.')
  }
  const verificaLease = async () => {
    const { data: corrente, error: err } = await db.from('storici_generazioni').select('id').eq('id', id).eq('preso_il', lease).gt('scade_il', new Date().toISOString()).maybeSingle()
    if (err) erroreQueryStorico('verifica-lavoro', err)
    if (!corrente) throw new ErroreStorico(410, 'GENERAZIONE_INTERROTTA', 'La generazione è scaduta o è stata revocata.')
  }
  try {
    if (fallimenti >= 3) throw new ErroreStorico(500, 'TENTATIVI_ESAURITI', 'Generazione interrotta dopo tre tentativi. Avvia una nuova stampa.')
    const user = job.richiesto_da ? await loadAppUser(job.richiesto_da) : null
    if (!user) throw new ErroreStorico(403, 'OPERATORE_NON_DISPONIBILE', 'L’operatore non è più autorizzato.')
    if (job.ruolo_richiedente !== firmaRuoliStorico(user)) throw new ErroreStorico(403, 'PERMESSI_MODIFICATI', 'I permessi sono cambiati. Genera nuovamente la stampa.')
    const richiesta = richiestaStoricoSchema.parse(job.richiesta)
    const ctx = await preparaContestoStorico(db, user, richiesta)
    if (ctx.alunni.map(a => a.id).sort().join(',') !== [...job.alunni_ids].sort().join(',')) throw new ErroreStorico(403, 'PERIMETRO_MODIFICATO', 'Il perimetro degli alunni è cambiato. Genera nuovamente la stampa.')
    const categorie = espandiCategorie(richiesta.categorie)
    while (cursore < categorie.length && Date.now() - inizio < tempoMassimoMs) {
      const sezione = await raccogliCategoria(ctx, categorie[cursore])
      await verificaLease()
      await salvaParte(db, `${basePath(job)}/parti/${cursore}.json`, sezione)
      cursore++
      await aggiorna({ cursore, tentativi: 0, titolo: ctx.titolo })
      fallimenti = 0
    }
    if (cursore < categorie.length) { await aggiorna({ stato: 'in_coda', preso_il: null }); return }
    const sezioni: SezioneStorico[] = []
    for (let i = 0; i < categorie.length; i++) sezioni.push(await leggiParte(db, `${basePath(job)}/parti/${i}.json`))
    const documento: DocumentoStorico = { titolo: ctx.titolo, scuolaNome: ctx.scuolaNome, dal: richiesta.dal, al: richiesta.al, generatoIl: new Date().toISOString(), avvisi: ctx.avvisi, sezioni: raggruppaPerAlunno(sezioni, ctx) }
    let avvisi = [...ctx.avvisi, ...sezioni.flatMap(s => s.avvisi)]
    let bytes: Uint8Array
    if (richiesta.formato === 'pdf') { const pdf = await creaPdfStorico(documento, db); bytes = pdf.bytes; avvisi = pdf.avvisi }
    else bytes = creaExcelStorico(documento)
    const filePath = `${basePath(job)}/storico.${richiesta.formato}`
    await verificaLease()
    const { error: errFile } = await db.storage.from(BUCKET_STORICI).upload(filePath, bytes, { contentType: richiesta.formato === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upsert: true })
    if (errFile) erroreQueryStorico('salva-file', errFile)
    avvisi = [...new Set(avvisi)]
    await aggiorna({ stato: avvisi.length ? 'parziale' : 'completato', file_path: filePath, avvisi, preso_il: null, tentativi: 0, errore: null })
    logEvento('registro', 'info', { operazione: 'storici/genera', esito: avvisi.length ? 'parziale' : 'completato', entita_id: id, n: sezioni.length, byte: bytes.byteLength })
  } catch (err) {
    logEvento('registro', 'error', { operazione: 'storici/genera', esito: 'generazione-fallita', entita_id: id }, err)
    if (err instanceof ErroreStorico && err.stato === 410) {
      // Rilascia anche un lavoro invalidato dall'oblio. Il cleanup rimuove sia
      // il percorso finale noto sia le parti, anche se l'upload precedeva il CAS.
      const { error: errRilascio } = await db.from('storici_generazioni').update({ preso_il: null }).eq('id', id).eq('preso_il', lease)
      if (errRilascio) erroreQueryStorico('rilascia-scaduto', errRilascio)
      return
    }
    await aggiorna({ stato: fallimenti + 1 >= 3 ? 'errore' : 'in_coda', tentativi: fallimenti + 1, preso_il: null, errore: err instanceof ErroreStorico ? err.message : 'Generazione non riuscita. Riprovare dalla scheda degli storici.' })
  }
}

export async function riprendiGenerazioni(db: SupabaseClient): Promise<number> {
  const scaduto = new Date(Date.now() - DURATA_LEASE_MS).toISOString()
  const { data, error } = await db.from('storici_generazioni').select('id').in('stato', ['in_coda', 'in_corso']).or(`preso_il.is.null,preso_il.lt.${scaduto}`).gt('scade_il', new Date().toISOString()).order('creato_il').limit(3)
  if (error) erroreQueryStorico('coda', error)
  for (const r of data ?? []) await eseguiGenerazione(db, r.id, 50_000)
  return data?.length ?? 0
}

export async function pulisciGenerazioniScadute(db: SupabaseClient): Promise<number> {
  const ora = new Date().toISOString(), scaduto = new Date(Date.now() - DURATA_LEASE_MS).toISOString()
  const { data, error } = await db.from('storici_generazioni').select('*').lte('scade_il', ora).or(`preso_il.is.null,preso_il.lt.${scaduto}`).order('scade_il').limit(30)
  if (error) erroreQueryStorico('scaduti', error)
  let n = 0
  for (const r of (data ?? []) as GenerazioneStorico[]) {
    const leasePulizia = new Date().toISOString()
    const { data: preso, error: errPresa } = await db.from('storici_generazioni').update({ preso_il: leasePulizia }).eq('id', r.id).lte('scade_il', ora).or(`preso_il.is.null,preso_il.lt.${scaduto}`).select('id').maybeSingle()
    if (errPresa) erroreQueryStorico('presa-pulizia', errPresa)
    if (!preso) continue
    const categorie = espandiCategorie(r.richiesta.categorie)
    const paths = categorie.map((_, i) => `${basePath(r)}/parti/${i}.json`)
    paths.push(`${basePath(r)}/storico.${r.richiesta.formato}`)
    const { error: errStorage } = await db.storage.from(BUCKET_STORICI).remove(paths)
    if (errStorage) { logEvento('registro', 'error', { operazione: 'storici/pulisci', esito: 'file-non-rimossi', entita_id: r.id }, errStorage); continue }
    const { error: errRiga } = await db.from('storici_generazioni').delete().eq('id', r.id).eq('preso_il', leasePulizia)
    if (errRiga) erroreQueryStorico('elimina-scaduto', errRiga)
    n++
  }
  return n
}

export async function opzioniStorici(db: SupabaseClient, user: AppUser, scuolaId: string) {
  const ctxSedi = await import('@/lib/auth/scope')
  const sedi = await ctxSedi.scuoleDiUtente(db, utenteStaffStorico(user))
  if (!sedi.some(s => s.toLowerCase() === scuolaId.toLowerCase())) throw new ErroreStorico(403, 'SEDE_NON_AUTORIZZATA', 'Sede non accessibile.')
  const alunni = await leggiTutte<{ id: string; nome: string; cognome: string; section_id: string | null; archiviato_il: string | null }>((dal, al) => db.from('alunni').select('id,nome,cognome,section_id,archiviato_il').eq('scuola_id', scuolaId).is('anonimizzato_il', null).order('cognome').order('id').range(dal, al), 'opzioni-alunni')
  const storico = await leggiTutte<{ alunno_id: string; section_id: string; section_nome: string }>((dal, al) => db.from('alunni_classi_storico').select('alunno_id,section_id,section_nome').eq('scuola_id', scuolaId).order('id').range(dal, al), 'opzioni-storiche')
  const gia = new Set(alunni.map(a => a.id))
  const ex = [...new Set(storico.map(a => a.alunno_id))].filter(id => !gia.has(id))
  for (let i = 0; i < ex.length; i += 100) alunni.push(...await leggiTutte<typeof alunni[number]>((dal, al) => db.from('alunni').select('id,nome,cognome,section_id,archiviato_il').in('id', ex.slice(i, i + 100)).is('anonimizzato_il', null).order('cognome').order('id').range(dal, al), 'opzioni-ex-alunni'))
  const classiStoriche = [...new Map(storico.map(r => [r.section_id, { id: r.section_id, name: r.section_nome || 'Classe archiviata' }])).values()]
  return { categorie: CATALOGO_STORICI.map(c => ({ ...c, disponibile: c.id !== 'documenti_protocolli' || haUnRuolo(user, ['admin', 'segreteria']) })), alunni, classiStoriche }
}
