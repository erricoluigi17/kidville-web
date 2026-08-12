import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// L'AUDIT DICE CHI HA FATTO COSA E QUANDO — non ricopia il dato.
//
// IL DIFETTO (collaudo del 2026-08-01). `admin/iscrizioni` registrava
// `valoreDopo: childRecord`, cioè il record INTEGRALE del bambino appena creato:
// nome, cognome, codice fiscale, data di nascita, indirizzo, allergie, note
// mediche. In produzione erano 11 righe di `audit_scritture_docente`, una
// tabella che l'oblio non toccava affatto. Esisteva un solo rimedio, il job di
// retention a 12 mesi — ma una richiesta di cancellazione non può aspettare un
// anno (art. 17 GDPR: «senza ingiustificato ritardo»).
//
// DUE CORREZIONI, in due punti diversi della catena, e servono entrambe:
//  1. NON SCRIVERCI DENTRO IL DATO. `logScrittura` riduce i campi identificativi
//     e sanitari a un marcatore prima dell'INSERT: il registro continua a dire
//     QUALE campo è stato toccato — che è il suo mestiere — senza esserne una
//     seconda copia. È la difesa che vale per tutti i 147 punti che lo chiamano,
//     compresi quelli che non sono ancora stati scritti.
//  2. L'OBLIO ARRIVA ANCHE LÌ. `anonimizzaAlunno`/`anonimizzaParent` svuotano
//     `valore_prima`/`valore_dopo` delle righe che riguardano quell'interessato,
//     subito. Serve comunque, e non solo per le righe già scritte: la riduzione
//     lascia in chiaro ciò che identificante non è (uuid, importi, stati), e su
//     una richiesta di cancellazione anche quello va tolto.
// =============================================================================

const h = vi.hoisted(() => ({
  logEvento: vi.fn(),
  logErrore: vi.fn(),
  inseriti: [] as Record<string, unknown>[],
  updateAudit: [] as { valori: Record<string, unknown>; filtri: Record<string, unknown> }[],
}))

vi.mock('@/lib/logging/logger', async (orig) => ({
  ...(await orig<typeof import('@/lib/logging/logger')>()),
  logEvento: (...a: unknown[]) => h.logEvento(...a),
  logErrore: (...a: unknown[]) => h.logErrore(...a),
}))

import { logScrittura } from '@/lib/audit/scrittura'
import { riassuntoCampi } from '@/lib/audit/riassunto'
import { bonificaAuditScritture } from '@/lib/gdpr/esegui'

function client() {
  return {
    from(table: string) {
      const st = { table, op: 'select', valori: {} as Record<string, unknown>, filtri: {} as Record<string, unknown> }
      const b: Record<string, unknown> = {}
      const risolvi = () => {
        if (st.table === 'audit_scritture_docente' && st.op === 'update') {
          h.updateAudit.push({ valori: st.valori, filtri: st.filtri })
          return { data: [{ id: 'a1' }], error: null }
        }
        return { data: [], error: null }
      }
      b.insert = async (rec: Record<string, unknown>) => {
        h.inseriti.push(rec)
        return { data: null, error: null }
      }
      b.update = (v: Record<string, unknown>) => {
        st.op = 'update'
        st.valori = v
        return b
      }
      b.select = () => b
      b.eq = (c: string, v: unknown) => {
        st.filtri[c] = v
        return b
      }
      b.in = (c: string, v: unknown) => {
        st.filtri[c] = v
        return b
      }
      b.or = (v: unknown) => {
        st.filtri.or = v
        return b
      }
      b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(risolvi()).then(f, r)
      return b
    },
  }
}

const ATTORE = { id: 'seg-1', role: 'segreteria', scuola_id: 'sc-1' } as never
const ALUNNO = '11111111-1111-4111-8111-111111111111'

