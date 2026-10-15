import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { fascicoloVivo } from '@/lib/primaria/cestino-fascicolo'
import { SIGNED_FORMS_BUCKET } from '@/lib/forms/signed-path'
import { readSignedDocumentSnapshot, type SignedDocumentSnapshotV1 } from '@/lib/forms/signed-document'
import type { CategoriaStorico } from '../catalogo'
import { ErroreStorico } from '../db'
import type { ContestoStorico, SezioneStorico } from '../tipi'
import { contenutoIscrizione } from '../iscrizioni-collegate'
import { aggiungiAllegato, allegato, ammesso, cella, elenco, giorno, idsAlunni, nome, nomePersona, nuovaSezione, oggetto, perIds, sezioni, stringhe, testo, type Riga } from './scolastici-comune'

async function famiglia(ctx: ContestoStorico): Promise<{ legami: Riga[]; genitori: Riga[] }> {
  const legami = await perIds(ctx, 'student_parents', 'student_id', ctx.alunni.filter(a => a.scuola_id === ctx.richiesta.scuolaId).map(a => a.id), q => q.order('parent_id'), '*', 'student_id')
  const genitori = await perIds(ctx, 'parents', 'id', legami.map(l => testo(l.parent_id)), q => q.is('anonimizzato_il', null))
  return { legami, genitori }
}

async function accessoSensibile(ctx: ContestoStorico): Promise<void> {
  for (const a of ctx.alunni.filter(a => a.scuola_id === ctx.richiesta.scuolaId)) {
    const accesso = await puoAccedereFascicolo(ctx.db, ctx.utente.id, a.id)
    if (!accesso.consentito) throw new ErroreStorico(403, 'FASCICOLO_NON_AUTORIZZATO', 'Non è consentito esportare il fascicolo di tutti gli alunni selezionati.')
    await logAccessoFascicolo(ctx.db, { alunnoId: a.id, utenteId: ctx.utente.id, azione: 'download',
      finalita: 'Esportazione storica del dossier scolastico richiesta da segreteria o direzione.' })
  }
}

export async function anagrafica(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  if (categoria === 'anagrafica_classe') {
    const s = nuovaSezione(categoria, { alunno: 'Alunno', classe: 'Classe', dal: 'Appartenenza dal', al: 'Appartenenza fino al (escluso)', archiviatoIl: 'Archiviato il' })
    const classi = await sezioni(ctx)
    for (const p of ctx.appartenenze.filter(p => !ctx.richiesta.sectionId || p.section_id === ctx.richiesta.sectionId)
      .sort((a, b) => a.dal.localeCompare(b.dal) || a.alunno_id.localeCompare(b.alunno_id))) {
      const a = ctx.alunni.find(a => a.id === p.alunno_id)
      if (!a) continue
      s.righe.push({ _alunno_id: a.id, alunno: nome(ctx, a.id), classe: testo(classi.find(c => c.id === p.section_id)?.name), dal: p.dal, al: p.al, archiviatoIl: a.archiviato_il ?? null })
    }
    if (!ctx.appartenenze.length) s.avvisi.push('Non sono presenti appartenenze documentate nel periodo selezionato; l’elenco non è ricostruito dalla classe attuale.')
    return s
  }
  const s = nuovaSezione(categoria, { alunno: 'Alunno', tipo: 'Scheda', nominativo: 'Nominativo', parentela: 'Relazione', nascita: 'Data di nascita',
    luogoNascita: 'Luogo di nascita', codiceFiscale: 'Codice fiscale', indirizzo: 'Indirizzo', comune: 'Comune', cap: 'CAP', cittadinanza: 'Cittadinanza', telefoni: 'Telefoni', email: 'Email' })
  const alunni = await perIds(ctx, 'alunni', 'id', idsAlunni(ctx), q => q.eq('scuola_id', ctx.richiesta.scuolaId).is('anonimizzato_il', null))
  const f = await famiglia(ctx)
  const delegati = await perIds(ctx, 'delegates', 'student_id', alunni.map(a => testo(a.id)))
  for (const a of alunni) {
    const id = testo(a.id)
    await logAccessoFascicolo(ctx.db, { alunnoId: id, utenteId: ctx.utente.id, azione: 'view', finalita: 'Esportazione della scheda anagrafica nel dossier storico.' })
    s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), tipo: 'Alunno', nominativo: nome(ctx, id), parentela: '', nascita: giorno(a.data_nascita),
      luogoNascita: testo(a.birth_city), codiceFiscale: testo(a.codice_fiscale) || testo(a.fiscal_code), indirizzo: testo(a.residence_address),
      comune: testo(a.residence_city), cap: testo(a.zip_code), cittadinanza: testo(a.citizenship), telefoni: '', email: '' })
    for (const l of f.legami.filter(l => l.student_id === id)) {
      const p = f.genitori.find(p => p.id === l.parent_id)
      if (!p) continue
      s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), tipo: 'Genitore / tutore', nominativo: nomePersona(p), parentela: testo(l.relation_type),
        nascita: giorno(p.birth_date), luogoNascita: testo(p.birth_city), codiceFiscale: testo(p.fiscal_code), indirizzo: testo(p.residence_address),
        comune: testo(p.residence_city), cap: testo(p.zip_code), cittadinanza: testo(p.citizenship), telefoni: stringhe(p.phone_numbers), email: stringhe(p.emails) })
    }
    for (const d of delegati.filter(d => d.student_id === id)) s.righe.push({ _alunno_id: id, alunno: nome(ctx, id), tipo: 'Delegato al ritiro', nominativo: nomePersona(d), parentela: testo(d.relation) })
  }
  s.avvisi.push('La scheda riporta i dati anagrafici, i legami familiari e le deleghe attualmente registrati. Le variazioni precedenti non sono versionate in queste tabelle.')
  if (ctx.alunni.some(a => a.scuola_id !== ctx.richiesta.scuolaId)) s.avvisi.push('Gli alunni trasferiti in un’altra sede restano nell’elenco storico, ma la loro scheda e i legami familiari correnti della nuova sede non vengono esportati.')
  return s
}

