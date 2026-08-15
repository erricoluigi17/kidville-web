// =============================================================================
// Il tipo che rende l'escaping una proprietà del COMPILATORE, non della memoria.
//
// ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
// La fonte di design di queste email (`email-sources.js` del pacchetto di
// consegna) concatena stringhe grezze: `'<p>' + o.nome + '</p>'`. In una pagina
// d'anteprima con dati inventati va benissimo. Qui dentro no: i valori che
// finiscono in queste dodici email sono nomi di bambini e di genitori, titoli ed
// estratti di articoli scritti a mano dalla redazione, etichette di prestampati
// configurate dalla segreteria, descrizioni di pagamento. Tutti dati che un
// essere umano ha digitato, e in cui `<` è un carattere come un altro.
//
// La difesa ovvia — «ricordati di chiamare escapeHtml» — è la stessa che in
// questo repo ha già fallito su un'altra regola: per mesi il corpo degli errori
// del provider email veniva buttato via, e nessun test era rosso (vedi la
// testata di `send.ts`). Una regola che vive solo nell'attenzione di chi scrive
// non è una regola: è una speranza.
//
// ─── COME FUNZIONA ──────────────────────────────────────────────────────────
// `Html` è una stringa marchiata. Il marchio non esiste a runtime — è un
// `unique symbol` in un campo mai valorizzato — ma esiste per `tsc`:
//
//     Html  →  string   assegnabile     (così `sendEmailDetailed({ html })` funziona)
//     string → Html     NON assegnabile (così un nome non scappato non entra)
//
// Il pezzo che porta il valore è il tag template `h`: interpola SOLO `Html` e
// `number`. Scrivere `` h`<p>${nome}</p>` `` con `nome: string` non compila.
// Bisogna scrivere `` h`<p>${esc(nome)}</p>` ``, e a quel punto è scappato.
//
// ─── I DUE POSTI IN CUI `Html` IN INGRESSO È LEGITTIMO ──────────────────────
// Un parametro di tipo `Html` significa «HTML già formato, responsabilità di chi
// chiama». Ce ne sono esattamente due categorie in tutto il modulo: il contenuto
// di `notice()` e il `body` di `doc()`. Ogni altro `Html` in una firma di questo
// modulo è un difetto, non una scelta.
// =============================================================================

declare const marchioHtml: unique symbol

/** Una stringa di HTML già sicura: o costante nel sorgente, o passata da `esc()`. */
export type Html = string & { readonly [marchioHtml]: 'html' }

/**
 * Testo → HTML sicuro. Le cinque entità che contano, nell'ordine che conta:
 * `&` per prima, altrimenti riscappa le entità appena prodotte dalle altre.
 *
 * `null`/`undefined` → stringa vuota, non «null»: un dato che manca si omette,
 * non si stampa (è la stessa regola di `parseAnagraficaSede`).
 */
export function esc(testo: string | number | null | undefined): Html {
    if (testo === null || testo === undefined) return '' as Html
    return String(testo)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;') as Html
}

/**
 * Fuga d'emergenza: dichiara che una stringa è già HTML sicuro.
 *
 * Serve dove l'HTML nasce fuori dal tag template — per esempio da un `.map()`
 * che produce righe, o da una costante lunga. NON va usata su un dato che viene
 * da fuori: per quello c'è `esc`. Il nome è brutto apposta, così un `grezzo(`
 * in una revisione si nota.
 */
export function grezzo(html: string): Html {
    return html as Html
}

/** Unisce pezzi di HTML già sicuri. Il separatore è a sua volta HTML. */
export function unisci(pezzi: readonly Html[], separatore: Html = '' as Html): Html {
    return pezzi.join(separatore) as Html
}

/**
 * Il tag template del modulo. Le parti fisse vengono dal sorgente (sicure per
 * costruzione); le interpolazioni possono essere solo `Html` o `number`.
 *
 * È qui che il tipo morde: un `string` non compila, e l'unico modo di farlo
 * compilare è passarlo da `esc()`.
 */
export function h(parti: TemplateStringsArray, ...valori: readonly (Html | number)[]): Html {
    let out = parti[0]
    for (let i = 0; i < valori.length; i++) out += String(valori[i]) + parti[i + 1]
    return out as Html
}

/**
 * Testo semplice multiriga → paragrafi HTML.
 *
 * Serve ai solleciti, dove la PROSA arriva da `admin_settings.solleciti_config`
 * — cioè da un campo che la segreteria compila — mentre la STRUTTURA (tabelle,
 * riquadri, piè di pagina) la mette questo modulo. Righe vuote separano i
 * paragrafi, un solo a capo diventa `<br>`, e tutto passa da `esc`.
 *
 * `rendiParagrafo` riceve il contenuto di un paragrafo già scappato e lo
 * avvolge: così il chiamante decide lo stile senza che questa funzione conosca i
 * token.
 */
export function paragrafiDaTesto(testo: string, rendiParagrafo: (contenuto: Html) => Html): Html {
    const blocchi = testo
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter((b) => b.length > 0)
    return unisci(
        blocchi.map((b) => rendiParagrafo(unisci(b.split('\n').map((r) => esc(r)), grezzo('<br>')))),
    )
}
