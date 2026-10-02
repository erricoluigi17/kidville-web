import { beforeEach, describe, expect, it, vi } from 'vitest'

// =============================================================================
// L'AVVISO ALLE FAMIGLIE QUANDO UN CONTENUTO ENTRA IN GALLERIA — in un posto solo.
//
// Stava dentro `POST /api/gallery`, scritto per le foto. Ora lo usano le foto e — appena la
// conversione finisce — i video, che si pubblicano sul server senza nessuna richiesta
// dell'insegnante in mezzo. Stessa funzione, stesso testo.
//
// ─── COSA PROVA QUESTO FILE ──────────────────────────────────────────────────
// A. IL TESTO è fisso e non nomina niente: la funzione non riceve una didascalia né il
//    nome di un file, quindi non può metterli nel messaggio (decisione del titolare,
//    2026-10-02: titolo «Nuovi contenuti in galleria», corpo senza nomi di file).
// B. CHI RICEVE, in ordine: i genitori dei bambini taggati; altrimenti quelli delle classi;
//    altrimenti quelli di tutta la sede. Mai tutti e tre insieme.
// C. LA RAFFICA COLLASSA: `entitaId` è l'INSEGNANTE (non il media), `bufferMin` 30 e il
//    debounce attivo — e quel debounce è PER DESTINATARIO (#131): provato col vero
//    `notificaEvento`, sopra un finto database che registra le `delete`.
// D. MAI UN'ECCEZIONE VERSO CHI CHIAMA, ma mai un guasto muto: `null` e una riga `error`.
// =============================================================================

const h = vi.hoisted(() => ({
  notifica: vi.fn(),
  alunni: vi.fn(),
  classi: vi.fn(),
  scuola: vi.fn(),
  log: vi.fn(),
  accoda: vi.fn(),
}))
vi.mock('@/lib/logging/logger', () => ({ logEvento: h.log, logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/notifiche/destinatari', () => ({
  genitoriDiAlunni: h.alunni,
  genitoriDiClassi: h.classi,
  genitoriDiScuola: h.scuola,
}))
vi.mock('@/lib/notifiche/triggers', () => ({ notificaEvento: h.notifica }))
// Le due foglie del VERO `notificaEvento`, usate solo dall'ultimo blocco: il toggle per scuola
// (qui sempre acceso) e l'accodamento (una spia, che registra cosa partirebbe).
vi.mock('@/lib/notifiche/config', () => ({ isNotificaAbilitata: async () => true }))
vi.mock('@/lib/push/enqueue', () => ({ enqueueNotifiche: h.accoda }))

import {
  CORPO_NOTIFICA_GENITORI_GALLERIA,
  MINUTI_BUFFER_NOTIFICA_GENITORI_GALLERIA,
  TITOLO_NOTIFICA_GENITORI_GALLERIA,
  notificaGenitoriGalleria,
} from '@/lib/gallery/notifica-genitori'

const SEDE = 'aaaaaaaa-0000-4000-8000-00000000000a'
const AUTORE = '22222222-2222-4222-8222-222222222222'
const ALU_1 = 'a1a1a1a1-1111-4111-8111-aaaaaaaaaaaa'
const ALU_2 = 'a2a2a2a2-2222-4222-8222-aaaaaaaaaaaa'
const G1 = 'f1f1f1f1-1111-4111-8111-ffffffffffff'
const G2 = 'f2f2f2f2-2222-4222-8222-ffffffffffff'
const G3 = 'f3f3f3f3-3333-4333-8333-ffffffffffff'
const SUPABASE = { finto: true } as never

beforeEach(() => {
  vi.clearAllMocks()
  h.notifica.mockResolvedValue(undefined)
  h.alunni.mockResolvedValue([G1, G2])
  h.classi.mockResolvedValue([G3])
  h.scuola.mockResolvedValue([G1, G2, G3])
})