export async function consensi(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Accettato il', alunno: 'Alunno', genitore: 'Genitore / tutore', tipo: 'Consenso', versione: 'Versione accettata', accettato: 'Accettato', testo: 'Testo conservato', link: 'Riferimento conservato', fonte: 'Fonte della prova' })
  const f = await famiglia(ctx)
  const righe = await perIds(ctx, 'consensi_accettazioni', 'parent_id', f.genitori.map(p => testo(p.id)))
  for (const r of righe.sort((a, b) => testo(a.accettato_il).localeCompare(testo(b.accettato_il)) || testo(a.id).localeCompare(testo(b.id)))) {
    for (const l of f.legami.filter(l => l.parent_id === r.parent_id)) {
      const id = testo(l.student_id), data = giorno(r.accettato_il)
      if (!ammesso(ctx, id, data)) continue
      s.righe.push({ _alunno_id: id, data: testo(r.accettato_il), alunno: nome(ctx, id), genitore: nomePersona(f.genitori.find(p => p.id === r.parent_id) ?? {}), tipo: testo(r.tipo), versione: testo(r.versione), accettato: true, testo: '', link: '', fonte: 'Accettazione personale del genitore' })
    }
  }
  s.avvisi.push('Le accettazioni sono personali del genitore e sono associate agli alunni attraverso i legami familiari attualmente registrati; non attestano un distinto consenso sanitario o fotografico per ciascun figlio.')
  if (ctx.alunni.some(a => a.scuola_id !== ctx.richiesta.scuolaId)) s.avvisi.push('Per gli alunni attualmente in un’altra sede non vengono usati i legami familiari correnti per ricostruire i consensi storici.')
  for (const tipo of ['iscrizione', 'modulo'] as const) {
    const links = await collegamenti(ctx, tipo)
    const fonte = tipo === 'iscrizione' ? 'enrollment_submissions' : 'form_submissions'
    const documenti = await perIds(ctx, fonte, 'id', links.map(l => testo(l.entita_id)), q => q.eq('scuola_id', ctx.richiesta.scuolaId))
    for (const d of documenti) for (const l of links.filter(l => l.entita_id === d.id)) {
      const prova = oggetto(d.consents_log)
      const blocchi = blocchiConsensi(d.consents_log)
      for (const b of blocchi) {
        const istante = testo(b.accepted_at) || testo(prova.accettato_il)
        const id = testo(l.alunno_id)
        if (!ammesso(ctx, id, giorno(istante) || giorno(d.created_at), undefined, testo(d.scuola_id))) continue
        s.righe.push({ _alunno_id: id, data: istante, alunno: nome(ctx, id), genitore: '', tipo: testo(b.label) || testo(b.field_id),
          versione: testo(prova.versione_informativa), accettato: cella(b.accepted), testo: testo(b.text), link: testo(b.link),
          fonte: tipo === 'iscrizione' ? 'Prova congelata della domanda collegata' : 'Prova congelata del modulo collegato' })
      }
      if (!blocchi.length) s.avvisi.push('Per alcuni documenti collegati manca una prova di consenso conservata: non viene dedotto un assenso dal valore attuale dell’anagrafica.')
    }
    if (documenti.length < new Set(links.map(l => l.entita_id)).size) s.avvisi.push('Alcuni documenti collegati non sono presenti nella sede richiesta; le relative prove di consenso sono escluse.')
  }
  const diretti = await perIds(ctx, 'forms_submissions', 'student_id', idsAlunni(ctx))
  const templates = await perIds(ctx, 'forms_templates', 'scuola_id', [ctx.richiesta.scuolaId])
  for (const r of diretti) {
    const id = testo(r.student_id), firma = oggetto(r.signature_log), fotografia = readSignedDocumentSnapshot(firma)
    if (fotografia && fotografia.school_id !== ctx.richiesta.scuolaId) continue
    const snapshot = snapshotModulo(ctx, r, id, testo(r.form_id))
    const modello = snapshot?.form ?? templates.find(t => t.id === r.form_id)
    if (!modello || !ammesso(ctx, id, giorno(snapshot?.signed_at || r.created_at), undefined, snapshot?.school_id)) continue
    const prova = oggetto(r.consents_log), dati = oggetto(snapshot?.answers ?? r.answers)
    const blocchi: Riga[] = snapshot ? campiModello(snapshot.form).filter(c => c.type === 'consent').map(c => ({ field_id: c.id, label: c.label, text: c.text, link: c.link, accepted: dati[testo(c.id)], accepted_at: snapshot.signed_at })) : blocchiConsensi(r.consents_log)
    for (const b of blocchi) s.righe.push({ _alunno_id: id, data: testo(b.accepted_at) || testo(prova.accettato_il) || testo(r.created_at), alunno: nome(ctx, id), genitore: '', tipo: testo(b.label) || testo(b.field_id), versione: testo(prova.versione_informativa), accettato: cella(b.accepted), testo: testo(b.text), link: testo(b.link), fonte: snapshot ? 'Consenso nel documento congelato alla firma' : 'Prova congelata del modulo con alunno diretto' })
    if (!blocchi.length && r.is_signed) s.avvisi.push('Un modulo firmato con alunno diretto non conserva una prova distinta di consenso: non viene dedotto un assenso dalla sola firma.')
    avvisaSnapshotModulo(s, snapshot)
  }
  s.avvisi.push('Le prove delle domande e dei moduli sono incluse soltanto tramite il collegamento esplicito all’alunno. I consensi comuni alla domanda sono riportati come prova della domanda, senza attribuire risposte o dati di eventuali fratelli.')
  return s
}

