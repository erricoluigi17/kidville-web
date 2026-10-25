/**
 * LE REGOLE COMUNI DEI CONTROLLI DELLA SESSIONE 7 (seconda serie di robustezza).
 *
 * Due regole, scritte in un posto solo perché valgono per cinque controlli (`cron-esiti`,
 * `storage`, `email`, `push`, `migrazioni`):
 *
 *  1. MAI `giu`. Un controllo nuovo dice al più `degradato` (HTTP 200): «qualcosa che nessuno
 *     vedrebbe è rotto». Il `503` resta di `db-lettura`, `auth` e `schema-atteso`, cioè di ciò
 *     senza cui nessuno entra; per `schema-atteso` solo se una tabella manca o non si legge, mai per
 *     lentezza. `db-lettura` e `auth` restano `giu` anche oltre il tetto di 2 s, ed è un'eccezione
 *     voluta (specifica, Sessione 7): sono i due controlli di `eseguiVivo`, cioè di
 *     `/api/health/vivo`, che risponde 200 su `degradato`; se il loro timeout scendesse a
 *     `degradato`, un database appeso risponderebbe 200 e il Worker `monitor-esterno` non suonerebbe
 *     più. Il tipo qui sotto non contiene `giu`, e il lock
 *     `__tests__/architecture/salute-controlli-nuovi-mai-giu.test.ts` vieta di aggiungerlo.
 *  2. LA TOLLERANZA DEL MERGE. Una migrazione e il deploy che la usa partono insieme: per qualche
 *     minuto il codice nuovo chiede una funzione che PostgREST non conosce ancora (`PGRST202`),
 *     oppure il repo dichiara una migrazione che il database non ha ancora. Per
 *     `TOLLERANZA_MERGE_MS` dopo la build quella differenza è attesa e si dice `ok`, con il
 *     motivo nel dettaglio; dopo, è un'integrazione che non ha applicato, e si dice `degradato`.
 *     Fuori da una build (test, script) l'istante non c'è e non scade niente.
 *
 * I 30 minuti sono una SCELTA, non una misura: tre giri di `cron-esiti` (ogni 10 minuti) e margine
 * per l'integrazione Supabase, che applica le migrazioni al merge.
 */

export type EsitoSenzaGiu = 'ok' | 'degradato'

export interface Valutazione {
    esito: EsitoSenzaGiu
    dettaglio: string
}

export const TOLLERANZA_MERGE_MS = 30 * 60_000

/** Vero se una differenza fra repo e database è ancora attesa: build ignota o di al più 30 minuti fa. */
export function inAttesaDellIntegrazione(buildIl: number | null, adesso: number): boolean {
    return buildIl === null || adesso - buildIl <= TOLLERANZA_MERGE_MS
}
