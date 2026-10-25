import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { raccogliScolastico } from '@/lib/storici/adattatori/scolastici'
import type { ContestoStorico } from '@/lib/storici/tipi'
import { CATALOGO_STORICI } from '@/lib/storici/catalogo'
import { contenutoIscrizione } from '@/lib/storici/iscrizioni-collegate'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { puoAccedereFascicolo, logAccessoFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { buildSignedDocumentSnapshot } from '@/lib/forms/signed-document'
import { signedFormsDb, SCHOOL, STUDENT, ORIGINAL_SIGNATURE } from '../fixtures/signed-forms'

vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn() }))
vi.mock('@/lib/primaria/fascicolo-rbac', () => ({ puoAccedereFascicolo: vi.fn(), logAccessoFascicolo: vi.fn() }))

type Row = Record<string, unknown>
const SEDE = 'sede', CLASSE = 'classe', A = 'alunno-a', B = 'alunno-b'

/** Il finto applica DAVVERO i filtri e range: togliere uno scope cambia il risultato. */
function database(tabelle: Record<string, Row[]> = {}, errori: Record<string, unknown> = {}) {
  const letture: string[] = []
  const pagine: [string, number, number][] = []
  const db = {
    from(tabella: string) {
      letture.push(tabella)
      const predicati: ((r: Row) => boolean)[] = []
      const ordini: string[] = []
      let inizio = 0, fine = 999
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { predicati.push(r => r[k] === v); return q },
        in: (k: string, vs: unknown[]) => { predicati.push(r => vs.includes(r[k])); return q },
        is: (k: string, v: unknown) => { predicati.push(r => v === null ? r[k] == null : r[k] === v); return q },
        not: (k: string, _op: string, v: unknown) => { predicati.push(r => r[k] !== v); return q },
        gte: (k: string, v: unknown) => { predicati.push(r => String(r[k]) >= String(v)); return q },
        lte: (k: string, v: unknown) => { predicati.push(r => String(r[k]) <= String(v)); return q },
        or: (f: string) => {
          const clauses = f.split(',').map(c => c.split('.'))
          predicati.push(r => clauses.some(([k, op, ...v]) => op === 'is' ? r[k] == null : op === 'eq' && String(r[k]) === v.join('.')))
          return q
        },
        order: (k: string) => { ordini.push(k); return q },
        range: (dal: number, al: number) => { inizio = dal; fine = al; pagine.push([tabella, dal, al]); return q },
        then(onfulfilled: (r: unknown) => unknown) {
          const righe = (tabelle[tabella] ?? []).filter(r => predicati.every(p => p(r)))
          righe.sort((a, b) => { for (const k of ordini) { const n = String(a[k] ?? '').localeCompare(String(b[k] ?? '')); if (n) return n } return 0 })
          const res = { data: errori[tabella] ? null : righe.slice(inizio, fine + 1), error: errori[tabella] ?? null }
          return Promise.resolve(res).then(onfulfilled)
        },
      }
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, letture, pagine }
}
function contesto(db: SupabaseClient, overrides: Partial<ContestoStorico> = {}): ContestoStorico {
  return { db, utente: { id: 'staff', role: 'admin', scuola_id: SEDE }, scuolaNome: 'Scuola', titolo: 'Classe', avvisi: [],
    richiesta: { scuolaId: SEDE, sectionId: CLASSE, dal: '2020-01-01', al: '2100-12-31', categorie: ['diario_pasti'], formato: 'pdf', raggruppamento: 'classe' },
    alunni: [{ id: A, nome: 'Anna', cognome: 'Rossi', scuola_id: SEDE, section_id: 'classe-attuale-diversa' },
      { id: B, nome: 'Bruno', cognome: 'Verdi', scuola_id: SEDE, section_id: 'classe-attuale-diversa' }],
    appartenenze: [A, B].map(id => ({ alunno_id: id, scuola_id: SEDE, section_id: CLASSE, dal: '2020-01-01', al: null })), ...overrides }
}
const classe = { id: CLASSE, scuola_id: SEDE, name: 'Prima A' }
const periodo = { id: 'periodo', scuola_id: SEDE, nome: 'Secondo quadrimestre', anno_scolastico: '2025/2026', data_fine: '2026-06-10' }
const scrutinio = { id: 'scrutinio', section_id: CLASSE, periodo_id: 'periodo', stato: 'chiuso' }

beforeEach(() => {
  vi.mocked(puoAccedereFascicolo).mockResolvedValue({ consentito: true, ruolo: 'admin', motivo: 'staff' })
  vi.mocked(logAccessoFascicolo).mockResolvedValue()
})
afterEach(() => vi.clearAllMocks())

