import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { getModuleConfig } from '@/lib/settings/module-config';
import { requireUser, requireDocente } from '@/lib/auth/require-staff';
// Dal MODULO PURO, non da `require-staff`: 298 file sostituiscono quest'ultimo per
// intero con una factory `vi.mock`, e importare di lì un predicato li farebbe
// esplodere con `No "agisceComeGenitore" export is defined on the mock`.
import { agisceComeGenitore } from '@/lib/auth/predicati-ruolo';
import { resolveScuoleAttive, resolveScuolaScrittura } from '@/lib/auth/scope';
import { getFigliDiGenitore } from '@/lib/anagrafiche/legami';
import { verificaTargetAvvisoDocente } from '@/lib/avvisi/target-gate';
import { logScrittura } from '@/lib/audit/scrittura';
import { notificaEvento } from '@/lib/notifiche/triggers';
import { genitoriDiClassi, genitoriDiScuola } from '@/lib/notifiche/destinatari';
import { parseBody, parseQuery } from '@/lib/validation/http';
import { zUuid } from '@/lib/validation/common';
import { degradoSedeLecito } from '@/lib/forms/degrado-sede';
import { firmaAllegatiAvvisi, normalizzaAllegatoAvviso } from '@/lib/allegati/storage';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { RUOLI_PUBBLICAZIONE_DEFAULT } from '@/lib/scuole/admin-settings-default';
import {
    zTitoloAvviso, zContenutoAvviso, zTipoAvviso, zTargetScopeAvviso,
    zScadenzaAvvisoDataOra, zTargetClassesAvviso, formaAdesioneAvviso,
    ETICHETTA_NUMERO_PREDEFINITA,
} from '@/lib/validation/avvisi';
import { intervallo, MIN_PREDEFINITO, MAX_PREDEFINITO } from '@/lib/avvisi/partecipanti';
import { risolviScadenze, avvisoScaduto, adesioniChiuse } from '@/lib/avvisi/scadenze';
import { classiMancantiNellaSede, classiTargetValide } from '@/lib/avvisi/classi-sede';
import {
    statistichePerAvviso, autoriDegliAvvisi, rispostePerAvvisoDelGenitore,
    AUTORE_IGNOTO, STATS_ZERO, type StatsAvviso, type RispostaDelGenitore,
} from '@/lib/avvisi/statistiche';

// Il ramo STAFF filtra ancora per scope/classe (dashboard cockpit). Il ramo
// GENITORE è SERVER-DERIVED (G3): i parametri client sono ignorati, figli e
// classi si ricavano dalla sessione — quindi qui non c'è più parentId/studentId.
const getQuerySchema = z.object({
    scope: z.string().optional(),
    classe: z.string().optional(),
    /**
     * Il filtro del cockpit: `si` mostra solo gli avvisi già scaduti, `no` solo
     * quelli vivi. ASSENTE = tutto, che è il comportamento di sempre e la
     * decisione del committente: **allo staff gli avvisi scaduti non si
     * nascondono**, perché il cockpit è anche l'archivio di ciò che è stato
     * pubblicato. Solo il feed del genitore li toglie.
     *
     * Si applica in memoria sul booleano `scaduto` calcolato qui sotto, e non come
     * filtro SQL, di proposito: `scaduto` deve rispondere allo STESSO istante e
     * alla STESSA regola (`avvisoScaduto`) del campo che la card riceve — un
     * filtro scritto due volte, una in SQL e una in TypeScript, è la forma di
     * divergenza che questo cantiere esiste per chiudere.
     */
    scaduti: z.enum(['si', 'no']).optional(),
});

const postBodySchema = z.object({
    // NB: `author_id` NON è più nel body (M7): l'autore è sempre la sessione.
    // I massimi vengono dal DDL e stanno in `@/lib/validation/avvisi`: senza,
    // un titolo lungo usciva come 500 col tipo della colonna dentro (S34).
    titolo: zTitoloAvviso,
    contenuto: zContenutoAvviso,
    tipo: zTipoAvviso.nullish(),
    target_scope: zTargetScopeAvviso.nullish(),
    target_classes: zTargetClassesAvviso.optional(),
    /**
     * OBBLIGATORIA, e non è più la `scadenza` a grana giorno di prima: è l'istante
     * oltre il quale l'avviso esce dalla bacheca dei genitori. Arriva come cifre
     * LOCALI italiane (`YYYY-MM-DDTHH:MM`, ciò che produce
     * `<input type="datetime-local">`): un ISO dal client porterebbe con sé
     * l'orologio e il fuso del tablet, che è il difetto per cui
     * `zDataOraLocale`/`istanteDaLocale` esistono.
     */
    scadenza_avviso: zScadenzaAvvisoDataOra,
    // Il blocco condiviso con il PUT — UNA definizione, non due. Il perché sta
    // scritto per esteso accanto a `formaAdesioneAvviso`: in questo repo una
    // regola scritta due volte è già rimasta indietro su una delle due strade due
    // volte su due (`classiMancantiNellaSede`, il tetto del titolo).
    ...formaAdesioneAvviso,
    attachment_url: z.string().nullish(),
    // Modulo firmabile FEA collegato (gita): opzionale (item 19).
    form_model_id: zUuid.nullish(),
    // Sede su cui si PUBBLICA (multi-sede, 2026-07-31). Il cockpit la manda
    // esplicitamente; se manca la deduce `resolveScuolaScrittura` dal selettore
    // di sede, e se resta ambigua risponde 400. Mai la sede primaria dell'autore.
    scuola_id: zUuid.nullish(),
});

type SupabaseAdmin = Awaited<ReturnType<typeof createAdminClient>>;

/**
 * Le colonne STORICHE. Restano com'erano perché sono anche il ripiego del degrado
 * sul DB E2E della CI, che non è migrato: se `AVVISO_COLS` portasse le colonne
 * nuove, il ripiego chiederebbe le stesse colonne che hanno appena prodotto il
 * `42703` e il degrado non degraderebbe niente.
 */
const AVVISO_COLS =
    'id, author_id, titolo, contenuto, tipo, target_scope, target_classes, scadenza, attachment_url, created_at';

/** Le storiche PIÙ le sette del cantiere A2 (due scadenze, contatore, tetto). */
const AVVISO_COLS_SCADENZE =
    `${AVVISO_COLS}, scadenza_avviso, scadenza_adesione, chiedi_numero, etichetta_numero, numero_min, numero_max, posti_totali`;

type AvvisoRow = {
    id: string; author_id: string; titolo: string; contenuto: string;
    tipo: string | null; target_scope: string | null; target_classes: string[] | null;
    scadenza: string | null; attachment_url: string | null; created_at: string;
    form_model_id?: string | null;
    /**
     * Il plesso dell'avviso. FACOLTATIVA nel tipo perché la chiede solo il ramo
     * GENITORE — che la usa per decidere quali figli un globale riferisce — e non
     * il cockpit dello staff, già ristretto alle sedi attive da `plessiScope`.
     * Il ramo genitore la pota poi dal payload: vedi `rigaPubblica`.
     */
    scuola_id?: string | null;
    // Le sette nuove: facoltative nel tipo perché sul DB E2E non migrato il
    // degrado le sfila davvero, e il codice che segue deve reggerlo.
    scadenza_avviso?: string | null;
    scadenza_adesione?: string | null;
    chiedi_numero?: boolean | null;
    etichetta_numero?: string | null;
    numero_min?: number | null;
    numero_max?: number | null;
    posti_totali?: number | null;
};

/**
 * LE DUE SCADENZE DI UNA RIGA, COME LE LEGGE CHI DEVE DECIDERE.
 *
 * `scadenza_avviso` quando c'è; altrimenti la vecchia `scadenza` (una `date`
 * pura), che `avvisoScaduto` sa trattare come FINE del giorno civile italiano —
 * l'unica lettura che qualcuno abbia mai dato a quel campo. Il ripiego serve alla
 * finestra fra merge e deploy e al DB E2E non migrato: senza, un avviso con la sola
 * colonna storica risulterebbe «senza scadenza», cioè eterno.
 */
function scadenzaEffettiva(a: AvvisoRow): string | null {
    return a.scadenza_avviso ?? a.scadenza ?? null;
}

type Figlio = { id: string; nome: string | null; classe_sezione: string | null; scuola_id: string | null };
type RispostaFiglio = RispostaDelGenitore;

