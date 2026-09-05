// Regole fiscali della contabilità:
//  • tracciabilità dei pagamenti (L. 160/2019: detrazione 19% solo con metodi
//    tracciabili; i contanti, anche parziali, escludono la detrazione);
//  • marca da bollo su documenti esenti IVA art. 10 DPR 633/72 oltre € 77,47;
//  • dati struttura per ricevute/attestazioni con fallback sui dati fiscali
//    già configurati per Aruba (aruba_config.fiscal).
//
// `fiscale_config` è la FONTE UNICA dell'anagrafica di chi emette: le ricevute e
// le attestazioni la leggono da qui (`datiStruttura`), la fattura elettronica la
// legge dagli stessi campi tramite `cedenteDaConfig` (@/lib/fatturazione/cedente).
// Prima erano due: il pannello Aruba raccoglieva la sede legale come stringa
// libera e l'XML cercava CAP e comune separati, che nessuno aveva mai scritto.

import { logEvento } from '@/lib/logging/logger'
import {
    componiIndirizzo,
    primoNonVuoto,
    type AnagraficaCedente,
    type FiscalAruba,
} from '@/lib/fatturazione/cedente'

/**
 * `admin_settings.fiscale_config`: l'anagrafica del CEDENTE più le regole del bollo.
 *
 * L'anagrafica non è ridichiarata qui — estende `AnagraficaCedente`, che è la
 * stessa forma che il pannello delle impostazioni valida e che il tracciato
 * FatturaPA consuma. Due elenchi di campi destinati a divergere erano esattamente
 * il difetto: `<CAP></CAP>` nell'XML perché la sede legale stava altrove, in una
 * stringa libera.
 *
 * L'import di `@/lib/fatturazione/cedente` va in QUESTA direzione (fiscale →
 * cedente) e non nell'altra: quel modulo è puro e lo carica anche il browser,
 * questo invece importa il logger, che trascina `node:crypto`.
 */
export interface FiscaleConfig extends AnagraficaCedente {
    bollo_enabled?: boolean
    bollo_soglia?: number
    bollo_importo?: number
    dicitura_bollo_ricevuta?: string
    /**
     * L'IBAN su cui le famiglie fanno il bonifico.
     *
     * NON è un campo del `CedentePrestatore` — infatti non sta su
     * `AnagraficaCedente` — e non entra nella fattura elettronica: l'emissione lo
     * ha tolto deliberatamente dal tracciato. Serve alle EMAIL di promemoria e
     * sollecito, dove il riquadro «Dati per il bonifico» è l'unica cosa che chi
     * legge deve poter copiare nell'home banking.
     *
     * Finché resta vuoto il riquadro mostra importo, causale e intestatario —
     * cioè esattamente quello che il sollecito manda oggi. Nessuna regressione, e
     * il giorno che qualcuno lo compila compare da solo.
     */
    iban?: string
    // ⚠️ NON esiste `bollo_riaddebito`, ed è una scelta: vedi il blocco qui sotto
    // a `bolloDovuto`. Una chiave rimasta in un `fiscale_config` già salvato viene
    // semplicemente ignorata (il JSONB tollera le chiavi in più).
}

export interface ArubaFiscalConfig {
    fiscal?: FiscalAruba
}

export interface DatiStruttura {
    denominazione: string
    piva: string
    codice_fiscale: string
    indirizzo: string
    cap: string
    comune: string
    provincia: string
}

export const BOLLO_SOGLIA_DEFAULT = 77.47
export const BOLLO_IMPORTO_DEFAULT = 2
export const DICITURA_BOLLO_DEFAULT =
    'Imposta di bollo assolta in modo virtuale (documento esente IVA art. 10 DPR 633/72 di importo superiore a € 77,47).'

// Slug di categorie che NON sono spese di istruzione detraibili: restano fuori
// dalla comunicazione AdE e dai totali detraibili delle attestazioni.
export const CATEGORIE_ESCLUSE_ADE = ['divisa', 'materiale']