describe('adattatori scolastici degli storici', () => {
  it('conserva lezioni e nome storico di una classe rimossa dall’elenco corrente', async () => {
    const d = database({ registro_orario: [{ id: 'lezione-storica', section_id: CLASSE, scuola_id: SEDE, data: '2026-01-10', ora_lezione: 1, argomento: 'Lezione conservata' }] })
    const ctx = contesto(d.db)
    ctx.appartenenze = ctx.appartenenze.map(p => ({ ...p, section_nome: 'Prima storica' }))
    const s = await raccogliScolastico(ctx, 'primaria_registro')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe.every(r => r.classe === 'Prima storica' && r.argomento === 'Lezione conservata')).toBe(true)
  })
  it.each(['primaria_registro', 'primaria_compiti'] as const)('raccoglie una lezione comune una volta per 25 alunni in %s', async categoria => {
    const d = database({ sections: [classe], registro_orario: [{ id: 'lezione', section_id: CLASSE, scuola_id: SEDE,
      data: '2026-09-01', ora_lezione: 1, argomento: 'Lettura', compiti: 'Pagina 10' }] })
    const ctx = contesto(d.db)
    ctx.alunni = Array.from({ length: 25 }, (_, i) => ({ id: `alunno-${i}`, nome: `Nome ${i}`, cognome: 'Prova', scuola_id: SEDE, section_id: CLASSE }))
    ctx.appartenenze = ctx.alunni.map(a => ({ alunno_id: a.id, scuola_id: SEDE, section_id: CLASSE, dal: '2026-01-01', al: null }))
    const s = await raccogliScolastico(ctx, categoria)
    expect(s?.righe).toEqual([expect.objectContaining({ _ambito: 'classe', _registro_id: 'lezione', _classe_id: CLASSE, argomento: 'Lettura', compiti: 'Pagina 10' })])
    expect(s?.righe[0]._alunno_id).toBeUndefined()
    expect(s?._versione_raccolta).toBe(1)
  })

  it('conserva lezioni distinte con testo identico e ammette solo giorni della classe storica', async () => {
    const d = database({ sections: [classe], registro_orario: ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'].map((data, i) => ({
      id: `lezione-${i}`, section_id: CLASSE, scuola_id: SEDE, data, ora_lezione: 1, argomento: 'Stesso testo',
    })) })
    const ctx = contesto(d.db)
    ctx.appartenenze = [{ alunno_id: A, scuola_id: SEDE, section_id: CLASSE, dal: '2026-09-01', al: '2026-09-03' }]
    const s = await raccogliScolastico(ctx, 'primaria_registro')
    expect(s?.righe.map(r => r._registro_id)).toEqual(['lezione-1', 'lezione-2'])
    expect(s?.righe.every(r => r.argomento === 'Stesso testo')).toBe(true)
  })

  it('mantiene le firme di classe distinte una volta per firma', async () => {
    const d = database({ sections: [classe], registro_orario: [{ id: 'lezione', section_id: CLASSE, scuola_id: SEDE, data: '2026-09-01', argomento: 'Classe' }],
      firme_docenti: ['f1', 'f2'].map(id => ({ id, registro_id: 'lezione', maestra_id: 'docente', firmato_il: '2026-09-01T10:00:00Z' })) })
    const s = await raccogliScolastico(contesto(d.db), 'primaria_firme')
    expect(s?.righe).toHaveLength(2)
    expect(s?.righe.map(r => r._firma_id)).toEqual(['f1', 'f2'])
    expect(s?.righe.every(r => r._ambito === 'classe' && r._registro_id === 'lezione' && !r._alunno_id)).toBe(true)
  })

  it('raccoglie gli allegati didattici in una sola riga comune per lezione', async () => {
    const d = database({ sections: [classe], registro_orario: [{ id: 'lezione', section_id: CLASSE, scuola_id: SEDE, data: '2026-09-01', argomento: 'Classe' }],
      allegati_registro: ['scheda', 'lettura'].map(id => ({ id, registro_id: 'lezione', file_name: `${id}.pdf`, storage_path: `${id}.pdf`, tipo: 'pdf', ambito: 'lezione' })) })
    const s = await raccogliScolastico(contesto(d.db), 'documenti_didattici')
    expect(s?.righe).toEqual([expect.objectContaining({ _ambito: 'classe', _registro_id: 'lezione', allegati: 'lettura.pdf; scheda.pdf' })])
    expect(s?.allegati).toHaveLength(2)
    expect(s?.allegati.every(a => !a.alunnoId)).toBe(true)
  })

  it('mantiene nel dossier singolo le sole lezioni comuni pertinenti all’alunno', async () => {
    const d = database({ sections: [classe], registro_orario: [{ id: 'lezione', section_id: CLASSE, scuola_id: SEDE, data: '2026-09-01', argomento: 'Classe' }] })
    const ctx = contesto(d.db)
    ctx.richiesta.sectionId = undefined; ctx.richiesta.alunnoId = A
    ctx.alunni = ctx.alunni.filter(a => a.id === A)
    const s = await raccogliScolastico(ctx, 'primaria_registro')
    expect(s?.righe).toEqual([expect.objectContaining({ _ambito: 'classe', _registro_id: 'lezione', argomento: 'Classe' })])
    ctx.appartenenze = []
    expect((await raccogliScolastico(ctx, 'primaria_registro'))?.righe).toEqual([])
  })

  it.each(['primaria_registro', 'primaria_compiti', 'primaria_firme'] as const)('attribuisce varianti personali solo ai rispettivi destinatari in %s', async categoria => {
    const d = database({ sections: [classe], registro_orario: [{ id: 'lezione', section_id: CLASSE, scuola_id: SEDE, data: '2026-09-01', argomento: 'Classe', compiti: 'Per tutti' }],
      firme_docenti: [A, B, 'estraneo'].map(id => ({ id: `firma-${id}`, registro_id: 'lezione', argomento_proprio: `Argomento ${id}`, compiti_propri: `Compito ${id}` })),
      registro_destinatari: [A, B, 'estraneo'].map(id => ({ id, registro_id: 'lezione', firma_id: `firma-${id}`, alunno_id: id })) })
    const s = await raccogliScolastico(contesto(d.db), categoria)
    for (const id of [A, B]) expect(s?.righe.filter(r => r._alunno_id === id)).toEqual([expect.objectContaining({
      _ambito: 'alunno', _registro_id: 'lezione', _firma_id: `firma-${id}`, argomento: `Argomento ${id}`, compiti: `Compito ${id}`,
    })])
    expect(JSON.stringify(s)).not.toContain('estraneo')
  })
  it('nel dossier individuale esclude eventi senza sede fuori dalle appartenenze documentate', async () => {
    const d = database({ eventi_diario: [
      { id: 'altra-sede-prima', alunno_id: A, tipo_evento: 'pranzo', orario_inizio: '2025-05-12T10:00:00Z', dettagli: { corsi: { primo: 'poco' } } },
      { id: 'sede-richiesta', alunno_id: A, tipo_evento: 'pranzo', orario_inizio: '2026-09-10T10:00:00Z', dettagli: { corsi: { primo: 'tutto' } } },
    ] })
    const ctx = contesto(d.db)
    ctx.richiesta.sectionId = undefined; ctx.richiesta.alunnoId = A
    ctx.appartenenze = [{ alunno_id: A, scuola_id: SEDE, section_id: CLASSE, dal: '2026-09-01', al: null }]
    const s = await raccogliScolastico(ctx, 'diario_pasti')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0].data).toBe('2026-09-10')
    expect(s?.avvisi.some(v => v.includes('appartenenze') && v.includes('sede'))).toBe(true)
    ctx.appartenenze = []
    const senzaCopertura = await raccogliScolastico(ctx, 'diario_pasti')
    expect(senzaCopertura?.righe).toHaveLength(0)
    expect(senzaCopertura?.avvisi.some(v => v.includes('appartenenze') && v.includes('sede'))).toBe(true)
  })

  it('preserva tutte le scelte di una routine personalizzata come testo leggibile', async () => {
    const d = database({ eventi_diario: [{ id: 'routine', alunno_id: A, tipo_evento: 'routine:abcd1234', orario_inizio: '2026-09-10T10:00:00Z',
      dettagli: { nome: 'Merenda preferita', risposta: 'scelta', valore: ['Banana', 'Pane'] } }] })
    const s = await raccogliScolastico(contesto(d.db), 'diario_routine')
    expect(s?.righe[0]).toMatchObject({ tipo: 'Merenda preferita', valore: 'Banana, Pane' })
  })

  it('calcola le ore con le sole campanelle della classe e del giorno dell’assenza', async () => {
    const d = database({ sections: [classe], presenze: [{ id: 'lunedi', alunno_id: A, scuola_id: SEDE, section_id: CLASSE, data: '2026-09-07', stato: 'assente' }],
      campanelle: [{ id: 'lun', section_id: CLASSE, giorno_settimana: 1, tipo: 'lezione', ora_inizio: '08:30', ora_fine: '13:30' },
        { id: 'mar', section_id: CLASSE, giorno_settimana: 2, tipo: 'lezione', ora_inizio: '08:30', ora_fine: '16:30' }] })
    const s = await raccogliScolastico(contesto(d.db), 'presenze_riepilogo')
    expect(s?.righe.find(r => r._alunno_id === A)?.ore).toBe(5)
  })

  it('stampa il modello e le risposte congelati alla firma dopo modifiche al modello corrente', async () => {
    const fixture = signedFormsDb()
    const template = fixture.forms_templates[0], r = fixture.forms_submissions[0]
    template.fields = [...template.fields as Row[], { id: 'documento', type: 'file', label: 'Allegato alla firma' }]
    r.answers = { ...r.answers as Row, documento: 'models/form/documento-firmato.pdf' }
    const snapshot = buildSignedDocumentSnapshot({ template, student: fixture.alunni[0], signer: fixture.utenti[0],
      answers: r.answers, signatureLog: ORIGINAL_SIGNATURE, source: 'contemporaneous' })
    template.title = 'Titolo rinominato dopo la firma'
    template.fields = [{ id: 'accept', type: 'checkbox', label: 'Consenso completamente diverso', required: true }]
    r.answers = { accept: false, note: 'TESTO MODIFICATO' }
    r.signature_log = { ...ORIGINAL_SIGNATURE, document_snapshot: snapshot }
    const d = database(fixture), ctx = contesto(d.db)
    ctx.richiesta.scuolaId = SCHOOL; ctx.richiesta.sectionId = undefined; ctx.richiesta.alunnoId = STUDENT
    ctx.alunni = [{ id: STUDENT, nome: 'Bambino', cognome: 'Esempio', scuola_id: SCHOOL, section_id: CLASSE }]
    ctx.appartenenze = [{ alunno_id: STUDENT, scuola_id: SCHOOL, section_id: CLASSE, dal: '2020-01-01', al: null }]
    const s = await raccogliScolastico(ctx, 'documenti_moduli')
    expect(s?.righe.some(row => row.titolo === 'Autorizzazione uscita' && row.campo === 'Autorizzo la visita' && row.valore === true)).toBe(true)
    expect(s?.righe.some(row => row.campo === 'Note' && row.valore === 'Risposta presente')).toBe(true)
    expect(JSON.stringify(s)).not.toContain('TESTO MODIFICATO')
    expect(JSON.stringify(s)).not.toContain('Consenso completamente diverso')
    expect(s?.allegati.some(a => a.percorso === 'models/form/documento-firmato.pdf' && a.alunnoId === STUDENT)).toBe(true)
  })

  it('usa il consenso congelato dei moduli legacy e dichiara il fallback per i campi senza snapshot', async () => {
    const d = database({ storici_collegamenti: [{ id: 'link', scuola_id: SEDE, alunno_id: A, tipo: 'modulo', entita_id: 'legacy' }],
      form_submissions: [{ id: 'legacy', scuola_id: SEDE, model_id: 'modello', created_at: '2026-09-10T10:00:00Z', status: 'signed', signed_at: '2026-09-10T11:00:00Z',
        data: { consent: false, nota: 'Risposta salvata' }, consents_log: [{ field_id: 'consent', label: 'Autorizzazione originaria', text: 'Testo accettato originario', accepted: true, accepted_at: '2026-09-10T11:00:00Z' }] }],
      form_models: [{ id: 'modello', scuola_id: SEDE, title: 'Modulo', schema: { pages: [{ fields: [{ id: 'consent', type: 'consent', label: 'Testo rinominato' }, { id: 'nota', type: 'text', label: 'Nota attuale' }] }] } }] })
    const s = await raccogliScolastico(contesto(d.db), 'documenti_moduli')
    expect(s?.righe.some(r => r.campo === 'Autorizzazione originaria' && r.valore === true && r.testoConsenso === 'Testo accettato originario')).toBe(true)
    expect(s?.righe.some(r => r.campo === 'Testo rinominato')).toBe(false)
    expect(s?.avvisi.some(v => v.includes('snapshot') && v.includes('attuale'))).toBe(true)
  })
  it('riporta anche i consensi diretti forms_submissions dal documento congelato', async () => {
    const fixture = signedFormsDb(), template = fixture.forms_templates[0], r = fixture.forms_submissions[0]
    template.fields = [{ id: 'foto', type: 'consent', label: 'Foto originarie', text: 'Testo foto originario', required: false }]
    r.answers = { foto: false }
    const snapshot = buildSignedDocumentSnapshot({ template, student: fixture.alunni[0], signer: fixture.utenti[0], answers: r.answers, signatureLog: ORIGINAL_SIGNATURE, source: 'contemporaneous' })
    template.fields = [{ id: 'foto', type: 'consent', label: 'TESTO ATTUALE DA NON USARE', required: false }]
    r.answers = { foto: true }; r.signature_log = { ...ORIGINAL_SIGNATURE, document_snapshot: snapshot }
    const d = database(fixture), ctx = contesto(d.db)
    ctx.richiesta.scuolaId = SCHOOL; ctx.richiesta.sectionId = undefined; ctx.richiesta.alunnoId = STUDENT
    ctx.alunni = [{ id: STUDENT, nome: 'Bambino', cognome: 'Esempio', scuola_id: SCHOOL, section_id: CLASSE }]
    ctx.appartenenze = [{ alunno_id: STUDENT, scuola_id: SCHOOL, section_id: CLASSE, dal: '2020-01-01', al: null }]
    const s = await raccogliScolastico(ctx, 'documenti_consensi')
    expect(s?.righe).toEqual([expect.objectContaining({ tipo: 'Foto originarie', testo: 'Testo foto originario', accettato: false, _alunno_id: STUDENT })])
    expect(JSON.stringify(s)).not.toContain('TESTO ATTUALE DA NON USARE')
  })

  it('include gli allegati dei campi file dichiarati dal modulo nel bucket privato corretto', async () => {
    const d = database({ forms_templates: [{ id: 'form', scuola_id: SEDE, title: 'Modulo allegato', fields: [{ id: 'documento', type: 'file', label: 'Documento richiesto' }] }],
      forms_submissions: [{ id: 'invio', student_id: A, form_id: 'form', created_at: '2026-09-10T10:00:00Z', answers: { documento: 'models/form/uuid-documento.pdf' }, is_signed: false }] })
    const s = await raccogliScolastico(contesto(d.db), 'documenti_moduli')
    expect(s?.allegati).toEqual([expect.objectContaining({ bucket: 'form_attachments', percorso: 'models/form/uuid-documento.pdf', alunnoId: A })])
    expect(s?.righe.some(r => r.campo === 'Documento richiesto' && r.valore === 'Allegato incluso')).toBe(true)
  })

  it('include le prove congelate di iscrizioni e moduli tramite collegamenti espliciti', async () => {
    const d = database({ storici_collegamenti: [
      { id: 'link-iscr', scuola_id: SEDE, alunno_id: A, tipo: 'iscrizione', entita_id: 'domanda' },
      { id: 'link-modulo', scuola_id: SEDE, alunno_id: A, tipo: 'modulo', entita_id: 'modulo' },
    ], enrollment_submissions: [{ id: 'domanda', scuola_id: SEDE, created_at: '2026-09-01T10:00:00Z', data: { children: [{ nome: 'Anna' }, { nome: 'SEGRETO FRATELLO' }] },
      consents_log: { versione_informativa: 'v4', accettato_il: '2026-09-01T10:00:00Z', ip: 'NON ESPORTARE', blocchi: [
        { field_id: 'foto', label: 'Foto galleria', text: 'Testo foto congelato', accepted: false, accepted_at: '2026-09-01T10:00:00Z' },
      ] } }], form_submissions: [{ id: 'modulo', scuola_id: SEDE, created_at: '2026-09-02T10:00:00Z', consents_log: [
        { field_id: 'privacy', label: 'Privacy modulo', text: 'Testo privacy congelato', accepted: true, accepted_at: '2026-09-02T10:00:00Z' },
      ] }] })
    const s = await raccogliScolastico(contesto(d.db), 'documenti_consensi')
    expect(s?.righe).toHaveLength(2)
    expect(s?.righe.some(r => r._alunno_id === A && r.tipo === 'Foto galleria' && r.accettato === false && r.testo === 'Testo foto congelato')).toBe(true)
    expect(s?.righe.some(r => r.tipo === 'Privacy modulo' && r.accettato === true)).toBe(true)
    expect(JSON.stringify(s)).not.toContain('SEGRETO FRATELLO')
    expect(JSON.stringify(s)).not.toContain('NON ESPORTARE')
  })

  it('mantiene un documento con sede propria e dichiara la stampa parziale se manca l’originale della domanda', async () => {
    const d = database({ storici_collegamenti: [{ id: 'l', scuola_id: SEDE, alunno_id: A, tipo: 'iscrizione', entita_id: 'domanda' }],
      enrollment_submissions: [{ id: 'domanda', scuola_id: SEDE, created_at: '2025-01-01T10:00:00Z', status: 'approved',
        data: { children: [{ nome: 'SEGRETO FRATELLO', documento_path: 'file-del-fratello.pdf' }] } }] })
    const ctx = contesto(d.db)
    ctx.richiesta.sectionId = undefined; ctx.richiesta.alunnoId = A; ctx.appartenenze = []
    const s = await raccogliScolastico(ctx, 'documenti_iscrizioni')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ originale: false, completezza: 'Estratto amministrativo parziale' })
    expect(s?.avvisi.some(v => v.includes('non conserva un PDF originale'))).toBe(true)
    expect(JSON.stringify(s)).not.toContain('SEGRETO FRATELLO')
    expect(s?.allegati).toHaveLength(0)
  })
  it('trascrive soltanto il figlio e gli adulti attribuiti, poi rifiuta il contenuto cambiato', async () => {
    const data = { children: [{ nome: 'Alunno verificato', documento_path: 'moduli/documento-alunno.pdf' }, { nome: 'SEGRETO FRATELLO' }], adults: [{ nome: 'Adulto verificato' }, { nome: 'ADULTO NON ATTRIBUITO' }] }
    const scelta = contenutoIscrizione(data, 0, [0])!
    const d = database({ storici_collegamenti: [{ id: 'l', scuola_id: SEDE, alunno_id: A, tipo: 'iscrizione', entita_id: 'domanda', indice_figlio: 0, adulti_indici: [0], contenuto_impronta: scelta.impronta }], enrollment_submissions: [{ id: 'domanda', scuola_id: SEDE, created_at: '2025-01-01T10:00:00Z', data }] })
    const s = await raccogliScolastico(contesto(d.db), 'documenti_iscrizioni')
    expect(JSON.stringify(s)).toContain('Alunno verificato')
    expect(JSON.stringify(s)).toContain('Adulto verificato')
    expect(JSON.stringify(s)).not.toContain('SEGRETO FRATELLO')
    expect(JSON.stringify(s)).not.toContain('ADULTO NON ATTRIBUITO')
    expect(s?.allegati[0]).toMatchObject({ percorso: 'moduli/documento-alunno.pdf', alunnoId: A })
    data.children[0].nome = 'Figlio sostituito'
    const cambiato = await raccogliScolastico(contesto(d.db), 'documenti_iscrizioni')
    expect(JSON.stringify(cambiato)).not.toContain('Figlio sostituito')
    expect(cambiato?.avvisi.some(v => v.includes('cambiata dopo l’attribuzione'))).toBe(true)
  })
  it('non incorpora il PDF familiare se un fratello entra in classe dopo la data della domanda', async () => {
    const data = { children: [{ nome: 'Alunno A fittizio' }, { nome: 'Fratello B fittizio' }], adults: [] }
    const links = [A, B].map((id, indice) => ({ id: `l${indice}`, scuola_id: SEDE, alunno_id: id, tipo: 'iscrizione', entita_id: 'domanda', indice_figlio: indice, adulti_indici: [], contenuto_impronta: contenutoIscrizione(data, indice, [])!.impronta }))
    const d = database({ storici_collegamenti: links, enrollment_submissions: [{ id: 'domanda', scuola_id: SEDE, created_at: '2026-01-10T10:00:00Z', pdf_path: 'domande/famiglia.pdf', data }] })
    const ctx = contesto(d.db)
    ctx.richiesta.dal = '2026-01-01'; ctx.richiesta.al = '2026-01-31'
    ctx.appartenenze = [{ alunno_id: A, scuola_id: SEDE, section_id: CLASSE, dal: '2026-01-01', al: null }, { alunno_id: B, scuola_id: SEDE, section_id: CLASSE, dal: '2026-01-20', al: null }]
    const s = await raccogliScolastico(ctx, 'documenti_iscrizioni')
    expect(s?.righe.every(r => r._alunno_id === A)).toBe(true)
    expect(s?.allegati).toEqual([])
    expect(JSON.stringify(s)).not.toContain('Fratello B fittizio')
  })

  it('legge eventi_diario, usa il giorno romano e rispetta la fine esclusiva dell’appartenenza', async () => {
    const d = database({ eventi_diario: [
      { id: '1', alunno_id: A, tipo_evento: 'pranzo', orario_inizio: '2026-09-01T22:30:00Z', dettagli: { corsi: { primo: 'tutto', secondo: 'meta' }, password: 'NON ESPORTARE' } },
      { id: '2', alunno_id: A, tipo_evento: 'pranzo', orario_inizio: '2026-09-02T22:30:00Z', dettagli: { corsi: { primo: 'poco' } } },
      { id: '3', alunno_id: 'estraneo', tipo_evento: 'pranzo', orario_inizio: '2026-09-02T10:00:00Z' },
    ] })
    const ctx = contesto(d.db)
    ctx.richiesta.dal = '2026-09-02'; ctx.richiesta.al = '2026-09-03'
    ctx.appartenenze[0].al = '2026-09-03'
    const s = await raccogliScolastico(ctx, 'diario_pasti')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ _alunno_id: A, data: '2026-09-02', alunno: 'Rossi Anna', inizio: '00:30', dettaglio: 'primo: tutto; secondo: meta' })
    expect(JSON.stringify(s)).not.toContain('NON ESPORTARE')
    expect(d.letture).not.toContain('daily_routines')
  })

  it('pagina oltre le 1000 righe senza troncare o duplicare il diario', async () => {
    const eventi = Array.from({ length: 1101 }, (_, i) => ({ id: String(i).padStart(5, '0'), alunno_id: A,
      tipo_evento: 'bagno', orario_inizio: '2026-09-02T10:00:00Z', dettagli: { pipi: i, cacca: 0, vasino: 1 } }))
    const d = database({ eventi_diario: eventi })
    const s = await raccogliScolastico(contesto(d.db), 'diario_bagno')
    expect(s?.righe).toHaveLength(1101)
    expect(s?.righe.at(-1)?.pipi).toBe(1100)
    expect(d.pagine.filter(p => p[0] === 'eventi_diario')).toEqual([['eventi_diario', 0, 499], ['eventi_diario', 500, 999], ['eventi_diario', 1000, 1499]])
  })

  describe('attività e note di sezione del diario', () => {
    const C = 'alunno-c'
    const eventi = () => [A, B, C].map((id, i) => ({
      id: `att-${id}`, alunno_id: id, tipo_evento: 'attivita', orario_inizio: '2026-09-10T08:00:00Z', maestra_id: 'edu',
      nota_libera: 'Uscita in giardino' as string | null, nota_bambino: id === C ? 'Ha guidato il gioco' : null,
      dettagli: { activities: [{ tipo: 'Pittura', descrizione: 'Colori a dita', ora_inizio: '10:00', ora_fine: '10:45', partecipazione: (i === 0 ? 'Con entusiasmo' : 'Ha partecipato') as string | null }] },
    }))
    const tre = (db: SupabaseClient) => contesto(db, {
      alunni: [{ id: A, nome: 'Anna', cognome: 'Rossi', scuola_id: SEDE, section_id: CLASSE }, { id: B, nome: 'Bruno', cognome: 'Verdi', scuola_id: SEDE, section_id: CLASSE },
        { id: C, nome: 'Carla', cognome: 'Bianchi', scuola_id: SEDE, section_id: CLASSE }],
      appartenenze: [A, B, C].map(id => ({ alunno_id: id, scuola_id: SEDE, section_id: CLASSE, dal: '2020-01-01', al: null })),
    })
    const utenti = [{ id: 'edu', nome: 'Edu', cognome: 'Sintetica' }]

    it('in stampa di classe accorpa l’attività: una riga, partecipazione raggruppata, nota di sezione una volta', async () => {
      const s = await raccogliScolastico(tre(database({ eventi_diario: eventi(), utenti }).db), 'diario_attivita')
      expect(s?.righe).toEqual([
        expect.objectContaining({ _ambito: 'classe', _nota_giorno: true, data: '2026-09-10', tipo: 'Nota di sezione', dettaglio: 'Uscita in giardino', autore: 'Sintetica Edu' }),
        expect.objectContaining({ _ambito: 'classe', data: '2026-09-10', alunno: '', tipo: 'Pittura', dettaglio: 'Colori a dita', inizio: '10:00', fine: '10:45',
          valore: 'Ha partecipato: 2 bambini · Con entusiasmo: Rossi Anna', notaIndividuale: 'Bianchi Carla: Ha guidato il gioco', autore: 'Sintetica Edu' }),
      ])
      expect(s?.righe.some(r => r._alunno_id)).toBe(false)
      expect(s?.colonne.map(c => c.chiave)).not.toContain('notaSezione')
    })

    it('con un solo valore di partecipazione scrive «tutti» e senza valore il solo conteggio', async () => {
      const uguali = eventi().map(e => ({ ...e, nota_libera: null, nota_bambino: null, dettagli: { activities: [{ ...e.dettagli.activities[0], partecipazione: 'Ha partecipato' }] } }))
      const s = await raccogliScolastico(tre(database({ eventi_diario: uguali, utenti }).db), 'diario_attivita')
      expect(s?.righe.map(r => r.valore)).toEqual(['Ha partecipato: tutti i 3 bambini'])
      const senza = eventi().map(e => ({ ...e, nota_libera: null, dettagli: { activities: [{ ...e.dettagli.activities[0], partecipazione: null }] } }))
      const t = await raccogliScolastico(tre(database({ eventi_diario: senza, utenti }).db), 'diario_attivita')
      expect(t?.righe.map(r => r.valore)).toEqual(['3 bambini'])
    })

    it('nel dossier per alunno mette la descrizione nella riga di classe e ai singoli solo la propria partecipazione', async () => {
      const ctx = tre(database({ eventi_diario: eventi(), utenti }).db)
      ctx.richiesta.raggruppamento = 'alunno'
      const s = await raccogliScolastico(ctx, 'diario_attivita')
      const classe = s?.righe.filter(r => r._ambito === 'classe' && !r._nota_giorno)
      expect(classe).toEqual([expect.objectContaining({ dettaglio: 'Colori a dita', valore: 'Ha partecipato: 2 bambini · Con entusiasmo: 1 bambino', notaIndividuale: '' })])
      const singoli = s?.righe.filter(r => r._alunno_id) ?? []
      expect(singoli.map(r => [r._alunno_id, r.dettaglio, r.valore, r.notaIndividuale])).toEqual([
        [A, '', 'Con entusiasmo', ''], [B, '', 'Ha partecipato', ''], [C, '', 'Ha partecipato', 'Ha guidato il gioco'],
      ])
      expect(JSON.stringify(classe)).not.toContain('Rossi')
    })

    it('nella stampa di un solo alunno non accorpa e tiene la descrizione', async () => {
      const ctx = tre(database({ eventi_diario: eventi(), utenti }).db)
      ctx.richiesta.sectionId = undefined; ctx.richiesta.alunnoId = A
      ctx.alunni = ctx.alunni.filter(a => a.id === A)
      const s = await raccogliScolastico(ctx, 'diario_attivita')
      expect(s?.righe).toEqual([
        expect.objectContaining({ _nota_giorno: true, dettaglio: 'Uscita in giardino' }),
        expect.objectContaining({ _alunno_id: A, alunno: 'Rossi Anna', dettaglio: 'Colori a dita', valore: 'Con entusiasmo' }),
      ])
    })

    it('nelle note tiene le sole note individuali per bambino e la nota di sezione una volta per giorno', async () => {
      const s = await raccogliScolastico(tre(database({ eventi_diario: eventi(), utenti }).db), 'diario_note')
      expect(s?.righe.filter(r => r._nota_giorno)).toHaveLength(1)
      expect(s?.righe.filter(r => r._alunno_id).map(r => [r._alunno_id, r.notaIndividuale])).toEqual([[C, 'Ha guidato il gioco']])
    })
  })

  it('separa fatti del registro e comunicazioni non ancora confermate di oggi o future', async () => {
    const oggi = oggiFiscaleISO()
    const d = database({ presenze: [
      { id: 'ieri', alunno_id: A, data: '2020-01-02', scuola_id: SEDE, section_id: CLASSE, stato: 'assente', registrato_da: null, giustificata_da: 'genitore' },
      { id: 'oggi-annuncio', alunno_id: A, data: oggi, scuola_id: SEDE, section_id: CLASSE, stato: 'assente', registrato_da: null, giustificata_da: 'genitore' },
      { id: 'oggi-appello', alunno_id: B, data: oggi, scuola_id: SEDE, section_id: CLASSE, stato: 'presente', registrato_da: 'docente' },
      { id: 'futuro', alunno_id: A, data: '2099-12-31', scuola_id: SEDE, section_id: CLASSE, stato: 'assente', giustificata_da: 'genitore' },
      { id: 'altra-sede', alunno_id: A, data: '2026-01-01', scuola_id: 'altra-sede', section_id: CLASSE, stato: 'assente' },
    ], sections: [classe] })
    const ctx = contesto(d.db)
    const registro = await raccogliScolastico(ctx, 'presenze_registro')
    expect(registro?.righe).toHaveLength(2)
    const comunicazioni = await raccogliScolastico(ctx, 'presenze_comunicazioni')
    expect(comunicazioni?.righe).toHaveLength(3)
    const riepilogo = await raccogliScolastico(ctx, 'presenze_riepilogo')
    expect(riepilogo?.righe[0]).toMatchObject({ _alunno_id: A, assenti: 1, giorni: 1, ore: 5 })
    expect(riepilogo?.righe[1]).toMatchObject({ _alunno_id: B, presenti: 1, giorni: 1, ore: 0 })
  })

  it('attribuisce i contenuti riservati alla singola firma destinataria, anche per le prese visione', async () => {
    const d = database({ sections: [classe], registro_orario: [{ id: 'lezione', scuola_id: SEDE, section_id: CLASSE, data: '2026-09-01', ora_lezione: 1, materia: 'Italiano', argomento: 'Classe', compiti: 'Per tutti' }],
      firme_docenti: [{ id: 'f1', registro_id: 'lezione', maestra_id: 'docente', argomento_proprio: 'Riservato Anna', compiti_propri: 'Esercizio Anna' },
        { id: 'f2', registro_id: 'lezione', maestra_id: 'docente', argomento_proprio: 'Riservato estraneo' }],
      registro_destinatari: [{ id: 'd1', registro_id: 'lezione', firma_id: 'f1', alunno_id: A }, { id: 'd2', registro_id: 'lezione', firma_id: 'f2', alunno_id: 'estraneo' }],
      utenti: [{ id: 'docente', nome: 'Maria', cognome: 'Bianchi' }] })
    const ctx = contesto(d.db)
    const registro = await raccogliScolastico(ctx, 'primaria_registro')
    expect(registro?.righe.filter(r => r._ambito === 'classe').map(r => r.argomento)).toEqual(['Classe'])
    expect(registro?.righe.filter(r => r._alunno_id === B)).toEqual([])
    expect(registro?.righe.filter(r => r._alunno_id === A)).toEqual([expect.objectContaining({ _ambito: 'alunno', _registro_id: 'lezione', _firma_id: 'f1', argomento: 'Riservato Anna' })])
    expect(JSON.stringify(registro)).not.toContain('Riservato estraneo')
    const firme = await raccogliScolastico(ctx, 'primaria_firme')
    expect(firme?.righe).toHaveLength(1)
    expect(firme?.righe[0]).toMatchObject({ _alunno_id: A, argomento: 'Riservato Anna' })
  })

  it('usa le materie storiche e la scala della sede per le medie per materia e obiettivo', async () => {
    const d = database({ valutazioni: [
      { id: 'v1', alunno_id: A, section_id: CLASSE, data_evento: '2026-06-10', creato_il: '2099-06-01T10:00:00Z', materia_id: 'materia-inattiva',
        materie: { nome: 'Geografia storica' }, modalita: 'sintetico', giudizio_sintetico: 'Buono', valutazione_obiettivi: [{ obiettivo_id: 'o1', obiettivi_apprendimento: { codice: 'G1', descrizione: 'Orientarsi' } }] },
      { id: 'v2', alunno_id: A, section_id: CLASSE, creato_il: '2026-06-09T22:30:00Z', materia_id: 'materia-inattiva',
        materie: { nome: 'Geografia storica' }, modalita: 'dimensioni', giudizio_sintetico: 'Ottimo', valutazione_obiettivi: [{ obiettivo_id: 'o1', obiettivi_apprendimento: { codice: 'G1', descrizione: 'Orientarsi' } }] },
      { id: 'v3', alunno_id: A, section_id: CLASSE, data_evento: '2026-06-11', materia_id: 'materia-inattiva', giudizio_sintetico: 'Insufficiente' },
    ], giudizi_sintetici_scala: [{ id: 's1', scuola_id: SEDE, etichetta: 'Buono', valore_numerico: 7 }, { id: 's2', scuola_id: SEDE, etichetta: 'Ottimo', valore_numerico: 10 },
      { id: 's3', scuola_id: 'altra-sede', etichetta: 'Ottimo', valore_numerico: 1 }] })
    const ctx = contesto(d.db); ctx.richiesta.dal = '2026-06-10'; ctx.richiesta.al = '2026-06-10'
    const s = await raccogliScolastico(ctx, 'primaria_prospetti')
    expect(s?.righe).toHaveLength(2)
    expect(s?.righe.map(r => r.media)).toEqual([8.5, 8.5])
    expect(s?.righe.some(r => r.obiettivo === 'G1 — Orientarsi')).toBe(true)
    expect(s?.righe[0].materia).toBe('Geografia storica')
    expect(s?.avvisi.some(v => v.includes('Europe/Rome'))).toBe(true)
    expect(d.letture).not.toContain('materie')
  })

  it('mantiene l’originale privato della pagella con periodo accademico e alunno corretti', async () => {
    const d = database({ sections: [classe], scrutinio_periodi: [periodo], scrutini: [scrutinio], pagelle: [{ id: 'p1', scrutinio_id: 'scrutinio', alunno_id: A,
      generata_il: '2026-09-01T12:00:00Z', file_url: `https://example.supabase.co/storage/v1/object/sign/pagelle/${A}/originale.pdf?token=segreto`, firma_applicativa: { password: 'NON ESPORTARE' } }] })
    const ctx = contesto(d.db); ctx.richiesta.dal = '2026-06-01'; ctx.richiesta.al = '2026-06-30'
    const s = await raccogliScolastico(ctx, 'primaria_pagelle')
    expect(s?.righe[0]).toMatchObject({ _alunno_id: A, data: '2026-06-10', periodo: 'Secondo quadrimestre', originale: true })
    expect(s?.allegati[0]).toMatchObject({ bucket: 'pagelle', percorso: `${A}/originale.pdf`, alunnoId: A, mime: 'application/pdf' })
    expect(JSON.stringify(s)).not.toContain('segreto')
    expect(JSON.stringify(s)).not.toContain('NON ESPORTARE')
  })

  it('una pagella ritirata da una riapertura porta tutte le versioni consegnate, ciascuna riconoscibile', async () => {
    const r1 = `ritirate/scrutinio/${A}-20261001090000000.pdf`
    const r2 = `ritirate/scrutinio/${A}-20261103100000123.pdf`
    const d = database({ sections: [classe], scrutinio_periodi: [periodo], scrutini: [scrutinio], pagelle: [{ id: 'p1', scrutinio_id: 'scrutinio', alunno_id: A,
      generata_il: '2026-09-01T12:00:00Z', file_url: r2, ritirata_il: '2026-11-03T10:00:00Z', file_ritirati: [r1, r2] }] })
    const ctx = contesto(d.db); ctx.richiesta.dal = '2026-06-01'; ctx.richiesta.al = '2026-06-30'
    const s = await raccogliScolastico(ctx, 'primaria_pagelle')
    expect(s?.allegati.map(a => a.percorso)).toEqual([r2, r1])
    expect(s?.allegati[0].nome).toMatch(/\(ritirata\)\.pdf$/)
    expect(s?.allegati[1].nome).toMatch(/\(ritirata 1\)\.pdf$/)
  })

  it('una pagella di nuovo in vigore: l’originale col suo nome, la versione ritirata accanto', async () => {
    const r1 = `ritirate/scrutinio/${A}-20261001090000000.pdf`
    const d = database({ sections: [classe], scrutinio_periodi: [periodo], scrutini: [scrutinio], pagelle: [{ id: 'p1', scrutinio_id: 'scrutinio', alunno_id: A,
      generata_il: '2026-09-01T12:00:00Z', file_url: `scrutinio/${A}.pdf`, ritirata_il: null, file_ritirati: [r1] }] })
    const ctx = contesto(d.db); ctx.richiesta.dal = '2026-06-01'; ctx.richiesta.al = '2026-06-30'
    const s = await raccogliScolastico(ctx, 'primaria_pagelle')
    expect(s?.allegati.map(a => a.percorso)).toEqual([`scrutinio/${A}.pdf`, r1])
    expect(s?.allegati[0].nome).not.toMatch(/ritirata/)
    expect(s?.allegati[1].nome).toMatch(/\(ritirata 1\)\.pdf$/)
  })

  it('blocca il fascicolo prima di leggerne i documenti quando il gate è negato', async () => {
    vi.mocked(puoAccedereFascicolo).mockResolvedValue({ consentito: false, ruolo: 'admin', motivo: 'cross-tenant' })
    const d = database({ student_documents: [{ id: 'sensibile', student_id: A }] })
    await expect(raccogliScolastico(contesto(d.db), 'documenti_fascicolo')).rejects.toMatchObject({ stato: 403, codice: 'FASCICOLO_NON_AUTORIZZATO' })
    expect(d.letture).not.toContain('student_documents')
    expect(logAccessoFascicolo).not.toHaveBeenCalled()
  })

  it('traccia l’accesso prima della lettura sanitaria ed esclude i documenti nel cestino', async () => {
    const d = database({ student_documents: [{ id: 'vivo', student_id: A, created_at: '2026-09-02T09:00:00Z', document_type: 'PDP', storage_path: `${A}/pdp.pdf`, file_name: 'PDP.pdf' },
      { id: 'eliminato', student_id: A, created_at: '2026-09-02T09:00:00Z', eliminato_il: '2026-09-03', storage_path: `${A}/eliminato.pdf` }] })
    vi.mocked(logAccessoFascicolo).mockImplementation(async () => { expect(d.letture).not.toContain('student_documents') })
    const s = await raccogliScolastico(contesto(d.db), 'documenti_fascicolo')
    expect(logAccessoFascicolo).toHaveBeenCalledTimes(2)
    expect(s?.righe).toHaveLength(1)
    expect(s?.allegati[0]).toMatchObject({ bucket: 'sensitive_documents', percorso: `${A}/pdp.pdf`, alunnoId: A })
  })

  it('non associa per omonimia domande senza collegamento verificato', async () => {
    const d = database({ enrollment_submissions: [{ id: 'domanda', scuola_id: SEDE, created_at: '2026-09-01', data: { children: [{ nome: 'Anna', cognome: 'Rossi' }] } }] })
    const s = await raccogliScolastico(contesto(d.db), 'documenti_iscrizioni')
    expect(s?.righe).toEqual([])
    expect(s?.avvisi.some(v => v.includes('2 alunni manca un collegamento verificato'))).toBe(true)
    expect(d.letture).not.toContain('enrollment_submissions')
  })

  it('non nasconde un guasto di lettura come un elenco vuoto', async () => {
    const d = database({}, { valutazioni: { code: '42501', message: 'permission denied' } })
    await expect(raccogliScolastico(contesto(d.db), 'primaria_valutazioni')).rejects.toMatchObject({ stato: 500, codice: 'LETTURA_FALLITA' })
  })

  it('gestisce tutte le categorie scolastiche concrete e lascia alle altre fonti le categorie estranee', async () => {
    const d = database()
    const ctx = contesto(d.db)
    const categorie = CATALOGO_STORICI.filter(c => /^(diario_|presenze_|primaria_|anagrafica_|documenti_)/.test(c.id)
      && !['diario_completo', 'primaria_completo', 'documenti_protocolli'].includes(c.id))
    expect(categorie).toHaveLength(32)
    for (const c of categorie) expect((await raccogliScolastico(ctx, c.id))?.categoria).toBe(c.id)
    expect(await raccogliScolastico(ctx, 'contabilita_incassi')).toBeNull()
    expect(await raccogliScolastico(ctx, 'documenti_protocolli')).toBeNull()
  })
})
