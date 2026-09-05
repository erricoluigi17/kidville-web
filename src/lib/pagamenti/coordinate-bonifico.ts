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
import { getModuleConfig } from '@/lib/settings/module-config'
import { datiStruttura, type ArubaFiscalConfig, type FiscaleConfig } from './fiscale'
import { ibanLeggibile } from './iban'

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
 * Non lancia e non fallisce: `getModuleConfig` degrada da solo a `{}` quando la
 * riga non c'è o non si è potuta leggere (e la registra), e da `{}` escono due
 * `null` — cioè «non lo sappiamo», che è la verità e che la pagina sa mostrare.
 *
 * @param ctx `operazione` finisce nella riga di log della configurazione fiscale
 *   mancante (AGENTS.md §4: configurazione assente = `error`). Senza contesto si
 *   saprebbe CHE manca, non a chi serviva.
 */
export async function coordinateBonificoSede(
    supabase: SupabaseClient,
    scuolaId: string,
    ctx: { operazione: string },
): Promise<CoordinateBonifico> {
    const [fiscale, aruba] = await Promise.all([
        getModuleConfig(supabase, 'fiscale_config', scuolaId) as Promise<FiscaleConfig>,
        getModuleConfig(supabase, 'aruba_config', scuolaId) as Promise<ArubaFiscalConfig>,
    ])
    const denominazione = datiStruttura(fiscale, aruba, {
        operazione: ctx.operazione,
        scuolaId,
    }).denominazione.trim()
    return {
        scuola_id: scuolaId,
        iban: ibanLeggibile(fiscale?.iban),
        intestatario: denominazione === '' ? null : denominazione,
    }
}