// PostgREST torna 42703 (SELECT) / PGRST204 (INSERT) quando `form_model_id` manca
// nel DB E2E CI non migrato: si riprova senza la colonna.
function colonnaMancante(err: { code?: string } | null | undefined): boolean {
    return !!err && ['PGRST204', '42703'].includes(err.code ?? '');
}

/**
 * Quante colonne il ciclo di degrado dell'INSERT può sfilare prima di arrendersi.
 *
 * 🔺 ERA 4, ED È SALITA A 12 IL 2026-09-19 — si scrive accanto al numero, perché
 * una soglia che si muove senza una riga accanto è una soglia che fra sei mesi
 * nessuno sa se era un miglioramento o una resa. PostgREST nomina UNA colonna per
 * volta, e il cantiere A2 ne ha aggiunte SETTE a `avvisi`; con `form_model_id` (che
 * già c'era) fanno otto giri prima che l'insert passi su un DB non migrato. Con il
 * tetto a 4 il ciclo si sarebbe fermato a metà e l'E2E della CI avrebbe visto un
 * 500 che sembra un bug del codice e non lo è.
 *
 * Non è un tetto «grande abbastanza per stare tranquilli»: è otto più il margine di
 * una colonna nuova che arrivi prima del prossimo che legge questa riga. Resta un
 * tetto perché un ciclo che sfila colonne senza fine, il giorno in cui PostgREST
 * rispondesse `42703` per un'altra ragione, girerebbe finché la richiesta non
 * scade.
 */
const MAX_COLONNE_SFILATE = 12;

/**
 * Conteggi risposte + info autore per UN ELENCO di avvisi, in blocco (T11-F2).
 *
 * Qui prima c'era `autoreEStats(supabase, avviso)`, chiamata dentro un `.map()`:
 * tre `count` su `avvisi_risposte` e una `maybeSingle()` su `utenti` per OGNI
 * avviso. Il `Promise.all` che l'avvolgeva le mandava in parallelo — e questo è
 * esattamente ciò che rendeva il difetto invisibile: con dieci avvisi in tabella
 * il cronometro non se ne accorge, con duecento sono ottocento round-trip verso
 * Postgres per aprire una bacheca.
 *
 * Il numero di query ora è indipendente da quanti avvisi ci sono. Il conteggio
 * resta ESATTO: vedi `@/lib/avvisi/statistiche`, dove la lettura pagina finché il
 * `count` esatto del server non è coperto — un'aggregazione fatta su righe
 * troncate mostrerebbe «hanno letto in 3» invece di «in 47», che è peggio di un
 * errore perché sembra un dato.
 */
async function autoriEStatistiche(supabase: SupabaseAdmin, avvisi: readonly AvvisoRow[]) {
    const [stats, autori] = await Promise.all([
        statistichePerAvviso(supabase, avvisi.map((a) => a.id), 'avvisi:GET'),
        autoriDegliAvvisi(supabase, avvisi.map((a) => a.author_id), 'avvisi:GET'),
    ]);
    return (avviso: AvvisoRow) => ({
        author: autori.get(avviso.author_id) ?? AUTORE_IGNOTO,
        stats: stats.get(avviso.id) ?? { ...STATS_ZERO },
    });
}

// Aggrega le risposte per-figlio di UN avviso in un singolo `my_response` (il
// contratto di AvvisoCard). Un figlio solo → è esattamente la sua risposta.
// Più figli (avviso globale) → "letto" solo se TUTTI hanno letto, "risposto"
// solo se tutti hanno dato la STESSA risposta (altrimenti i bottoni riappaiono).
//
// ── LO STATO E IL NUMERO SEGUONO LA STESSA REGOLA, E NON È UN DETTAGLIO ──────
//
// `stato_adesione` e `numero_partecipanti` si valorizzano SOLO quando tutti i
// figli riferiti concordano, `null` altrimenti — esattamente come `risposta`. Un
// genitore con Marco ammesso e Giulia in coda non HA uno stato: ce l'hanno i suoi
// figli, e sceglierne uno dei due (il primo? il peggiore?) direbbe alla famiglia
// una cosa vera per metà.
//
// 🔴 MA `null` NON BASTA, E IL COMMENTO CHE STAVA QUI DICEVA IL FALSO. «Con `null`
// la card ricade sul caso non concordano» non era vero: quel caso, nella card, non
// esiste. `risposta` CONCORDA (entrambi i figli hanno detto «sì»), quindi la card
// entra nel ramo `myAnswer === 'si'`, e lì `stato_adesione === null` vale AMMESSO —
// deve valere ammesso, perché le 869 righe storiche hanno lo stato nullo e quelle
// famiglie sono davvero dentro. Risultato misurato: Marco dentro, Giulia in coda, e
// la card diceva «Hai aderito per 3 persone ✓» senza nominare la coda.
//
// Perciò l'aggregato resta `null` — è la sola risposta onesta a «qual è lo stato di
// QUESTA famiglia» — e la verità per figlio esce accanto, dentro `figli`: lo stato
// della PROPRIA riga, come `my_response`, mai la capienza altrui.
//
// ⚠️ E questi due campi NON sono una statistica di capienza: dicono dove sta
// QUESTA famiglia, non quanto spazio resta agli altri. Il riquadro di
// `statsPerGenitore`, poche righe più giù, spiega perché la differenza è tutto.
function aggregaRisposta(
    studentIds: string[],
    perFiglio: Map<string, RispostaFiglio>,
): RispostaFiglio | null {
    if (studentIds.length === 0) return null;
    const righe = studentIds.map((id) => perFiglio.get(id) ?? null);

    const tuttiLetti = righe.every((r) => !!r?.letto_il);
    const letti = righe.map((r) => r?.letto_il).filter((x): x is string => !!x).sort();
    const letto_il = tuttiLetti ? letti[letti.length - 1] ?? null : null;

    const risposte = righe.map((r) => r?.risposta ?? null);
    const tuttiRisposto = risposte.every((x) => x != null);
    const uguali = tuttiRisposto && new Set(risposte).size === 1;
    const rispostiIl = righe.map((r) => r?.risposto_il).filter((x): x is string => !!x).sort();

    // `new Set(...).size === 1` anche qui, e su TUTTE le righe (`null` compreso):
    // un figlio senza riga vale `null` e fa già divergere l'insieme, che è giusto —
    // «uno dentro e uno che non ha risposto» non è uno stato di famiglia.
    const stati = righe.map((r) => r?.stato_adesione ?? null);
    const numeri = righe.map((r) => r?.numero_partecipanti ?? null);

    return {
        letto_il,
        risposta: uguali ? risposte[0] : null,
        risposto_il: uguali ? (rispostiIl[rispostiIl.length - 1] ?? null) : null,
        stato_adesione: new Set(stati).size === 1 ? stati[0] : null,
        numero_partecipanti: new Set(numeri).size === 1 ? numeri[0] : null,
    };
}

/**
 * ─── I DUE BOOLEANI CHE DECIDE IL SERVER, E NON PIÙ IL TABLET ────────────────
 *
 * Fino al 2026-09-19 `AvvisoCard.tsx:91` faceva
 * `new Date(avviso.scadenza) < new Date()`: `new Date('2026-09-19')` è mezzanotte
 * **UTC**, cioè le 02:00 italiane d'estate, quindi dalle 02:00 in poi un avviso che
 * scadeva quel giorno risultava già morto — la card si mostrava scaduta per
 * ventidue ore su ventiquattro dell'ULTIMO giorno utile. E il confronto lo faceva
 * l'orologio del dispositivo: un tablet con la data sbagliata mostrava bottoni che
 * il server avrebbe rifiutato.
 *
 * Adesso i due booleani arrivano calcolati da qui, con l'UNICO istante della
 * richiesta e con le stesse funzioni (`@/lib/avvisi/scadenze`) che la RPC
 * dell'adesione usa per decidere chi entra. Il client non confronta più niente.
 */
function statoTemporale(a: AvvisoRow, adessoISO: string): { scaduto: boolean; adesioni_chiuse: boolean } {
    const scadenza = scadenzaEffettiva(a);
    return {
        scaduto: avvisoScaduto(scadenza, adessoISO),
        adesioni_chiuse: adesioniChiuse(
            { scadenza_adesione: a.scadenza_adesione ?? null, scadenza_avviso: scadenza },
            adessoISO,
        ),
    };
}

