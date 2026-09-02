import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTranslator } from 'use-intl'
import {
  campiModuliGenitori,
  opzioniClasseModuli,
  scadenzaDi,
  type ModuloGenitori,
} from '@/components/features/admin/iscrizioni/filtri-moduli-genitori'
import { filtraRighe, valoriIniziali } from '@/lib/ui/filtri/motore'
import type { CampoFiltro, ValoriFiltri } from '@/lib/ui/filtri/tipi'

/**
 * I MODULI PER I GENITORI ISCRITTI — la linguetta che oggi ha ZERO righe in produzione.
 *
 * Proprio perché è vuota, la semantica dei suoi filtri non si può misurare a schermo: qui si
 * misura sui descrittori, che sono puri. Le tre cose che contano e che a occhio non si
 * vedrebbero:
 *
 *  · «senza scadenza» è un TERZO stato, non un sinonimo di «ancora valido»;
 *  · le classi fra cui scegliere sono l'UNIONE fra quelle nominate dai moduli e le sezioni
 *    della sede — l'una senza l'altra perde righe o perde scelte;
 *  · il giorno di `created_at` è quello ITALIANO, non quello UTC.
 */

const CATALOGO = JSON.parse(
  readFileSync(join(process.cwd(), 'messages/it/adminModulistica.json'), 'utf8'),
) as Record<string, string>

const t = createTranslator({
  locale: 'it',
  messages: { adminModulistica: CATALOGO } as never,
  namespace: 'adminModulistica' as never,
  onError: (errore) => {
    throw errore
  },
}) as unknown as (chiave: string, valori?: Record<string, string | number>) => string

const GIORNO = 24 * 60 * 60 * 1000

function modulo(p: Partial<ModuloGenitori>): ModuloGenitori {
  return {
    id: 'x',
    title: 'Titolo',
    description: '',
    form_type: 'autorizzazione',
    target_scope: 'class',
    target_classes: [],
    expiration_date: null,
    created_at: '2026-06-20T10:00:00Z',
    ...p,
  }
}

describe('scadenzaDi — tre stati, non due', () => {
  const adesso = Date.parse('2026-06-01T12:00:00Z')

  it('senza data è «senza scadenza», che non è «ancora valido»', () => {
    expect(scadenzaDi(modulo({ expiration_date: null }), adesso)).toBe('senza')
    expect(scadenzaDi(modulo({ expiration_date: '' }), adesso)).toBe('senza')
  })

  it('una data passata è «scaduto», una futura è «ancora valido»', () => {
    expect(scadenzaDi(modulo({ expiration_date: '2026-05-31T23:59:00Z' }), adesso)).toBe('scaduti')
    expect(scadenzaDi(modulo({ expiration_date: '2026-06-02T00:00:00Z' }), adesso)).toBe('attivi')
  })

  it('una data illeggibile NON diventa «scaduto»: non si sa, e si dice così', () => {
    // Dire «scaduto» su una data che non si è saputa leggere è affermare un fatto sul tempo
    // che nessuno ha misurato — e farebbe sparire il modulo dal filtro «Ancora validi».
    expect(scadenzaDi(modulo({ expiration_date: 'non-una-data' }), adesso)).toBe('senza')
  })

  it('senza secondo argomento legge l’orologio, e il verso è quello giusto', () => {
    expect(scadenzaDi(modulo({ expiration_date: new Date(Date.now() - GIORNO).toISOString() }))).toBe('scaduti')
    expect(scadenzaDi(modulo({ expiration_date: new Date(Date.now() + GIORNO).toISOString() }))).toBe('attivi')
  })
})

describe('opzioniClasseModuli — l’unione, e perché serve in tutti e due i versi', () => {
  it('comprende le classi NOMINATE dai moduli anche se la sezione non esiste più', () => {
    // Una sezione rinominata lascia dietro di sé moduli che la nominano ancora: senza questa
    // metà dell'unione quei moduli non sarebbero raggiungibili da nessun filtro.
    //
    // ⚠️ Servono DUE classi in gioco perché la domanda abbia senso: con una sola scelta il
    // campo si azzera comunque (`opzioniUtili`), e il caso a una voce misurerebbe quella
    // regola invece di questa. È il rosso che questo test ha dato al primo giro.
    const opzioni = opzioniClasseModuli(
      [modulo({ target_classes: ['SEZIONE SPARITA'] })],
      [{ name: 'INFANZIA B' }],
    )
    expect(opzioni.map((o) => o.valore)).toContain('SEZIONE SPARITA')
    expect(opzioni.map((o) => o.valore)).toContain('INFANZIA B')
  })

  it('comprende le sezioni SENZA moduli, col conteggio a zero', () => {
    // Sono proprio quelle che si va a cercare («su questa sezione ho già mandato qualcosa?»),
    // e un elenco costruito sui soli moduli non saprebbe nemmeno offrirle.
    const opzioni = opzioniClasseModuli(
      [modulo({ target_classes: ['PRIMAVERA A'] })],
      [{ name: 'PRIMAVERA A' }, { name: 'INFANZIA B' }],
    )
    expect(opzioni.map((o) => [o.etichetta, o.conteggio])).toEqual([
      ['INFANZIA B', 0],
      ['PRIMAVERA A', 1],
    ])
  })

  it('non ripete una classe che sta da tutte e due le parti', () => {
    const opzioni = opzioniClasseModuli(
      [modulo({ target_classes: ['PRIMAVERA A'] }), modulo({ target_classes: ['PRIMAVERA A'] })],
      [{ name: 'PRIMAVERA A' }, { name: 'NIDO A' }],
    )
    expect(opzioni.map((o) => o.valore)).toEqual(['NIDO A', 'PRIMAVERA A'])
    expect(opzioni.find((o) => o.valore === 'PRIMAVERA A')?.conteggio).toBe(2)
  })

  it('con una sola classe in gioco il campo si azzera: una scelta sola non restringe niente', () => {
    expect(opzioniClasseModuli([modulo({ target_classes: ['UNICA'] })], [{ name: 'UNICA' }])).toEqual([])
  })
})

