import type { SupabaseClient } from '@supabase/supabase-js'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { stockDiAlunno } from '@/lib/armadietto/stock'
import { soglieMateriali } from '@/lib/armadietto/soglie'

const TAVOLA = 'armadietto_richieste'

export interface EsitoRiconciliazione { aperte: number; aggiornate: number; evase: number }

interface RichiestaViva {
    id: string
    materiale: string
    livello: 'giallo' | 'rosso'
    stato: 'aperta' | 'presa_in_carico'
}

/**
 * Allinea le richieste di rifornimento allo stock reale di un alunno.
 *
 * Apre a `stock <= allerta` (`rosso` sotto `emergenza`), chiude sopra la stessa
 * linea: la soglia di apertura e quella di chiusura coincidono, quindi non c'è
 * zona morta e non c'è ping-pong finché lo stock non attraversa davvero il confine.
 *
 * Promuove giallo → rosso ma NON declassa: un allarme già dato al genitore non si
 * ritira perché la maestra ha caricato due pezzi.
 *
 * ⚠️ Se lo stock non è leggibile non fa NULLA. Chiudere una richiesta su un dato
 * non letto significherebbe dire al genitore «non serve più» senza saperlo.
 *
 * ⚠️ LE SOGLIE VOGLIONO `section_id`, NON IL NOME DELLA CLASSE. `soglieMateriali`
 * su un nome di sezione non fallisce: ripiega sui default IN SILENZIO, e le
 * richieste nascerebbero sulle soglie sbagliate senza che nessuno se ne accorga.
 * Per questo `section_id` si legge da `alunni` qui dentro, e non lo passa il
 * chiamante.
 *
 * L'evento di log è `db` e non `armadietto`: il vocabolario di `logEvento` è un
 * elenco CHIUSO (`EVENTI_NOTI` in `src/lib/logging/logger.ts`, lock
 * `__tests__/architecture/eventi-log.test.ts`) e `armadietto` non ne fa parte.
 * È la stessa scelta già fatta da `stock.ts` e `soglie.ts`: il nome del modulo
 * viaggia in `operazione`, che è la chiave che sopravvive alla lista bianca di
 * `redact()` e con cui si interroga la tabella.
 */