const METODI_TRACCIABILI = new Set(['bonifico', 'pos', 'assegno'])

/** Il singolo metodo è tracciabile? (contanti/altro/ignoto → no) */
export function metodoTracciabile(metodo?: string | null): boolean {
    return !!metodo && METODI_TRACCIABILI.has(metodo)
}

/** Vero solo se OGNI incasso usa un metodo tracciabile (contanti/altro/ignoto escludono). */
export function isTracciabile(metodi: (string | null | undefined)[]): boolean {
    if (metodi.length === 0) return false
    return metodi.every((m) => metodoTracciabile(m))
}

/** Importo del bollo dovuto sul documento (0 se non dovuto o bollo disattivato). */
export function bolloDovuto(importo: number, cfg?: FiscaleConfig | null): number {
    if (!cfg?.bollo_enabled) return 0
    const soglia = cfg.bollo_soglia ?? BOLLO_SOGLIA_DEFAULT
    if (!(importo > soglia)) return 0
    return cfg.bollo_importo ?? BOLLO_IMPORTO_DEFAULT
}

/* ─── IL BOLLO NON SI RIADDEBITA AL CLIENTE, E NON C'È UN INTERRUTTORE CHE DICA
 * DI SÌ ───────────────────────────────────────────────────────────────────────
 *
 * Fino al 2026-08-10 qui viveva `bolloRiaddebitato(cfg)`, con in Impostazioni una
 * casella «Riaddebita il bollo al cliente» il cui testo prometteva: «il bollo è
 * una riga in più in fattura e il totale cresce di 2 €». Non lo faceva. La
 * funzione aveva ZERO chiamanti: `emissione.ts` passava il bollo al solo blocco
 * `<DatiBollo>`, la riga non veniva aggiunta e `<ImportoTotaleDocumento>` restava
 * l'imponibile. Accendere quella casella non cambiava un centesimo di nessuna
 * fattura, e due test verdi certificavano che «l'impostazione si salva».
 *
 * Un comando che promette un importo diverso e non lo produce è peggio di un
 * comando assente: chi lo accende crede di aver deciso. Perciò casella, helper e
 * chiavi i18n sono stati TOLTI, non lasciati con una nota nel PRD.
 *
 * Cosa servirebbe per implementarlo davvero, scritto qui perché chi lo riprenderà
 * non lo scopra a fatture emesse: il riaddebito è un'operazione ESCLUSA dall'IVA
 * ex art. 15 DPR 633/1972, cioè `Natura N1` — una riga con natura DIVERSA da
 * quella del resto del documento (N4, esente art. 10). Il generatore oggi ha
 * un'unica `iva` per tutte le righe e un solo `<DatiRiepilogo>`: vanno resi
 * plurali, riepilogo per natura. È una modifica al tracciato più una decisione
 * del commercialista, non una casella.
 */

/** Da dove arriva la richiesta, per la riga di log della config mancante. */
export interface ContestoStruttura {
    /** Nome della route/operazione: finisce nella colonna `operazione` di `app_log`. */
    operazione: string
    /** La sede di cui mancano i dati. Senza, si sa CHE manca ma non A CHI. */
    scuolaId?: string | null
    /**
     * Quanto pesa il buco PER CHI CHIAMA. Default `error`, e il default non si
     * tocca: chi non sceglie non deve poter abbassare l'allarme per distrazione.
     *
     * ─── PERCHÉ ESISTE (collaudo 2026-09-05, rilievo b) ────────────────────
     * «Configurazione mancante = incidente» (AGENTS.md §4) è stato scritto per
     * chi EMETTE un documento: la ricevuta esce anonima, e resta. Da quando
     * l'intestatario del conto compare anche nella card «Come pagare», questa
     * stessa funzione gira a OGNI apertura di `/parent/pagamenti` — percorso ad
     * alta frequenza che degrada da solo («chiedile in segreteria») — e per sedi
     * che in `admin_settings` la riga non ce l'hanno affatto (Demo, E2E). Lì un
     * `error` al giorno per sede non aggiunge una notizia: consuma la
     * credibilità degli `error` veri, ed è così che un allarme smette di essere
     * letto.
     *
     * Il buco continua a vedersi — la riga esce comunque, con gli stessi campi:
     * cambia solo quanto forte lo si grida.
     */
    livello?: 'error' | 'info'
}

