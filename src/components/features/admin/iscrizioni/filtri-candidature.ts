import { GRADI_OPTIONS, POSIZIONI_OPTIONS, TITOLI_STUDIO } from '@/lib/forms/insegnanti-template'
import type { CampoFiltro, OpzioneFiltro, Periodo, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * ─── I FILTRI DELLE CANDIDATURE — TUTTI `dove: 'server'` ─────────────────────
 *
 * 392 candidature in produzione (misurate il 2026-09-01) e un elenco che carica
 * a pagine da 50: qui un filtro CLIENT non è una scorciatoia, è una bugia. Con
 * «Rifiutata» selezionato scriverebbe «3 risultati» mentre 342 righe mai
 * caricate corrispondono al criterio, e il numero accanto — «3 su 392» — sarebbe
 * l'unico posto in cui la contraddizione si vede, scritto piccolo.
 *
 * Il tipo `CampoFiltro` impedisce l'errore opposto: un campo `dove: 'server'`
 * NON può portare un estrattore, e uno `dove: 'client'` deve portarlo. Non è una
 * raccomandazione, è la forma del tipo, e `tsc` la fa rispettare.
 *
 * ── LE ETICHETTE DEGLI STATI ARRIVANO DA FUORI ──────────────────────────────
 *
 * Non si traducono qui: le passa il pannello, GIÀ RISOLTE, dalle stesse chiavi
 * (`candStato*`) con cui disegna il badge di ogni riga. Due cataloghi per la
 * stessa parola sono due parole diverse nella stessa schermata — «In attesa» nel
 * filtro e «In valutazione» nel badge — ed è esattamente ciò che il lock del
 * glossario sorveglia. Il `tono` segue la stessa regola: è quello del badge.
 *
 * ── E LE ALTRE VOCI VENGONO DAL TEMPLATE ────────────────────────────────────
 *
 * Posizioni, fasce e titoli di studio si leggono da `insegnanti-template.ts`,
 * che è il contratto del modulo pubblico. Ribatterli qui vorrebbe dire che il
 * giorno in cui il modulo aggiunge una voce, quella voce esiste in tabella e non
 * è filtrabile — cioè un elenco che non trova righe che ci sono.
 */

/** Come il pannello chiama i quattro stati: le stringhe del badge, già tradotte. */
export interface EtichetteStatoCandidatura {
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
export function campiCandidature<R>(
  t: Traduttore,
  etichetteStato: EtichetteStatoCandidatura,
  opzioniSede: readonly OpzioneFiltro[],
  formattaData: (iso: string) => string,
): CampoFiltro<R>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtriCandRicerca'),
      segnaposto: t('filtriCandRicercaSegnaposto'),
      dove: 'server',
      primario: true,
    },
    {
      tipo: 'chip',
      chiave: 'stato',
      etichetta: t('filtriCandStato'),
      dove: 'server',
      primario: true,
      // ⚠️ Lo `stato` che il server filtra è quello della RIGA DI SEDE, cioè lo
      // stesso che il badge mostra: filtrare sulla colonna aggregata farebbe
      // sparire righe il cui badge dice il contrario.
      opzioni: [
        { valore: 'pending', etichetta: etichetteStato.pending, tono: 'warn' },
        { valore: 'in_approvazione', etichetta: etichetteStato.in_approvazione, tono: 'info' },
        { valore: 'approvata', etichetta: etichetteStato.approvata, tono: 'success' },
        { valore: 'rifiutata', etichetta: etichetteStato.rifiutata, tono: 'error' },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'scuola_id',
      etichetta: t('filtriCandSede'),
      dove: 'server',
      primario: true,
      nascondiSeVuoto: true,
      opzioni: opzioniSede,
    },
    {
      tipo: 'interruttore',
      chiave: 'daEvadere',
      etichetta: t('filtriCandDaEvadere'),
      dove: 'server',
    },
    {
      tipo: 'scelta',
      chiave: 'posizione',
      etichetta: t('filtriCandPosizione'),
      dove: 'server',
      opzioni: POSIZIONI_OPTIONS.map((o): OpzioneFiltro => ({
        valore: String(o.value),
        etichetta: String(o.label),
      })),
    },
    {
      tipo: 'scelta',
      chiave: 'grado',
      etichetta: t('filtriCandGrado'),
      dove: 'server',
      opzioni: GRADI_OPTIONS.map((o): OpzioneFiltro => ({
        valore: String(o.value),
        etichetta: String(o.label),
      })),
    },
    {
      tipo: 'scelta',
      chiave: 'titolo',
      etichetta: t('filtriCandTitolo'),
      dove: 'server',
      opzioni: TITOLI_STUDIO.map((o): OpzioneFiltro => ({
        valore: String(o.value),
        etichetta: String(o.label),
      })),
    },
    /*
     * ⚠️ QUI NON CI SONO `citta` E `provincia`, e NON è una dimenticanza.
     *
     * `BarraFiltri` disegna UN SOLO campo di testo — quello della prima riga — e
     * per ogni altro `tipo: 'ricerca'` il suo `ControlloFiltro` ritorna `null`.
     * Un secondo campo libero qui dentro non sarebbe «un filtro in più»:
     * sarebbe un filtro che vive nello stato e nell'indirizzo e non ha nessun
     * controllo a schermo — invisibile, e togliibile solo modificando l'URL a
     * mano. È esattamente la categoria di difetto che questo lavoro chiude.
     *
     * I due parametri restano validati e applicati dalla rotta
     * (`?citta=`, `?provincia=`): un indirizzo li porta, e chi li manda ottiene
     * ciò che ha chiesto. E la CITTÀ è comunque raggiungibile da qui: la ricerca
     * `q` la comprende (vedi il segnaposto), quindi «Giugliano» trova chi ci
     * abita senza bisogno di un campo suo.
     */
    {
      tipo: 'scelta',
      chiave: 'esperienza_min',
      etichetta: t('filtriCandEsperienza'),
      dove: 'server',
      // Soglie e non un numero libero: la domanda che si fa davvero è «chi ha
      // almeno qualche anno», non «chi ne ha esattamente sette». Un campo
      // numerico aperto qui produrrebbe soprattutto elenchi vuoti.
      // ⚠️ Chi NON ha dichiarato gli anni resta fuori da tutte le soglie: il
      // campo è facoltativo nel modulo, e `null` non è «zero anni».
      opzioni: [
        { valore: '1', etichetta: t('filtriCandEsperienza1') },
        { valore: '3', etichetta: t('filtriCandEsperienza3') },
        { valore: '5', etichetta: t('filtriCandEsperienza5') },
        { valore: '10', etichetta: t('filtriCandEsperienza10') },
      ],
    },
    {
      tipo: 'periodo',
      chiave: 'creata',
      etichetta: t('filtriCandPeriodo'),
      dove: 'server',
      descrivi: (p: Periodo) =>
        [p.da && formattaData(p.da), p.a && formattaData(p.a)].filter(Boolean).join(' → '),
    },
  ]
}