/**
 * IL TETTO È GIÀ SUPERATO?
 *
 * ⚠️ Gemello dichiarato di `riepilogoPosti(...).sopraCapienza`
 * (`@/lib/avvisi/posti`): stessa regola — `persone > postiTotali`, contate in
 * PERSONE e non in adesioni — applicata dove i due numeri si incontrano. Non si
 * chiama `riepilogoPosti` qui perché questa route non ha mai in mano le RIGHE di
 * `avvisi_risposte`: le legge in blocco `@/lib/avvisi/statistiche` e ne restituisce
 * già l'aggregato (`persone_ammesse`). Chi cambia quel confronto là dentro cambia
 * anche questa riga.
 *
 * Sopra capienza è uno STATO LEGITTIMO, non un errore: la segreteria può abbassare
 * il tetto sotto l'occupato e nessuno viene espulso. Il booleano serve a farglielo
 * vedere.
 */
function sopraCapienza(postiTotali: number | null | undefined, personeAmmesse: number): boolean {
    return postiTotali !== null && postiTotali !== undefined && personeAmmesse > postiTotali;
}

/**
 * ─── I POSTI LIBERI NON ARRIVANO MAI AL GENITORE, NEMMENO PER SOTTRAZIONE ────
 *
 * 🔴 DECISIONE n. 17 DEL COMMITTENTE, e non è estetica: **al genitore non si
 * mostra quanti posti restano**. Una famiglia che legge «restano 3 posti» non
 * decide con più calma, corre — e la corsa all'ultimo posto è esattamente ciò
 * che la lista d'attesa esiste per evitare. Al genitore spettano due sole
 * informazioni: che i posti sono esauriti, e che LUI è in lista d'attesa.
 *
 * ⚠️ IL DIFETTO ERA UNA SOTTRAZIONE, non un campo chiamato «posti liberi». Il
 * payload del ramo genitore portava `posti_totali` (dentro `AVVISO_COLS_SCADENZE`)
 * insieme a `stats.persone_ammesse`: due numeri leciti presi da soli, il residuo
 * esatto messi accanto. È la forma di fuga che nessuna ricerca per nome trova,
 * perché il dato vietato non è scritto da nessuna parte — si ricava.
 *
 * ⚠️ SUL RAMO STAFF QUEI DUE CAMPI RESTANO, e devono: sono i numeri con cui la
 * segreteria decide quante telefonate fare, e sono gli argomenti di
 * `sopraCapienza` qui sopra. Perciò si pota il PAYLOAD del solo ramo genitore, e
 * NON la proiezione della query — che è condivisa, e toglierle le colonne
 * spegnerebbe anche l'indicatore della segreteria.
 *
 * Questa funzione è una LISTA BIANCA e non una `delete` delle quattro chiavi
 * vietate: una statistica nuova aggiunta a `StatsAvviso` domani nasce FUORI dal
 * payload del genitore, e chi la vuole dentro deve scriverla qui — cioè passare
 * da questo riquadro. Al contrario, una lista nera l'avrebbe fatta entrare da
 * sola, che è precisamente il modo in cui `posti_totali` era entrato.
 *
 * ✅ «SEI IN LISTA D'ATTESA» È ARRIVATO, E DAL VERSO GIUSTO: non è una statistica,
 * è `my_response.stato_adesione` — lo stato della PROPRIA riga, aggregato sui figli
 * come già `risposta` (vedi `aggregaRisposta`). Non è un posto libero altrui, e
 * infatti resta fuori da questa lista bianca: qui dentro stanno solo i conteggi.
 *
 * ⏳ Quel che MANCA ancora, e va detto invece di lasciarlo scoprire: «posti
 * esauriti». Quando arriverà dovrà essere un BOOLEANO calcolato dal server — come
 * `scaduto` e `adesioni_chiuse` poche righe più su — e mai i due numeri che lo
 * generano: rimettere `posti_totali` accanto a `persone_ammesse` «tanto poi il
 * client fa la sottrazione giusta» riapre questo difetto parola per parola.
 */
type StatsGenitore = Pick<StatsAvviso, 'letti' | 'adesioni_si' | 'adesioni_no' | 'adesioni_senza_numero'>;

function statsPerGenitore(stats: StatsAvviso): StatsGenitore {
    return {
        letti: stats.letti,
        adesioni_si: stats.adesioni_si,
        adesioni_no: stats.adesioni_no,
        adesioni_senza_numero: stats.adesioni_senza_numero,
    };
}

// ── Ramo STAFF/DOCENTE: cockpit /admin|/teacher avvisi, isolato per plesso. ──
async function listaAvvisiStaff(
    request: NextRequest,
    supabase: SupabaseAdmin,
    plessiScope: string[],
): Promise<NextResponse> {
    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { scope, classe, scaduti } = q.data;
    // UN istante per tutta la richiesta: due `new Date()` a due righe di distanza
    // possono cadere ai due lati di una scadenza, e il risultato sarebbe un avviso
    // «scaduto ma con le adesioni ancora aperte» che non è mai esistito.
    const adessoISO = new Date().toISOString();

    const buildQuery = (cols: string) => {
        // ⚠️ NESSUN FILTRO DI SCADENZA, ed è una decisione del committente: allo
        // staff gli avvisi scaduti restano visibili. Il cockpit è anche l'archivio
        // di ciò che è stato pubblicato, e «sparito dalla bacheca delle famiglie»
        // non vuol dire «sparito dal lavoro della segreteria».
        let query = supabase.from('avvisi').select(cols).order('created_at', { ascending: false })
            .in('scuola_id', plessiScope);
        if (scope) query = query.eq('target_scope', scope);
        return query;
    };
    let res = await buildQuery(`${AVVISO_COLS_SCADENZE}, form_model_id`);
    if (colonnaMancante(res.error as { code?: string } | null)) {
        res = await buildQuery(AVVISO_COLS);
        // 🔴 IL DEGRADO SI DICHIARA, E QUI PIÙ CHE ALTROVE. Senza le sette colonne
        // del cantiere A2, `posti_totali` arriva `undefined` su OGNI riga e
        // `sopraCapienza` restituisce `false` per tutti: un indicatore di sicurezza
        // che si spegne MOSTRANDO IL VALORE RASSICURANTE. La segreteria legge
        // «nessun avviso sopra capienza» e non ha nulla da guardare per sapere che
        // quel numero non è stato calcolato — è la stessa forma di silenzio falso
        // che ha nascosto per mesi il guasto delle email di credenziali.
        // Degrada anche la scadenza (`scadenzaEffettiva` ripiega sulla vecchia
        // `scadenza date`), ma quello è un ripiego leggibile; questo è un `false`.
        //
        // Solo conteggi: quante righe hanno ricevuto il booleano non calcolato.
        logEvento('avvisi', 'warn', {
            operazione: 'avvisi:GET',
            esito: 'degrado-proiezione-capienza-spenta',
            n: (res.data ?? []).length,
        });
    }
    if (res.error) {
        logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, res.error);
        return NextResponse.json({ error: res.error.message }, { status: 500 });
    }
    let filtered = (res.data ?? []) as unknown as AvvisoRow[];
    if (classe) {
        filtered = filtered.filter(
            (a) => a.target_scope === 'globale' || (a.target_classes?.includes(classe) ?? false),
        );
    }
    if (scaduti) {
        const voluto = scaduti === 'si';
        filtered = filtered.filter((a) => avvisoScaduto(scadenzaEffettiva(a), adessoISO) === voluto);
    }

    // Due query in tutto, non quattro per avviso: il `.map()` qui sotto non tocca
    // più il database.
    const arricchisci = await autoriEStatistiche(supabase, filtered);
    const enriched = filtered.map((avviso) => {
        const extra = arricchisci(avviso);
        return {
            ...avviso,
            ...extra,
            ...statoTemporale(avviso, adessoISO),
            sopra_capienza: sopraCapienza(avviso.posti_totali, extra.stats.persone_ammesse),
            my_response: null,
        };
    });
    // Il bucket degli allegati è PRIVATO (2026-07-31): l'indirizzo si firma qui,
    // dietro a questo gate, e vale dieci minuti. Una sola chiamata per pagina.
    return NextResponse.json(await firmaAllegatiAvvisi(supabase, enriched, 'avvisi:GET'));
}