/** Il record che `admin/iscrizioni` costruiva e passava per intero all'audit. */
const RECORD_BAMBINO = {
  nome: 'Anna',
  cognome: 'Rossi',
  codice_fiscale: 'RSSNNA19A41F839X',
  data_nascita: '2019-01-01',
  residence_address: 'Via Roma',
  residence_city: 'Giugliano',
  zip_code: '80014',
  allergies: 'arachidi',
  note_mediche: 'terapia in corso',
  scuola_id: 'sc-1',
  section_id: 'sez-1',
  usa_pannolino: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.inseriti = []
  h.updateAudit = []
})

describe('logScrittura — il registro non è una seconda copia dell’anagrafica', () => {
  it('i campi identificativi e sanitari NON finiscono in chiaro nella riga di audit', async () => {
    await logScrittura(client() as never, {
      attore: ATTORE,
      entitaTipo: 'alunni',
      entitaId: ALUNNO,
      azione: 'insert',
      valoreDopo: RECORD_BAMBINO,
    })

    expect(h.inseriti).toHaveLength(1)
    const scritto = JSON.stringify(h.inseriti[0])
    for (const valore of [
      'Anna',
      'Rossi',
      'RSSNNA19A41F839X',
      '2019-01-01',
      'Via Roma',
      '80014',
      'arachidi',
      'terapia in corso',
    ]) {
      expect(scritto, `«${valore}» è finito in chiaro in audit_scritture_docente`).not.toContain(valore)
    }
  })

  it('🔴 i percorsi delle DUE FACCE del documento del personale non entrano in chiaro', async () => {
    // Il 12/08/2026 la migrazione `20260812194501` ha rinominato
    // `pratiche_personale.documento_path` in `documento_fronte_path` e ne ha aggiunta
    // una seconda, `documento_retro_path`. La lista nera conosceva il solo nome
    // morto, e `norm()` è un confronto ESATTO (trim, minuscole, `-`→`_`): non
    // intercetta un prefisso né una variante, quindi le due colonne nuove passavano
    // in chiaro. Oggi non perde nulla — i tre `logScrittura` di
    // `admin/pratiche-personale` passano oggetti costruiti a mano, mai la riga
    // grezza — ma basta la prima `logScrittura` che passi una riga di
    // `anagrafica_personale` perché il percorso di una carta d'identità finisca
    // scritto nel registro delle modifiche, che è la tabella che l'oblio fatica di
    // più a raggiungere.
    //
    // ⚠️ `documento_path` resta in lista: NON è un nome morto dappertutto. Misurato
    // su `information_schema.columns` il 12/08/2026, la colonna esiste ancora su
    // `alunni` e su `parents` — cioè sui MINORI. Toglierla sarebbe stato scambiare
    // un rinomino su due tabelle per un rinomino globale.
    await logScrittura(client() as never, {
      attore: ATTORE,
      entitaTipo: 'anagrafica_personale',
      entitaId: ALUNNO,
      azione: 'update',
      valoreDopo: {
        documento_fronte_path: 'documenti/aaaaaaaa-0000-4000-8000-000000000001/fronte-rossi.jpeg',
        documento_retro_path: 'documenti/aaaaaaaa-0000-4000-8000-000000000001/retro-rossi.jpeg',
        documento_path: 'documenti/aaaaaaaa-0000-4000-8000-000000000001/vecchio-rossi.jpeg',
        cessato_il: '2026-01-31',
      },
    })

    expect(h.inseriti).toHaveLength(1)
    const scritto = JSON.stringify(h.inseriti[0])
    for (const valore of ['fronte-rossi', 'retro-rossi', 'vecchio-rossi']) {
      expect(
        scritto,
        `«${valore}» è la chiave che apre il documento d’identità di una persona`,
      ).not.toContain(valore)
    }
    // CONTROLLO POSITIVO: il campo resta visibile, il valore no — altrimenti questa
    // prova sarebbe verde anche con un audit che non scrive più niente.
    expect(scritto).toContain('documento_fronte_path')
    expect(scritto).toContain('documento_retro_path')
    expect(scritto, 'una data di cessazione non è un dato da nascondere').toContain('2026-01-31')
  })

  it('CONTROLLO POSITIVO — la riga esiste e dice ancora chi, cosa, quando e QUALI campi', async () => {
    // Senza questa prova, «non contiene il nome» sarebbe verde anche con un audit
    // che non scrive più niente — cioè con la tracciabilità spenta.
    await logScrittura(client() as never, {
      attore: ATTORE,
      entitaTipo: 'alunni',
      entitaId: ALUNNO,
      azione: 'insert',
      valoreDopo: RECORD_BAMBINO,
    })
    const riga = h.inseriti[0] as Record<string, unknown>
    expect(riga.attore_id).toBe('seg-1')
    expect(riga.entita_tipo).toBe('alunni')
    expect(riga.entita_id).toBe(ALUNNO)
    expect(riga.azione).toBe('insert')
    // I nomi dei campi toccati restano: sono la sostanza dell'audit.
    const dopo = JSON.stringify(riga.valore_dopo)
    expect(dopo).toContain('codice_fiscale')
    expect(dopo).toContain('allergies')
  })

  it('i campi NON identificativi restano leggibili (l’audit resta utile)', async () => {
    await logScrittura(client() as never, {
      attore: ATTORE,
      entitaTipo: 'presenze',
      entitaId: ALUNNO,
      azione: 'update',
      valorePrima: { stato: 'assente', ore: 3 },
      valoreDopo: { stato: 'presente', ore: 0 },
    })
    const riga = h.inseriti[0] as Record<string, unknown>
    expect(JSON.stringify(riga.valore_prima)).toContain('assente')
    expect(JSON.stringify(riga.valore_dopo)).toContain('presente')
  })

  it('la riduzione scende anche negli oggetti annidati', async () => {
    await logScrittura(client() as never, {
      attore: ATTORE,
      entitaTipo: 'legame',
      entitaId: ALUNNO,
      azione: 'insert',
      valoreDopo: { alunno: { nome: 'Anna', allergies: 'arachidi' }, adulti: [{ email: 'a@b.it' }] },
    })
    const scritto = JSON.stringify(h.inseriti[0])
    expect(scritto).not.toContain('Anna')
    expect(scritto).not.toContain('arachidi')
    expect(scritto).not.toContain('a@b.it')
  })
})