async function collegamenti(ctx: ContestoStorico, tipo: 'iscrizione' | 'modulo'): Promise<Riga[]> {
  return perIds(ctx, 'storici_collegamenti', 'alunno_id', idsAlunni(ctx), q => q.eq('scuola_id', ctx.richiesta.scuolaId).eq('tipo', tipo))
}
export async function iscrizioni(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Presentata il', alunno: 'Alunno', stato: 'Stato domanda', importataIl: 'Importata il', soggetto: 'Soggetto della domanda', campo: 'Campo compilato', valore: 'Contenuto salvato', note: 'Annotazioni della domanda', originale: 'Originale archiviato', completezza: 'Completezza della stampa' })
  const links = await collegamenti(ctx, 'iscrizione')
  const righe = await perIds(ctx, 'enrollment_submissions', 'id', links.map(l => testo(l.entita_id)), q => q.eq('scuola_id', ctx.richiesta.scuolaId))
  for (const r of righe) for (const l of links.filter(l => l.entita_id === r.id)) {
    const id = testo(l.alunno_id), data = giorno(r.created_at), d = oggetto(r.data)
    if (!ammesso(ctx, id, data, undefined, testo(r.scuola_id))) continue
    const adulti = Array.isArray(l.adulti_indici) ? l.adulti_indici.filter((i): i is number => typeof i === 'number') : []
    const scelta = contenutoIscrizione(d, typeof l.indice_figlio === 'number' ? l.indice_figlio : null, adulti)
    const verificata = scelta && scelta.impronta === l.contenuto_impronta
    const tuttiFigli = elenco(d.children).every((_, indice) => links.some(v => {
      if (v.entita_id !== r.id || v.indice_figlio !== indice || !ammesso(ctx, testo(v.alunno_id), data, undefined, testo(r.scuola_id))) return false
      const adultiLink = Array.isArray(v.adulti_indici) ? v.adulti_indici.filter((i): i is number => typeof i === 'number') : []
      return contenutoIscrizione(d, indice, adultiLink)?.impronta === v.contenuto_impronta
    }))
    const tuttiAdulti = elenco(d.adults).every((_, indice) => adulti.includes(indice))
    const originale = verificata && tuttiFigli && tuttiAdulti ? allegato('form_attachments', r.pdf_path || d.pdf_path, `Domanda di iscrizione ${nome(ctx, id)}.pdf`, id, 'application/pdf') : null
    aggiungiAllegato(s, originale)
    const base = { _alunno_id: id, data: testo(r.created_at), alunno: nome(ctx, id), stato: testo(r.status), importataIl: testo(r.imported_at), note: '', originale: Boolean(originale), completezza: verificata ? 'Contenuto dei soggetti attribuiti dallo staff' : 'Estratto amministrativo parziale' }
    s.righe.push(base)
    if (!originale) s.avvisi.push('Stampa iscrizioni parziale: la domanda non conserva un PDF originale pertinente a tutti i soggetti selezionati. Il contenuto salvato è riportato come trascrizione; non viene ricostruita una firma o una versione mai archiviata.')
    if (verificata && scelta) {
      righePersonaIscrizione(s, base, scelta.figlio, 'Alunno')
      for (const adulto of scelta.adulti) righePersonaIscrizione(s, base, adulto, testo(adulto.ruolo) || 'Adulto attribuito dallo staff')
    } else if (scelta) s.avvisi.push('La domanda è cambiata dopo l’attribuzione documentale: verifica e salva nuovamente il collegamento. I contenuti delle persone sono esclusi per evitare attribuzioni errate.')
    else if (elenco(d.children).length) s.avvisi.push('Il collegamento alla domanda non identifica l’indice del figlio nei dati children: completa l’attribuzione del figlio e degli adulti nel centro stampe prima di esportarne dati e documenti.')
  }
  const mancanti = ctx.alunni.filter(a => !links.some(l => l.alunno_id === a.id)).length
  if (mancanti) s.avvisi.push(`Per ${mancanti} alunni manca un collegamento verificato tra domanda di iscrizione e anagrafica. Le domande non sono associate per nome o codice fiscale.`)
  if (righe.length < new Set(links.map(l => l.entita_id)).size) s.avvisi.push('Alcuni collegamenti puntano a domande non presenti nella sede richiesta; tali contenuti sono esclusi.')
  s.avvisi.push('I dati delle persone sono trascritti dalla domanda salvata soltanto dopo attribuzione esplicita dello staff. I dati di eventuali fratelli non selezionati sono esclusi.')
  return s
}