const chiama = (extra: Partial<Parameters<typeof notificaGenitoriGalleria>[1]> = {}) =>
  notificaGenitoriGalleria(SUPABASE, {
    scuolaId: SEDE,
    uploadedBy: AUTORE,
    tagAlunni: [ALU_1, ALU_2],
    classi: [],
    operazione: 'gallery:POST',
    ...extra,
  })

describe('il testo: fisso, e non nomina niente', () => {
  it('titolo «Nuovi contenuti in galleria» e corpo «Ci sono nuovi contenuti nella galleria.»', async () => {
    expect(TITOLO_NOTIFICA_GENITORI_GALLERIA).toBe('Nuovi contenuti in galleria')
    expect(CORPO_NOTIFICA_GENITORI_GALLERIA).toBe('Ci sono nuovi contenuti nella galleria.')

    await chiama()
    expect(h.notifica).toHaveBeenCalledTimes(1)
    const params = h.notifica.mock.calls[0][1]
    expect(params.titolo).toBe('Nuovi contenuti in galleria')
    expect(params.corpo).toBe('Ci sono nuovi contenuti nella galleria.')
  })

  it('l’intera richiesta di notifica è quella attesa, campo per campo', async () => {
    await chiama()
    expect(h.notifica).toHaveBeenCalledWith(SUPABASE, {
      tipo: 'galleria',
      scuolaId: SEDE,
      utenteIds: [G1, G2],
      titolo: 'Nuovi contenuti in galleria',
      corpo: 'Ci sono nuovi contenuti nella galleria.',
      link: '/parent/gallery',
      entitaTipo: 'galleria',
      entitaId: AUTORE,
      bufferMin: 30,
      debounce: true,
    })
  })

  it('il testo non cambia con l’input: nessun parametro può portarci dentro un nome', async () => {
    // Qualunque cosa passi chi chiama (anche valori che somigliano a un nome di file), il
    // messaggio è lo stesso. Se un domani la funzione accettasse una didascalia, questo test
    // diventerebbe rosso nel momento in cui qualcuno la mettesse nel corpo.
    await chiama({ tagAlunni: [ALU_1] })
    await chiama({ tagAlunni: [], classi: ['Marco al parco.jpg'] })
    await chiama({ tagAlunni: [], classi: [], uploadedBy: AUTORE })
    const testi = h.notifica.mock.calls.map((c) => [c[1].titolo, c[1].corpo])
    expect(new Set(testi.map((t) => JSON.stringify(t))).size).toBe(1)
    expect(JSON.stringify(testi)).not.toContain('Marco')
    expect(JSON.stringify(testi)).not.toContain('.jpg')
    expect(JSON.stringify(testi)).not.toContain('.mp4')
  })
})