describe('riassuntoCampi — l’audit di una creazione elenca i campi, non li ricopia', () => {
  it('restituisce solo i NOMI dei campi valorizzati', () => {
    const r = riassuntoCampi(RECORD_BAMBINO)
    expect(r.campi).toContain('codice_fiscale')
    expect(r.campi).toContain('allergies')
    expect(JSON.stringify(r)).not.toContain('Anna')
    expect(JSON.stringify(r)).not.toContain('arachidi')
  })

  it('i campi non valorizzati non compaiono (dice cosa è stato scritto davvero)', () => {
    const r = riassuntoCampi({ nome: 'Anna', note_mediche: null, section_id: undefined })
    expect(r.campi).toEqual(['nome'])
  })
})

describe('bonificaAuditScritture — l’oblio arriva anche al registro delle scritture', () => {
  it('svuota valore_prima/valore_dopo delle righe dell’interessato', async () => {
    const n = await bonificaAuditScritture(client() as never, [ALUNNO], 'gdpr:test')
    expect(n).toBe(1)
    expect(h.updateAudit).toHaveLength(1)
    expect(h.updateAudit[0].valori).toEqual({ valore_prima: null, valore_dopo: null })
    // La riga NON viene cancellata: continua a dire chi ha modificato cosa e
    // quando, che è il motivo per cui quel registro esiste (art. 5 §2 GDPR).
    expect(h.updateAudit[0].filtri.entita_id).toEqual([ALUNNO])
  })

  it('nessun id → nessuna scrittura (non si tocca l’intera tabella)', async () => {
    const n = await bonificaAuditScritture(client() as never, [], 'gdpr:test')
    expect(n).toBe(0)
    expect(h.updateAudit).toEqual([])
  })
})