function righePersonaIscrizione(s: SezioneStorico, base: Record<string, string | boolean>, persona: Riga, soggetto: string, prefisso = ''): void {
  const etichette: Record<string, string> = { nome: 'Nome', cognome: 'Cognome', codice_fiscale: 'Codice fiscale', fiscal_code: 'Codice fiscale', data_nascita: 'Data di nascita', birth_date: 'Data di nascita', documento_path: 'Documento di identità', allergies: 'Allergie', note_mediche: 'Note mediche', first_name: 'Nome', last_name: 'Cognome', phone: 'Telefono', email: 'Email', residence_address: 'Indirizzo', residence_city: 'Comune di residenza' }
  for (const [chiave, valore] of Object.entries(persona)) {
    if (valore == null || valore === '' || /password|token|otp|signature|firma/i.test(chiave)) continue
    const campo = `${prefisso}${etichette[chiave] ?? chiave.replaceAll('_', ' ')}`
    if (chiave === 'documento_path') {
      const file = allegato('form_attachments', valore, `Documento ${soggetto} ${testo(base.alunno)}`, testo(base._alunno_id))
      aggiungiAllegato(s, file)
      s.righe.push({ ...base, soggetto, campo, valore: file ? 'Allegato incluso' : 'Originale non disponibile' })
      if (!file) s.avvisi.push('Un documento di identità della domanda non conserva un percorso privato valido e non è incorporato.')
    } else if (typeof valore === 'object' && !Array.isArray(valore)) righePersonaIscrizione(s, base, oggetto(valore), soggetto, `${campo} / `)
    else {
      const leggibile = Array.isArray(valore) ? valore.map(cella).filter(v => v !== null).join(', ') : cella(valore)
      if (leggibile !== null && leggibile !== '') s.righe.push({ ...base, soggetto, campo, valore: leggibile })
    }
  }
}

