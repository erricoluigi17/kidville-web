// =============================================================================
// DOVE MANDARE I SOLDI, E A CHI: un motore solo.
//
// ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
// L'IBAN e l'intestatario del conto compaiono in due posti che parlano alla
// STESSA famiglia: il riquadro «Dati per il bonifico» delle email di sollecito
// (`@/lib/email/messaggi/sollecito`) e la card «Come pagare» di
// `/parent/pagamenti`. Sono le due righe che chi legge copia e incolla
// nell'home banking, e sono l'unico punto del prodotto in cui un dato
// sbagliato non produce un errore: produce un bonifico andato altrove.
//
// Due letture separate della stessa configurazione divergono al primo cambio, e
// la divergenza non si vede: l'email direbbe una cosa e la pagina un'altra,
// entrambe con l'aria di essere giuste. Perciò la coppia si compone QUI, una
// volta, e chi la mostra la riceve già fatta. Il lock
// `__tests__/architecture/coordinate-bonifico-un-motore-solo.test.ts` impedisce
// che ne nasca una seconda copia.
//
// ─── LE DUE REGOLE CHE QUESTO MODULO CUSTODISCE ─────────────────────────────
//  1. UN IBAN SBAGLIATO NON SI MOSTRA MAI. `ibanLeggibile` verifica le cifre di
//     controllo (mod 97) e restituisce `null` se non tornano: assente e
//     sbagliato finiscono nello stesso posto, perché mostrarne uno sbagliato è
//     peggio che ometterlo — l'errore lo scopre la famiglia dopo aver pagato.
//  2. L'INTESTATARIO NON È UN CAMPO NUOVO: è la denominazione del cedente, la
//     stessa che firma ricevute, attestazioni e fatture elettroniche
//     (`datiStruttura`, con il ripiego su `aruba_config.fiscal`). Un campo
//     dedicato sarebbe una seconda anagrafica destinata a divergere da quella
//     che emette i documenti.
//
// ⚠️ È UN MODULO DI SERVER, e non può diventare altro: importa `fiscale.ts`,
// che porta con sé il logger e quindi `node:crypto`. Un componente `'use client'`
// che lo importasse trascinerebbe tutto quello nel bundle della pagina — un
// difetto che `vitest` non vede e che salta fuori solo a `next build`. Il
// browser che deve validare un IBAN usa `./iban`, che è puro apposta.
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { leggiModuleConfig } from '@/lib/settings/module-config'
import { logEvento } from '@/lib/logging/logger'
import { datiStruttura, type ArubaFiscalConfig, type FiscaleConfig } from './fiscale'
import { ibanLeggibile, normalizzaIban } from './iban'

/** Le coordinate del bonifico di UNA sede. `null` = «non configurato», mai una stringa vuota. */
export interface CoordinateBonifico {
    scuola_id: string
    /** IBAN a gruppi di quattro. `null` se assente **o se le cifre di controllo non tornano**. */
    iban: string | null
    /** La denominazione di chi emette i documenti. `null` se non configurata. */
    intestatario: string | null
}

/**
 * Le coordinate del bonifico di una sede, dalla configurazione già esistente.
 *
 * Non lancia e non fallisce: quando la configurazione non c'è o non si è potuta
 * leggere escono due `null` — cioè «non lo sappiamo», che è la verità e che la
 * pagina sa mostrare («chiedile in segreteria»).
 *
 * ─── MA IL `null` NON PUÒ ESSERE MUTO (collaudo 2026-09-05, rilievo a) ───────
 * Fino a oggi i tre modi di finire a `null` — IBAN mai compilato, IBAN compilato
 * male, configurazione illeggibile — uscivano identici e senza una riga di log.
 * A schermo sono lo stesso ripiego, e in produzione l'IBAN è compilato su UNA
 * sede su tre: due famiglie su tre leggono «chiedile in segreteria» e dentro
 * l'azienda nessuno ha modo di saperlo. Adesso ognuno dei tre lascia la propria
 * riga, con il proprio livello:
 *
 *  · `warn`  `iban-non-configurato`     — nessuno l'ha ancora scritto. Da fare, non rotto.
 *  · `error` `iban-non-valido`          — qualcuno l'ha scritto credendo di aver finito e
 *                                         il prodotto lo sta scartando: è un guasto muto.
 *  · `warn`  `coordinate-non-leggibili` — la lettura è fallita; il prodotto degrada da sé.
 *
 * ⚠️ IL VALORE DELL'IBAN NON ENTRA NEI LOG, mai — nemmeno quello sbagliato: è
 * una coordinata bancaria della cooperativa. Ne esce la LUNGHEZZA delle sole
 * cifre (senza gli spazi con cui è stato digitato), che è ciò che distingue «ne
 * manca una» da «campo riempito a caso».
 *
 * ⚠️ `leggiModuleConfig` e non `getModuleConfig`: il secondo restituisce `{}`
 * sia quando la scuola non ha impostazioni sia quando la riga non si è potuta
 * leggere, e da qui i due casi vanno distinti — dedurre «l'IBAN non è
 * configurato» da una lettura fallita manderebbe la segreteria a compilare un
 * campo che potrebbe essere già compilato.
 *
 * @param ctx `operazione` finisce in ogni riga di log emessa da qui. Senza
 *   contesto si saprebbe CHE manca, non a chi serviva.
 */
