import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Il contratto HTTP della coda fatture (nucleo §3): gli schemi dei corpi, le funzioni pure
 * della GET e la sveglia. Gli uuid sono finti: il repository è pubblico.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (originale) => {
  const actual = await originale<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CODICI_ERRORE_CODA,
  ESITI_CODA,
  MINUTI_TICK_CODA,
  PASSO_FATTURA_STIMA_MS,
  STATI_ATTIVI,
  TETTO_VOCI_CODA,
  codaAssente,
  senzaDoppioni,
  stimaFineCoda,
  svegliaCoda,
  voceRpc,
  zCorpoAccoda,
  zCorpoAzioni,
  zCorpoSospensione,
  zRispostaAccoda,
} from '@/lib/fatture-coda/api'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { senzaCommenti } from '../../architecture/soglia-fotografia'
import { LIMITI } from '@/lib/aruba/fatturapa-xml'
import { STATI_CODA_OCCUPATA } from '@/lib/pagamenti/fatturazione-riga'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * La persona di prova: il cast verificato di `FatturaButton-intestatario.test.tsx` (`COMPLETI`,
 * `CF_DIGITATO`), ricopiato qui. Dati SINTETICI: il repository è pubblico.
 */
const PERSONA = {
  tipo: 'persona' as const,
  nome: 'Carlo',
  cognome: 'Perlini',
  codice_fiscale: 'PRLCRL85M41H501Y',
  indirizzo: 'Via delle Prove 1',
  cap: '80014',
  comune: 'Giugliano in Campania',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('zCorpoAccoda — da 1 a 500 voci', () => {
  const voci = (n: number) => Array.from({ length: n }, (_, i) => ({ pagamento_id: uuid(i + 1) }))

  it('rifiuta zero voci e 501 voci, accetta 1 e 500', () => {
    expect(zCorpoAccoda.safeParse({ voci: [] }).success).toBe(false)
    expect(zCorpoAccoda.safeParse({ voci: voci(1) }).success).toBe(true)
    expect(zCorpoAccoda.safeParse({ voci: voci(TETTO_VOCI_CODA) }).success).toBe(true)
    expect(zCorpoAccoda.safeParse({ voci: voci(TETTO_VOCI_CODA + 1) }).success).toBe(false)
    expect(TETTO_VOCI_CODA).toBe(500)
  })

  it('pretende un uuid come pagamento_id', () => {
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: 'non-un-uuid' }] }).success).toBe(false)
  })

  /**
   * Consegna 2b, D1 (T1): la persona scritta a mano («Altro») entra in coda, ma SOLO da un gesto
   * di UNA voce — il pulsante, che ha il modulo. Da un lotto non entra nessuna anagrafica digitata.
   */
  describe('l’intestatario: adult per id, o la persona scritta a mano in una voce sola', () => {
    it('adult accettato', () => {
      const adult = { pagamento_id: uuid(1), intestatario: { tipo: 'adult', adult_id: uuid(9) } }
      expect(zCorpoAccoda.safeParse({ voci: [adult] }).success).toBe(true)
    })

    it('la persona in UNA voce accettata, e arriva intera', () => {
      const letto = zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), intestatario: PERSONA }] })
      expect(letto.success).toBe(true)
      expect(letto.data?.voci[0].intestatario).toEqual(PERSONA)
    })

    it('la stessa persona in un corpo con DUE voci rifiutata, con un issue su voci', () => {
      const letto = zCorpoAccoda.safeParse({
        voci: [{ pagamento_id: uuid(1), intestatario: PERSONA }, { pagamento_id: uuid(2) }],
      })
      expect(letto.success).toBe(false)
      expect(letto.error?.issues.some((i) => i.path.length === 1 && i.path[0] === 'voci')).toBe(true)
    })

    it('la persona con una chiave in più rifiutata (oggetto stretto)', () => {
      const intestatario = { ...PERSONA, email: 'x@example.invalid' }
      expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), intestatario }] }).success).toBe(false)
    })

    it('l’ibrido adult + campi anagrafici rifiutato', () => {
      const intestatario = { tipo: 'adult', adult_id: uuid(9), nome: PERSONA.nome }
      expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), intestatario }] }).success).toBe(false)
    })

    it('un nome lungo LIMITI.nome + 1 rifiutato', () => {
      const intestatario = { ...PERSONA, nome: 'a'.repeat(LIMITI.nome + 1) }
      expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), intestatario }] }).success).toBe(false)
      const alLimite = { ...PERSONA, nome: 'a'.repeat(LIMITI.nome) }
      expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), intestatario: alLimite }] }).success).toBe(true)
    })
  })

  it('causale oltre i 1000 caratteri rifiutata; null ammesso', () => {
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), causale: 'a'.repeat(1001) }] }).success).toBe(false)
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), causale: 'a'.repeat(1000) }] }).success).toBe(true)
    expect(zCorpoAccoda.safeParse({ voci: [{ pagamento_id: uuid(1), causale: null }] }).success).toBe(true)
  })

  it('urgente deve essere booleano', () => {
    expect(zCorpoAccoda.safeParse({ voci: voci(1), urgente: 'sì' }).success).toBe(false)
    expect(zCorpoAccoda.safeParse({ voci: voci(1), urgente: true }).success).toBe(true)
  })
})