function campiModello(modello: Riga): Riga[] {
  const schema = oggetto(modello.schema)
  return [...elenco(modello.fields), ...elenco(schema.fields), ...elenco(schema.pages).flatMap(p => elenco(p.fields))]
}
function blocchiConsensi(prova: unknown): Riga[] {
  if (Array.isArray(prova)) return elenco(prova)
  return elenco(oggetto(prova).blocchi)
}

function snapshotModulo(ctx: ContestoStorico, r: Riga, alunnoId: string, modelloId: string): SignedDocumentSnapshotV1 | null {
  const firma = oggetto(r.signature_log)
  const snapshot = readSignedDocumentSnapshot(firma)
  if ('document_snapshot' in firma && (!snapshot || snapshot.school_id !== ctx.richiesta.scuolaId
    || snapshot.form.id !== modelloId || snapshot.student?.id !== alunnoId)) {
    throw new ErroreStorico(503, 'SNAPSHOT_MODULO_NON_VALIDO', 'La fotografia archiviata di un modulo non è valida o non appartiene all’alunno e alla sede richiesti.')
  }
  return snapshot
}

/** Solo campi dichiarati dal modello e valori semplici: nessun dump di risposte o firma. */
function risposte(s: SezioneStorico, base: Record<string, string | boolean>, modello: Riga, valori: unknown, consensiCongelati: Riga[] = []): void {
  const dati = oggetto(valori)
  let n = 0
  for (const campo of campiModello(modello)) {
    const campoId = testo(campo.id) || testo(campo.name)
    if (['signature', 'firma', 'password', 'otp'].includes(testo(campo.type)) || consensiCongelati.some(c => c.field_id === campoId)) continue
    const valore = dati[campoId]
    if (campo.type === 'file') {
      if (valore == null || valore === '') continue
      const a = allegato(SIGNED_FORMS_BUCKET, valore, '', testo(base._alunno_id))
      aggiungiAllegato(s, a)
      s.righe.push({ ...base, campo: testo(campo.label) || testo(campo.title), valore: a ? 'Allegato incluso' : 'Allegato non disponibile' }); n++
      if (!a) s.avvisi.push('Un campo file del modulo non conserva un riferimento valido all’allegato privato; il documento allegato non può essere incluso.')
      continue
    }
    const opzioni = elenco(campo.options)
    const leggibileSingolo = (v: unknown) => typeof v === 'string' ? testo(opzioni.find(o => o.value === v)?.label) || v : cella(v)
    const leggibile = Array.isArray(valore) ? valore.map(leggibileSingolo).filter(v => v !== null).join(', ') : leggibileSingolo(valore)
    if (leggibile === null || leggibile === '') continue
    s.righe.push({ ...base, campo: testo(campo.label) || testo(campo.title), valore: leggibile, testoConsenso: campo.type === 'consent' ? testo(campo.text) : '' }); n++
  }
  for (const c of consensiCongelati) {
    s.righe.push({ ...base, campo: testo(c.label) || testo(c.field_id), valore: cella(c.accepted), testoConsenso: testo(c.text), origine: 'Prova consenso congelata nel documento' }); n++
  }
  if (!n) s.righe.push({ ...base, campo: '', valore: '' })
}
export async function moduli(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Compilato il', alunno: 'Alunno', titolo: 'Modulo', stato: 'Stato', firmatoIl: 'Firmato il', campo: 'Campo', valore: 'Risposta', testoConsenso: 'Testo consenso conservato', origine: 'Fonte dei contenuti', originale: 'Originale del modulo archiviato' })
  const templates = await perIds(ctx, 'forms_templates', 'scuola_id', [ctx.richiesta.scuolaId])
  const diretti = await perIds(ctx, 'forms_submissions', 'student_id', idsAlunni(ctx))
  for (const r of diretti) {
    const id = testo(r.student_id), data = giorno(r.created_at)
    const fotografia = readSignedDocumentSnapshot(r.signature_log)
    // Una prova valida di un'altra sede è fuori scope, non è una prova corrotta della sede scelta.
    if (fotografia && fotografia.school_id !== ctx.richiesta.scuolaId) continue
    const snapshot = snapshotModulo(ctx, r, id, testo(r.form_id))
    const t = snapshot ? snapshot.form : templates.find(t => t.id === r.form_id)
    // Il modello corrente non è una prova della sede storica di una compilazione senza snapshot.
    if (!t || !ammesso(ctx, id, data, undefined, snapshot?.school_id)) continue
    const originale = allegato(SIGNED_FORMS_BUCKET, r.pdf_path, `${testo(t.title) || 'Modulo'} ${nome(ctx, id)}.pdf`, id)
    aggiungiAllegato(s, originale)
    const firma = oggetto(r.signature_log)
    risposte(s, { _alunno_id: id, data: testo(r.created_at), alunno: nome(ctx, id), titolo: testo(t.title), stato: r.is_signed === true ? 'Firmato' : 'Non firmato',
      firmatoIl: snapshot?.signed_at || testo(firma.signed_at) || testo(firma.timestamp), originale: Boolean(originale),
      origine: snapshot ? (snapshot.source === 'contemporaneous' ? 'Snapshot archiviato alla firma' : 'Snapshot ricostruito') : 'Modello attuale, snapshot assente' }, t, snapshot?.answers ?? r.answers,
    snapshot ? [] : blocchiConsensi(r.consents_log))
    avvisaSnapshotModulo(s, snapshot)
  }
  const links = await collegamenti(ctx, 'modulo')
  const moduli = await perIds(ctx, 'form_submissions', 'id', links.map(l => testo(l.entita_id)), q => q.eq('scuola_id', ctx.richiesta.scuolaId))
  const modelli = await perIds(ctx, 'form_models', 'id', moduli.map(m => testo(m.model_id)), q => q.or(`scuola_id.is.null,scuola_id.eq.${ctx.richiesta.scuolaId}`))
  for (const r of moduli) for (const l of links.filter(l => l.entita_id === r.id)) {
    const id = testo(l.alunno_id), data = giorno(r.created_at), snapshot = snapshotModulo(ctx, r, id, testo(r.model_id))
    const modello = snapshot ? snapshot.form : modelli.find(m => m.id === r.model_id)
    if (!ammesso(ctx, id, data, undefined, testo(r.scuola_id)) || !modello) continue
    const originale = allegato(SIGNED_FORMS_BUCKET, r.pdf_path, `${testo(modello.title) || 'Modulo'} ${nome(ctx, id)}.pdf`, id)
    aggiungiAllegato(s, originale)
    risposte(s, { _alunno_id: id, data: testo(r.created_at), alunno: nome(ctx, id), titolo: testo(modello.title), stato: testo(r.status),
      firmatoIl: snapshot?.signed_at || testo(r.signed_at), originale: Boolean(originale),
      origine: snapshot ? (snapshot.source === 'contemporaneous' ? 'Snapshot archiviato alla firma' : 'Snapshot ricostruito') : 'Modello attuale, snapshot assente' }, modello, snapshot?.answers ?? r.data,
    snapshot ? [] : blocchiConsensi(r.consents_log))
    avvisaSnapshotModulo(s, snapshot)
  }
  if (ctx.alunni.some(a => !links.some(l => l.alunno_id === a.id))) s.avvisi.push('I moduli del precedente archivio form_submissions privi di collegamento verificato all’alunno non possono essere inclusi. Le autorizzazioni forms_submissions con student_id diretto sono invece incluse.')
  if (moduli.length < new Set(links.map(l => l.entita_id)).size || moduli.some(m => !modelli.some(t => t.id === m.model_id))) s.avvisi.push('Alcuni moduli collegati o i rispettivi modelli non sono presenti nella sede richiesta; tali contenuti sono esclusi.')
  if (s.righe.some(r => r.stato === 'Firmato' && !r.originale)) s.avvisi.push('Per alcuni moduli firmati manca un originale archiviato: vengono riportati solo i campi salvati e non viene ricostruita una firma.')
  return s
}
function avvisaSnapshotModulo(s: SezioneStorico, snapshot: SignedDocumentSnapshotV1 | null): void {
  if (!snapshot) s.avvisi.push('In assenza di snapshot documentale, i campi non congelati sono interpretati con il modello attuale: titolo, etichette e campi potrebbero essere cambiati dopo la compilazione. Le prove consensi congelate mantengono invece testo e valore originari.')
  else if (snapshot.source === 'reconstructed') s.avvisi.push(`Un modulo usa uno snapshot ricostruito il ${snapshot.reconstructed_at}: non attesta che le etichette del modello coincidessero con quelle mostrate alla data della firma.`)
}