export async function riconciliaRichieste(
    admin: SupabaseClient,
    { alunnoId }: { alunnoId: string },
): Promise<EsitoRiconciliazione> {
    const esito: EsitoRiconciliazione = { aperte: 0, aggiornate: 0, evase: 0 }

    const { data: al, error: alErr } = await admin
        .from('alunni').select('section_id, scuola_id').eq('id', alunnoId).maybeSingle()
    if (alErr || !al?.scuola_id) {
        logEvento('db', 'warn', {
            operazione: 'armadietto/riconcilia', esito: 'anagrafica-non-leggibile',
        }, alErr)
        return esito
    }

    const stock = await stockDiAlunno(admin, alunnoId)
    if (stock === null) return esito   // già loggato da stockDiAlunno

    const soglie = await soglieMateriali(admin, (al.section_id as string | null) ?? null)

    const { data: viveRaw, error: viveErr } = await admin
        .from(TAVOLA).select('id, materiale, livello, stato').eq('alunno_id', alunnoId).neq('stato', 'evasa')
    if (viveErr) {
        logErrore({ operazione: 'armadietto/riconcilia', evento: 'db' }, viveErr)
        return esito
    }
    const vive = new Map(((viveRaw as RichiestaViva[] | null) ?? []).map((r) => [r.materiale, r]))

    const adesso = new Date().toISOString()

    for (const [materiale, soglia] of Object.entries(soglie)) {
        // ⚠️ «MAI PORTATO» NON È «FINITO», e la differenza vale quattro notifiche a
        // famiglia. `locker_config` è vuota per scelta del titolare, quindi `soglie`
        // contiene SEMPRE tutti e quattro i `MATERIALI_DEFAULT`, per ogni bambino.
        // Con `stock[materiale] ?? 0` un materiale mai movimentato risulterebbe a
        // zero, cioè sotto la soglia di emergenza: la passata delle 06:00 aprirebbe
        // una richiesta ROSSA di Crema, Salviette e Cambio a ogni bambino che ha in
        // armadietto anche solo i pannolini, e il genitore riceverebbe l'allarme per
        // roba che non ha mai portato.
        //
        // La chiave ASSENTE dal libro giornale significa «di questo materiale non
        // esiste nessun movimento», non «è esaurito». L'esaurimento vero si vede
        // eccome: consumando fino a zero la chiave RESTA, con valore 0 (`stock.ts`
        // fa `Math.max(0, …)`, non cancella). È la stessa distinzione che `stock.ts`
        // difende fra `null` e `{}`: assenza di dato non è misura.
        const q = stock[materiale]
        if (q === undefined) continue
        const viva = vive.get(materiale)
        const sotto = q <= soglia.allerta
        const livello: 'giallo' | 'rosso' = q <= soglia.emergenza ? 'rosso' : 'giallo'

        if (!sotto) {
            if (viva) {
                const { error } = await admin.from(TAVOLA)
                    .update({ stato: 'evasa', evasa_il: adesso, aggiornato_il: adesso })
                    .eq('id', viva.id)
                if (error) logErrore({ operazione: 'armadietto/riconcilia:evade', evento: 'db' }, error)
                else esito.evase++
            }
            continue
        }

        if (viva) {
            // Solo verso il peggio. `quantita_residua` si aggiorna sempre: è il
            // numero che il genitore legge nella notifica.
            const nuovo = viva.livello === 'rosso' ? 'rosso' : livello
            const { error } = await admin.from(TAVOLA)
                .update({ livello: nuovo, quantita_residua: q, aggiornato_il: adesso })
                .eq('id', viva.id)
            if (error) logErrore({ operazione: 'armadietto/riconcilia:aggiorna', evento: 'db' }, error)
            else esito.aggiornate++
            continue
        }

        // `insert` NUDO, e NON `upsert({ onConflict: 'alunno_id,materiale' })`.
        //
        // Qui c'era un `upsert`, con un commento che diceva «`ON CONFLICT`
        // sull'indice unico parziale: due scritture concorrenti non si rompono a
        // vicenda». Era falso, e non per sfumature: quella forma FALLISCE SEMPRE.
        // Misurato sul database vero il 2026-09-01 con `EXPLAIN`, che pianifica e
        // non scrive — l'inferenza dell'arbitro avviene in fase di planning:
        //
        //   EXPLAIN INSERT … ON CONFLICT (alunno_id, materiale) DO NOTHING;
        //   → ERROR 42P10: there is no unique or exclusion constraint
        //                  matching the ON CONFLICT specification
        //
        //   EXPLAIN INSERT … ON CONFLICT (alunno_id, materiale)
        //                    WHERE stato <> 'evasa' DO NOTHING;
        //   → Conflict Arbiter Indexes: armadietto_richieste_viva_uniq   ✅
        //
        // Postgres non infersce un indice PARZIALE da un `ON CONFLICT (colonne)`
        // nudo: per usarlo come arbitro pretende un `WHERE` che implichi il
        // predicato dell'indice. PostgREST emette solo l'elenco delle colonne
        // (`on_conflict=…`) e non ha modo di mandare il predicato, quindi da
        // supabase-js quella forma è IRRAGGIUNGIBILE. L'unico indice unico su
        // (alunno_id, materiale) è parziale (`WHERE stato <> 'evasa'`); l'altro
        // unico è la PK su `id`, che non conflitta mai.
        //
        // Sarebbe finita così: ogni apertura torna 42P10, `logErrore` scrive la
        // riga, `aperte` resta a zero. Il modulo non avrebbe MAI aperto una
        // richiesta, e lo si sarebbe visto solo in `app_log`.
        //
        // La guardia anti-doppione resta quella prevista dalla migrazione: è
        // l'indice parziale a farla, e non serve dirlo anche a PostgREST.
        const { error } = await admin.from(TAVOLA).insert({
            alunno_id: alunnoId,
            scuola_id: al.scuola_id as string,
            materiale,
            livello,
            quantita_residua: q,
            stato: 'aperta',
            creato_il: adesso,
            aggiornato_il: adesso,
        })

        if (!error) {
            esito.aperte++
        } else if (error.code === '23505') {
            // `23505` NON è un guasto: è la guardia che ha funzionato. Un'altra
            // scrittura concorrente (l'aggancio dopo il carico, mentre gira il cron)
            // ha già aperto quella richiesta, e l'indice parziale ha impedito il
            // doppione — che è esattamente ciò per cui esiste. `aperte` non si
            // incrementa: quella richiesta non l'ha aperta questa passata.
            //
            // Si logga `info` e non lo si ingoia (AGENTS.md regola 6): un errore
            // davvero ignorabile si logga comunque, dicendo perché.
            logEvento('db', 'info', {
                operazione: 'armadietto/riconcilia:apre',
                esito: 'richiesta-gia-viva',
                error_code: error.code,
            })
        } else {
            logErrore({ operazione: 'armadietto/riconcilia:apre', evento: 'db' }, error)
        }
    }

    // ─── LE RICHIESTE ORFANE ────────────────────────────────────────────────
    // Il ciclo qui sopra itera sulle SOGLIE, quindi una richiesta viva per un
    // materiale che la segreteria ha tolto da `locker_config` non viene MAI
    // guardata: nessun ramo la tocca, e resterebbe aperta per sempre. Il genitore
    // continuerebbe a vedersi chiedere una cosa che la scuola non traccia più, e
    // nessuna schermata direbbe perché.
    //
    // Si evade, ma il log non dice «è arrivato»: dice che il materiale non è più
    // tracciato. Sono due fatti diversi — una consegna della famiglia contro una
    // decisione della segreteria — e tenerli sulla stessa etichetta renderebbe
    // illeggibile proprio la domanda che si farà qualcuno: «quante richieste ha
    // chiuso il rifornimento, e quante le ha chiuse una modifica di listino?».
    //
    // ⚠️ NON copre il materiale che è ANCORA in `soglie` ma sparito dallo stock
    // (`q === undefined` più sopra): lì la richiesta resta aperta di proposito.
    // Assenza di movimenti non è prova che il bisogno sia finito, ed è la stessa
    // prudenza per cui uno stock illeggibile non chiude niente.
    for (const [materiale, viva] of vive) {
        if (Object.hasOwn(soglie, materiale)) continue
        const { error } = await admin.from(TAVOLA)
            .update({ stato: 'evasa', evasa_il: adesso, aggiornato_il: adesso })
            .eq('id', viva.id)
        if (error) {
            logErrore({ operazione: 'armadietto/riconcilia:evade-orfana', evento: 'db' }, error)
            continue
        }
        esito.evase++
        logEvento('db', 'info', {
            operazione: 'armadietto/riconcilia:evade-orfana',
            esito: 'materiale-non-piu-tracciato',
        })
    }

    return esito
}

/**
 * La passata completa, per il cron delle 06:00.
 *
 * Riconcilia OGNI alunno che ha almeno un movimento in `armadietto` — non solo
 * quelli mossi di recente. Serve proprio per i casi senza movimento: se ieri la
 * segreteria ha alzato una soglia da 5 a 8, le richieste devono comparire
 * stamattina, e nessun bambino si è mosso.
 */
export async function riconciliaTutto(
    admin: SupabaseClient,
): Promise<EsitoRiconciliazione & { alunni: number }> {
    const totale = { aperte: 0, aggiornate: 0, evase: 0, alunni: 0 }

    const { data, error } = await admin.from('armadietto').select('alunno_id')
    if (error) {
        logErrore({ operazione: 'armadietto/riconcilia-tutto', evento: 'db' }, error)
        return totale
    }

    const ids = [...new Set(((data as Array<{ alunno_id: string }> | null) ?? []).map((r) => r.alunno_id))]
    totale.alunni = ids.length

    for (const id of ids) {
        const e = await riconciliaRichieste(admin, { alunnoId: id })
        totale.aperte += e.aperte
        totale.aggiornate += e.aggiornate
        totale.evase += e.evase
    }

    return totale
}