describe('zCorpoAzioni e zCorpoSospensione', () => {
  it('azione ∈ {togli, rimetti}, ids da 1 a 500 uuid', () => {
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: [uuid(1)] }).success).toBe(true)
    expect(zCorpoAzioni.safeParse({ azione: 'rimetti', ids: [uuid(1)] }).success).toBe(true)
    expect(zCorpoAzioni.safeParse({ azione: 'cancella', ids: [uuid(1)] }).success).toBe(false)
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: [] }).success).toBe(false)
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: ['x'] }).success).toBe(false)
    const troppi = Array.from({ length: 501 }, (_, i) => uuid(i + 1))
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: troppi }).success).toBe(false)
    expect(zCorpoAzioni.safeParse({ azione: 'togli', ids: troppi.slice(0, 500) }).success).toBe(true)
  })

  it('sospesa è un booleano obbligatorio', () => {
    expect(zCorpoSospensione.safeParse({ sospesa: true }).success).toBe(true)
    expect(zCorpoSospensione.safeParse({}).success).toBe(false)
    expect(zCorpoSospensione.safeParse({ sospesa: 'true' }).success).toBe(false)
  })
})

describe('costanti del contratto', () => {
  it('codici e stati hanno i nomi fissati dalla spec', () => {
    expect(CODICI_ERRORE_CODA.NON_DISPONIBILE).toBe('CODA_FATTURE_NON_DISPONIBILE')
    expect(CODICI_ERRORE_CODA.PAGAMENTO_NON_SALDATO).toBe('PAGAMENTO_NON_SALDATO')
    expect(ESITI_CODA).toEqual({
      EMESSA: 'emessa',
      GIA_EMESSA: 'gia_emessa',
      SCARTO_ARUBA: 'scarto_aruba',
      ESITO_INCERTO: 'esito_incerto',
    })
    expect([...STATI_ATTIVI].sort()).toEqual(['errore', 'in_coda', 'in_invio'])
  })

  it('`STATI_ATTIVI` è l’elenco del motore della fatturazione, non una sua copia (consegna 2b, D5)', () => {
    // `toBe`, non `toEqual`: due array uguali ma distinti sono proprio la copia da togliere.
    expect(STATI_ATTIVI).toBe(STATI_CODA_OCCUPATA)
  })

  it('zRispostaAccoda legge la forma della RPC', () => {
    expect(zRispostaAccoda.safeParse({ gruppo_id: uuid(1), accodate: 2, gia_in_coda: [uuid(3)] }).success).toBe(true)
    expect(zRispostaAccoda.safeParse({ accodate: 2 }).success).toBe(false)
  })
})

describe('codaAssente — solo tabella o funzione mancanti', () => {
  it.each(['42P01', 'PGRST205', '42883', 'PGRST202'])('%s ⇒ assente', (code) => {
    expect(codaAssente({ code })).toBe(true)
  })
  it.each(['42703', 'PGRST204', '23505', '57014'])('%s ⇒ guasto vero, non degradazione', (code) => {
    expect(codaAssente({ code })).toBe(false)
  })
  it('valori non oggetto ⇒ false', () => {
    expect(codaAssente(null)).toBe(false)
    expect(codaAssente('42P01')).toBe(false)
  })
})

/**
 * La stima di fine (consegna 2b, D3): i tick del cron simulati con le regole del giro vero, col
 * secchio delle fatture emesse nell'ultima ora. I valori attesi vengono da un prototipo in node
 * del 24/09 (lo stesso codice) e coincidono con quelli del lettore del piano.
 */
