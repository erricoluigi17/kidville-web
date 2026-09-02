import type { CampoFiltro, OpzioneFiltro, Periodo, Traduttore } from '@/lib/ui/filtri/tipi'

/**
 * ─── I FILTRI DI «MODULI RICEVUTI» — TUTTI `dove: 'server'` ──────────────────
 *
 * 533 domande di iscrizione in produzione (misurate il 2026-09-01), elenco
 * paginato a 50, e circa sei nuove al giorno. È la linguetta con più righe di
 * tutto il cockpit: un filtro nel browser qui non è impreciso, è muto — direbbe
 * «2 risultati» su cinquanta righe caricate e non nominerebbe mai le altre 483.
 *
 * ── LA RICERCA ENTRA DENTRO `data` jsonb, E NON ERA SCONTATO ────────────────
 *
 * Il nome del bambino — l'unico modo in cui la segreteria riconosce una domanda
 * — vive nel payload che l'elenco NON restituisce più. Che PostgREST accetti un
 * percorso JSON dentro un filtro è stato MISURATO contro il database vero prima
 * di scriverlo, con due controlli negativi accanto ai positivi (il dettaglio è
 * nel blocco `PERCORSI_RICERCA_FIGLI` di `api/admin/iscrizioni/route.ts`). E la
 * ricerca guarda TUTTI i figli, non solo il primo: 63 domande su 533 ne hanno
 * più di uno, e cercando il nome del secondo l'elenco perdeva nove famiglie su
 * centosessantanove senza dirlo a nessuno.
 */

/** Come il pannello chiama i tre stati: le stringhe del badge, già tradotte. */
export interface EtichetteStatoDomanda {
  pending: string
  approved: string
  rejected: string
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
export function campiRicevuti<R>(
  t: Traduttore,
  etichetteStato: EtichetteStatoDomanda,
  opzioniSede: readonly OpzioneFiltro[],
  formattaData: (iso: string) => string,
): CampoFiltro<R>[] {
  return [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('filtriRicevRicerca'),
      segnaposto: t('filtriRicevRicercaSegnaposto'),
      dove: 'server',
      primario: true,
    },
    {
      tipo: 'chip',
      chiave: 'stato',
      etichetta: t('filtriRicevStato'),
      dove: 'server',
      primario: true,
      // I valori sono quelli in tabella (`enrollment_submissions.status`), le
      // parole quelle dei badge dell'elenco: stessa cosa, stesso nome.
      opzioni: [
        { valore: 'pending', etichetta: etichetteStato.pending, tono: 'warn' },
        { valore: 'approved', etichetta: etichetteStato.approved, tono: 'success' },
        { valore: 'rejected', etichetta: etichetteStato.rejected, tono: 'error' },
      ],
    },
    {
      tipo: 'scelta',
      chiave: 'scuola_id',
      etichetta: t('filtriRicevSede'),
      dove: 'server',
      primario: true,
      nascondiSeVuoto: true,
      opzioni: opzioniSede,
    },
    {
      tipo: 'interruttore',
      chiave: 'daLavorare',
      etichetta: t('filtriRicevDaLavorare'),
      dove: 'server',
    },
    {
      tipo: 'periodo',
      chiave: 'creato',
      etichetta: t('filtriRicevPeriodo'),
      dove: 'server',
      descrivi: (p: Periodo) =>
        [p.da && formattaData(p.da), p.a && formattaData(p.a)].filter(Boolean).join(' → '),
    },
  ]
}