export async function sanitari(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  await accessoSensibile(ctx)
  const ids = ctx.alunni.filter(a => a.scuola_id === ctx.richiesta.scuolaId).map(a => a.id)
  const avvisoTrasferiti = ctx.alunni.some(a => a.scuola_id !== ctx.richiesta.scuolaId)
    ? 'Per gli alunni attualmente in un’altra sede sono esclusi dati sanitari correnti e documenti privi di una sede storica autonoma verificabile; il gate del fascicolo non viene aggirato.' : ''
  if (categoria === 'documenti_alimentazione') {
    const s = nuovaSezione(categoria, { alunno: 'Alunno', allergeni: 'Allergeni registrati', allergie: 'Indicazioni alimentari registrate' })
    const righe = await perIds(ctx, 'alunni', 'id', ids, q => q.eq('scuola_id', ctx.richiesta.scuolaId).is('anonimizzato_il', null), 'id,allergeni,allergies')
    for (const r of righe) s.righe.push({ _alunno_id: testo(r.id), alunno: nome(ctx, testo(r.id)), allergeni: stringhe(r.allergeni), allergie: testo(r.allergies) })
    s.avvisi.push('Le indicazioni alimentari sono la fotografia attuale dell’anagrafica e non sono versionate per data. Gli eventuali certificati originali sono disponibili nella sezione dei certificati medici.')
    if (avvisoTrasferiti) s.avvisi.push(avvisoTrasferiti)
    return s
  }
  const fascicolo = categoria === 'documenti_fascicolo'
  const s = nuovaSezione(categoria, { data: 'Registrato il', alunno: 'Alunno', tipo: 'Tipo documento', nome: 'Nome file', descrizione: 'Descrizione',
    dal: 'Validità dal', al: 'Validità al / scadenza', stato: 'Stato', validatoIl: 'Validato il', notaValidazione: 'Nota di validazione', originale: 'Originale archiviato' })
  const righe = fascicolo
    ? await perIds(ctx, 'student_documents', 'student_id', ids, q => fascicoloVivo(q))
    : await perIds(ctx, 'certificati_medici', 'alunno_id', ids)
  for (const r of righe) {
    const id = testo(fascicolo ? r.student_id : r.alunno_id), data = giorno(fascicolo ? r.created_at : r.creato_il)
    if (!ammesso(ctx, id, data)) continue
    const originale = allegato(fascicolo ? 'sensitive_documents' : 'certificati-medici', r.storage_path || r.file_path || r.file_url,
      testo(r.file_name) || `${fascicolo ? 'Documento fascicolo' : 'Certificato medico'} ${nome(ctx, id)}`, id)
    aggiungiAllegato(s, originale)
    s.righe.push({ _alunno_id: id, data, alunno: nome(ctx, id), tipo: fascicolo ? testo(r.document_type) : 'Certificato medico', nome: originale?.nome ?? testo(r.file_name),
      descrizione: testo(r.descrizione) || testo(r.note), dal: giorno(r.data_inizio), al: giorno(r.expiry_date) || giorno(r.data_fine), stato: testo(r.stato),
      validatoIl: testo(r.validato_il), notaValidazione: testo(r.nota_validazione), originale: Boolean(originale) })
    if (!originale) s.avvisi.push('Per un documento presente nel periodo manca un riferimento valido all’originale privato.')
  }
  if (avvisoTrasferiti) s.avvisi.push(avvisoTrasferiti)
  return s
}