describe('stimaFineCoda — i tick del cron col secchio dell’ultima ora', () => {
  const ADESSO = new Date('2026-09-23T08:00:00.000Z')
  const base = {
    adesso: ADESSO,
    inCoda: 0,
    inInvio: 0,
    sospesa: false,
    pausaFinoA: null as string | null,
    emesseUltimaOra: [] as readonly string[] | null,
  }
  const stima = (campi: Partial<typeof base>) => stimaFineCoda({ ...base, ...campi })
  const emesse = (n: number, iso: string) => Array.from({ length: n }, () => iso)

  it.each([
    ['1. niente in coda né in invio', {}, null],
    ['2. 10 in coda, sospesa', { inCoda: 10, sospesa: true }, null],
    ['3. 10 in coda, emesse non misurate', { inCoda: 10, emesseUltimaOra: null }, null],
    ['4. 1 in coda', { inCoda: 1 }, '2026-09-23T08:07:05.500Z'],
    ['5. 15 in coda', { inCoda: 15 }, '2026-09-23T08:08:22.500Z'],
    ['6. 16 in coda (un blocco è di 15)', { inCoda: 16 }, '2026-09-23T08:12:05.500Z'],
    ['7. 50 in coda', { inCoda: 50 }, '2026-09-23T08:22:27.500Z'],
    ['8. 51 in coda: aspetta che esca dall’ora il blocco delle 08:07', { inCoda: 51 }, '2026-09-23T09:12:05.500Z'],
    ['9. 100 in coda (la formula di prima diceva 10:00)', { inCoda: 100 }, '2026-09-23T09:27:27.500Z'],
    ['10. 300 in coda', { inCoda: 300 }, '2026-09-23T13:52:27.500Z'],
    ['11. 1, con 50 emesse alle 07:40', { inCoda: 1, emesseUltimaOra: emesse(50, '2026-09-23T07:40:00.000Z') }, '2026-09-23T08:42:05.500Z'],
    ['12. 1, con 49 emesse alle 07:40', { inCoda: 1, emesseUltimaOra: emesse(49, '2026-09-23T07:40:00.000Z') }, '2026-09-23T08:07:05.500Z'],
    ['13. 1, pausa fino alle 09:00', { inCoda: 1, pausaFinoA: '2026-09-23T09:00:00.000Z' }, '2026-09-23T09:07:05.500Z'],
    ['14. 15, pausa finita alle 07:00', { inCoda: 15, pausaFinoA: '2026-09-23T07:00:00.000Z' }, '2026-09-23T08:08:22.500Z'],
    ['15. 0 in coda, 3 in invio', { inInvio: 3 }, '2026-09-23T08:00:16.500Z'],
    [
      '16. 1 in coda, 3 in invio, 47 emesse alle 07:50',
      { inCoda: 1, inInvio: 3, emesseUltimaOra: emesse(47, '2026-09-23T07:50:00.000Z') },
      '2026-09-23T08:52:05.500Z',
    ],
    [
      '17. come 16 ma senza le 3 in invio (controllo)',
      { inCoda: 1, emesseUltimaOra: emesse(47, '2026-09-23T07:50:00.000Z') },
      '2026-09-23T08:07:05.500Z',
    ],
    ['18. 15, istanti illeggibili', { inCoda: 15, emesseUltimaOra: ['boh', ''] }, '2026-09-23T08:08:22.500Z'],
    ['19. 1, adesso esattamente alle 08:07:00', { inCoda: 1, adesso: new Date('2026-09-23T08:07:00.000Z') }, '2026-09-23T08:07:05.500Z'],
    ['20. 1, adesso alle 08:57:30 (salto 57 → 07)', { inCoda: 1, adesso: new Date('2026-09-23T08:57:30.000Z') }, '2026-09-23T09:07:05.500Z'],
    // Il 20 non vede un minuto tolto a MINUTI_TICK_CODA (da 08:57:30 il tick dopo è 09:07 comunque):
    // questo sì, perché il tick delle 08:57 esiste solo se c'è il 57.
    ['20b. 1, adesso alle 08:52:30 (il tick delle 57)', { inCoda: 1, adesso: new Date('2026-09-23T08:52:30.000Z') }, '2026-09-23T08:57:05.500Z'],
    ['21. 1, adesso alle 08:27:30 (salto 27 → 37)',{ inCoda: 1, adesso: new Date('2026-09-23T08:27:30.000Z') }, '2026-09-23T08:37:05.500Z'],
  ] as const)('%s', (_nome, campi, atteso) => {
    expect(stima(campi as Partial<typeof base>)).toBe(atteso)
  })

  it('22. un miliardo in coda ⇒ null (oltre l’orizzonte), in meno di un secondo', () => {
    const t0 = performance.now()
    expect(stima({ inCoda: 1e9 })).toBeNull()
    expect(performance.now() - t0).toBeLessThan(1_000)
  })

  it('23. da 1 a 300 in coda la stima non scende mai', () => {
    let prima = 0
    for (let n = 1; n <= 300; n++) {
      const fine = Date.parse(stima({ inCoda: n }) ?? '')
      expect(Number.isFinite(fine)).toBe(true)
      expect(fine).toBeGreaterThanOrEqual(prima)
      prima = fine
    }
  })

  it('il passo di una fattura è la pausa fra gli upload più tre secondi', () => {
    expect(PASSO_FATTURA_STIMA_MS).toBe(5_500)
  })

  it('i minuti dei tick sono quelli del cron VERO (`fatture-coda-tick`), e il cron è pianificato una volta sola', () => {
    const cartella = join(process.cwd(), 'supabase', 'migrations')
    const re = /cron\.schedule\(\s*'fatture-coda-tick',\s*'([0-9,]+) \* \* \* \*'/g
    const trovati: string[] = []
    for (const f of readdirSync(cartella).filter((x) => x.endsWith('.sql')).sort()) {
      const sql = senzaCommenti(readFileSync(join(cartella, f), 'utf8'))
      for (const m of sql.matchAll(re)) trovati.push(m[1])
    }
    // Presenza prima dell'uguaglianza: se il regex non trovasse niente, il confronto sotto non misurerebbe nulla.
    expect(trovati).toHaveLength(1)
    const nucleo = senzaCommenti(
      readFileSync(join(cartella, '20260923102831_fatture_coda_nucleo.sql'), 'utf8'),
    ).match(/cron\.schedule\(\s*'fatture-coda-tick',\s*'([0-9,]+) \* \* \* \*'/)
    expect(nucleo?.[1]).toBe(trovati[0])
    expect(trovati[0].split(',').map(Number)).toEqual([...MINUTI_TICK_CODA])
  })
})

describe('senzaDoppioni e voceRpc', () => {
  it('toglie i doppioni tenendo il primo, anche con maiuscole diverse', () => {
    const a = uuid(1)
    const b = uuid(2)
    expect(senzaDoppioni([a, b, a.toUpperCase()], (x) => x)).toEqual([a, b])
  })

  it('porta la voce nella forma di p_voci, con ordine di selezione e default', () => {
    expect(voceRpc({ pagamento_id: uuid(1) }, 3)).toEqual({
      pagamento_id: uuid(1),
      intestatario_scelto: null,
      conferma_proposta: false,
      causale_manuale: null,
      ordine_selezione: 3,
    })
    expect(
      voceRpc(
        {
          pagamento_id: uuid(1),
          intestatario: { tipo: 'adult', adult_id: uuid(9) },
          conferma_proposta: true,
          causale: 'Retta settembre',
        },
        0,
      ),
    ).toEqual({
      pagamento_id: uuid(1),
      intestatario_scelto: { tipo: 'adult', adult_id: uuid(9) },
      conferma_proposta: true,
      causale_manuale: 'Retta settembre',
      ordine_selezione: 0,
    })
  })

  it('la persona scritta a mano arriva a p_voci intera, con la casella «ricorda sulla scheda»', () => {
    expect(voceRpc({ pagamento_id: uuid(1), intestatario: PERSONA, conferma_proposta: true }, 0)).toEqual({
      pagamento_id: uuid(1),
      intestatario_scelto: PERSONA,
      conferma_proposta: true,
      causale_manuale: null,
      ordine_selezione: 0,
    })
  })

  it('una causale vuota (dopo il trim dello schema) non diventa causale manuale', () => {
    const letta = zCorpoAccoda.parse({ voci: [{ pagamento_id: uuid(1), causale: '   ' }] })
    expect(voceRpc(letta.voci[0], 0).causale_manuale).toBeNull()
  })
})

describe('svegliaCoda — la RPC parte davvero, e il suo esito si logga', () => {
  function sbCon(risposta: { error: unknown }) {
    const rpc = vi.fn(() => Promise.resolve({ data: null, ...risposta }))
    return { sb: { rpc } as unknown as SupabaseClient, rpc }
  }

  it('chiama fatture_coda_tick_http senza aspettarla, e logga il successo', async () => {
    const { sb, rpc } = sbCon({ error: null })
    svegliaCoda(sb, 'prova')
    // Fuori da una richiesta `after` non c'è: la chiamata parte subito.
    expect(rpc).toHaveBeenCalledWith('fatture_coda_tick_http')
    await vi.waitFor(() =>
      expect(h.logEvento).toHaveBeenCalledWith('fattura', 'info', { operazione: 'prova', esito: 'sveglia-inviata' }),
    )
  })

  it('un errore della sveglia è un warn, non un’eccezione', async () => {
    const { sb } = sbCon({ error: { code: 'XX000', message: 'boom' } })
    expect(() => svegliaCoda(sb, 'prova')).not.toThrow()
    await vi.waitFor(() =>
      expect(h.logEvento).toHaveBeenCalledWith(
        'fattura',
        'warn',
        { operazione: 'prova', esito: 'sveglia-fallita' },
        expect.objectContaining({ code: 'XX000' }),
      ),
    )
  })
})
