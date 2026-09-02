import { GRADI_OPTIONS, TITOLI_STUDIO } from '@/lib/forms/insegnanti-template'
import { TIPI_DOCUMENTO } from '@/lib/forms/personale-template'
import type { CampoFiltro, OpzioneFiltro, Periodo, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * ─── I FILTRI DELLE PRATICHE DEL PERSONALE — TUTTI `dove: 'server'` ──────────
 *
 * 55 pratiche e un `limit` predefinito di 50: la pagina 2 esiste già. Il numero
 * piccolo rende il difetto PEGGIORE, non migliore — un filtro client qui
 * sbaglierebbe di cinque righe, cioè abbastanza poco perché nessuno se ne
 * accorga mai e abbastanza da mandare la Segreteria a cercare una pratica che
 * l'elenco giura di non avere.
 *
 * ── LA SCADENZA È IL FILTRO PER CUI QUESTA SCHERMATA ESISTE ─────────────────
 *
 * `document_expiry` è l'unica colonna dell'elenco che non serve a riconoscere
 * una persona ma a decidere cosa fare per prima: una pratica con il documento
 * scaduto è quella da guardare subito. Le quattro finestre le calcola il server
 * dal GIORNO CIVILE italiano — fra le 00:00 e le 02:00 un conto in UTC è al
 * giorno prima — e chi la scadenza non l'ha dichiarata resta fuori da tutte e
 * quattro: `null` non è «scaduto», è «non lo so».
 */

/** Come il pannello chiama i quattro stati: le stringhe del badge, già tradotte. */
export interface EtichetteStatoPratica {
  pending: string
  in_approvazione: string
  approvata: string
  rifiutata: string
}

/**
 * ⚠️ GENERICA IN `R`, e i campi sono TUTTI `dove: 'server'`.
 *
 * Un campo server non tocca mai una riga — il tipo glielo impedisce: non può
 * portare un estrattore — quindi questi descrittori valgono per qualunque forma
 * di riga, e la `R` la sceglie chi monta la barra. Fissarla a `never` sembrava
 * più onesto («qui non si guarda nessuna riga») ma non è assegnabile a nulla:
 * `useFiltri<RigaElenco>` la rifiuta, e la si aggirerebbe con un cast — cioè
 * togliendo proprio il controllo che tiene separati i due tipi di filtro.
 */
export function campiPratiche<R>(
  t: Traduttore,
  etichetteStato: EtichetteStatoPratica,
  opzioniSede: readonly OpzioneFiltro[],
  formattaData: (iso: string) => string,
): CampoFiltro<R>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtriPratRicerca'),
      segnaposto: t('filtriPratRicercaSegnaposto'),
      dove: 'server',
      primario: true,
    },
    {
      tipo: 'chip',
      chiave: 'stato',
      etichetta: t('filtriPratStato'),
      dove: 'server',
      primario: true,
      // Gli stessi toni del badge di riga: «In attesa» filtro e «In attesa»
      // pratica devono essere lo stesso arancione, o il colore smette di dire
      // qualcosa.
      opzioni: [
        { valore: 'pending', etichetta: etichetteStato.pending, tono: 'warn' },
        { valore: 'in_approvazione', etichetta: etichetteStato.in_approvazione, tono: 'info' },
        { valore: 'approvata', etichetta: etichetteStato.approvata, tono: 'success' },
        { valore: 'rifiutata', etichetta: etichetteStato.rifiutata, tono: 'error' },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'scadenza',
      etichetta: t('filtriPratScadenza'),
      dove: 'server',
      primario: true,
      // ⚠️ «Entro 90 giorni» COMPRENDE «entro 30»: è una finestra più larga, non
      // un'altra finestra. Insiemi disgiunti nasconderebbero a chi chiede «entro
      // 90» proprio i documenti che scadono la settimana prossima.
      opzioni: [
        { valore: 'scaduto', etichetta: t('filtriPratScadenzaScaduto'), tono: 'error' },
        { valore: 'entro30', etichetta: t('filtriPratScadenzaEntro30'), tono: 'warn' },
        { valore: 'entro90', etichetta: t('filtriPratScadenzaEntro90'), tono: 'warn' },
        { valore: 'valido', etichetta: t('filtriPratScadenzaValido'), tono: 'success' },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'scuola_id',
      etichetta: t('filtriPratSede'),
      dove: 'server',
      primario: true,
      nascondiSeVuoto: true,
      opzioni: opzioniSede,
    },
    {
      tipo: 'interruttore',
      chiave: 'daEvadere',
      etichetta: t('filtriPratDaEvadere'),
      dove: 'server',
    },
    {
      tipo: 'scelta',
      chiave: 'tipo_documento',
      etichetta: t('filtriPratTipoDocumento'),
      dove: 'server',
      // Le tre voci vengono dal template del modulo pubblico: aggiungerne una
      // qui e non là (o viceversa) produce un filtro che non trova righe che ci
      // sono, senza che nessun test diventi rosso.
      opzioni: TIPI_DOCUMENTO.map((o): OpzioneFiltro => ({
        valore: String(o.value),
        etichetta: String(o.label),
      })),
    },
    {
      tipo: 'scelta',
      chiave: 'grado',
      etichetta: t('filtriPratGrado'),
      dove: 'server',
      opzioni: GRADI_OPTIONS.map((o): OpzioneFiltro => ({
        valore: String(o.value),
        etichetta: String(o.label),
      })),
    },
    {
      tipo: 'scelta',
      chiave: 'titolo',
      etichetta: t('filtriPratTitolo'),
      dove: 'server',
      opzioni: TITOLI_STUDIO.map((o): OpzioneFiltro => ({
        valore: String(o.value),
        etichetta: String(o.label),
      })),
    },
    /*
     * ⚠️ `citta` e `provincia` restano fuori dalla barra per la stessa ragione
     * scritta in `filtri-candidature.ts`: `BarraFiltri` disegna un solo campo di
     * testo, e un secondo sarebbe un filtro senza controllo. I due parametri
     * restano nell'API, e la città è comunque dentro la ricerca `q`.
     */
    {
      tipo: 'periodo',
      chiave: 'creata',
      etichetta: t('filtriPratPeriodo'),
      dove: 'server',
      descrivi: (p: Periodo) =>
        [p.da && formattaData(p.da), p.a && formattaData(p.a)].filter(Boolean).join(' → '),
    },
  ]
}
