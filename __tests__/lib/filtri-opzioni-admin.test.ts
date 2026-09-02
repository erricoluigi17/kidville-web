import { describe, it, expect } from 'vitest'
import { opzioniUtili, ordinaPerRicerca } from '@/lib/ui/opzioni-filtro'
import type { OpzioneFiltro } from '@/lib/ui/filtri/tipi'

/**
 * ─── I DUE COMPLEMENTI DEL MOTORE, e perché non stanno DENTRO il motore ──────
 *
 * `src/lib/ui/filtri/` è chiuso: è il motore, e si prova per conto suo. Queste due
 * funzioni non sono motore — sono due decisioni che riguardano **come si presenta** un
 * filtro nell'area admin, e vivono accanto ai descrittori che le usano. Stanno però in un
 * modulo SOLO, e non copiate in quattro file: sono la stessa regola per quattro linguette,
 * e una regola copiata quattro volte si corregge in tre.
 *
 *  1. **Una scelta sola non è una scelta.** Le opzioni di sede, classe e genere nascono dai
 *     DATI (`opzioniDerivate`), e con una sede sola l'elenco esce con una voce: un controllo
 *     che, qualunque cosa si prema, mostra le stesse righe. Non è inerte — occupa la barra,
 *     entra nel conteggio dei filtri attivi e fa premere qualcosa a vuoto.
 *
 *  2. **La ricerca su un catalogo ORDINA, non solo tiene o scarta.** Il motore filtra e
 *     basta, ed è giusto: `filtraRighe` non ordina niente perché su un elenco di pratiche
 *     l'ordine è quello della tabella. Su un catalogo di diciassette modelli, invece, chi
 *     scrive «cert» vuole «Certificato di servizio» PRIMA di «Richiesta di un certificato»,
 *     e `rangoDiMatch` sa già dire quale delle due corrisponde meglio.
 */

const opz = (valore: string): OpzioneFiltro => ({ valore, etichetta: valore })

describe('opzioniUtili — una scelta sola non restringe niente', () => {
  it('lascia passare due o più opzioni, intatte e nello stesso ordine', () => {
    const elenco = [opz('a'), opz('b'), opz('c')]
    expect(opzioniUtili(elenco)).toEqual(elenco)
  })

  it('azzera un elenco con UNA sola opzione: il campo si nasconde (`nascondiSeVuoto`)', () => {
    expect(opzioniUtili([opz('unica')])).toEqual([])
  })

  it('un elenco già vuoto resta vuoto', () => {
    expect(opzioniUtili([])).toEqual([])
  })
})

describe('ordinaPerRicerca — la qualità della corrispondenza decide l’ordine', () => {
  const etichetta = (r: { nome: string }) => r.nome

  it('senza query l’ordine di partenza non si tocca', () => {
    const righe = [{ nome: 'Zeta' }, { nome: 'Alfa' }, { nome: 'Mu' }]
    expect(ordinaPerRicerca(righe, '', etichetta)).toEqual(righe)
    // Anche una query di soli spazi è «non sto cercando niente».
    expect(ordinaPerRicerca(righe, '   ', etichetta)).toEqual(righe)
  })

  it('prima chi comincia con la query, poi chi la porta a inizio parola, poi chi la nasconde dentro', () => {
    const righe = [
      { nome: 'Richiesta di un certificato' }, // «cert» dentro una parola? no: inizio di parola
      { nome: 'Autocertificazione' }, // «cert» dentro una parola
      { nome: 'Certificato di servizio' }, // «cert» in testa
    ]
    expect(ordinaPerRicerca(righe, 'cert', etichetta).map((r) => r.nome)).toEqual([
      'Certificato di servizio',
      'Richiesta di un certificato',
      'Autocertificazione',
    ])
  })

  it('a parità di rango l’ordine di partenza resta (l’ordinamento è stabile)', () => {
    // Senza stabilità l'elenco si rimescolerebbe a ogni battuta di tasto fra voci
    // equivalenti: il catalogo «balla» e non si ritrova più niente.
    const righe = [{ nome: 'Delega al ritiro' }, { nome: 'Delega permanente' }, { nome: 'Deleghe attive' }]
    expect(ordinaPerRicerca(righe, 'deleg', etichetta).map((r) => r.nome)).toEqual([
      'Delega al ritiro',
      'Delega permanente',
      'Deleghe attive',
    ])
  })

  it('accenti e apostrofi non cambiano il rango: si passa dalla stessa normalizzazione della ricerca', () => {
    const righe = [{ nome: 'Verbale di infortunio' }, { nome: 'Attività dell’anno' }]
    expect(ordinaPerRicerca(righe, 'attivita dell anno', etichetta)[0].nome).toBe('Attività dell’anno')
    expect(ordinaPerRicerca(righe, 'ATTIVITÀ', etichetta)[0].nome).toBe('Attività dell’anno')
  })

  it('chi non corrisponde affatto finisce in fondo, senza sparire', () => {
    // Non è un filtro: scartare qui vorrebbe dire due regole di «corrisponde» — una nel
    // motore e una qui — e il giorno in cui divergono l'elenco perde righe in silenzio.
    const righe = [{ nome: 'Niente a che vedere' }, { nome: 'Nulla osta' }]
    expect(ordinaPerRicerca(righe, 'osta', etichetta).map((r) => r.nome)).toEqual([
      'Nulla osta',
      'Niente a che vedere',
    ])
  })

  it('non muta l’array ricevuto', () => {
    const righe = [{ nome: 'Bravo' }, { nome: 'Alfa' }]
    const copia = [...righe]
    ordinaPerRicerca(righe, 'alfa', etichetta)
    expect(righe).toEqual(copia)
  })
})