export async function coordinateBonificoSede(
    supabase: SupabaseClient,
    scuolaId: string,
    ctx: { operazione: string },
): Promise<CoordinateBonifico> {
    // Senza parametro generico e con il cast dopo: `FiscaleConfig` è
    // un'interfaccia, e un'interfaccia non soddisfa `Record<string, unknown>` —
    // TypeScript non le attribuisce l'index signature implicita. È la stessa
    // forma che il file usava prima con `getModuleConfig`.
    const [esitoFiscale, esitoAruba] = await Promise.all([
        leggiModuleConfig(supabase, 'fiscale_config', scuolaId),
        leggiModuleConfig(supabase, 'aruba_config', scuolaId),
    ])

    if (!esitoFiscale.ok || !esitoAruba.ok) {
        // `leggiModuleConfig` ha già registrato il guasto di lettura sotto
        // `config`, con il nome della colonna. Questa riga aggiunge la sola cosa
        // che quella non sa: CHE COSA è rimasto senza risposta, e per chi. Il
        // nome della configurazione viaggia in `tipo` — chiave in lista bianca,
        // valore in forma di enumerato, quindi leggibile in `app_log` — e non in
        // un `msg`, che accanto a un errore verrebbe redatto.
        //
        // BASTA CHE NE CADA UNA. Le due letture vanno alla stessa riga di
        // `admin_settings`, quindi in pratica o falliscono insieme o non
        // falliscono: «una sì e una no» è un guasto transitorio. In quel caso si
        // rinuncia anche a ciò che si è letto — meglio «non lo sappiamo», che il
        // prodotto già sa mostrare, di un'affermazione composta a metà su dove
        // mandare dei soldi.
        logEvento('fiscale', 'warn', {
            operazione: ctx.operazione,
            esito: 'coordinate-non-leggibili',
            scuola_id: scuolaId,
            tipo: [!esitoFiscale.ok && 'fiscale_config', !esitoAruba.ok && 'aruba_config']
                .filter(Boolean)
                .join('+'),
        })
        return { scuola_id: scuolaId, iban: null, intestatario: null }
    }

    const fiscale = esitoFiscale.config as FiscaleConfig
    const aruba = esitoAruba.config as ArubaFiscalConfig

    // `livello: 'info'`: qui non si sta emettendo un documento, si sta componendo
    // una riga informativa che il genitore rilegge a ogni apertura della pagina —
    // e per Demo/E2E la riga in `admin_settings` non esiste nemmeno. Il buco si
    // vede lo stesso; non consuma la credibilità degli `error` veri. Vedi
    // `ContestoStruttura.livello`.
    //
    // Effetto collaterale voluto: `fiscale` NON è in `EVENTI_PERSISTITI`, quindi
    // questo `info` resta su console e non riempie `app_log` — mentre i tre
    // segnali qui sotto (`warn`/`error`) ci finiscono per livello, ed è
    // esattamente l'inverso di com'era: rumore in tabella e nessun segnale.
    const denominazione = datiStruttura(fiscale, aruba, {
        operazione: ctx.operazione,
        scuolaId,
        livello: 'info',
    }).denominazione.trim()

    const grezzo = normalizzaIban(fiscale?.iban)
    const iban = ibanLeggibile(grezzo)
    if (grezzo === '') {
        logEvento('fiscale', 'warn', {
            operazione: ctx.operazione,
            esito: 'iban-non-configurato',
            scuola_id: scuolaId,
        })
    } else if (iban === null) {
        logEvento('fiscale', 'error', {
            operazione: ctx.operazione,
            esito: 'iban-non-valido',
            scuola_id: scuolaId,
            lunghezza: grezzo.length,
        })
    }

    return {
        scuola_id: scuolaId,
        iban,
        intestatario: denominazione === '' ? null : denominazione,
    }
}
