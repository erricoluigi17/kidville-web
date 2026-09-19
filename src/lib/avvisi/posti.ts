/**
 * ─── I POSTI DI UN AVVISO SI CONTANO IN PERSONE, NON IN ADESIONI ─────────────
 *
 * Un pullman ha 50 sedili, non 50 famiglie. Il tetto `posti_totali` è espresso in
 * PERSONE, e ogni adesione ne vale quante ne ha dichiarate
 * (`numero_partecipanti`). Contarle come una ciascuna è il modo di riempire un
 * pullman da 50 con 120 persone e scoprirlo il mattino della gita.
 *
 * ── IL GEMELLO IN SQL, DICHIARATO ───────────────────────────────────────────
 *
 * ⚠️ La riga «vale `numero_partecipanti` se è un numero, **altrimenti 1**» è il
 * gemello del `COALESCE(numero_partecipanti, 1)` che vive nella funzione SQL
 * `avviso_posti_occupati` (cantiere A2). Sono la stessa regola in due linguaggi,
 * con due mestieri diversi: **quella decide chi entra, questa mostra il totale.**
 *
 * Se divergono — se una delle due contasse le righe nulle come zero — la
 * schermata della segreteria direbbe un numero e il tetto ne applicherebbe un
 * altro: «22 su 50» a schermo mentre il database rifiuta la ventitreesima
 * adesione. E **nessun test se ne accorgerebbe**, perché ciascuna delle due metà,
 * da sola, è perfettamente coerente: il difetto esiste solo nel confronto, che è
 * il posto dove nessuno guarda. Chi tocca il `COALESCE` là dentro tocca anche
 * questa funzione.
 *
 * Perché `1` e non `0`: un'adesione senza numero è un'adesione di un avviso in
 * cui il contatore era spento (`chiedi_numero = false`), e quella famiglia porta
 * comunque il suo bambino. Zero sarebbe l'unico valore che rende il totale più
 * piccolo del numero di adesioni, cioè un totale che non descrive niente.
 *
 * ── PERCHÉ ANCHE `famiglie`, E NON SOLO `persone` ───────────────────────────
 *
 * Perché una famiglia con due figli nello stesso avviso dichiara lo stesso
 * accompagnatore DUE volte: una adesione per bambino, due volte «2 persone», e il
 * totale dice 4 dove le teste sono 3. È voluto — il conteggio in persone deve
 * essere largo, perché un pullman pieno a metà è un fastidio e un pullman pieno
 * al 110% è un bambino a terra — ma la segreteria deve poterlo leggere per quello
 * che è, e senza il numero delle famiglie accanto non ha modo di sapere quanto il
 * totale sia gonfio. Due numeri accanto raccontano ciò che uno solo nasconde.
 */

/** Ciò che serve di una riga di adesione per contare i posti, e nient'altro. */
export type RigaAdesione = {
    /** `null`/assente se l'avviso non chiedeva il numero: vale 1 (vedi il gemello SQL). */
    numero_partecipanti?: number | null;
    /** Solo `ammessa` occupa un posto. `in_attesa` è in coda, non dentro. */
    stato_adesione?: string | null;
    /** L'alunno, o la famiglia, a cui la riga appartiene: serve a contare le famiglie DISTINTE. */
    parent_id?: string | null;
};

export type RiepilogoPosti = {
    /** Le PERSONE ammesse — la grandezza che si confronta con `posti_totali`. */
    persone: number;
    /** Le famiglie DISTINTE ammesse: il totale in persone senza il gonfiore dei fratelli. */
    famiglie: number;
    /** Quante righe sono in coda (`in_attesa`). */
    inAttesa: number;
    /** Quante persone valgono quelle righe in coda: che cosa entrerebbe alzando il tetto. */
    personeInAttesa: number;
    /** Il tetto è già superato? Consentito, vedi sotto. */
    sopraCapienza: boolean;
};

/** Una riga vale `numero_partecipanti` se è un numero VERO, altrimenti 1. Gemello del `COALESCE`. */
function personeDellaRiga(riga: RigaAdesione): number {
    const n = riga.numero_partecipanti;
    // `typeof n === 'number'` non basta: `NaN` è un `number`, e sommato una volta
    // sola rende `NaN` l'intero riepilogo — cioè «50 posti su NaN» a schermo. È la
    // stessa famiglia di difetti del `?? 0` che ha congelato per sempre lo stato
    // SDI di una fattura: un valore non valido che entra in un conto e ci resta.
    return typeof n === 'number' && Number.isFinite(n) ? n : 1;
}

/**
 * IL RIEPILOGO DEI POSTI DI UN AVVISO, DA UN ELENCO DI ADESIONI.
 *
 * `postiTotali` a `null` significa **nessun tetto**, che è il caso della gran
 * parte degli avvisi: `sopraCapienza` resta `false` e i conteggi servono solo a
 * mostrare quante adesioni sono arrivate.
 *
 * ── SOPRA CAPIENZA È UNO STATO LEGITTIMO, NON UN ERRORE ─────────────────────
 *
 * ⚠️ `persone > postiTotali` può succedere, e questa funzione lo RIPORTA invece di
 * rifiutarlo: la segreteria può abbassare il tetto sotto l'occupato — il pullman
 * grande non è disponibile, restano 30 posti invece di 50 — e nessuno viene
 * espulso da un'adesione già confermata per un campo modificato in un modulo.
 * Chi entra da quel momento in poi va in lista d'attesa; chi era già dentro resta
 * dentro. Il numero serve alla segreteria per sapere quante telefonate deve fare,
 * e un vincolo che glielo impedisse le lascerebbe solo la strada di cancellare
 * adesioni a mano.
 *
 * ── SOLO `ammessa` OCCUPA ───────────────────────────────────────────────────
 *
 * Il confronto è `=== 'ammessa'`, cioè una LISTA BIANCA, e non `!== 'in_attesa'`.
 * La differenza conta il giorno in cui arriva un terzo stato (un `annullata`, per
 * dire): con la lista bianca quel valore semplicemente non occupa posti; con la
 * lista nera occuperebbe, e il tetto si riempirebbe di righe che nessuno conta
 * più. `zStatoAdesione` (`@/lib/validation/avvisi`) è un `z.enum` per la stessa
 * ragione, dall'altro lato del filo.
 */
export function riepilogoPosti(
    righe: readonly RigaAdesione[],
    postiTotali: number | null | undefined,
): RiepilogoPosti {
    let persone = 0;
    let inAttesa = 0;
    let personeInAttesa = 0;
    const famiglie = new Set<string>();

    for (const riga of righe) {
        const n = personeDellaRiga(riga);
        if (riga.stato_adesione === 'ammessa') {
            persone += n;
            // `parent_id` assente: la riga conta comunque come UNA famiglia, e per
            // saperla distinta da un'altra senza id le si dà una chiave propria.
            // Sommare tutte le righe senza id in una sola voce farebbe sparire
            // famiglie vere dal conteggio — un numero troppo BASSO, che è il verso
            // pericoloso: farebbe credere che il gonfiore dei fratelli sia maggiore
            // di quello che è.
            famiglie.add(riga.parent_id ?? `#senza-id-${famiglie.size}`);
        } else if (riga.stato_adesione === 'in_attesa') {
            inAttesa += 1;
            personeInAttesa += n;
        }
    }

    return {
        persone,
        famiglie: famiglie.size,
        inAttesa,
        personeInAttesa,
        sopraCapienza: postiTotali !== null && postiTotali !== undefined && persone > postiTotali,
    };
}