/**
 * Dati struttura per i documenti: fiscale_config prevale, fallback su aruba_config.fiscal.
 *
 * ⚠️ CONFIGURAZIONE MANCANTE = INCIDENTE (AGENTS.md §4). Al 2026-07-31
 * `fiscale_config` è `{}` su tutte e quattro le righe di `admin_settings` e
 * `aruba_config` esiste solo per Giugliano, con `piva` e `ragione_sociale`
 * vuote: questa funzione restituisce allora sette stringhe vuote, il PDF stampa
 * l'intestazione generica al posto del nome dell'ente e omette del tutto la
 * riga fiscale — perché P.IVA e codice fiscale si stampano solo se valorizzati.
 * Il documento esce, semplicemente anonimo. È già successo almeno una volta
 * (`ricevute_emesse`: 1 riga), e non c'era un avviso da nessuna parte.
 *
 * Il comportamento NON cambia — i documenti continuano a omettere ciò che
 * manca, e non si inventa nessun dato fiscale — ma il buco adesso si vede.
 *
 * @param ctx senza, la riga di log esce comunque (con `operazione` generica):
 *   un chiamante che non passa il contesto non deve poter spegnere l'allarme.
 */
export function datiStruttura(
    fiscale?: FiscaleConfig | null,
    aruba?: ArubaFiscalConfig | null,
    ctx?: ContestoStruttura,
): DatiStruttura {
    const f = fiscale ?? {}
    const a = aruba?.fiscal ?? {}
    // `primoNonVuoto` e non `??`: una chiave salvata come stringa VUOTA dal
    // pannello è "non configurata" quanto una chiave assente, e con `??` avrebbe
    // azzerato il ripiego su `aruba_config.fiscal` invece di cedergli il posto —
    // cioè avrebbe stampato una ricevuta anonima avendo il dato a due righe di
    // distanza. Stessa regola che usa il cedente della fattura elettronica.
    const dati: DatiStruttura = {
        denominazione: primoNonVuoto(f.denominazione, a.ragione_sociale),
        piva: primoNonVuoto(f.piva, a.piva),
        codice_fiscale: primoNonVuoto(f.codice_fiscale, a.cf),
        // Il numero civico è un campo a parte nella configurazione (lo pretende il
        // tracciato FatturaPA, che non lo indovina): sulle ricevute e sulle
        // attestazioni torna a essere una riga sola, con la stessa composizione
        // che finisce in `<Indirizzo>`.
        indirizzo: componiIndirizzo(primoNonVuoto(f.indirizzo, a.indirizzo), f.numero_civico),
        cap: primoNonVuoto(f.cap, a.cap),
        comune: primoNonVuoto(f.comune, a.comune),
        provincia: primoNonVuoto(f.provincia, a.provincia),
    }

    // Denominazione e partita IVA sono il minimo perché un documento sia
    // riconducibile a chi lo emette: se ne manca anche una sola, il documento
    // che ne esce non è utilizzabile. Nel log finiscono solo BOOLEANI e l'uuid
    // della sede — i dati fiscali non ci entrano, né servirebbero a nessuno lì.
    if (dati.denominazione.trim() === '' || dati.piva.trim() === '') {
        logEvento('fiscale', ctx?.livello ?? 'error', {
            operazione: ctx?.operazione ?? 'datiStruttura',
            esito: 'dati-struttura-mancanti',
            scuola_id: ctx?.scuolaId ?? '',
            denominazione_presente: dati.denominazione.trim() !== '',
            piva_presente: dati.piva.trim() !== '',
        })
    }

    return dati
}