// ── Ramo GENITORE (G3+m3): parentId dalla SESSIONE, feed unificato dei figli. ─
async function listaAvvisiGenitore(supabase: SupabaseAdmin, parentId: string): Promise<NextResponse> {
    const figliIds = await getFigliDiGenitore(supabase, parentId);
    if (figliIds.length === 0) return NextResponse.json([]);

    const { data: figliRows, error: figliErr } = await supabase
        .from('alunni')
        .select('id, nome, classe_sezione, scuola_id')
        .in('id', figliIds);
    if (figliErr) {
        logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, figliErr);
        return NextResponse.json({ error: figliErr.message }, { status: 500 });
    }
    const figli = (figliRows ?? []) as unknown as Figlio[];
    const classiFigli = new Set(figli.map((f) => f.classe_sezione).filter((c): c is string => !!c));
    // Isolamento di plesso anche lato genitore: un globale di un'altra sede non compare.
    const scuoleFigli = [...new Set(figli.map((f) => f.scuola_id).filter((s): s is string => !!s))];
    // Fail-closed: se nessun figlio ha un plesso determinabile non si mostra nulla,
    // così un globale cross-tenant non appare quando scuola_id manca sull'anagrafica.
    if (scuoleFigli.length === 0) return NextResponse.json([]);

    // UN istante per tutta la richiesta: lo stesso che filtra la query e che
    // calcola i due booleani del payload. Due `new Date()` a due righe di distanza
    // possono cadere ai due lati di una scadenza.
    const adessoISO = new Date().toISOString();

    const buildQuery = (cols: string, conFiltro: boolean) => {
        let query = supabase.from('avvisi').select(cols).order('created_at', { ascending: false });
        query = query.in('scuola_id', scuoleFigli);
        // ── GLI SCADUTI ESCONO DAL FEED, E LO DECIDE IL DATABASE ──────────────
        //
        // Qui prima c'era un confronto fra STRINGHE contro il giorno UTC:
        //     const oggi = new Date().toISOString().split('T')[0]
        //     if (a.scadenza && a.scadenza < oggi) return false
        // Fra le 00:00 e le 02:00 italiane il server è ancora «ieri», quindi un
        // avviso scaduto restava in bacheca un giorno in più. È la stessa famiglia
        // di difetti che il 2026-08-01 alle 01:08 ha fatto sparire un incasso vero
        // da un KPI, e la ragione per cui esistono `dataCivile()` e
        // `confini-giorno.ts`.
        //
        // 🔴 `.gte` E NON `.gt`, ed è una decisione arbitrata: **la scadenza è
        // l'ultimo istante valido, incluso**. `fineGiornoCivile` restituisce
        // `23:59:59.999` proprio perché è l'ultimo istante VIVO del giorno, e
        // `avvisoScaduto` usa `adesso > scadenza` sulla stessa idea. Con `.gt` un
        // avviso sparirebbe dalla bacheca nel millisecondo esatto in cui è ancora
        // valido per il server che raccoglie le adesioni: due regole a un
        // millisecondo di distanza, cioè il difetto meno riproducibile che si possa
        // scrivere. E il confronto avviene fra DUE ISTANTI ASSOLUTI, non fra una
        // data e una stringa: è la differenza sostanziale rispetto a prima.
        if (conFiltro) query = query.gte('scadenza_avviso', adessoISO);
        return query;
    };

    // ── IL DEGRADO È A DUE PASSI, E PRIMA IL COMMENTO NE DICHIARAVA TRE ──────
    //
    // Sul DB E2E della CI, che è un progetto separato e NON è migrato, un `42703`
    // arriva su questa query perché una colonna del cantiere A2 non esiste. Il
    // codice provava allora TRE query: proiezione nuova col filtro, proiezione
    // nuova senza filtro, proiezione storica senza filtro — «un `42703` può
    // arrivare da due punti diversi, la proiezione e il filtro; si scende un
    // gradino alla volta».
    //
    // 🔴 IL GRADINO DI MEZZO NON POTEVA RIUSCIRE MAI, e il commento che lo
    // giustificava era falso. Il filtro gira su `scadenza_avviso`, che è DENTRO
    // `AVVISO_COLS_SCADENZE`: la colonna del filtro è un sottoinsieme di quelle
    // della proiezione, quindi togliere il filtro lascia in piedi esattamente la
    // stessa proiezione che ha appena prodotto il `42703`. PostgREST costruisce
    // UNA query sola: se una colonna manca, manca anche senza la `WHERE`. Il
    // secondo tentativo era un round-trip garantito a vuoto su ogni richiesta di
    // un ambiente non migrato — e un file che si spiega con un fatto falso è
    // peggio di un file che tace.
    //
    // Restano due passi: tutto, oppure le colonne storiche senza filtro. Il
    // gradino di mezzo torna il giorno in cui il filtro userà una colonna che la
    // proiezione NON chiede; finché il filtro è un sottoinsieme, non serve.
    //
    // ⚠️ `scuola_id` SI AGGIUNGE QUI, A ENTRAMBI I PASSI, e non dentro
    // `AVVISO_COLS`: quella costante la condivide il cockpit dello staff, che la
    // sede non la usa (è già ristretto a `plessiScope`). E sta anche nel RIPIEGO
    // perché la colonna è STORICA — la `.in('scuola_id', …)` di `buildQuery` gira
    // su entrambi i passi, quindi se mancasse il ripiego sarebbe già un 500 oggi.
    // Senza questa colonna il filtro dei figli qui sotto confronterebbe contro
    // `undefined` e non offrirebbe più NESSUN bambino su un avviso globale.
    let res = await buildQuery(`${AVVISO_COLS_SCADENZE}, form_model_id, scuola_id`, true);
    if (colonnaMancante(res.error as { code?: string } | null)) {
        res = await buildQuery(`${AVVISO_COLS}, scuola_id`, false);
        // ⚠️ IL DEGRADO SI DICHIARA. Da qui in poi la bacheca dei genitori
        // mostra ANCHE gli avvisi scaduti, perché la colonna su cui si filtra
        // non c'è. Senza questa riga, il giorno in cui quella colonna mancasse
        // in produzione la bacheca mostrerebbe tutto per sempre e non ci
        // sarebbe niente da guardare per accorgersene: nessun errore, nessun
        // 500, solo avvisi vecchi che non se ne vanno più.
        logEvento('avvisi', 'warn', {
            operazione: 'avvisi:GET',
            esito: 'degrado-filtro-scadenza-assente',
        });
    }
    if (res.error) {
        logErrore({ operazione: 'avvisi:GET', stato: 500, evento: 'db' }, res.error);
        return NextResponse.json({ error: res.error.message }, { status: 500 });
    }
    const avvisi = (res.data ?? []) as unknown as AvvisoRow[];

    // ⚠️ `scadenza_adesione` NON filtra il feed, e non è una dimenticanza: un
    // avviso con le adesioni chiuse ma ancora dentro `scadenza_avviso` resta
    // visibile IN SOLA LETTURA. È l'intera ragione per cui le scadenze sono due —
    // «le adesioni si chiudono venerdì, ma l'avviso deve restare leggibile fino
    // alla gita». Il bottone lo spegne `adesioni_chiuse`, qui sotto.
    const rilevanti = avvisi.filter((a) => {
        if (a.target_scope === 'globale') return true;
        return (a.target_classes ?? []).some((c) => classiFigli.has(c));
    });

    // Il percorso PIÙ CALDO dell'applicazione: è la home del genitore, e prima
    // costava CINQUE query per avviso (le quattro di `autoreEStats` più le
    // risposte del genitore, qui sotto). Ora sono tre in tutto, qualunque sia il
    // numero di avvisi, e il `.map()` che segue è puro calcolo in memoria.
    const [arricchisci, mieRisposte] = await Promise.all([
        autoriEStatistiche(supabase, rilevanti),
        rispostePerAvvisoDelGenitore(supabase, rilevanti.map((a) => a.id), parentId, 'avvisi:GET'),
    ]);

    const enriched = rilevanti.map((avviso) => {
        // ── I FIGLI CUI L'AVVISO SI RIFERISCE — E IL PLESSO CONTA ANCHE QUI ──
        //
        // m3: globale = tutti i figli DI QUELLA SEDE, classe = chi è in quella
        // classe.
        //
        // 🔴 IL `.filter` SULLA SEDE NEL RAMO GLOBALE NON È RIDONDANTE, ed è il
        // motivo per cui questa riga ha una spiegazione. Il feed è già ristretto
        // alle sedi dei figli (`.in('scuola_id', scuoleFigli)`), ma `scuoleFigli`
        // è l'UNIONE: un genitore con un bambino a Giugliano e uno ad Aversa
        // riceve i globali di ENTRAMBE, e senza questo filtro ogni avviso
        // offriva TUTTI i figli — compreso quello dell'altro plesso.
        //
        // Dal 2026-09-19 `POST …/risposte` rifiuta quell'accoppiamento con un
        // 403 `ADESIONE_ALUNNO_FUORI_AVVISO`: senza questa riga la bacheca
        // continuerebbe a offrire un bottone che il server ha appena imparato a
        // rifiutare, e il genitore toccherebbe il nome di suo figlio per leggere
        // «questo avviso non riguarda il bambino indicato».
        //
        // ⚠️ L'argomento con cui quel gate è stato approvato — «non è più stretto
        // della bacheca, nessuno perde un bottone che vedeva» — valeva per il caso
        // analizzato allora (l'uuid in `target_classes`, che già non compariva a
        // nessuno) e NON per questo: qui il bottone c'era davvero. Le due regole
        // devono dire la stessa cosa, e il test che lo impedisce di ri-divergere
        // non guarda il caso ma l'INVARIANTE — ciò che la bacheca offre, il
        // server accetta (`__tests__/api/avvisi-cerchio-bacheca-adesione.test.ts`).
        //
        // Il ramo per classe non ha bisogno della sede: `classe_sezione` è un
        // nome, e un omonimo fra due plessi sarebbe già oggi un avviso che arriva
        // alla sezione sbagliata — un difetto diverso, che vive nel filtro
        // `rilevanti` qui sopra e non in questa riga.
        const figliRiferiti = avviso.target_scope === 'globale'
            ? figli.filter((f) => !!avviso.scuola_id && f.scuola_id === avviso.scuola_id)
            : figli.filter(
                (f) => f.classe_sezione && (avviso.target_classes ?? []).includes(f.classe_sezione),
            );
        // Risposte del genitore per QUESTO avviso, una riga per figlio: la mappa
        // è già in memoria, indicizzata per avviso e poi per alunno.
        const perFiglio: Map<string, RispostaFiglio> = mieRisposte.get(avviso.id) ?? new Map();
        const my_response = aggregaRisposta(figliRiferiti.map((f) => f.id), perFiglio);

        // ── LO STATO PER FIGLIO ESCE QUI, ACCANTO AL NOME ────────────────────
        //
        // 🔴 NON è una fuga di capienza, ed è la stessa distinzione di
        // `statsPerGenitore`: questi due campi sono LA PROPRIA RIGA di ciascun
        // figlio — esattamente ciò che `my_response` già porta aggregato — e non
        // dicono niente su quanto spazio resta agli altri. Nessuna sottrazione è
        // possibile da «Giulia è in coda»: il tetto non c'è, gli ammessi nemmeno.
        //
        // Servono perché l'aggregato, quando i figli non concordano, è `null` — e
        // `null` in quel punto significa «ammesso» (le 869 righe storiche). Senza
        // il dato per figlio la famiglia con Marco dentro e Giulia in coda legge
        // «Hai aderito ✓» e la coda non viene nominata da nessuna parte.
        const figliOut = figliRiferiti.map((f) => {
            const riga = perFiglio.get(f.id) ?? null;
            return {
                student_id: f.id,
                nome: f.nome ?? '',
                stato_adesione: riga?.stato_adesione ?? null,
                numero_partecipanti: riga?.numero_partecipanti ?? null,
            };
        });

        // Il tetto esce dal payload del genitore: da solo non dice niente, accanto
        // a `persone_ammesse` dice quanti posti restano. Vedi `statsPerGenitore`.
        const rigaPubblica: AvvisoRow = { ...avviso };
        delete rigaPubblica.posti_totali;
        // …e con lui la sede, chiesta SOLO per filtrare i figli qui sopra. Il
        // contratto verso il client resta quello di ieri: una colonna letta per
        // un uso interno non diventa un campo pubblico per inerzia — è così che
        // `posti_totali` era entrato nel payload del genitore la prima volta.
        delete rigaPubblica.scuola_id;
        const { author, stats } = arricchisci(avviso);

        return {
            ...rigaPubblica,
            author,
            stats: statsPerGenitore(stats),
            ...statoTemporale(avviso, adessoISO),
            figli: figliOut,
            my_response,
        };
    });

    // Stessa firma del ramo staff: il genitore riceve un link a tempo, non un
    // indirizzo pubblico che resterebbe valido per chiunque, per sempre.
    return NextResponse.json(await firmaAllegatiAvvisi(supabase, enriched, 'avvisi:GET'));
}

