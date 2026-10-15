import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContestoStorico } from '@/lib/storici/tipi'
import type { CategoriaStorico } from '@/lib/storici/catalogo'

const { audit, ricevutaPdf, attestazionePdf } = vi.hoisted(() => ({ audit: vi.fn(), ricevutaPdf: vi.fn(), attestazionePdf: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/chat/vigilanza-audit', () => ({ registraAccessoVigilanza: audit }))
vi.mock('@/lib/pagamenti/pdf', () => ({ buildRicevutaFamigliaPdf: ricevutaPdf, buildAttestazionePdf: attestazionePdf }))
import { raccogliServizio } from '@/lib/storici/adattatori/servizi'

type Row = Record<string, unknown>
const SCUOLA = 'sede-a', A = 'alunno-a', B = 'fratello-b', CLASSE = 'classe-a'
const campo = (r: Row, c: string): unknown => c.split('.').reduce<unknown>((v, k) => v && typeof v === 'object' ? (v as Row)[k] : undefined, r)
const compara = (v: unknown): string | number => typeof v === 'string' && v.includes('T') ? new Date(v).getTime() : String(v ?? '')
function separaFiltri(s: string): string[] {
  const parti: string[] = []
  let profondita = 0, inizio = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') profondita++
    if (s[i] === ')') profondita--
    if (s[i] === ',' && profondita === 0) { parti.push(s.slice(inizio, i)); inizio = i + 1 }
  }
  parti.push(s.slice(inizio))
  return parti
}
function filtroLogico(espressione: string, r: Row): boolean {
  const gruppo = /^(and|or)\((.*)\)$/.exec(espressione)
  if (gruppo) {
    const filtri = separaFiltri(gruppo[2])
    return gruppo[1] === 'and' ? filtri.every(f => filtroLogico(f, r)) : filtri.some(f => filtroLogico(f, r))
  }
  const atomo = /^(.*?)\.(eq|is|gte|lte|lt)\.(.*)$/.exec(espressione)
  if (!atomo) throw new Error(`Filtro del finto non supportato: ${espressione}`)
  const [, colonna, operatore, valore] = atomo, dato = campo(r, colonna)
  if (operatore === 'is') return valore === 'null' ? dato == null : dato === valore
  if (dato == null) return false
  if (operatore === 'eq') return dato === valore
  if (operatore === 'gte') return compara(dato) >= compara(valore)
  if (operatore === 'lte') return compara(dato) <= compara(valore)
  return compara(dato) < compara(valore)
}

function fintoDb(tabelle: Record<string, Row[]>, guasti: Record<string, { code: string; message: string }> = {}) {
  const letture: { tabella: string; colonne: string; range?: [number, number] }[] = []
  const from = vi.fn((tabella: string) => {
    const filtri: ((r: Row) => boolean)[] = [], ordini: string[] = []
    const lettura = { tabella, colonne: '', range: undefined as [number, number] | undefined }
    let da = 0, a = 499
    const q = {
      select(colonne: string) { lettura.colonne = colonne; return q },
      eq(c: string, v: unknown) { filtri.push(r => campo(r, c) === v); return q },
      neq(c: string, v: unknown) { filtri.push(r => campo(r, c) !== v); return q },
      in(c: string, v: unknown[]) { filtri.push(r => v.includes(campo(r, c))); return q },
      is(c: string, v: unknown) { filtri.push(r => (campo(r, c) ?? null) === v); return q },
      not(c: string, op: string, v: unknown) { filtri.push(r => op === 'is' ? (campo(r, c) ?? null) !== v : campo(r, c) !== v); return q },
      overlaps(c: string, v: unknown[]) { filtri.push(r => Array.isArray(campo(r, c)) && (campo(r, c) as unknown[]).some(x => v.includes(x))); return q },
      gte(c: string, v: unknown) { filtri.push(r => compara(campo(r, c)) >= compara(v)); return q },
      lte(c: string, v: unknown) { filtri.push(r => compara(campo(r, c)) <= compara(v)); return q },
      lt(c: string, v: unknown) { filtri.push(r => compara(campo(r, c)) < compara(v)); return q },
      or(espressione: string) {
        filtri.push(r => filtroLogico(`or(${espressione})`, r))
        return q
      },
      order(c: string) { ordini.push(c); return q },
      range(inizio: number, fine: number) { da = inizio; a = fine; lettura.range = [da, a]; return q },
      then<T>(risolvi: (v: { data: Row[] | null; error: unknown }) => T): Promise<T> {
        letture.push(lettura)
        const dati = [...(tabelle[tabella] ?? [])].filter(r => filtri.every(f => f(r))).sort((x, y) => {
          for (const o of ordini) { const d = String(campo(x, o)).localeCompare(String(campo(y, o))); if (d) return d }
          return 0
        }).slice(da, a + 1)
        return Promise.resolve(risolvi({ data: guasti[tabella] ? null : dati, error: guasti[tabella] ?? null }))
      },
    }
    return q
  })
  return { db: { from }, letture }
}

function contesto(tabelle: Record<string, Row[]> = {}, opzioni: { classe?: boolean; dal?: string; al?: string; guasti?: Record<string, { code: string; message: string }> } = {}) {
  const mock = fintoDb(tabelle, opzioni.guasti)
  const ctx: ContestoStorico = {
    db: mock.db as unknown as ContestoStorico['db'], utente: { id: 'staff-a', role: 'segreteria', scuola_id: SCUOLA } as ContestoStorico['utente'],
    richiesta: { scuolaId: SCUOLA, ...(opzioni.classe ? { sectionId: CLASSE } : { alunnoId: A }), dal: opzioni.dal ?? '2026-01-01', al: opzioni.al ?? '2026-01-31', categorie: ['mensa_pasti'], formato: 'pdf', raggruppamento: 'alunno' },
    alunni: [{ id: A, nome: 'Nome inventato', cognome: 'Alunno prova', scuola_id: SCUOLA, section_id: CLASSE }],
    appartenenze: [{ alunno_id: A, scuola_id: SCUOLA, section_id: CLASSE, dal: '2026-01-10', al: '2026-01-20' }],
    scuolaNome: 'Scuola fittizia', titolo: 'Storico di prova', avvisi: [],
  }
  return { ctx, ...mock }
}

const comunicazioni = [
  ['comunicazioni_avvisi', 'avvisi'],
  ['comunicazioni_news', 'news_posts'],
  ['comunicazioni_galleria', 'galleria_media_v2'],
] as const
function contenutiRettificabili(tabella: string, righe: Row[]): Record<string, Row[]> {
  return {
    sections: [{ id: CLASSE, scuola_id: SCUOLA, name: 'Classe prova', school_type: 'primaria' }],
    [tabella]: righe.map(r => ({ scuola_id: SCUOLA, target_scope: 'globale', tag_students: [A], file_type: 'foto', file_url: 'uploads/prova.jpg', eliminato_il: null, file_rimosso_il: null, stato: 'pubblicata', ...r })),
  }
}

beforeEach(() => {
  audit.mockReset().mockResolvedValue({ tracciato: true })
  ricevutaPdf.mockReset().mockReturnValue(Buffer.from('%PDF-ricevuta-snapshot'))
  attestazionePdf.mockReset().mockReturnValue(Buffer.from('%PDF-attestazione'))
})

describe('adattatori dei servizi storici', () => {
  it('rispetta la sede e l’appartenenza storica semiaperta per ogni pasto', async () => {
    const righe = ['2026-01-09', '2026-01-10', '2026-01-19', '2026-01-20'].map((data, i) => ({ id: `p-${i}`, alunno_id: A, scuola_id: SCUOLA, data, stato: 'prenotato', ticket_scalato: 1 }))
    righe.push({ id: 'sede-estranea', alunno_id: A, scuola_id: 'altra-sede', data: '2026-01-15', stato: 'prenotato', ticket_scalato: 1 })
    const { ctx } = contesto({ mensa_prenotazioni: righe }, { classe: true })
    const s = await raccogliServizio(ctx, 'mensa_pasti')
    expect(s?.righe.map(r => r.data)).toEqual(['2026-01-10', '2026-01-19'])
    expect(s?.righe.every(r => r._alunno_id === A)).toBe(true)
  })

  it('conserva movimenti e addebiti della vecchia sede dopo trasferimento, escludendo nuova sede e giorni esterni', async () => {
    const { ctx } = contesto({
      mensa_ticket_movimenti: [
        { id: 'vecchia-sede', alunno_id: A, scuola_id: SCUOLA, data: '2026-01-12', tipo: 'ricarica', delta: 10 },
        { id: 'nuova-sede', alunno_id: A, scuola_id: 'nuova-sede', data: '2026-01-12', tipo: 'ricarica', delta: 999 },
        { id: 'prima', alunno_id: A, scuola_id: SCUOLA, data: '2026-01-09', tipo: 'ricarica', delta: 999 },
        { id: 'dopo', alunno_id: A, scuola_id: SCUOLA, data: '2026-01-20', tipo: 'ricarica', delta: 999 },
      ],
      pagamenti: [
        { id: 'p-vecchia', alunno_id: A, scuola_id: SCUOLA, tipo: 'singolo', importo: 100, scadenza: '2026-01-12', descrizione: 'Retta vecchia sede' },
        { id: 'p-nuova', alunno_id: A, scuola_id: 'nuova-sede', tipo: 'singolo', importo: 999, scadenza: '2026-01-12' },
        { id: 'p-fuori', alunno_id: A, scuola_id: SCUOLA, tipo: 'singolo', importo: 999, scadenza: '2026-01-20' },
      ],
    })
    ctx.alunni[0].scuola_id = 'nuova-sede'
    expect((await raccogliServizio(ctx, 'mensa_ticket'))?.righe.map(r => r.delta)).toEqual([10])
    expect((await raccogliServizio(ctx, 'contabilita_addebiti'))?.righe.map(r => r.importo)).toEqual([100])
    ctx.appartenenze[0].scuola_id = 'altra-sede'
    expect((await raccogliServizio(ctx, 'mensa_ticket'))?.righe).toEqual([])
  })

  it('pagina oltre 1000 righe e mantiene i movimenti con segno e saldo salvato', async () => {
    const movimenti = Array.from({ length: 1101 }, (_, i) => ({ id: String(i).padStart(5, '0'), alunno_id: A, scuola_id: SCUOLA, data: '2026-01-12', tipo: 'rettifica', delta: i % 2 ? -1 : 2, saldo_dopo: i }))
    const { ctx, letture } = contesto({ mensa_ticket_movimenti: movimenti })
    const s = await raccogliServizio(ctx, 'mensa_ticket')
    expect(s?.righe).toHaveLength(1101)
    expect(s?.righe[1]).toMatchObject({ delta: -1, saldo: 1 })
    expect(letture.map(l => l.range)).toEqual([[0, 499], [500, 999], [1000, 1499]])
  })

  it('fallisce sugli errori PostgREST senza trattarli come assenza dati', async () => {
    const { ctx } = contesto({}, { guasti: { mensa_prenotazioni: { code: '42501', message: 'Permesso negato' } } })
    await expect(raccogliServizio(ctx, 'mensa_pasti')).rejects.toMatchObject({ codice: 'LETTURA_FALLITA' })
  })

  it('esclude le voci padre e conserva lo storno nel criterio di cassa', async () => {
    const p = { id: 'pag-a', alunno_id: A, scuola_id: SCUOLA, tipo: 'singolo', descrizione: 'Retta gennaio', payment_categories: { slug: 'retta' } }
    const { ctx } = contesto({ incassi: [
      { id: 'i1', importo: 100, data_incasso: '2026-01-12', metodo: 'bonifico', pagamenti: p },
      { id: 'i2', importo: -20, storno_di: 'i1', data_incasso: '2026-01-14', metodo: 'bonifico', pagamenti: p },
      { id: 'i3', importo: 900, data_incasso: '2026-01-14', metodo: 'bonifico', pagamenti: { ...p, tipo: 'padre' } },
      { id: 'i4', importo: 500, data_incasso: '2026-01-14', metodo: 'bonifico', pagamenti: { ...p, alunno_id: B } },
    ] })
    const s = await raccogliServizio(ctx, 'contabilita_attestazioni')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ importo: 80, tracciabile: true, escluso: false })
    expect(attestazionePdf).not.toHaveBeenCalled()
    expect(s?.avvisi.join(' ')).toContain('anno solare completo')
  })

  it('non presenta importo_pagato corrente come incasso storico', async () => {
    const { ctx } = contesto({ pagamenti: [
      { id: 'p1', alunno_id: A, scuola_id: SCUOLA, tipo: 'singolo', descrizione: 'Voce', importo: 100, sconto: 10, importo_pagato: 90, scadenza: '2026-01-12', stato: 'pagato' },
      { id: 'padre', alunno_id: A, scuola_id: SCUOLA, tipo: 'padre', importo: 1000, scadenza: '2026-01-12' },
    ] })
    const s = await raccogliServizio(ctx, 'contabilita_situazione')
    expect(s?.righe[0]).toMatchObject({ addebiti: 90, incassi: 0, differenza: 90 })
    expect(s?.avvisi.join(' ')).toContain('non è il debito residuo')
  })

  it('blocca la lettura dei messaggi quando la vigilanza non viene registrata', async () => {
    audit.mockResolvedValue({ tracciato: false })
    const { ctx, letture } = contesto({ chat_threads: [{ id: 't1', student_id: A, alunni: { scuola_id: SCUOLA } }], chat_messages: [{ id: 'm1', thread_id: 't1', content: 'Testo fittizio', created_at: '2026-01-12T10:00:00Z' }] })
    await expect(raccogliServizio(ctx, 'comunicazioni_chat')).rejects.toMatchObject({ codice: 'VIGILANZA_NON_TRACCIABILE' })
    expect(letture.some(l => l.tabella === 'chat_messages')).toBe(false)
  })

  it('preserva testo e allegato privato della chat dopo audit e senza mark-read', async () => {
    const { ctx, letture } = contesto({ chat_threads: [{ id: 't1', student_id: A, parent_id: 'parent1', alunni: { scuola_id: SCUOLA } }], chat_messages: [{ id: 'm1', thread_id: 't1', sender_id: 'parent1', content: 'Testo fittizio', attachment_url: 'thread/file.pdf', attachment_type: 'documento', created_at: '2026-01-12T10:00:00Z' }] })
    const s = await raccogliServizio(ctx, 'comunicazioni_chat')
    expect(s?.righe[0]).toMatchObject({ testo: 'Testo fittizio', mittente: 'Genitore', _alunno_id: A })
    expect(s?.allegati[0]).toMatchObject({ bucket: 'chat-allegati', percorso: 'thread/file.pdf', alunnoId: A })
    expect(audit).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ alunnoId: A, scuolaId: SCUOLA }))
    expect(letture.filter(l => l.tabella === 'chat_messages')).toHaveLength(1)
  })

  it('galleria: include esclusivamente media vivi col tag alunno, anche nel dossier classe', async () => {
    const base = { scuola_id: SCUOLA, created_at: '2026-01-12T10:00:00Z', tag_students: [A], caption: 'Disegno fittizio', file_type: 'foto', file_url: 'uploads/foto.jpg', eliminato_il: null, file_rimosso_il: null }
    const { ctx } = contesto({ galleria_media_v2: [{ ...base, id: 'ok' }, { ...base, id: 'broadcast', tag_students: [], is_broadcast: true }, { ...base, id: 'altro', tag_students: [B] }, { ...base, id: 'eliminato', eliminato_il: '2026-02-01' }, { ...base, id: 'file-rimosso', file_rimosso_il: '2026-02-01' }] }, { classe: true })
    const s = await raccogliServizio(ctx, 'comunicazioni_galleria')
    expect(s?.righe).toHaveLength(1)
    expect(s?.allegati[0]).toMatchObject({ bucket: 'gallery', percorso: 'uploads/foto.jpg', alunnoId: A })
  })

  it.each([
    ['uploads/filmato.mp4', 'video/mp4', 'mp4'],
    ['uploads/filmato.webm', 'video/webm', 'webm'],
    ['uploads/filmato.mov', 'video/quicktime', 'mov'],
    ['uploads/video-senza-estensione', 'video/mp4', 'mp4'],
  ])('galleria video: conserva un riferimento privato riconoscibile per %s', async (percorso, mime, estensione) => {
    const { ctx } = contesto(contenutiRettificabili('galleria_media_v2', [{ id: 'video-galleria-1', file_type: 'video', file_url: percorso, caption: 'Laboratorio fittizio', giorno_competenza: '2026-01-12', created_at: '2026-01-13T10:00:00Z' }]), { dal: '2026-01-12', al: '2026-01-12' })
    const s = await raccogliServizio(ctx, 'comunicazioni_galleria')
    expect(s?.allegati).toEqual([expect.objectContaining({ bucket: 'gallery', percorso, nome: `Video-galleria-video-galleria-1.${estensione}`, mime, alunnoId: A })])
    expect(s?.righe[0]).toMatchObject({ riferimento: 'Video galleria video-galleria-1', originale: 'Riferimento al video privato', tipo: 'video' })
    expect(s?.colonne.some(c => c.chiave === 'riferimento')).toBe(true)
    expect(s?.avvisi.some(a => /originale.*non.*(?:disponibile|incorporato)/i.test(a))).toBe(false)
  })

  it('news video: il file privato conserva MIME e identificativo della scheda', async () => {
    const { ctx } = contesto({ ...contenutiRettificabili('news_posts', [{ id: 'news-video', giorno_competenza: '2026-01-12', pubblicata_il: '2026-01-13T10:00:00Z', titolo: 'Video del laboratorio' }]), news_media: [{ id: 'video-news-1', post_id: 'news-video', tipo: 'video', url: 'video/laboratorio.webm' }] }, { dal: '2026-01-12', al: '2026-01-12' })
    const s = await raccogliServizio(ctx, 'comunicazioni_news')
    expect(s?.allegati).toEqual([expect.objectContaining({ bucket: 'news', percorso: 'video/laboratorio.webm', nome: 'Video-news-video-news-1.webm', mime: 'video/webm', alunnoId: A })])
    expect(s?.righe[0].riferimenti).toBe('Video news video-news-1: riferimento al video privato')
    expect(s?.colonne.some(c => c.chiave === 'riferimenti')).toBe(true)
    expect(s?.avvisi.some(a => /originale.*non.*(?:disponibile|incorporato)/i.test(a))).toBe(false)
  })

  it.each([
    ['youtube', 'https://www.youtube.com/watch?v=filmato-fittizio'],
    ['vimeo', 'https://vimeo.com/123456789'],
    ['video', 'https://video.example.org/laboratorio.mp4'],
  ])('news video esterno %s: conserva il collegamento senza download o falso originale mancante', async (tipo, url) => {
    const fetchEsterno = vi.fn().mockRejectedValue(new Error('I video esterni non devono essere scaricati'))
    vi.stubGlobal('fetch', fetchEsterno)
    try {
      const { ctx } = contesto({ ...contenutiRettificabili('news_posts', [{ id: 'news-video', giorno_competenza: '2026-01-12', pubblicata_il: '2026-01-13T10:00:00Z', titolo: 'Video esterno del laboratorio' }]), news_media: [{ id: 'video-esterno-1', post_id: 'news-video', tipo, url }] }, { dal: '2026-01-12', al: '2026-01-12' })
      const s = await raccogliServizio(ctx, 'comunicazioni_news')
      expect(fetchEsterno).not.toHaveBeenCalled()
      expect(s?.allegati).toEqual([])
      expect(s?.righe[0].riferimenti).toBe(`Video news video-esterno-1 (esterno): ${url}`)
      expect(s?.avvisi.some(a => /originale.*non.*(?:disponibile|incorporato)/i.test(a))).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })

  it('non include una notifica dello stesso genitore riferita all’altro figlio', async () => {
    const { ctx } = contesto({ utenti: [{ id: 'parent1', ruolo: 'genitore' }], notifiche: [
      { id: 'n1', utente_id: 'parent1', entita_tipo: 'diario', entita_id: A, titolo: 'Aggiornamento A', creato_il: '2026-01-12T10:00:00Z' },
      { id: 'n2', utente_id: 'parent1', entita_tipo: 'diario', entita_id: B, titolo: 'Aggiornamento B', creato_il: '2026-01-12T10:00:00Z' },
      { id: 'n3', utente_id: 'parent1', entita_tipo: null, entita_id: null, titolo: 'Generica', creato_il: '2026-01-12T10:00:00Z' },
    ] })
    const s = await raccogliServizio(ctx, 'comunicazioni_notifiche')
    expect(s?.righe.map(r => r.titolo)).toEqual(['Aggiornamento A'])
  })

  it('avvisi scaduti: risolve target della classe nel giorno storico e formato allegato JSON', async () => {
    const { ctx } = contesto({ sections: [{ id: CLASSE, scuola_id: SCUOLA, name: 'Primaria A', school_type: 'primaria' }], avvisi: [
      { id: 'av1', scuola_id: SCUOLA, target_scope: 'classi', target_classes: ['Primaria A'], created_at: '2026-01-12T10:00:00Z', scadenza: '2026-01-13', titolo: 'Avviso storico', contenuto: 'Testo originale', attachment_url: JSON.stringify({ file: 'documenti/prova.pdf', link: null }) },
      { id: 'av2', scuola_id: SCUOLA, target_scope: 'classi', target_classes: ['Primaria B'], created_at: '2026-01-12T10:00:00Z', titolo: 'Non pertinente' },
    ] }, { classe: true })
    const s = await raccogliServizio(ctx, 'comunicazioni_avvisi')
    expect(s?.righe.map(r => r.titolo)).toEqual(['Avviso storico'])
    expect(s?.allegati[0]).toMatchObject({ bucket: 'avvisi_allegati', percorso: 'documenti/prova.pdf', alunnoId: A })
  })

  it.each([
    ['comunicazioni_avvisi', 'avvisi'],
    ['comunicazioni_news', 'news_posts'],
  ] as const)('%s: conserva il target del nome storico dopo rimozione della classe, senza inventare il grado', async (categoria, tabella) => {
    const { ctx } = contesto({ ...contenutiRettificabili(tabella, [
      { id: 'nome-storico', titolo: 'Destinato alla classe rimossa', target_scope: 'classi', target_classes: ['Classe rimossa prova'], created_at: '2026-01-12T10:00:00Z', pubblicata_il: '2026-01-12T10:00:00Z' },
      { id: 'altro-nome', titolo: 'Destinato a un’altra classe', target_scope: 'classi', target_classes: ['Classe diversa'], created_at: '2026-01-12T10:00:00Z', pubblicata_il: '2026-01-12T10:00:00Z' },
      { id: 'altra-sede', titolo: 'Destinato alla classe di un altro plesso', target_scope: 'classi', target_classes: ['Classe altro plesso'], created_at: '2026-01-12T10:00:00Z', pubblicata_il: '2026-01-12T10:00:00Z' },
      { id: 'grado-non-documentato', titolo: 'Grado non determinabile dal nome', target_scope: 'grado', target_gradi: ['primaria'], created_at: '2026-01-12T10:00:00Z', pubblicata_il: '2026-01-12T10:00:00Z' },
    ]), sections: [] }, { classe: true })
    ctx.appartenenze[0].section_nome = 'Classe rimossa prova'
    ctx.appartenenze.push({ ...ctx.appartenenze[0], scuola_id: 'altro-plesso', section_id: 'classe-altro-plesso', section_nome: 'Classe altro plesso' })
    const s = await raccogliServizio(ctx, categoria)
    expect(s?.righe.map(r => r.titolo)).toEqual(['Destinato alla classe rimossa'])
    expect(s?.righe[0]._alunno_id).toBe(A)
  })

  it('non anticipa il contenuto di una risposta successiva al periodo', async () => {
    const { ctx } = contesto({ avvisi_risposte: [{ id: 'r1', student_id: A, parent_id: 'p1', letto_il: '2026-01-15T10:00:00Z', risposto_il: '2026-02-10T10:00:00Z', risposta: 'si', avvisi: { scuola_id: SCUOLA, titolo: 'Circolare' } }] })
    const s = await raccogliServizio(ctx, 'comunicazioni_risposte')
    expect(s?.righe[0]).toMatchObject({ letto: '2026-01-15T10:00:00Z', risposta: '', risposto: '' })
  })

  it('avvisi globali: non attribuisce all’alunno avvisi precedenti alla sua appartenenza', async () => {
    const { ctx } = contesto({ avvisi: [
      { id: 'prima', scuola_id: SCUOLA, target_scope: 'globale', created_at: '2026-01-05T10:00:00Z', titolo: 'Prima dell’ingresso' },
      { id: 'durante', scuola_id: SCUOLA, target_scope: 'globale', created_at: '2026-01-15T10:00:00Z', titolo: 'Durante l’appartenenza' },
      { id: 'dopo', scuola_id: SCUOLA, target_scope: 'globale', created_at: '2026-01-25T10:00:00Z', titolo: 'Dopo il trasferimento' },
    ] })
    expect((await raccogliServizio(ctx, 'comunicazioni_avvisi'))?.righe.map(r => r.titolo)).toEqual(['Durante l’appartenenza'])
  })

  it('esclude protocolli per coordinator prima di interrogare qualsiasi contenuto', async () => {
    const { ctx, letture } = contesto()
    ctx.utente.role = 'coordinator'
    const s = await raccogliServizio(ctx, 'documenti_protocolli')
    expect(s?.righe).toEqual([])
    expect(letture).toEqual([])
    expect(s?.avvisi.join(' ')).toContain('riservato')
  })

  it.each(['admin', 'segreteria'] as const)('protocolli: il ruolo reale %s autorizza anche nella veste genitore', async ruolo => {
    const { ctx, letture } = contesto({ storici_collegamenti: [{ id: 'l1', scuola_id: SCUOLA, alunno_id: A, tipo: 'protocollo', entita_id: 'pr1' }], protocolli: [{ id: 'pr1', scuola_id: SCUOLA, numero: 5, anno: 2026, data_registrazione: '2026-01-12T10:00:00Z', oggetto: 'Documento fittizio', file_originale: '2026/5/originale.pdf', file_timbrato: '2026/5/timbrato.pdf' }] })
    ctx.utente.role = 'genitore'
    ctx.utente.ruoli = [ruolo, 'genitore']
    const s = await raccogliServizio(ctx, 'documenti_protocolli')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ numero: '5/2026', oggetto: 'Documento fittizio' })
    expect(letture.some(l => l.tabella === 'protocolli')).toBe(true)
  })

  it('protocolli: il coordinator nella veste genitore resta escluso prima di qualsiasi lettura', async () => {
    const { ctx, letture } = contesto()
    ctx.utente.role = 'genitore'
    ctx.utente.ruoli = ['coordinator', 'genitore']
    const s = await raccogliServizio(ctx, 'documenti_protocolli')
    expect(s?.righe).toEqual([])
    expect(s?.avvisi.join(' ')).toContain('riservato')
    expect(letture).toEqual([])
  })

  it('protocolli: esige link esplicito, filtra sede e restituisce originali e timbrati', async () => {
    const { ctx } = contesto({ storici_collegamenti: [{ id: 'l1', scuola_id: SCUOLA, alunno_id: A, tipo: 'protocollo', entita_id: 'pr1' }], protocolli: [
      { id: 'pr1', scuola_id: SCUOLA, numero: 5, anno: 2026, data_registrazione: '2026-01-12T10:00:00Z', oggetto: 'Documento fittizio', file_originale: '2026/5/originale.pdf', file_timbrato: '2026/5/timbrato.pdf' },
      { id: 'pr2', scuola_id: SCUOLA, numero: 6, anno: 2026, data_registrazione: '2026-01-12T10:00:00Z', oggetto: 'Documento non collegato' },
    ] })
    const s = await raccogliServizio(ctx, 'documenti_protocolli')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ numero: '5/2026', oggetto: 'Documento fittizio' })
    expect(s?.allegati).toHaveLength(2)
  })

  it('audit: non carica valori prima/dopo né operazioni di classe o di altri alunni', async () => {
    const { ctx, letture } = contesto({ presenze: [{ id: 'presenza-a', alunno_id: A, scuola_id: SCUOLA }], audit_scritture_docente: [
      { id: 'a1', scuola_id: SCUOLA, entita_tipo: 'presenze', entita_id: 'presenza-a', azione: 'update', creato_il: '2026-01-12T10:00:00Z' },
      { id: 'a2', scuola_id: SCUOLA, entita_tipo: 'presenze', entita_id: 'presenza-b', azione: 'update', creato_il: '2026-01-12T10:00:00Z' },
      { id: 'a3', scuola_id: SCUOLA, entita_tipo: 'registro', entita_id: 'classe-a', azione: 'update', creato_il: '2026-01-12T10:00:00Z' },
    ] })
    const s = await raccogliServizio(ctx, 'servizi_audit')
    expect(s?.righe).toHaveLength(1)
    expect(letture.filter(l => l.tabella === 'audit_scritture_docente').every(l => !l.colonne.includes('valore_'))).toBe(true)
  })

  it('rigenera una ricevuta esistente dal suo snapshot senza mutazioni o nuova numerazione', async () => {
    const snapshot = { id: 'r1', alunno_id: A, scuola_id: SCUOLA, numero: 8, anno: 2026, importo: 80, creato_il: '2026-01-12T10:00:00Z', metodi: ['bonifico'], intestatario: { nome: 'Persona fittizia' }, dati_struttura: { denominazione: 'Scuola dello snapshot' }, righe: [{ figlio: 'Nome dello snapshot', descrizione: 'Causale originaria', importo: 80 }] }
    const { ctx } = contesto({ ricevute_emesse: [snapshot] })
    const s = await raccogliServizio(ctx, 'contabilita_ricevute')
    expect(ricevutaPdf).toHaveBeenCalledWith(expect.objectContaining({ numero: 8, anno: 2026, importoTotale: 80, struttura: expect.objectContaining({ denominazione: 'Scuola dello snapshot' }), righe: [expect.objectContaining({ descrizione: 'Causale originaria' })] }))
    expect(s?.generati?.[0]).toMatchObject({ nome: 'Ricevuta-8-2026.pdf', alunnoId: A, mime: 'application/pdf' })
    expect(Buffer.from(s!.generati![0].base64, 'base64').toString()).toBe('%PDF-ricevuta-snapshot')
  })

  it('ricevute familiari: segue la transazione e impedisce di esportare lo snapshot con un altro figlio', async () => {
    const pagamentiA = { alunno_id: A, scuola_id: SCUOLA }, pagamentiB = { alunno_id: B, scuola_id: SCUOLA }
    const ricevute = [{ id: 'r-fam', transazione_id: 'tx1', alunno_id: null, scuola_id: SCUOLA, numero: 9, anno: 2026, importo: 100, creato_il: '2026-01-12T10:00:00Z', righe: [{ figlio: 'Figlio A fittizio', descrizione: 'Quota A', importo: 80 }, { figlio: 'Figlio B fittizio', descrizione: 'Quota B', importo: 20 }] }]
    const { ctx } = contesto({ ricevute_emesse: ricevute, incassi: [{ id: 'i1', transazione_id: 'tx1', pagamenti: pagamentiA }, { id: 'i2', transazione_id: 'tx1', pagamenti: pagamentiB }] })
    const s = await raccogliServizio(ctx, 'contabilita_ricevute')
    expect(ricevutaPdf).not.toHaveBeenCalled()
    expect(s?.generati ?? []).toEqual([])
    expect(s?.avvisi.join(' ')).toContain('fuori dalla selezione')
  })

  it('ricevute familiari: rigenera da transazione univoca anche senza alunno_id nello snapshot', async () => {
    const { ctx } = contesto({ ricevute_emesse: [{ id: 'r-fam', transazione_id: 'tx1', alunno_id: null, scuola_id: SCUOLA, numero: 9, anno: 2026, importo: 80, creato_il: '2026-01-12T10:00:00Z', righe: [{ figlio: 'Figlio A fittizio', descrizione: 'Quota A', importo: 80 }] }], incassi: [{ id: 'i1', transazione_id: 'tx1', pagamenti: { alunno_id: A, scuola_id: SCUOLA } }] })
    const s = await raccogliServizio(ctx, 'contabilita_ricevute')
    expect(s?.righe[0]).toMatchObject({ numero: '9/2026', importo: 80, _alunno_id: A })
    expect(s?.generati?.[0]).toMatchObject({ nome: 'Ricevuta-9-2026.pdf', alunnoId: A })
    expect(ricevutaPdf).toHaveBeenCalledWith(expect.objectContaining({ righe: [expect.objectContaining({ descrizione: 'Quota A' })] }))
  })

  it('menù: usa assegnazione datata, alternativa del giorno e portate leggibili', async () => {
    const { ctx, letture } = contesto({
      admin_settings: [{ scuola_id: SCUOLA, mensa_giorni_attivi: [1, 2, 3, 4, 5], mensa_settimane_rotazione: 4 }],
      sections: [{ id: CLASSE, scuola_id: SCUOLA, name: 'Classe prova' }],
      mensa_class_menu_assignment: [{ id: 'as1', scuola_id: SCUOLA, classe: 'Classe prova', menu_config_id: 'menu1', attivo_dal: '2026-01-01' }],
      mensa_menu_override: [{ id: 'ov1', scuola_id: SCUOLA, menu_config_id: 'menu1', data: '2026-01-12', chiuso: false, portate: { primo: 'Pasta di prova', secondo: 'Pollo di prova', contorno: 'Carote' }, allergeni: { primo: ['glutine'] }, ingredienti: { primo: 'Pasta, pomodoro' } }],
    }, { dal: '2026-01-12', al: '2026-01-12' })
    const s = await raccogliServizio(ctx, 'mensa_menu')
    expect(s?.righe[0]).toMatchObject({ primo: 'Pasta di prova', secondo: 'Pollo di prova', contorno: 'Carote', ingredienti: 'primo: Pasta, pomodoro', allergeni: 'primo: glutine', _alunno_id: A })
    expect(s?.avvisi.join(' ')).toContain('non certifica')
    expect(letture.find(l => l.tabella === 'admin_settings')?.colonne).not.toMatch(/\bid\b/)
  })

  it('menù: errore lettura configurazione non diventa un menù vuoto dichiarato valido', async () => {
    const { ctx } = contesto({}, { guasti: { admin_settings: { code: '42501', message: 'Permesso negato' } } })
    await expect(raccogliServizio(ctx, 'mensa_menu')).rejects.toMatchObject({ codice: 'LETTURA_FALLITA' })
  })

  it('news: il target è quello della classe documentata, con originali e senza media di altri post', async () => {
    const { ctx } = contesto({ sections: [{ id: CLASSE, scuola_id: SCUOLA, name: 'Classe prova', school_type: 'primaria' }], news_posts: [
      { id: 'news1', scuola_id: null, target_scope: 'grado', target_gradi: ['primaria'], pubblicata_il: '2026-01-12T10:00:00Z', titolo: 'News primaria', contenuto_testo: 'Testo della news', stato: 'pubblicata' },
      { id: 'news2', scuola_id: null, target_scope: 'grado', target_gradi: ['infanzia'], pubblicata_il: '2026-01-12T10:00:00Z', titolo: 'Altra news', stato: 'pubblicata' },
    ], news_media: [{ id: 'media1', post_id: 'news1', url: 'immagini/foto.jpg', tipo: 'immagine' }, { id: 'media2', post_id: 'news2', url: 'immagini/estranea.jpg', tipo: 'immagine' }] }, { classe: true })
    const s = await raccogliServizio(ctx, 'comunicazioni_news')
    expect(s?.righe.map(r => r.titolo)).toEqual(['News primaria'])
    expect(s?.allegati.map(a => a.percorso)).toEqual(['immagini/foto.jpg'])
  })

  it('ordini: usa prezzi e nomi snapshot delle righe, senza rileggere il catalogo corrente', async () => {
    const { ctx, letture } = contesto({ divise_ordini: [{ id: 'o1', alunno_id: A, scuola_id: SCUOLA, creato_il: '2026-01-12T10:00:00Z', stato: 'consegnato', totale: 30 }], divise_ordini_righe: [{ id: 'or1', ordine_id: 'o1', articolo_nome: 'Polo originaria', taglia: '6 anni', quantita: 2, prezzo_unitario: 15 }] })
    const s = await raccogliServizio(ctx, 'servizi_ordini')
    expect(s?.righe[0]).toMatchObject({ articolo: 'Polo originaria', prezzo: 15, quantita: 2, subtotale: 30 })
    expect(letture.some(l => l.tabella === 'divise_articoli')).toBe(false)
  })

  it('fatture: conserva sezionale, numero e anno senza cambiare sede nel join', async () => {
    const base = { scuola_id: SCUOLA, sezionale: 'KV', numero: 19, anno: 2026, causale: 'Causale originaria', importo: 80, creato_il: '2026-01-12T10:00:00Z', pdf_path: 'KV/2026/19.pdf' }
    const { ctx } = contesto({ fatture_emesse: [{ ...base, id: 'f1', pagamenti: { alunno_id: A, scuola_id: SCUOLA } }, { ...base, id: 'f2', pagamenti: { alunno_id: A, scuola_id: 'altra-sede' } }] })
    const s = await raccogliServizio(ctx, 'contabilita_fatture')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ numero: 'KV/19/2026', causale: 'Causale originaria' })
    expect(s?.allegati[0]).toMatchObject({ bucket: 'fatture', percorso: 'KV/2026/19.pdf', alunnoId: A })
  })

  it('genera attestazione annuale dal netto incassi e dai dati fiscali autorizzati', async () => {
    const { ctx } = contesto({
      incassi: [{ id: 'i1', importo: 100, data_incasso: '2026-01-12', metodo: 'bonifico', pagamenti: { alunno_id: A, scuola_id: SCUOLA, tipo: 'singolo', descrizione: 'Retta annuale di prova', payment_categories: { slug: 'retta' } } }],
      alunni: [{ id: A, scuola_id: SCUOLA, nome: 'Nome fittizio', cognome: 'Cognome fittizio', intestatario_fatture: { tipo: 'altro', dati: { nome: 'Persona', cognome: 'Fittizia' } } }],
      admin_settings: [{ scuola_id: SCUOLA, fiscale_config: {}, aruba_config: {} }],
    }, { dal: '2026-01-01', al: '2026-12-31' })
    const s = await raccogliServizio(ctx, 'contabilita_attestazioni')
    expect(attestazionePdf).toHaveBeenCalledWith(expect.objectContaining({ anno: 2026, versato: 100, detraibile: 100, intestatario: expect.objectContaining({ nome: 'Persona Fittizia' }) }))
    expect(s?.generati?.[0]).toMatchObject({ alunnoId: A, nome: `Attestazione-2026-${A}.pdf` })
  })

  it('data di Roma: include messaggi della mezzanotte locale ed esclude il giorno dopo', async () => {
    const { ctx } = contesto({ chat_threads: [{ id: 't1', student_id: A, alunni: { scuola_id: SCUOLA } }], chat_messages: [
      { id: 'm1', thread_id: 't1', content: 'Inizio giornata', created_at: '2026-01-11T23:05:00Z' },
      { id: 'm2', thread_id: 't1', content: 'Giorno successivo', created_at: '2026-01-12T23:05:00Z' },
    ] }, { dal: '2026-01-12', al: '2026-01-12' })
    expect((await raccogliServizio(ctx, 'comunicazioni_chat'))?.righe.map(r => r.testo)).toEqual(['Inizio giornata'])
  })

  it.each(comunicazioni)('%s: seleziona competenza di ieri anche quando registrata oggi, con fallback legacy e isolamento sede', async (categoria, tabella) => {
    const ieri = '2026-01-12T10:00:00Z', oggi = '2026-01-13T10:00:00Z'
    const { ctx } = contesto(contenutiRettificabili(tabella, [
      { id: 'retro', titolo: 'Rettifica di ieri', caption: 'Rettifica di ieri', giorno_competenza: '2026-01-12', created_at: oggi, pubblicata_il: oggi },
      { id: 'legacy', titolo: 'Legacy di ieri', caption: 'Legacy di ieri', giorno_competenza: null, created_at: ieri, pubblicata_il: ieri },
      { id: 'competenza-esterna', titolo: 'Competenza di oggi', caption: 'Competenza di oggi', giorno_competenza: '2026-01-13', created_at: ieri, pubblicata_il: ieri },
      { id: 'legacy-esterno', titolo: 'Legacy di oggi', caption: 'Legacy di oggi', giorno_competenza: null, created_at: oggi, pubblicata_il: oggi },
      { id: 'altra-sede', titolo: 'Dato esterno', caption: 'Dato esterno', scuola_id: 'sede-b', giorno_competenza: '2026-01-12', created_at: oggi, pubblicata_il: oggi },
    ]), { dal: '2026-01-12', al: '2026-01-12', classe: true })
    const s = await raccogliServizio(ctx, categoria)
    expect(s?.righe).toHaveLength(2)
    expect(s?.righe.map(r => r.titolo ?? r.didascalia).sort()).toEqual(['Legacy di ieri', 'Rettifica di ieri'])
    expect(s?.righe.every(r => r.data === '2026-01-12')).toBe(true)
    expect(s?.righe.find(r => (r.titolo ?? r.didascalia) === 'Rettifica di ieri')?.registrata).toBe(oggi)
    ctx.richiesta.dal = '2026-01-13'; ctx.richiesta.al = '2026-01-13'
    const odierno = await raccogliServizio(ctx, categoria)
    expect(odierno?.righe.map(r => r.titolo ?? r.didascalia).sort()).toEqual(['Competenza di oggi', 'Legacy di oggi'])
  })

  it.each(comunicazioni)('%s: pagina più di mille competenze nel periodo con timestamp reale esterno', async (categoria, tabella) => {
    const righe = Array.from({ length: 1101 }, (_, i) => ({ id: String(i).padStart(5, '0'), titolo: `Voce ${i}`, caption: `Voce ${i}`, giorno_competenza: '2026-01-12', created_at: '2026-01-13T10:00:00Z', pubblicata_il: '2026-01-13T10:00:00Z' }))
    const { ctx, letture } = contesto(contenutiRettificabili(tabella, righe), { dal: '2026-01-12', al: '2026-01-12' })
    const s = await raccogliServizio(ctx, categoria)
    expect(s?.righe).toHaveLength(1101)
    expect(letture.filter(l => l.tabella === tabella).map(l => l.range)).toEqual([[0, 499], [500, 999], [1000, 1499]])
  })

  for (const [data, inizio, fine] of [
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
  ]) it.each(comunicazioni)(`%s: fallback legacy rispetta i confini DST del ${data}`, async (categoria, tabella) => {
    const date = [new Date(Date.parse(inizio) - 1).toISOString(), inizio, new Date(Date.parse(fine) - 1).toISOString(), fine]
    const { ctx } = contesto(contenutiRettificabili(tabella, date.map((istante, i) => ({ id: `r${i}`, giorno_competenza: null, created_at: istante, pubblicata_il: istante }))), { dal: data, al: data })
    ctx.appartenenze[0].dal = '2026-01-01'; ctx.appartenenze[0].al = null
    const s = await raccogliServizio(ctx, categoria)
    expect(s?.righe.map(r => r.registrata).sort()).toEqual([date[1], date[2]].sort())
    expect(s?.righe.every(r => r.data === data)).toBe(true)
  })

  it('news globali: include solo le appartenenze documentate nella sede richiesta', async () => {
    const { ctx } = contesto(contenutiRettificabili('news_posts', [{ id: 'globale', scuola_id: null, target_scope: 'globale', giorno_competenza: '2026-01-12', pubblicata_il: '2026-01-13T10:00:00Z' }]), { dal: '2026-01-12', al: '2026-01-12' })
    ctx.appartenenze[0].scuola_id = 'altra-sede'
    expect((await raccogliServizio(ctx, 'comunicazioni_news'))?.righe).toEqual([])
  })

  it('ordini vecchi: esporta la consegna di ieri anche se la testata è precedente al periodo', async () => {
    const ordine = { id: 'ordine-vecchio', alunno_id: A, scuola_id: SCUOLA }
    const { ctx } = contesto({
      divise_ordini: [{ ...ordine, creato_il: '2025-12-01T10:00:00Z', stato: 'consegnato' }],
      divise_ordini_righe: [{ id: 'r1', ordine_id: ordine.id, articolo_nome: 'Polo dello snapshot', taglia: '6 anni', quantita: 2, prezzo_unitario: 15, ordinato_il: '2025-12-10T10:00:00Z', arrivato_il: '2026-01-11T10:00:00Z', consegnato_il: '2026-01-12T10:00:00Z', ordine }],
    }, { dal: '2026-01-12', al: '2026-01-12' })
    const ieri = await raccogliServizio(ctx, 'servizi_ordini')
    expect(ieri?.righe).toHaveLength(1)
    expect(ieri?.righe[0]).toMatchObject({ data: '2026-01-12T10:00:00Z', evento: 'Consegna alla famiglia', stato: 'Consegnato', articolo: 'Polo dello snapshot', subtotale: 30 })
    ctx.richiesta.dal = '2026-01-13'; ctx.richiesta.al = '2026-01-13'
    expect((await raccogliServizio(ctx, 'servizi_ordini'))?.righe).toEqual([])
  })

  it('ordini: non anticipa lo stato di una consegna futura nell’evento di registrazione', async () => {
    const ordine = { id: 'ordine-a', alunno_id: A, scuola_id: SCUOLA, creato_il: '2026-01-12T10:00:00Z', stato: 'consegnato' }
    const { ctx } = contesto({ divise_ordini: [ordine], divise_ordini_righe: [{ id: 'r1', ordine_id: ordine.id, articolo_nome: 'Polo originaria', quantita: 1, prezzo_unitario: 15, consegnato_il: '2026-01-13T10:00:00Z', ordine }] }, { dal: '2026-01-12', al: '2026-01-12' })
    const s = await raccogliServizio(ctx, 'servizi_ordini')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ evento: 'Ordine registrato', stato: 'Registrato' })
    expect(s?.righe.some(r => r.stato === 'Consegnato')).toBe(false)
  })

  it('avanzamenti ordini: applica sede e appartenenza al giorno dell’evento, anche dopo trasferimento', async () => {
    const ordine = { id: 'ordine-vecchio', alunno_id: A, scuola_id: SCUOLA }
    const riga = { articolo_nome: 'Polo originaria', quantita: 1, prezzo_unitario: 15 }
    const { ctx } = contesto({ divise_ordini_righe: [
      { ...riga, id: 'ok', ordine, consegnato_il: '2026-01-12T10:00:00Z' },
      { ...riga, id: 'altra-sede', ordine: { ...ordine, scuola_id: 'sede-b' }, consegnato_il: '2026-01-12T10:00:00Z' },
      { ...riga, id: 'prima', ordine, consegnato_il: '2026-01-09T10:00:00Z' },
      { ...riga, id: 'dopo', ordine, consegnato_il: '2026-01-20T10:00:00Z' },
    ] })
    ctx.alunni[0].scuola_id = 'sede-b'
    const s = await raccogliServizio(ctx, 'servizi_ordini')
    expect(s?.righe).toHaveLength(1)
    expect(s?.righe[0]).toMatchObject({ data: '2026-01-12T10:00:00Z', stato: 'Consegnato' })
  })

  it('avanzamenti ordini: legge tutte le pagine senza dipendere dalla data di creazione della testata', async () => {
    const righe = Array.from({ length: 1101 }, (_, i) => ({ id: String(i).padStart(5, '0'), articolo_nome: 'Articolo snapshot', quantita: 1, prezzo_unitario: 15, consegnato_il: '2026-01-12T10:00:00Z', ordine: { id: 'ordine-vecchio', alunno_id: A, scuola_id: SCUOLA } }))
    const { ctx, letture } = contesto({ divise_ordini_righe: righe }, { dal: '2026-01-12', al: '2026-01-12' })
    expect((await raccogliServizio(ctx, 'servizi_ordini'))?.righe).toHaveLength(1101)
    expect(letture.filter(l => l.tabella === 'divise_ordini_righe').map(l => l.range)).toEqual([[0, 499], [500, 999], [1000, 1499]])
  })

  it.each<CategoriaStorico>(['servizi_armadietto', 'servizi_ordini', 'comunicazioni_news', 'mensa_menu', 'contabilita_fatture', 'contabilita_solleciti'])('fornisce colonne leggibili per %s anche senza dati', async categoria => {
    const { ctx } = contesto()
    const s = await raccogliServizio(ctx, categoria)
    expect(s).not.toBeNull()
    expect(s!.colonne.length).toBeGreaterThan(2)
    expect(s!.colonne.some(c => /json|payload|tabella/i.test(c.titolo))).toBe(false)
  })
})
