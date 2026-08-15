import { formatEuro } from '@/lib/format/valuta'
import { ibanLeggibile } from '@/lib/pagamenti/iban'
import { h, paragrafiDaTesto, unisci, type Html } from '../html'
import { documento, intestazioneTesto, piedeTesto } from '../layout'
import {
    avviso, h2, nota, p, riepilogoVoci, riepilogoVociTesto, riquadroApp,
    riquadroAppTesto, spazio, tabellaDati, tabMascotte, type RigaDati, type VocePagamento,
} from '../componenti'
import type { ContestoSede } from '../contesto'
import type { Messaggio } from './tipi'

// =============================================================================
// 03 · 04 · 05 — Promemoria, sollecito, secondo sollecito.
//
// ─── LA DIVISIONE DELLE COMPETENZE, CHE QUI È TUTTO ─────────────────────────
// Gli oggetti e i testi dei tre livelli sono CONFIGURABILI PER SEDE, in
// `admin_settings.solleciti_config`, e la segreteria li può riscrivere dal
// pannello. Questo modulo NON li sostituisce: li ospita.
//
//     LA CONFIGURAZIONE DÀ LA PROSA — le frasi che la scuola ha scelto, già
//     interpolate da `renderTemplate`, che entrano nella scheda bianca.
//
//     IL MODULO DÀ LA STRUTTURA — riga dell'alunno, riepilogo delle voci con il
//     totale, riquadro d'avviso col tono del livello, dati per il bonifico,
//     riquadro app, piè di pagina. Vengono dai dati strutturati, non dal testo.
//
// Perché questa divisione e non una delle due scorciatoie:
//  · «HTML-izzare il testo configurato» butterebbe via tutto ciò che il design
//    fa, e metterebbe una stringa scrivibile dall'operatore dentro l'HTML;
//  · «ignorare la configurazione» romperebbe IN SILENZIO una funzione che la
//    segreteria ha già: cambierebbe il testo nel pannello e nelle email non
//    cambierebbe niente.
//
// ⚠️ E c'è una ragione misurata perché non è teoria. Il 2026-08-15: Kidville
// Giugliano è l'UNICA sede con i solleciti accesi, e ha tutti e tre i livelli
// salvati per intero in tabella, col testo di oggi congelato parola per parola.
// `livelliEffettivi()` sovrappone il salvato al default, quindi riscrivere i
// testi di fabbrica nel codice non cambierebbe UNA SOLA PAROLA di ciò che
// Giugliano manda. Con questa divisione, invece, Giugliano riceve subito
// l'impaginazione nuova con le proprie parole.
//
// ─── LA GRAVITÀ SALE NEL COLORE, NON NEL VOLUME ─────────────────────────────
// I tre livelli differiscono per giorni di ritardo (3 / 10 / 20) e per il tono
// del riquadro (`info` / `avviso` / `errore`). Il terzo è il più CORTO dei tre.
// Chi legge è una famiglia che porta lì il proprio figlio ogni mattina e che
// rivedrà quelle persone in faccia domani: un tono da recupero crediti è, qui,
// un errore di progettazione.
//
// Nessuno dei tre ha un bottone di pagamento: non esiste un pagamento online nel
// prodotto, e un bottone che non paga sarebbe una promessa non mantenuta.
// =============================================================================

export type LivelloSollecito = 1 | 2 | 3

const TONO: Record<LivelloSollecito, 'info' | 'avviso' | 'errore'> = {
    1: 'info',
    2: 'avviso',
    3: 'errore',
}

const TITOLO: Record<LivelloSollecito, string> = {
    1: 'Promemoria di pagamento',
    2: 'Sollecito di pagamento',
    3: 'Secondo sollecito',
}

export interface DatiSollecito {
    livello: LivelloSollecito
    /** L'oggetto già reso dal template della sede: questo modulo non lo ricompone. */
    oggetto: string
    /** La prosa già resa dal template della sede, a paragrafi separati da righe vuote. */
    prosa: string
    /** Nome dell'alunno, o il ripiego che il motore usa già quando non è noto. */
    alunno: string
    voci: readonly VocePagamento[]
    /** La causale del bonifico, composta dal motore: si copia nell'home banking. */
    causale: string
    /** L'intestatario del conto. Assente ⇒ la riga si omette. */
    intestatario?: string | null
    /** L'IBAN dalle impostazioni fiscali. Assente o invalido ⇒ la riga si omette. */
    iban?: string | null
}