// GET /api/avvisi
// Ramo deciso sul RUOLO di sessione (non su un parametro client, G3):
//  - genitore → feed unificato dei propri figli, server-derived.
//  - docente/staff → cockpit isolato per plesso.
export const GET = withRoute('avvisi:GET', async (request: NextRequest) => {
    try {
        const auth = await requireUser(request);
        if (auth.response) return auth.response;
        const supabase = await createAdminClient();

        // PRESENTAZIONE: quale delle due bacheche si sta guardando. `eFamiglia`
        // qui toglierebbe a una docente-genitore il cockpit di plesso — la sua
        // bacheca di lavoro — ogni volta che apre gli avvisi.
        if (agisceComeGenitore(auth.user)) {
            return await listaAvvisiGenitore(supabase, auth.user.id);
        }

        // Personale docente/staff: il genitore è già uscito sopra; cuoca e altri
        // ruoli non hanno una bacheca avvisi.
        const ruoliStaff = ['educator', 'admin', 'coordinator', 'segreteria'];
        if (!ruoliStaff.includes(auth.user.role)) {
            return NextResponse.json({ error: 'Accesso negato' }, { status: 403 });
        }
        // Sedi ATTIVE (cookie SedeSelector) ∩ sedi accessibili, ri-validate server-side.
        const plessiScope = await resolveScuoleAttive(request, supabase, auth.user);
        if (plessiScope.length === 0) return NextResponse.json([]);
        return await listaAvvisiStaff(request, supabase, plessiScope);
    } catch (error) {
        logErrore({ operazione: 'avvisi:GET', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});

// ── Le classi destinatarie devono esistere NELLA SEDE su cui si pubblica. ──
//
// `assertClasseNomeInScope` (lib/auth/scope) risolve il nome dentro TUTTI i
// plessi dell'utente: risponde «questa classe è tua», non «questa classe è nel
// plesso su cui stai pubblicando». Per la Direzione, che ha tre sedi, le due
// domande hanno risposte diverse, ed è la seconda che conta: «3 ANNI» esiste
// solo ad Aversa, quindi un avviso pubblicato su Giugliano che la nomina non
// raggiunge nessuno e non lo scopre nessuno (in produzione, il 2026-07-31, due
// avvisi erano già finiti così — con l'uuid della sezione al posto del nome).
//
// La sede arriva da `resolveScuolaScrittura`, cioè è già dentro il perimetro
// dell'utente: questo controllo è quindi **più stretto** dello scope, e vale da
// gate per TUTTI i ruoli (il gate dell'educator, `verificaTargetAvvisoDocente`,
// resta e risponde prima: «non è una tua classe» è un 403, non un 400).
// Una query sola, mai una per classe.
// L'esito è un'unione DISCRIMINATA su `ok`. Il campo dell'errore non può fare
// da discriminante: `errore: unknown` non è un tipo unitario, quindi
// `if (esito.errore)` non restringe l'unione e a valle `esito.mancanti` resta
// `string[] | null` — cioè il compilatore, giustamente, non crede al controllo.
// Lo dicono `tsc --noEmit` e `next build`; i test no, perché a runtime il ramo
// si comporta bene: è il tipo a non reggere, ed è il tipo che tiene onesto chi
// aggiungerà il prossimo controllo qui dentro.
// ─── Chi può pubblicare, e come si dice a chi non può (S24) ──────────────────
//
// `avvisi_config.ruoli_pubblicazione` non elenca RUOLI, elenca due GRUPPI:
// `admin` e `teacher`. È il vocabolario della schermata Impostazioni → Avvisi,
// dove la pillola `admin` si chiama letteralmente «Segreteria/Admin»
// (AvvisiSettings.tsx:24). Fino al 2026-07-31 la route metteva `segreteria` nel
// gruppo `teacher`: la segreteria veniva negata da una configurazione che, letta
// sullo schermo, la autorizzava. Il resto dell'applicazione non ha mai avuto
// questo dubbio — `areaForRole('segreteria') = 'admin'` (active-role.ts:24),
// `requireStaff` la ammette per default (require-staff.ts:253),
// `vedeTutteLeClassi` la include (scope.ts:240).
const RUOLI_GRUPPO_GESTIONE = ['admin', 'coordinator', 'segreteria'];

function gruppoPubblicazione(ruolo: string): string {
    return RUOLI_GRUPPO_GESTIONE.includes(ruolo) ? 'admin' : 'teacher';
}

/** Come si chiama un gruppo sullo schermo; un gruppo ignoto si mostra com'è. */
const ETICHETTA_GRUPPO: Record<string, string> = {
    admin: 'Segreteria e Direzione',
    teacher: 'Docenti',
};
const etichettaGruppo = (g: string) => ETICHETTA_GRUPPO[g] ?? g;

/**
 * Il messaggio del 403 dice la CONFIGURAZIONE, non un'ipotesi.
 *
 * Il testo precedente — «La pubblicazione di avvisi è riservata alla segreteria»
 * — era scritto per un caso solo e nominava come autorizzato proprio il ruolo
 * che stava ricevendo il diniego: la segreteria di Aversa lo ha letto per due
 * giorni. Un messaggio d'errore che afferma il contrario di quel che succede
 * costa più del silenzio, perché manda a cercare il guasto dove non è.
 */
function messaggioRuoliAbilitati(abilitati: readonly string[], gruppo: string): string {
    if (abilitati.length === 0) {
        return 'In questa sede nessun ruolo è abilitato a pubblicare avvisi — Impostazioni → Avvisi.';
    }
    return (
        `In questa sede possono pubblicare avvisi: ${abilitati.map(etichettaGruppo).join(', ')}. ` +
        `Il tuo ruolo (${etichettaGruppo(gruppo)}) non è fra questi — Impostazioni → Avvisi.`
    );
}

/**
 * IL RIFIUTO DELLE SCADENZE, TRADOTTO IN UNA RISPOSTA — con il `codice` LETTERALE.
 *
 * ⚠️ Quattro rami e non un `codice: esito.codice`, e non è verbosità: il lock
 * `__tests__/architecture/errori-con-codice.test.ts` legge il SORGENTE e pretende
 * che il `codice` di ogni risposta sia una stringa letterale (o una costante
 * `const X = '…'` dello stesso file). Un valore che il lock non sa leggere smette
 * di essere confrontato con `CODICI_ERRORE` e con i due cataloghi — cioè un codice
 * inventato, o scritto male, passerebbe qualunque cosa contenga, e a schermo
 * l'utente inglese ricadrebbe sulla prosa italiana.
 *
 * Le frasi sono le stesse dei cataloghi (`messages/{it,en}/shared.json`): qui
 * servono da ripiego per chi non traduce, e due versioni diverse dello stesso
 * rifiuto sono il difetto F1 del collaudo del 2026-07-31.
 *
 * Il `warn` è PERSISTITO, stessa scelta e stessa ragione di `classe-fuori-sede`
 * poco sopra: una scadenza rifiutata è quasi sempre un modulo da correggere, non un
 * tentativo, e senza questa riga «la segreteria non riesce a salvare gli avvisi»
 * resta una segnalazione telefonica invece di un dato. Solo metadati — uuid e
 * conteggi, nessun testo.
 */
function rifiutoScadenze(
    codice: 'SCADENZE_INCOERENTI' | 'SCADENZA_ADESIONE_MANCANTE' | 'SCADENZA_AVVISO_MANCANTE' | 'SCADENZA_NEL_PASSATO',
    operazione: string,
    campi: Record<string, string | number | boolean | null>,
): NextResponse {
    const esito = {
        SCADENZE_INCOERENTI: 'scadenze-incoerenti',
        SCADENZA_ADESIONE_MANCANTE: 'scadenza-adesione-mancante',
        SCADENZA_AVVISO_MANCANTE: 'scadenza-avviso-mancante',
        SCADENZA_NEL_PASSATO: 'scadenza-nel-passato',
    }[codice];
    logEvento('avvisi', 'warn', { operazione, esito, ...campi });

    switch (codice) {
        case 'SCADENZE_INCOERENTI':
            return NextResponse.json(
                {
                    error: 'La data entro cui si può aderire viene dopo la scadenza dell’avviso: correggi una delle due. L’avviso non è stato salvato.',
                    codice: 'SCADENZE_INCOERENTI',
                },
                { status: 400 },
            );
        case 'SCADENZA_ADESIONE_MANCANTE':
            return NextResponse.json(
                {
                    error: 'Controlla entro quando si può aderire: se quella data e ora manca o non è valida, l’avviso non viene salvato.',
                    codice: 'SCADENZA_ADESIONE_MANCANTE',
                },
                { status: 400 },
            );
        case 'SCADENZA_NEL_PASSATO':
            return NextResponse.json(
                {
                    error: 'Una delle due scadenze è già passata: correggila. L’avviso non è stato salvato.',
                    codice: 'SCADENZA_NEL_PASSATO',
                },
                { status: 400 },
            );
        default:
            return NextResponse.json(
                {
                    error: 'Controlla fino a quando l’avviso resta visibile in bacheca: se quella data e ora manca o non è valida, l’avviso non viene salvato.',
                    codice: 'SCADENZA_AVVISO_MANCANTE',
                },
                { status: 400 },
            );
    }
}

// POST /api/avvisi
// Body: { titolo, contenuto, tipo?, target_scope?, target_classes?, scadenza_avviso,
//         scadenza_adesione?, chiedi_numero?, etichetta_numero?, numero_min?, numero_max?,
//         posti_totali?, attachment_url?, form_model_id?, scuola_id? }
export const POST = withRoute('avvisi:POST', async (request: Request) => {
    try {
        const auth = await requireDocente(request);
        if (auth.response) return auth.response;

        const b = await parseBody(request, postBodySchema);
        if ('response' in b) return b.response;
        const {
            titolo, contenuto, tipo, target_scope, target_classes, attachment_url, form_model_id,
            scadenza_avviso, scadenza_adesione, chiedi_numero, etichetta_numero,
            numero_min, numero_max, posti_totali,
        } = b.data;

        // M7: l'autore è SEMPRE l'utente di sessione. `author_id` del client non esiste più.
        const authorId = auth.user.id;
        const ruolo = (auth.user.role || '').toLowerCase();

        const supabase = await createAdminClient();

        // La sede si DICHIARA (multi-sede, 2026-07-31). Fino a oggi era
        // `auth.user.scuola_id`: la sede PRIMARIA di chi scrive, che con tre
        // plessi non ha nessun rapporto con la sede su cui sta lavorando. Quel
        // valore si propagava a tutto — riga `avvisi`, audit, destinatari della
        // notifica — quindi un avviso per Aversa nasceva a Giugliano, lo
        // ricevevano le famiglie sbagliate (o nessuna) e l'autore non lo
        // ritrovava nemmeno nel cockpit. Se la sede resta ambigua il resolver
        // risponde 400: «dimmi dove stai pubblicando» è la risposta giusta, un
        // ripiego silenzioso no.
        const sw = await resolveScuolaScrittura(
            request as NextRequest, supabase, auth.user, b.data.scuola_id ?? undefined,
        );
        if (sw.response) return sw.response;
        const scuolaId = sw.scuolaId as string;

        // Ruoli abilitati alla pubblicazione: la configurazione è PER SEDE, e
        // quella che conta è la sede su cui si pubblica, non quella dell'autore.
        // Se la sede non ha ancora la configurazione (sede nuova, o DB E2E non
        // migrato) vale il default con cui la sede NASCE: una copia sola, non
        // due che divergono.
        const gruppo = gruppoPubblicazione(ruolo);
        const avvisiCfg = await getModuleConfig<{ ruoli_pubblicazione: string[] }>(
            supabase, 'avvisi_config', scuolaId,
        );
        const abilitati = avvisiCfg.ruoli_pubblicazione ?? [...RUOLI_PUBBLICAZIONE_DEFAULT];
        if (!abilitati.includes(gruppo)) {
            // `warn` → persistito. Un diniego di pubblicazione è quasi sempre una
            // configurazione da correggere, non un tentativo: senza questa riga
            // «la segreteria di Aversa non riesce a pubblicare» resta una
            // segnalazione telefonica invece di un dato. Solo metadati.
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi:POST',
                esito: 'pubblicazione-non-abilitata',
                tipo: 'ruolo-fuori-configurazione',
                ruolo,
                uid: auth.user.id,
                scuola_id: scuolaId,
                n_abilitati: abilitati.length,
            });
            return NextResponse.json(
                { error: messaggioRuoliAbilitati(abilitati, gruppo) },
                { status: 403 },
            );
        }

        // M8: 'classe' senza classi VALIDE → 400 (per TUTTI i ruoli). Niente più
        // degradazione implicita a globale: notifica e feed coincidono sempre.
        const classiTarget = classiTargetValide(target_classes);
        if ((target_scope ?? 'globale') === 'classe' && classiTarget.length === 0) {
            return NextResponse.json(
                { error: 'Seleziona almeno una classe destinataria per un avviso di classe.', codice: 'CLASSE_DESTINATARIA_MANCANTE' },
                { status: 400 },
            );
        }

        // Gate sul TARGET: un educator scrive solo alle proprie classi (mai globale,
        // mai classi altrui). Staff/direzione/segreteria non sono limitati.
        const targetErr = await verificaTargetAvvisoDocente(supabase, auth.user, {
            scope: target_scope,
            classi: target_classes,
        });
        if (targetErr) return targetErr;

        // Gate di SEDE sul target, per TUTTI i ruoli: ogni nome di classe deve
        // esistere nella sede risolta. Il nome-classe non è più una chiave
        // univoca (da quando le sedi sono tre, «2 ANNI» esiste in due plessi):
        // senza questo controllo si pubblica in una sede una classe che sta in
        // un'altra, e l'avviso non arriva a nessuno rispondendo 201.
        if (classiTarget.length > 0) {
            const esito = await classiMancantiNellaSede(supabase, scuolaId, classiTarget);
            if (!esito.ok) {
                logErrore({ operazione: 'avvisi:POST', stato: 500, evento: 'db' }, esito.errore);
                return NextResponse.json(
                    { error: 'Verifica delle classi destinatarie non riuscita', codice: 'VERIFICA_CLASSI_NON_RIUSCITA' },
                    { status: 500 },
                );
            }
            if (esito.mancanti.length > 0) {
                // `warn` → persistito: «pubblicare a una classe che non è in
                // questa sede» è o un errore d'interfaccia o un tentativo. Solo
                // metadati non personali (i nomi di sezione sono in lista bianca).
                logEvento('avvisi', 'warn', {
                    operazione: 'avvisi:POST',
                    esito: 'classe-fuori-sede',
                    tipo: 'target-non-nella-sede',
                    ruolo,
                    uid: auth.user.id,
                    n_classi: esito.mancanti.length,
                    sezione: esito.mancanti.join(','),
                });
                return NextResponse.json(
                    {
                        error:
                            'Classi non presenti nella sede selezionata: ' +
                            `${esito.mancanti.join(', ')}. Controlla la sede di pubblicazione.`,
                        codice: 'CLASSI_FUORI_SEDE',
                    },
                    { status: 400 },
                );
            }
        }

        // ── LE DUE SCADENZE, DOPO I GATE E PRIMA DELL'INSERT ─────────────────
        //
        // Qui, e non prima: rifiutare per una scadenza sbagliata un utente che non
        // ha nemmeno il diritto di pubblicare in questa sede gli direbbe che il suo
        // problema è la data, e lo manderebbe a correggere un campo mentre il 403
        // lo aspetta comunque due righe dopo.
        //
        // ⚠️ `vietaPassato: true` SOLO QUI. Sul POST un avviso che nasce già
        // scaduto è sempre uno sbaglio di digitazione — nessuno pubblica qualcosa
        // perché nessuno lo veda. Sul PUT la stessa cosa è il gesto legittimo con
        // cui la segreteria chiude SUBITO un avviso, e vietarlo le toglierebbe
        // l'unico modo di farlo.
        const adessoISO = new Date().toISOString();
        const scad = risolviScadenze({
            tipo: tipo ?? null,
            scadenzaAvvisoLocale: scadenza_avviso,
            scadenzaAdesioneLocale: scadenza_adesione,
            vietaPassato: true,
            adessoISO,
        });
        if (!scad.ok) return rifiutoScadenze(scad.codice, 'avvisi:POST', { uid: auth.user.id, sede_id: scuolaId });

        // ── L'INTERVALLO DEL CONTATORE ───────────────────────────────────────
        //
        // Un vincolo fra DUE campi: uno schema zod non lo può esprimere, e il
        // `CHECK (numero_min >= 1 AND numero_max >= numero_min …)` della colonna lo
        // respingerebbe con un `23514` → 500, cioè un 400 travestito da «è colpa
        // mia» con dentro il nome di un vincolo del database. Si controlla
        // sull'intervallo EFFETTIVO (`intervallo()` applica i predefiniti, gemelli
        // del `DEFAULT` della colonna) e SEMPRE, anche a contatore spento: il CHECK
        // vale sulla colonna, non sulla bandierina.
        const numeri = intervallo({ numero_min, numero_max });
        if (numeri.min > numeri.max) {
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi:POST',
                esito: 'numero-intervallo-non-valido',
                uid: auth.user.id,
                sede_id: scuolaId,
            });
            return NextResponse.json(
                {
                    error: 'L’intervallo di persone indicato non è valido: controlla il minimo, il massimo e il valore proposto. L’avviso non è stato salvato.',
                    codice: 'NUMERO_INTERVALLO_NON_VALIDO',
                },
                { status: 400 },
            );
        }

        // A contatore SPENTO i tre campi sono rumore: l'interfaccia li lascia
        // riempiti quando la segreteria accende e poi rispegne l'interruttore.
        // Non si archiviano — ma `numero_min`/`numero_max` sono `NOT NULL` in
        // colonna, quindi si scrivono i predefiniti, non `null`.
        const conNumero = chiedi_numero === true;
        const etichetta = (etichetta_numero ?? '').trim();

        // Insert resiliente alla colonna form_model_id mancante (DB E2E CI non migrato).
        const avvisoRecord: Record<string, unknown> = {
            author_id: authorId,
            titolo,
            contenuto,
            tipo: tipo ?? 'presa_visione',
            target_scope: target_scope ?? 'globale',
            // Si archivia l'insieme VALIDATO (`classiTarget`), non l'array grezzo:
            // validare una lista e scriverne un'altra rende il gate una formalità —
            // duplicati, stringhe vuote e valori non-testuali entrerebbero senza
            // essere mai stati confrontati con le sezioni della sede.
            target_classes: classiTarget.length > 0 ? classiTarget : null,
            // ⚠️ `scadenza` (la vecchia `date`) NON si scrive più: la governa il
            // trigger `trg_avvisi_scadenza_compat`, che la deriva da
            // `scadenza_avviso` a ogni INSERT e a ogni UPDATE. Scriverla anche da
            // qui vorrebbe dire avere due sorgenti per la stessa colonna, ed è
            // esattamente la coppia che il trigger esiste per tenere allineata.
            scadenza_avviso: scad.scadenzaAvviso,
            scadenza_adesione: scad.scadenzaAdesione,
            chiedi_numero: conNumero,
            etichetta_numero: conNumero ? (etichetta || ETICHETTA_NUMERO_PREDEFINITA) : null,
            numero_min: conNumero ? numeri.min : MIN_PREDEFINITO,
            numero_max: conNumero ? numeri.max : MAX_PREDEFINITO,
            posti_totali: posti_totali ?? null,
            // In tabella si archivia il PERCORSO nel bucket. Il modulo rilegge un
            // avviso già firmato e rimanda quell'indirizzo tale e quale: senza
            // questa normalizzazione resterebbe salvato un URL col token scaduto.
            attachment_url: normalizzaAllegatoAvviso(attachment_url),
            form_model_id: form_model_id ?? null,
            scuola_id: scuolaId, // tenant
        };
        // ── IL DEGRADO SI DICHIARA, E LA TENANCY NON SI SFILA MAI IN SILENZIO. ──
        //
        // Questo ciclo esiste per il DB E2E della CI, che non è migrato: PostgREST
        // risponde `PGRST204`/`42703` nominando la colonna che non ha, e si riprova
        // senza. Il difetto era che `scuola_id` È NEL RECORD: bastava che PostgREST la
        // nominasse (una migrazione a metà, una cache dello schema stantia, una colonna
        // rimossa per errore) perché l'avviso venisse inserito SENZA CHIAVE DI TENANCY,
        // senza una riga di log, con 201 al chiamante. Con tre plessi quella riga non è
        // di nessuno: non compare nel cockpit di nessuna sede e nel feed di nessuna
        // famiglia — cioè l'avviso "esiste" e non lo legge nessuno.
        //
        // Il gemello `gallery:GET` per lo stesso degrado NEGA già (`degradoSedeLecito`):
        // si prosegue senza isolamento SOLO se non c'è niente da isolare (al più una
        // sede reale). Qui vale la stessa regola, e per la stessa ragione: il fallback
        // scatta proprio quando l'isolamento non è disponibile, cioè nel momento in cui
        // è più pericoloso assecondarlo.
        //
        // Ogni colonna sfilata lascia comunque la sua riga: il nome viaggia sia come
        // campo (`colonna`, leggibile su Vercel) sia dentro `msg` — `redact()` è a lista
        // bianca PER CHIAVE e `colonna` non è in lista, quindi in `app_log` uscirebbe
        // come `[redatto:str/N]` e la riga direbbe «ho sfilato una colonna» senza dire
        // quale. `msg` finisce invece in `app_log.messaggio`, in chiaro e sanificato.
        let insRes = await supabase.from('avvisi').insert(avvisoRecord).select().single();
        let attempts = 0;
        while (insRes.error && colonnaMancante(insRes.error as { code?: string } | null) && attempts < MAX_COLONNE_SFILATE) {
            const m = /Could not find the '([a-z_]+)' column|column "?([a-z_]+)"? of relation/i.exec(insRes.error.message);
            const col = m?.[1] ?? m?.[2];
            if (!col || !(col in avvisoRecord)) break;
            if (col === 'scuola_id' && !(await degradoSedeLecito(supabase, 'avvisi:POST'))) {
                // Isolamento di sede non disponibile su impianto multi-sede: è un
                // incidente, quindi `error`, mai `info`. E si NEGA prima di riprovare:
                // un avviso senza tenant è peggio di un avviso non pubblicato.
                logEvento('avvisi', 'error', {
                    operazione: 'avvisi:POST',
                    esito: 'colonna-sede-assente-degrado-negato',
                    msg: 'avvisi:POST: colonna "scuola_id" assente su impianto multi-sede, pubblicazione negata',
                });
                return NextResponse.json(
                    { error: 'Isolamento per sede non disponibile' },
                    { status: 500 },
                );
            }
            logEvento('avvisi', 'warn', {
                operazione: 'avvisi:POST',
                esito: 'degrado-colonna-sfilata',
                colonna: col,
                msg: `avvisi:POST: colonna "${col}" assente sul DB, sfilata dal record`,
            });
            delete avvisoRecord[col];
            insRes = await supabase.from('avvisi').insert(avvisoRecord).select().single();
            attempts++;
        }
        const { data, error } = insRes;

        if (error) {
            // Il corpo del guasto sta nel LOG, non nella risposta: `error.message`
            // rigirato al client raccontava il tipo esatto della colonna
            // (`value too long for type character varying(255)`) a chiunque sapesse
            // mandare una stringa lunga — e a chi lavora in segreteria non diceva
            // niente di utile. Il massimo ora è dichiarato in zod, quindi un `22001`
            // che arrivasse comunque fin qui non è più un errore del chiamante: è la
            // prova che il DDL e `@/lib/validation/avvisi` hanno divergiuto, e resta
            // un 500 perché quella è la verità.
            logErrore({ operazione: 'avvisi:POST', stato: 500, evento: 'db' }, error);
            return NextResponse.json({ error: 'Pubblicazione dell\'avviso non riuscita' }, { status: 500 });
        }

        await logScrittura(supabase, {
            attore: auth.user, entitaTipo: 'avviso', entitaId: (data as { id?: string })?.id ?? null,
            azione: 'insert', scuolaId,
            valoreDopo: { id: (data as { id?: string })?.id, titolo, target_scope },
        });

        // Notifica ai genitori destinatari (best-effort). UN solo enqueue con
        // tipo per priorità: modulo firmabile > richiesta adesione > avviso.
        const tipoNotifica = form_model_id
            ? 'modulo_da_compilare'
            : (tipo === 'adesione' ? 'consenso_uscita' : 'avviso');
        // Il conteggio si tiene FUORI dal try perché è il dato del log di successo qui
        // sotto. `null` significa «non si è arrivati a calcolarlo»: in quel caso la riga
        // `error` del catch dice già perché, e un conteggio inventato mentirebbe.
        let nDestinatari: number | null = null;
        try {
            const globale = (target_scope ?? 'globale') === 'globale';
            const destinatari = globale
                ? await genitoriDiScuola(supabase, scuolaId)
                : await genitoriDiClassi(supabase, scuolaId, classiTarget);
            nDestinatari = destinatari.length;
            const titoloNotifica =
                tipoNotifica === 'modulo_da_compilare' ? `Modulo da compilare: ${titolo}`
                : tipoNotifica === 'consenso_uscita' ? `Richiesta di consenso: ${titolo}`
                : `Nuovo avviso: ${titolo}`;
            await notificaEvento(supabase, {
                tipo: tipoNotifica,
                scuolaId,
                utenteIds: destinatari,
                titolo: titoloNotifica,
                corpo: contenuto.length > 140 ? `${contenuto.slice(0, 140)}…` : contenuto,
                link: '/parent/avvisi',
                entitaTipo: 'avviso',
                entitaId: (data as { id?: string })?.id ?? null,
                bufferMin: 10,
                debounce: true,
            });
        } catch (e) {
            // `error` benché l'avviso sia pubblicato (201): la notifica non è mai stata accodata,
            // quindi le famiglie non sapranno dell'avviso — e se era un consenso o un modulo
            // firmabile, la segreteria aspetterà risposte che nessuno sa di dover dare. L'avviso
            // c'è, il suo recapito no: è una scrittura persa, non un dettaglio saltato.
            logEvento('notifica', 'error', {
                operazione: 'avvisi:POST',
                esito: 'notifica-genitori-non-accodata',
            }, e);
        }

        // IL SUCCESSO SI LOGGA, COL NUMERO DI FAMIGLIE RAGGIUNTE (AGENTS, regola 5).
        // Prima questa route rispondeva 201 e non lasciava NIENTE: né l'esito, né la
        // sede, né quante famiglie avesse davvero avvisato. Con i soli errori, «nessun
        // log» non distingue «tutto ok» da «non è partito niente» — ed è la condizione
        // in cui il sistema si trova adesso, perché in produzione ci sono alunni senza
        // alcun tutore collegato: un avviso di classe raggiunge meno famiglie di quante
        // ce ne siano, e nessuno può accorgersene. `n_destinatari: 0` è il dato che
        // rende visibile quel caso; solo conteggi, uuid e chiavi in lista bianca.
        //
        // I TRE CAMPI NUOVI sono solo booleani e numeri, che `redact` lascia
        // passare PER FORMA senza bisogno di allargare nessuna lista bianca — e
        // rispondono alle tre domande che la segreteria farà davvero quando un
        // avviso «non si comporta come previsto»: chiedeva il numero? aveva un
        // tetto? aveva un termine per aderire diverso dalla scadenza? Nessun
        // testo, nessuna etichetta: sono dati che l'operatore ha scritto a mano.
        logEvento('avvisi', 'info', {
            operazione: 'avvisi:POST',
            esito: 'pubblicato',
            sede_id: scuolaId,
            tipo: tipoNotifica,
            n_destinatari: nDestinatari,
            n_classi: classiTarget.length,
            con_numero: conNumero,
            posti_totali: posti_totali ?? null,
            ha_scadenza_adesione: scad.scadenzaAdesione !== null,
        });

        return NextResponse.json(data, { status: 201 });
    } catch (error) {
        logErrore({ operazione: 'avvisi:POST', stato: 500 }, error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
});