describe('chi riceve: bambini, poi classi, poi tutta la sede — mai tutti insieme', () => {
  it('con dei bambini taggati: i genitori di QUEI bambini, e nessun altro elenco', async () => {
    const n = await chiama({ tagAlunni: [ALU_1, ALU_2], classi: ['2 ANNI'] })
    expect(h.alunni).toHaveBeenCalledWith(SUPABASE, [ALU_1, ALU_2])
    expect(h.classi).not.toHaveBeenCalled()
    expect(h.scuola).not.toHaveBeenCalled()
    expect(h.notifica.mock.calls[0][1].utenteIds).toEqual([G1, G2])
    expect(n).toBe(2)
  })

  it('senza bambini ma con delle classi: i genitori di quelle classi, DELLA SEDE del contenuto', async () => {
    const n = await chiama({ tagAlunni: [], classi: ['2 ANNI', '', '3 ANNI'] })
    // La sede entra nella query di classe: «2 ANNI» esiste in tutti e tre i plessi.
    expect(h.classi).toHaveBeenCalledWith(SUPABASE, SEDE, ['2 ANNI', '3 ANNI'])
    expect(h.alunni).not.toHaveBeenCalled()
    expect(h.scuola).not.toHaveBeenCalled()
    expect(h.notifica.mock.calls[0][1].utenteIds).toEqual([G3])
    expect(n).toBe(1)
  })

  it('senza bambini e senza classi (il broadcast di sede): tutta la sede', async () => {
    const n = await chiama({ tagAlunni: [], classi: [] })
    expect(h.scuola).toHaveBeenCalledWith(SUPABASE, SEDE)
    expect(h.alunni).not.toHaveBeenCalled()
    expect(h.classi).not.toHaveBeenCalled()
    expect(h.notifica.mock.calls[0][1].utenteIds).toEqual([G1, G2, G3])
    expect(n).toBe(3)
  })

  it.each([
    ['null', null, null],
    ['undefined', undefined, undefined],
  ])('tag e classi %s valgono «nessuno»: si cade sulla sede', async (_nome, tag, classi) => {
    await chiama({ tagAlunni: tag, classi })
    expect(h.scuola).toHaveBeenCalledWith(SUPABASE, SEDE)
  })

  it('la lista dei bambini che riceve non viene modificata (è l’input di chi chiama)', async () => {
    const tag = [ALU_1, ALU_2] as const
    await chiama({ tagAlunni: tag })
    expect(tag).toEqual([ALU_1, ALU_2])
  })

  it('«nessuna famiglia raggiunta» è un numero, non un fallimento: 0, non null', async () => {
    // È la condizione viva in produzione: bambini senza nessun tutore collegato. «Due bambini
    // nella foto, zero famiglie avvisate» è un guasto, e va letto come un numero accanto al
    // contenuto — non confuso con un avviso che non è mai stato accodato.
    h.alunni.mockResolvedValue([])
    expect(await chiama()).toBe(0)
    expect(h.log).not.toHaveBeenCalled()
  })
})

describe('mai un’eccezione verso chi chiama, mai un guasto muto', () => {
  it('se i destinatari non si risolvono: `null`, nessuna eccezione, una riga `error`', async () => {
    h.alunni.mockRejectedValue(new Error('rete giù'))
    const n = await chiama({ operazione: 'gallery/pubblicazione-video:notifica' })
    expect(n).toBeNull()
    expect(h.notifica).not.toHaveBeenCalled()
    expect(h.log).toHaveBeenCalledTimes(1)
    const [evento, livello, campi, errore] = h.log.mock.calls[0]
    expect(evento).toBe('notifica')
    expect(livello).toBe('error')
    expect(campi).toEqual({
      operazione: 'gallery/pubblicazione-video:notifica',
      esito: 'notifica-genitori-non-accodata',
    })
    // L'errore vero arriva al logger: «non è partita» non dice perché, «rete giù» sì.
    expect((errore as Error).message).toBe('rete giù')
  })

  it('se l’accodamento stesso lancia: `null` e la stessa riga, non il numero dei destinatari', async () => {
    h.notifica.mockRejectedValue(new Error('coda piena'))
    expect(await chiama()).toBeNull()
    expect(h.log.mock.calls[0][2]).toMatchObject({ esito: 'notifica-genitori-non-accodata' })
  })

  it('il successo non lascia righe di log proprie: il log di successo è del chiamante, col numero', async () => {
    await chiama()
    expect(h.log).not.toHaveBeenCalled()
  })
})