export function messaggioSollecito(d: DatiSollecito, sede: ContestoSede): Messaggio {
    const totale = d.voci.reduce((a, v) => a + v.importo, 0)
    const motivo = `Ricevi questo messaggio perché risulta un pagamento non ancora saldato presso ${sede.nome}.`
    const iban = ibanLeggibile(d.iban)

    const righeBonifico: RigaDati[] = [
        { etichetta: 'Importo', valore: formatEuro(totale), mono: true },
        ...(iban ? [{ etichetta: 'IBAN', valore: iban, mono: true }] : []),
        { etichetta: 'Causale', valore: d.causale, mono: true },
        ...(d.intestatario ? [{ etichetta: 'Intestato a', valore: d.intestatario }] : []),
    ]

    // Il riquadro d'avviso dipende dal livello, e al terzo dice l'unica cosa
    // concreta che resta da dire: cosa succede se non si sistema.
    const avvisoDelLivello: Html = d.livello === 1
        ? avviso('info', h`Se hai già pagato, ignora questo messaggio: l'accredito può richiedere qualche giorno per comparire.`)
        : d.livello === 2
            ? avviso('avviso', h`Se hai già pagato negli ultimi giorni, considera questo messaggio come non ricevuto.`)
            : avviso('errore', h`Oltre i trenta giorni la segreteria è tenuta a sospendere i servizi accessori: preferiamo evitarlo.`)

    const piuVoci = d.voci.length > 1

    const corpo = unisci([
        // La prosa della sede, non riscritta da noi.
        paragrafiDaTesto(d.prosa, (contenuto) => p(contenuto)),
        tabellaDati([{ etichetta: 'Alunno', valore: d.alunno }]),
        spazio(12),
        riepilogoVoci(d.voci),
        piuVoci
            ? unisci([spazio(14), nota(h`Un solo bonifico dell'importo totale copre tutte le voci: non serve un versamento per ciascuna.`)])
            : ('' as Html),
        spazio(16),
        avvisoDelLivello,
        h2('Dati per il bonifico'),
        tabellaDati(righeBonifico),
        spazio(18),
        // Il riquadro app non compare al terzo sollecito: a quel punto il
        // messaggio è uno solo, e un invito a scaricare un'app in mezzo lo
        // annacqua.
        d.livello < 3
            ? unisci([
                riquadroApp(sede, {
                    titolo: 'La situazione pagamenti sul telefono',
                    introduzione: h`Importi, scadenze e ricevute stanno nell'area genitori, anche nell'app: gratuita su App Store e Google Play.`,
                }),
                spazio(18),
            ])
            : ('' as Html),
    ])

    const sottotitolo = piuVoci
        ? `${d.voci.length} pagamenti arretrati · ${formatEuro(totale)}`
        : undefined

    return {
        oggetto: d.oggetto,
        html: documento(sede, {
            oggetto: d.oggetto,
            // Il preheader non promette un IBAN che non c'è: senza, dice quello
            // che il messaggio contiene davvero. Una riga d'anteprima che
            // annuncia un dato assente è una bugia piccola, letta da tutti e
            // scoperta da chi apre.
            preheader: piuVoci
                ? `${formatEuro(totale)} in tutto su ${d.voci.length} pagamenti arretrati. ${iban ? 'IBAN e causale sono' : 'La causale è'} nel messaggio.`
                : `${formatEuro(totale)} da saldare. ${iban ? 'IBAN e causale sono' : 'La causale è'} nel messaggio.`,
            tab: tabMascotte({ occhiello: 'Pagamenti', titolo: TITOLO[d.livello], sottotitolo }),
            corpo,
            motivo,
        }),
        testo: [
            intestazioneTesto(TITOLO[d.livello], sede),
            '',
            d.prosa.trim(),
            '',
            `  Alunno: ${d.alunno}`,
            '',
            riepilogoVociTesto(d.voci),
            '',
            piuVoci ? 'Un solo bonifico dell\'importo totale copre tutte le voci: non serve un versamento per ciascuna.\n' : '',
            testoAvviso(d.livello),
            '',
            'DATI PER IL BONIFICO',
            `  Importo:      ${formatEuro(totale)}`,
            ...(iban ? [`  IBAN:         ${iban}`] : []),
            `  Causale:      ${d.causale}`,
            ...(d.intestatario ? [`  Intestato a:  ${d.intestatario}`] : []),
            '',
            d.livello < 3
                ? `${riquadroAppTesto(sede, 'Importi, scadenze e ricevute stanno nell\'area genitori, anche nell\'app: gratuita su App Store e Google Play.')}\n`
                : '',
            piedeTesto(sede, motivo),
        ].filter((r) => r !== '').join('\n'),
    }
}

function testoAvviso(livello: LivelloSollecito): string {
    if (livello === 1) return 'Se hai già pagato, ignora questo messaggio: l\'accredito può richiedere qualche giorno per comparire.'
    if (livello === 2) return 'Se hai già pagato negli ultimi giorni, considera questo messaggio come non ricevuto.'
    return 'Oltre i trenta giorni la segreteria è tenuta a sospendere i servizi accessori: preferiamo evitarlo.'
}

/** Il tono del livello, esposto per i test e per l'anteprima. */
export function tonoDelLivello(livello: LivelloSollecito): 'info' | 'avviso' | 'errore' {
    return TONO[livello]
}
