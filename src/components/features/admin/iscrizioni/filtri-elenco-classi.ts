import { opzioniDerivate } from '@/lib/ui/filtri/motore'
import { opzioniUtili } from '@/lib/ui/opzioni-filtro'
import type { CampoFiltro, OpzioneFiltro, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * I FILTRI DI «ELENCO CLASSI» — e la prima domanda è: filtrare CHE COSA.
 *
 * Questa linguetta non elenca alunni: elenca CARICAMENTI, uno per sede, e dentro ciascuno le
 * difformità del foglio. Le card di sede sono tre (o quante sono le sedi) e non hanno bisogno
 * di essere cercate; le difformità sono decine su 338 righe vere, ed è lì che si perde tempo.
 * Perciò la superficie filtrabile è UNA SOLA: le difformità, appiattite in righe che portano
 * con sé la sede da cui vengono.
 *
 * ─── 🔴 IL TESTO SU CUI SI CERCA CONTIENE IL NOME DI UN BAMBINO ─────────────────
 *
 * `Anomalia.nome` è «il nome com'è scritto» sul foglio, e il `dettaglio` spesso lo ripete.
 * Cercarci dentro è esattamente ciò che serve — è così che si ritrova la riga da correggere —
 * ma per questo il pannello monta la barra con `scriviUrl: false`: un indirizzo si copia, si
 * incolla in una chat e resta nella cronologia del browser. È l'unica delle quattro linguette
 * di «Modulistica» in cui la ricerca NON entra nell'URL, e la ragione è tutta qui.
 */

/** Una difformità, appiattita: la sede non sta nella riga del server, e serve per filtrare. */
export interface RigaDifformita {
  sedeId: string
  genere: string
  classe: string
  rigaExcel: number
  /** Il nome com'è scritto sul foglio: è un dato personale. Non va nei log né nell'URL. */
  nome: string
  dettaglio: string
  /** Ferma un'iscrizione (o fa sparire dei bambini): lo decide il pannello, non il server. */
  bloccante: boolean
}

/**
 * I nove generi che l'importatore sa produrre (`GenereAnomalia` in
 * `lib/iscrizioni/import/elenco.ts`), con la loro chiave di catalogo.
 *
 * ⚠️ È una mappa ESPLICITA e non `t('filtriClassiGenere' + camelCase(genere))`: una chiave
 * costruita da un dato renderebbe cieco `messaggi-chiavi-orfane` su tutto il namespace
 * `adminModulistica`, che è sotto tutela proprio perché nessuna delle sue chiavi lo è. Un
 * genere nuovo, senza la sua riga qui, si mostra col proprio nome tecnico: brutto e onesto —
 * mai un'etichetta sbagliata.
 */
const CHIAVE_GENERE: Record<string, string> = {
  'nome-mancante': 'filtriClassiGenereNomeMancante',
  'retta-mancante': 'filtriClassiGenereRettaMancante',
  'retta-non-numerica': 'filtriClassiGenereRettaNonNumerica',
  'nome-ripetuto': 'filtriClassiGenereNomeRipetuto',
  'spazi-anomali': 'filtriClassiGenereSpaziAnomali',
  'retta-fuori-scala': 'filtriClassiGenereRettaFuoriScala',
  'colonna-senza-classe': 'filtriClassiGenereColonnaSenzaClasse',
  'classe-riscritta': 'filtriClassiGenereClasseRiscritta',
  'classe-senza-sezione': 'filtriClassiGenereClasseSenzaSezione',
}

export const etichettaGenere = (genere: string, t: Traduttore): string =>
  CHIAVE_GENERE[genere] ? t(CHIAVE_GENERE[genere]) : genere

/** Le sedi che hanno almeno una difformità, col loro nome. */
export function opzioniSedeDifformita(
  righe: readonly RigaDifformita[],
  nomeSede: (id: string) => string | undefined,
): readonly OpzioneFiltro[] {
  return opzioniUtili(
    opzioniDerivate(righe, (r) => r.sedeId, { etichettaDi: (id) => nomeSede(id) ?? id }),
  )
}

/** I generi presenti davvero: un elenco fisso di nove offrirebbe otto scelte a vuoto. */
export function opzioniGenere(
  righe: readonly RigaDifformita[],
  t: Traduttore,
): readonly OpzioneFiltro[] {
  return opzioniUtili(
    opzioniDerivate(righe, (r) => r.genere, { etichettaDi: (g) => etichettaGenere(g, t) }),
  )
}

/**
 * Le classi fra cui scegliere vengono da `perClasse`, cioè dai FOGLI, e non dalle
 * difformità — ed è la differenza che fa la domanda utile.
 *
 * Un elenco costruito sulle difformità offrirebbe solo le classi che ne hanno, e non saprebbe
 * mai rispondere a «questa classe è a posto?»: la classe pulita non comparirebbe affatto, e
 * la sua assenza si legge come «classe che non esiste». Costruito sui fogli, invece,
 * sceglierla dà l'insieme vuoto — che è la risposta, e si legge.
 *
 * ⚠️ Il `conteggio` di `opzioniDerivate` qui si BUTTA: conterebbe in quanti fogli quella
 * classe compare (uno, quasi sempre), cioè un numero che non varia. Un contatore che dice
 * sempre «1» accanto a ogni voce non informa: fa solo credere che ci sia una difformità.
 */
export function opzioniClasse(
  perClasse: readonly { classe: string }[],
): readonly OpzioneFiltro[] {
  return opzioniUtili(
    opzioniDerivate(perClasse, (c) => c.classe).map(({ valore, etichetta }) => ({
      valore,
      etichetta,
    })),
  )
}

export function campiDifformita(
  t: Traduttore,
  opzioni: {
    sede: readonly OpzioneFiltro[]
    classe: readonly OpzioneFiltro[]
    genere: readonly OpzioneFiltro[]
  },
): CampoFiltro<RigaDifformita>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtriClassiRicerca'),
      segnaposto: t('filtriClassiRicercaSegnaposto'),
      dove: 'client',
      primario: true,
      testiDi: (r) => [r.nome, r.dettaglio, r.classe],
    },
    {
      tipo: 'interruttore',
      chiave: 'bloccanti',
      etichetta: t('filtriClassiSoloBloccanti'),
      dove: 'client',
      // È il filtro che si preme tutti i giorni: sta nella prima riga, non nel pannello.
      primario: true,
      predicato: (r) => r.bloccante,
    },
    {
      tipo: 'scelta',
      chiave: 'sede',
      etichetta: t('filtriClassiSede'),
      dove: 'client',
      primario: true,
      nascondiSeVuoto: true,
      valoreDi: (r) => r.sedeId,
      opzioni: opzioni.sede,
    },
    {
      tipo: 'scelta',
      chiave: 'classe',
      etichetta: t('filtriClassiClasse'),
      dove: 'client',
      nascondiSeVuoto: true,
      valoreDi: (r) => r.classe,
      opzioni: opzioni.classe,
    },
    {
      tipo: 'multi',
      chiave: 'genere',
      etichetta: t('filtriClassiGenere'),
      dove: 'client',
      nascondiSeVuoto: true,
      // Un `multi`: «nome mancante OPPURE nome ripetuto» è la domanda vera di chi sta
      // ripulendo i nomi. Con una scelta sola si dovrebbe passare due volte sullo stesso foglio.
      valoriDi: (r) => [r.genere],
      opzioni: opzioni.genere,
    },
  ]
}