// ─── C. IL DEBOUNCE È PER DESTINATARIO — col `notificaEvento` VERO ───────────────
// I test qui sopra mockano `notificaEvento` e provano CHE cosa gli si passa. Questo prova
// che quello che gli si passa produce l'effetto che conta (#131): le notifiche in attesa
// dello stesso insegnante vengono tolte SOLO per le famiglie di questa chiamata, e il buffer
// è di 30 minuti.
describe('la raffica collassa PER FAMIGLIA (#131), col vero `notificaEvento`', () => {
  type Cancellazione = { tipo: unknown; entita: unknown; destinatari: unknown; pending: unknown }

  /** Un client che registra le `delete` su `notifiche`: la catena che il debounce usa davvero. */
  function clientConDelete(registro: Cancellazione[]) {
    return {
      from: (tabella: string) => ({
        delete: () => {
          expect(tabella).toBe('notifiche')
          const stato: Cancellazione = { tipo: undefined, entita: undefined, destinatari: undefined, pending: undefined }
          const q: Record<string, unknown> = {}
          q.eq = (colonna: string, valore: unknown) => {
            if (colonna === 'tipo') stato.tipo = valore
            if (colonna === 'entita_id') stato.entita = valore
            return q
          }
          q.in = (colonna: string, valore: unknown) => {
            if (colonna === 'utente_id') stato.destinatari = valore
            return q
          }
          q.is = (colonna: string, valore: unknown) => {
            if (colonna === 'push_inviata_il') stato.pending = valore
            return q
          }
          q.select = async () => {
            registro.push({ ...stato })
            return { data: [], error: null }
          }
          return q
        },
      }),
    } as never
  }

  async function conIlNotificaEventoVero() {
    const reale = await vi.importActual<typeof import('@/lib/notifiche/triggers')>('@/lib/notifiche/triggers')
    h.notifica.mockImplementation(reale.notificaEvento)
  }

  it('toglie le pending dello stesso insegnante SOLO per i destinatari della chiamata', async () => {
    await conIlNotificaEventoVero()
    const registro: Cancellazione[] = []

    const n = await notificaGenitoriGalleria(clientConDelete(registro), {
      scuolaId: SEDE,
      uploadedBy: AUTORE,
      tagAlunni: [ALU_1, ALU_2],
      classi: [],
      operazione: 'gallery:POST',
    })

    expect(n).toBe(2)
    // UNA `delete`, filtrata per tipo, per INSEGNANTE e per FAMIGLIA (`utente_id IN (…)`), e
    // solo sulle notifiche non ancora spedite. Senza il filtro per famiglia ogni foto
    // cancellava gli avvisi generati dalle precedenti per famiglie che non c'entravano: il
    // 7-8 settembre ne sono andati persi 168 su 298.
    expect(registro).toEqual([{ tipo: 'galleria', entita: AUTORE, destinatari: [G1, G2], pending: null }])
    // …e subito dopo l'avviso vero, col testo nuovo, in coda per 30 minuti.
    expect(h.accoda).toHaveBeenCalledTimes(1)
    expect(h.accoda.mock.calls[0][1]).toMatchObject({
      tipo: 'galleria',
      utenteIds: [G1, G2],
      titolo: 'Nuovi contenuti in galleria',
      corpo: 'Ci sono nuovi contenuti nella galleria.',
      link: '/parent/gallery',
      entitaTipo: 'galleria',
      entitaId: AUTORE,
      bufferMin: MINUTI_BUFFER_NOTIFICA_GENITORI_GALLERIA,
      scuolaId: SEDE,
    })
    expect(MINUTI_BUFFER_NOTIFICA_GENITORI_GALLERIA).toBe(30)
  })

  it('un altro insegnante, o altre famiglie, non toccano le pending di questo', async () => {
    await conIlNotificaEventoVero()
    const registro: Cancellazione[] = []
    const ALTRO_AUTORE = '99999999-9999-4999-8999-999999999999'

    h.alunni.mockResolvedValue([G1])
    await notificaGenitoriGalleria(clientConDelete(registro), {
      scuolaId: SEDE,
      uploadedBy: AUTORE,
      tagAlunni: [ALU_1],
      classi: [],
      operazione: 'gallery:POST',
    })
    h.alunni.mockResolvedValue([G2])
    await notificaGenitoriGalleria(clientConDelete(registro), {
      scuolaId: SEDE,
      uploadedBy: ALTRO_AUTORE,
      tagAlunni: [ALU_2],
      classi: [],
      operazione: 'gallery:POST',
    })

    expect(registro).toEqual([
      { tipo: 'galleria', entita: AUTORE, destinatari: [G1], pending: null },
      { tipo: 'galleria', entita: ALTRO_AUTORE, destinatari: [G2], pending: null },
    ])
  })
})
