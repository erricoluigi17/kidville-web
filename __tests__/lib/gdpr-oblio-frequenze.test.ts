import { describe, it, expect, vi } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { anonimizzaAlunno } from '@/lib/gdpr/esegui'

// =============================================================================
// L'OBLIO DEVE ARRIVARE ALLE FREQUENZE DI OGNI ANNO (Compito 3.6-2 · Ruling P43/P44)
//
// Intestatario delle fatture, ripartizione della retta e motivo della sospensione vivono in `alunni` e, dal 3.7,
// anche in `frequenze` (una riga per anno). Lo specchio `alunni → frequenze` aggiorna SOLO l'anno attivo: senza il
// passo dell'oblio, gli anni chiusi li conservano. `sospeso` e `sospeso_causa` restano (fatto, non testo libero).
// Le asserzioni sono sulla MUTAZIONE della riga, non sul solo valore di ritorno.
// =============================================================================

const RPC_OBLIO_VIDEO = {
  video_intent_oblio_alunno: async () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }),
}

const AT = '2026-11-07T09:00:00Z'
const NOSTRO = '44444444-0000-4000-8000-000000000001'
const ALTRO = '44444444-0000-4000-8000-000000000002'
const INTESTATARIO = { nome: 'TESTO-DI-PROVA' }
const SPLIT = { quote: [{ percentuale: 100 }] }

function frequenza(id: string, alunno: string, anno: string): Record<string, unknown> {
  return {
    id, alunno_id: alunno, anno_sede_id: anno,
    intestatario_fatture: INTESTATARIO, retta_split_config: SPLIT,
    sospeso: true, sospeso_causa: 'morosita', sospeso_motivo: 'MOTIVO-DI-PROVA',
  }
}
function dbConFrequenze(): DBFinto {
  return {
    frequenze: [
      frequenza('f-chiusa', NOSTRO, 'anno-chiuso'),
      frequenza('f-corrente', NOSTRO, 'anno-corrente'),
      frequenza('f-altro', ALTRO, 'anno-chiuso'),
    ],
  }
}

describe('anonimizzaAlunno — le frequenze di tutti gli anni', () => {
  it('azzera intestatario, ripartizione e motivo in OGNI anno dell\'alunno, lascia il fatto e non tocca gli altri', async () => {
    const db = dbConFrequenze()
    const chiamate: Array<{ nome: string; args: Record<string, unknown> }> = []
    const client = creaFintoSupabase(db, [], { rpc: RPC_OBLIO_VIDEO })
    const rpcOriginale = client.rpc.bind(client)
    vi.spyOn(client, 'rpc').mockImplementation(((nome: string, args: Record<string, unknown>) => {
      chiamate.push({ nome, args })
      return rpcOriginale(nome, args)
    }) as never)

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    for (const id of ['f-chiusa', 'f-corrente']) {
      const f = db.frequenze.find((x) => x.id === id)!
      expect(f.intestatario_fatture, id).toBeNull()
      expect(f.retta_split_config, id).toBeNull()
      expect(f.sospeso_motivo, id).toBeNull()
      expect(f.sospeso, id).toBe(true)
      expect(f.sospeso_causa, id).toBe('morosita')
    }
    const altro = db.frequenze.find((x) => x.id === 'f-altro')!
    expect(altro.intestatario_fatture).toEqual(INTESTATARIO)
    expect(altro.retta_split_config).toEqual(SPLIT)
    expect(altro.sospeso_motivo).toBe('MOTIVO-DI-PROVA')
    expect(r.frequenzeBonificate).toBe(2)

    const suFrequenze = chiamate.filter((c) => c.nome === 'anno_oblio_scrivi' && c.args.p_tabella === 'frequenze')
    expect(suFrequenze).toHaveLength(1)
    expect(suFrequenze[0].args).toMatchObject({
      p_azione: 'update', p_colonna: 'alunno_id', p_valori: [NOSTRO],
      p_set: { intestatario_fatture: null, retta_split_config: null, sospeso_motivo: null },
    })
  })

  it('se la patch di `alunni` fallisce, NON tocca le frequenze', async () => {
    const db = dbConFrequenze()
    db.alunni = [{ id: NOSTRO }]
    const scritture: Scrittura[] = []
    const client = creaFintoSupabase(db, [], { scritture, rpc: RPC_OBLIO_VIDEO, errori: { 'alunni:update': { code: '23514' } } })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(scritture.filter((s) => s.tabella === 'frequenze')).toEqual([])
    expect(db.frequenze.find((x) => x.id === 'f-chiusa')!.sospeso_motivo).toBe('MOTIVO-DI-PROVA')
    expect(r.frequenzeBonificate).toBe(0)
  })

  it('degrada in silenzio se `frequenze` non esiste (DB della CI, non migrato)', async () => {
    const db = dbConFrequenze()
    const client = creaFintoSupabase(db, [], { errori: { frequenze: { code: 'PGRST205' } }, rpc: RPC_OBLIO_VIDEO })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(r.frequenzeBonificate).toBe(0)
    expect(r.iscrizioniScrubbate).toBe(0)
  })
})
