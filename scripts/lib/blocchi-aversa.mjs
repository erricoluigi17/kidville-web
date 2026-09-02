/**
 * I sei blocchi dell'elenco di Aversa, e la sezione a cui ognuno corrisponde.
 *
 * ─── PERCHÉ STA QUI E NON DENTRO UNO DEI DUE SCRIPT ─────────────────────────
 * Due programmi hanno bisogno della stessa risposta: quello che RICOSTRUISCE il
 * foglio e quello che RIALLINEA i 73 alunni già creati. Se la mappa vivesse in
 * entrambi, al primo ritocco divergerebbero — e divergerebbero in silenzio,
 * mettendo dei bambini in una classe e i loro compagni in un'altra. È la lezione
 * del ciclo 2 di /ship-cycle: una regola valida per due strade vive in un posto
 * solo.
 *
 * ─── COSA C'ERA NEL FOGLIO ──────────────────────────────────────────────────
 * `elenco_rette_aversa.xlsx` (26/08) è un foglio solo, chiamato `RETTE`, con i
 * nomi delle sezioni scritti come righe in mezzo ai nomi dei bambini, ognuna
 * preceduta da una riga vuota. Il lettore lo legge in Forma A — dove il nome del
 * foglio È la classe — e ha scritto `classe = 'RETTE'` su tutte e 117 le righe.
 *
 * ─── COME SI RITROVANO I CONFINI ────────────────────────────────────────────
 * Le righe di intestazione sono sopravvissute in `iscrizioni_elenco_righe`: si
 * riconoscono perché nella colonna della retta c'è la parola «RETTA», che è
 * l'intestazione di una colonna e non può stare sotto i propri dati. Da lì
 * l'ordine dei blocchi. Il nome del PRIMO è l'unico che la tabella non ha — la
 * riga 1 del foglio è stata consumata come intestazione — ed è stato LETTO dal
 * file originale nel bucket il 2026-08-31: dice «MERAVIGLIE».
 *
 * ─── LA MAPPA È MISURATA, NON DEDOTTA DALL'ORDINE ───────────────────────────
 * Che ogni blocco sia la fascia d'età che dice di essere è provato due volte:
 *   1. dalle date di nascita dei bambini di ciascun blocco (2026/27);
 *   2. dall'export del vecchio registro (2025/26), dove la stessa sede aveva SEI
 *      sezioni e ognuna teneva l'anno di nascita PRECEDENTE. Il nome resta
 *      attaccato alla fascia d'età, non alla coorte: i bambini salgono, il nome
 *      no. Le cinque sezioni già nominate nel foglio lo dimostrano da sole, e per
 *      esclusione fissano anche la sesta.
 *
 * ⚠️ Nessuno deduca MAI la classe di un singolo bambino dalla sua data di
 * nascita. Le date hanno provato la mappa dei BLOCCHI; la classe del bambino
 * viene dal foglio, sempre. `abbinamento.ts` si apre con questa regola.
 */

/**
 * Foglio → sezione in anagrafica. A sinistra la stringa letterale scritta dalla
 * segreteria, a destra la convenzione scelta dal titolare il 2026-08-31: solo la
 * fascia d'età, come a Giugliano.
 *
 * ⚠️ Questa tabella e il commento della migrazione
 * `20260831192032_aversa_due_sezioni_di_due_anni.sql` sono gli unici due posti
 * in cui resta scritta la corrispondenza coi nomi che le famiglie di Aversa
 * usano da anni. Non cancellarla.
 */
export const SEZIONE_PER_BLOCCO = new Map([
    ['MERAVIGLIE', 'NIDO'],
    ['SEZIONE SOGNI', '2 ANNI A'],
    ['SEZIONE ABBRACCI', '2 ANNI B'],
    ['SEZ RACCONTI', '3 ANNI'],
    ['SEZ SCINTILLE', '4 ANNI'],
    ['PICCOLI SAPIENTI', '5 ANNI'],
])

/** Il nome del primo blocco: riga 1 del foglio, che la tabella non ha. */
export const PRIMO_BLOCCO = 'MERAVIGLIE'

/** Le sei sezioni, nell'ordine in cui compaiono nel foglio. */
export const SEZIONI = [...SEZIONE_PER_BLOCCO.values()]

/** Una riga di intestazione si riconosce dalla parola «RETTA» nella sua retta. */
const SOLO_RETTA = /^retta$/i

/**
 * Divide le righe dell'elenco nei sei blocchi.
 *
 * Funziona sia sull'elenco vecchio (tutte le righe in classe `RETTE`, con le
 * intestazioni ancora dentro) sia su quello nuovo (un foglio per sezione, nessuna
 * intestazione): nel secondo caso non trova nessuna riga «RETTA» e allora si fida
 * della colonna `classe`, che a quel punto è già la risposta.
 *
 * @param {Array<{nome:string, riga_excel:number, classe?:string, retta?:unknown, retta_testo?:unknown}>} righe
 *        già ordinate per `riga_excel`
 * @returns {{perSezione: Map<string, Array>, intestazioni: Array, via: 'blocchi'|'colonna-classe'}}
 */
export function dividiInBlocchi(righe) {
    const intestazioni = righe.filter((r) => SOLO_RETTA.test(String(r.retta_testo ?? '').trim()))

    // L'elenco nuovo: la classe è già scritta e combacia con le sezioni. Non si
    // ricostruisce niente — ricostruire quando non serve è il modo di introdurre
    // una differenza fra i due script.
    if (intestazioni.length === 0) {
        const perSezione = new Map()
        for (const r of righe) {
            const sez = String(r.classe ?? '').trim()
            if (!SEZIONI.includes(sez)) {
                throw new Error(`la riga ${r.riga_excel} ha classe «${sez}», che non è una delle sei sezioni`)
            }
            if (!perSezione.has(sez)) perSezione.set(sez, [])
            perSezione.get(sez).push(r)
        }
        return { perSezione, intestazioni, via: 'colonna-classe' }
    }

    const perSezione = new Map()
    let blocco = PRIMO_BLOCCO
    for (const r of righe) {
        if (SOLO_RETTA.test(String(r.retta_testo ?? '').trim())) {
            blocco = String(r.nome ?? '').trim()
            continue
        }
        const sez = SEZIONE_PER_BLOCCO.get(blocco)
        if (!sez) throw new Error(`il blocco «${blocco}» non è nella mappa delle sezioni`)
        if (!perSezione.has(sez)) perSezione.set(sez, [])
        perSezione.get(sez).push(r)
    }

    const mancanti = SEZIONI.filter((s) => !perSezione.has(s))
    if (mancanti.length) throw new Error(`sezioni previste e non trovate: ${mancanti.join(', ')}`)

    return { perSezione, intestazioni, via: 'blocchi' }
}