describe('i campi — che cosa passa', () => {
  const MODULI: ModuloGenitori[] = [
    modulo({ id: 'a', title: 'Uscita al museo', form_type: 'autorizzazione', target_classes: ['PRIMAVERA A'], expiration_date: new Date(Date.now() + 30 * GIORNO).toISOString(), created_at: '2026-01-15T10:00:00Z', sempre_firmabile: true }),
    modulo({ id: 'b', title: 'Come è andato l’anno', description: 'Un giudizio sul servizio', form_type: 'gradimento', target_classes: ['INFANZIA B'], expiration_date: new Date(Date.now() - 30 * GIORNO).toISOString(), created_at: '2026-06-20T10:00:00Z' }),
    modulo({ id: 'c', title: 'Preferenze sul menu', form_type: 'sondaggio', target_classes: ['PRIMAVERA A', 'INFANZIA B'], expiration_date: null, created_at: '2026-03-10T10:00:00Z' }),
  ]

  const campi = (): CampoFiltro<ModuloGenitori>[] =>
    campiModuliGenitori(t, { classe: opzioniClasseModuli(MODULI, []) }, (iso) => iso)

  function filtra(scelte: ValoriFiltri): string[] {
    const c = campi()
    return filtraRighe(c, { ...valoriIniziali(c), ...scelte }, MODULI).map((m) => m.id)
  }

  it('sono tutti `client`, e sono le sei chiavi attese', () => {
    expect(campi().map((c) => c.chiave)).toEqual([
      'q',
      'tipo',
      'scadenza',
      'classe',
      'essenziali',
      'creato',
    ])
    for (const campo of campi()) expect(campo.dove, `${campo.chiave} non è client`).toBe('client')
  })

  it('il tipo usa i tre valori dell’enum del database', () => {
    expect(filtra({ tipo: 'gradimento' })).toEqual(['b'])
    expect(filtra({ tipo: 'sondaggio' })).toEqual(['c'])
  })

  it('la scadenza separa i tre stati, e «senza» non finisce fra gli «attivi»', () => {
    expect(filtra({ scadenza: 'attivi' })).toEqual(['a'])
    expect(filtra({ scadenza: 'scaduti' })).toEqual(['b'])
    expect(filtra({ scadenza: 'senza' })).toEqual(['c'])
  })

  it('la classe è un `multi`: un modulo passa se ANCHE UNA delle sue classi è fra quelle scelte', () => {
    expect(filtra({ classe: ['PRIMAVERA A'] })).toEqual(['a', 'c'])
    expect(filtra({ classe: ['INFANZIA B'] })).toEqual(['b', 'c'])
    // OR dentro il campo: due scelte non restringono, allargano.
    expect(filtra({ classe: ['PRIMAVERA A', 'INFANZIA B'] })).toEqual(['a', 'b', 'c'])
  })

  it('«solo gli essenziali» tiene chi lo dichiara, e `undefined` NON vale «sì»', () => {
    // Sul DB E2E non migrato la colonna può non arrivare: `undefined` deve valere «non lo
    // so», cioè non passa — mai «sì», che metterebbe fra i moduli firmabili da un genitore
    // sospeso dei moduli che nessuno ha dichiarato tali.
    expect(filtra({ essenziali: true })).toEqual(['a'])
    const senzaColonna = [modulo({ id: 'z', sempre_firmabile: undefined })]
    const c = campi()
    expect(filtraRighe(c, { ...valoriIniziali(c), essenziali: true }, senzaColonna)).toEqual([])
  })

  it('il periodo su `created_at` è INCLUSIVO ai due estremi, sul giorno italiano', () => {
    // L'estremo superiore che perde l'ultimo giorno è il difetto più comune di tutti, e si
    // nota solo quando manca la registrazione di fine mese.
    expect(filtra({ creato: { da: '2026-03-10', a: '2026-03-10' } })).toEqual(['c'])
    expect(filtra({ creato: { da: '2026-01-15', a: '2026-03-10' } })).toEqual(['a', 'c'])
    expect(filtra({ creato: { da: '', a: '2026-01-15' } })).toEqual(['a'])
  })

  it('la ricerca guarda titolo E descrizione', () => {
    expect(filtra({ q: 'museo' })).toEqual(['a'])
    // «Un giudizio sul servizio» è solo nella descrizione: senza, quel modulo non si trova
    // scrivendo la parola con cui chi l'ha creato lo ricorda.
    expect(filtra({ q: 'giudizio' })).toEqual(['b'])
  })

  it('i criteri si combinano in AND', () => {
    expect(filtra({ classe: ['PRIMAVERA A'], scadenza: 'senza' })).toEqual(['c'])
    expect(filtra({ classe: ['PRIMAVERA A'], tipo: 'gradimento' })).toEqual([])
  })
})
