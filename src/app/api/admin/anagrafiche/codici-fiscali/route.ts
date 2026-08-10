import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireStaff } from '@/lib/auth/require-staff';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { rifiutoSede } from '@/lib/auth/rifiuto-sede';
import { parseQuery } from '@/lib/validation/http';
import { zUuid, zPaginazione } from '@/lib/validation/common';
import { HEADER_TOTALE } from '@/lib/api/paginazione';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore, logEvento } from '@/lib/logging/logger';
import { selectResiliente } from '@/lib/supabase/select-resiliente';
import {
    verificaCoerenza,
    type CampoNonVerificabile,
    type MotivoIncoerenza,
} from '@/lib/fiscale/coerenza';
import { calcolaCodiceFiscale, normalizzaCodiceBelfiore } from '@/lib/fiscale/calcolo';
import { risolviComune } from '@/lib/fiscale/comuni';

// =============================================================================
// GET /api/admin/anagrafiche/codici-fiscali — «Codici fiscali da verificare».
//
// Elenca alunni e genitori il cui codice fiscale NON coincide con l'anagrafica,
// dice PERCHÉ, e propone il codice corretto quando lo può calcolare.
//
// ⚠️ TRE STATI, NON DUE — ed è l'unica decisione di questo file che, sbagliata,
// lo renderebbe inutile il primo giorno. Misurato in produzione il 2026-08-10:
// 18 alunni su 33 e 27 genitori su 50 NON hanno il codice fiscale, e lo stesso
// numero non ha il comune di nascita; 17 alunni non hanno il sesso registrato.
// Se «manca» venisse trattato come «sbagliato», questo pannello aprirebbe con 45
// record su 83 in rosso per un dato che nessuno ha mai inserito — e un pannello
// che segnala tutto non segnala niente: si impara a ignorarlo in una settimana, e
// da quel momento non segnala nemmeno le cose vere. Perciò:
//   · `incoerente`      — c'è un codice e non torna. È il rosso, ed è azionabile.
//   · `non-verificabile`— c'è un codice ma mancano i dati per confrontarlo.
//   · `da-compilare`    — il codice non c'è proprio. Neutro, non un errore.
// La distinzione la fa già `verificaCoerenza` (`motivi` vs `nonVerificabili`):
// qui ci si appoggia a quella, non la si riscrive.
//
// ⚠️ LA VERIFICA GIRA IN NODE, NON IN SQL. `verificaCoerenza` è pura e testata;
// riscriverla in PL/pgSQL sarebbe la seconda copia della stessa regola, e questo
// repo quella lezione l'ha già pagata. La conseguenza va detta invece che
// nascosta: il predicato «incoerente» non è indicizzabile, quindi la paginazione
// è IN MEMORIA e la scansione ha un tetto dichiarato (`LIMITE_SCANSIONE`). Un
// elenco troncato non dà errore — dà meno righe, ed è il modo più silenzioso di
// mentire: quando il tetto morde, si logga.
// =============================================================================

/**
 * Il nome della rotta, in un posto solo — e scritto PER ESTESO anche dentro
 * `withRoute` più sotto: il lock `logging-coverage` legge il letterale, non la
 * costante, perché è quello che finisce nella colonna `operazione` di `app_log`
 * e un nome copiato da un'altra route produce una colonna che MENTE.
 */
const OPERAZIONE = 'admin/anagrafiche/codici-fiscali:GET';

/**
 * 500 — l'anagrafica non si è potuta leggere, quindi non si è potuto verificare
 * niente. Il `message` di PostgREST NON esce di qui: è prosa inglese con dentro
 * nomi di colonne, e resta nel log — che è dove dice *perché*.
 */
const CODICE_LETTURA_FALLITA = 'VERIFICA_CODICI_FISCALI_NON_RIUSCITA';

/**
 * Quante righe si leggono per costruire il pannello.
 *
 * Al 2026-08-10 in produzione ci sono 33 alunni e 50 genitori: il limite è
 * LATENTE, non attivo. Esiste perché il filtro «incoerente» non si può spingere
 * nel database (vedi in testa al file) e senza un limite una scuola da diecimila
 * righe ne farebbe scaricare diecimila a ogni apertura della pagina.
 *
 * ⚠️ È un CONTEGGIO di righe, non dei millisecondi: per questo non si chiama
 * `TETTO_…`. `__tests__/lib/logging-tetto.test.ts` inventaria per NOME ogni
 * costante che dica «tetto», «timeout», «scadenza» o «attesa», e ci finiva dentro
 * come se fosse un budget di tempo — costringendo a un'eccezione in quel lock per
 * una cosa che non c'entra. Il nome giusto costa meno di un condono.
 */
const LIMITE_SCANSIONE = 2000;

/**
 * QUANTI UUID ENTRANO IN UNA SOLA `.in(...)`.
 *
 * PostgREST riceve i filtri nella QUERY STRING di una GET: 2000 uuid diventano
 * `student_id=in.(…)` da circa 76 KB di URL, e nessun proxy davanti al database
 * accetta una riga di richiesta simile (il limite tipico è 8 KB). Senza lotti il
 * tetto vero di questo pannello non sarebbe `LIMITE_SCANSIONE`: sarebbe **~180
 * alunni in scope**, e oltre quella soglia la pagina risponderebbe 500 — cioè si
 * romperebbe esattamente dove il commento in testa al file promette di
 * DEGRADARE dando meno righe. Un tetto dichiarato a 2000 e vero a 180 è peggio
 * di nessun tetto: è un numero che qualcuno userà per decidere.
 *
 * 150 uuid ≈ 6 KB di URL: sta sotto la soglia con margine, e i lotti si sommano
 * (14 richieste al massimo per arrivare a `LIMITE_SCANSIONE`).
 *
 * ⚠️ Lo stesso difetto è ancora aperto in `admin/parents:GET`
 * (`src/app/api/admin/parents/route.ts`), e lì è PEGGIORE — non «la metà»:
 * quella route risale dagli alunni dei plessi ai loro genitori con tre `.in(…)`
 * in fila (`scuola_id`, poi `student_id`, poi `id`) e **non ha nessun tetto di
 * lettura**: né lotti, né `.limit(…)`, né `.range(…)`. Si verifica in due righe,
 * che non invecchiano come invecchierebbe un numero scritto qui:
 *
 *     grep -c '\.limit(\|\.range(' src/app/api/admin/parents/route.ts   # → 0
 *     grep -n  '\.in('            src/app/api/admin/parents/route.ts   # → i tre filtri
 *
 * Conseguenza: là il punto di rottura dell'URL **non ha soffitto sopra di sé**.
 * Qui `LIMITE_SCANSIONE` almeno garantisce che gli uuid da impacchettare siano
 * un numero noto, e quando morde la risposta lo DICHIARA (`troncato`); là non
 * c'è niente da dichiarare perché non c'è niente che tagli, e il giorno in cui
 * i legami in scope superano il migliaio la route smette di rispondere invece di
 * rispondere meno. Non si tocca perché è un'altra corsia e la conversione va
 * fatta col suo collaudo accanto.
 *
 * ⚠️ Questo capoverso, nella sua prima stesura, attribuiva a quel file «un tetto
 * 1000». Non è mai esistito: `1000` non compare in quel file, né nell'albero di
 * lavoro né a `HEAD`. Era un inventario inventato scritto due schermate sotto la
 * riparazione che di quella stessa classe d'errore si vantava — cioè esattamente
 * ciò che CLAUDE.md chiama «un commento che descrive una protezione che il codice
 * non ha», e che è peggio di nessun commento perché SOTTOSTIMAVA il rischio.
 */
const UUID_PER_LOTTO = 150;

/** Gli elementi a gruppi di `dimensione`, nell'ordine dato. Elenco vuoto ⇒ nessun lotto. */
function aLotti<T>(elementi: readonly T[], dimensione: number): T[][] {
    const lotti: T[][] = [];
    for (let i = 0; i < elementi.length; i += dimensione) lotti.push(elementi.slice(i, i + dimensione));
    return lotti;
}

/**
 * LE COLONNE, e nient'altro. Da qui esce l'anagrafica identificativa di minori:
 * si legge ciò che serve a confrontare un codice fiscale e a dire di chi è —
 * niente note mediche, niente allergie, niente documenti, niente residenza.
 */
const COLONNE_ALUNNI = [
    'id', 'scuola_id', 'nome', 'cognome', 'gender', 'data_nascita',
    'codice_fiscale', 'birth_city', 'birth_province', 'codice_belfiore_nascita',
];

const COLONNE_GENITORI = [
    'id', 'first_name', 'last_name', 'gender', 'birth_date',
    'fiscal_code', 'birth_city', 'birth_province', 'codice_belfiore_nascita',
];

const getQuerySchema = z.object({
    tipo: z.enum(['tutti', 'alunni', 'genitori']).default('tutti'),
    stato: z.enum(['tutti', 'incoerente', 'non-verificabile', 'da-compilare']).default('tutti'),
    /** Restringe a UNA sede, sempre in AND con lo scope: mai al posto suo. */
    scuola_id: zUuid.optional(),
    ...zPaginazione.shape,
});

type Stato = 'incoerente' | 'non-verificabile' | 'da-compilare';
type EsitoLuogo = 'belfiore' | 'risolto' | 'ambiguo' | 'sconosciuto' | 'assente';

interface Candidato {
    belfiore: string;
    nome: string;
    sigla: string;
}

interface RigaVerifica {
    tipo: 'alunno' | 'genitore';
    id: string;
    nome: string | null;
    cognome: string | null;
    /** Per un alunno la sua sede; per un genitore le sedi dei suoi FIGLI. */
    scuole_ids: string[];
    stato: Stato;
    codice_attuale: string | null;
    motivi: MotivoIncoerenza[];
    non_verificabili: CampoNonVerificabile[];
    /** Il codice catastale DETERMINATO, da colonna o da risoluzione esatta del comune. */
    codice_belfiore: string | null;
    luogo_esito: EsitoLuogo;
    /** Valorizzato solo quando `luogo_esito` è `ambiguo`: la scelta spetta a chi ha il certificato. */
    luogo_candidati: Candidato[];
    codice_proposto: string | null;
    /** Perché la proposta non c'è: il luogo di nascita, oppure il resto dell'anagrafica. */
    proposta_bloccata_da: 'luogo' | 'anagrafica' | null;
    /** La proposta coincide col codice registrato: resta solo da completare l'anagrafica. */
    proposta_combacia: boolean;
    /** 0 = si chiude in un gesto · 1 = prima si corregge il luogo · 2 = manca altro. */
    priorita: 0 | 1 | 2;
}

/** Riga grezza di `alunni`/`parents`, con i nomi di colonna già uniformati. */
interface Persona {
    tipo: 'alunno' | 'genitore';
    id: string;
    nome: string | null;
    cognome: string | null;
    sesso: string | null;
    dataNascita: string | null;
    codiceFiscale: unknown;
    comune: string | null;
    provincia: string | null;
    belfioreColonna: unknown;
    scuoleIds: string[];
}

const testo = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t === '' ? null : t;
};

/**
 * IL CODICE CATASTALE, E MAI UN'IPOTESI.
 *
 * Due sole sorgenti, in quest'ordine: la colonna `codice_belfiore_nascita` — che
 * qualcuno ha scelto da una tendina, quindi è esatta per costruzione — e la
 * risoluzione del comune scritto a mano, ma SOLO con esito `trovato`. «Calliano»
 * esiste ad Asti e a Trento con due Belfiore diversi: sceglierne uno vorrebbe
 * dire proporre a una segretaria il codice fiscale di un bambino con dentro un
 * comune di nascita sbagliato, e nessun errore che si accenda da nessuna parte.
 */
function determinaLuogo(persona: Persona): {
    belfiore: string | null;
    esito: EsitoLuogo;
    candidati: Candidato[];
} {
    const daColonna = normalizzaCodiceBelfiore(persona.belfioreColonna);
    if (daColonna !== null) return { belfiore: daColonna, esito: 'belfiore', candidati: [] };

    if (persona.comune === null) return { belfiore: null, esito: 'assente', candidati: [] };

    const risolto = risolviComune(persona.comune, persona.provincia);
    if (risolto.esito === 'trovato') {
        return { belfiore: risolto.comune.belfiore, esito: 'risolto', candidati: [] };
    }
    if (risolto.esito === 'ambiguo') {
        return {
            belfiore: null,
            esito: 'ambiguo',
            candidati: risolto.candidati.map((c) => ({ belfiore: c.belfiore, nome: c.nome, sigla: c.sigla })),
        };
    }
    return { belfiore: null, esito: 'sconosciuto', candidati: [] };
}

/**
 * Il verdetto su una persona, o `null` quando non c'è niente da segnalare.
 *
 * ⚠️ Il Belfiore che si passa a `verificaCoerenza` è SOLO quello della COLONNA,
 * mai quello risolto dal testo libero. Non è una svista: un comune fuso o
 * rinominato ha nel codice fiscale il Belfiore VECCHIO mentre `birth_city` porta
 * il nome nuovo, e confrontarli produrrebbe un rosso su un codice giusto. Il
 * testo libero basta a PROPORRE — che è un suggerimento su cui un operatore
 * decide — non ad ACCUSARE.
 *
 * ⚠️ E FINO AL 2026-08-10 QUESTA REGOLA ERA SOLO UN COMMENTO: sostituendo la
 * riga qui sotto con `determinaLuogo(persona).belfiore` la suite restava tutta
 * verde. Ora la tiene ferma `__tests__/api/admin-codici-fiscali.test.ts`
 * («si ACCUSA solo col Belfiore della colonna»), con una bambina nata a Rossano
 * — comune soppresso nel 2018 — la cui `birth_city` dice «Corigliano-Rossano»:
 * col Belfiore indovinato quella riga esce `incoerente` su un codice GIUSTO.
 * Il caso non è di laboratorio: la migrazione che crea
 * `codice_belfiore_nascita` dichiara di non fare backfill, quindi in produzione
 * la colonna è NULL su ogni riga e questo è l'unico ramo che gira sui dati veri.
 */
function valuta(persona: Persona): RigaVerifica | null {
    const esito = verificaCoerenza(persona.codiceFiscale, {
        nome: persona.nome,
        cognome: persona.cognome,
        sesso: persona.sesso,
        dataNascita: persona.dataNascita,
        codiceBelfiore: normalizzaCodiceBelfiore(persona.belfioreColonna),
    });

    const codiceAttuale = esito.codiceEsaminato === '' ? null : esito.codiceEsaminato;
    const stato: Stato = codiceAttuale === null
        ? 'da-compilare'
        : esito.coerente
            ? 'non-verificabile'
            : 'incoerente';

    // Il codice c'è, torna, e si è potuto confrontare per intero: non c'è niente
    // da fare su questa riga, e una riga senza niente da fare in un pannello di
    // cose da fare è solo rumore.
    if (stato === 'non-verificabile' && esito.nonVerificabili.length === 0) return null;

    const luogo = determinaLuogo(persona);
    const proposta = luogo.belfiore === null
        ? null
        : calcolaCodiceFiscale({
            cognome: persona.cognome ?? '',
            nome: persona.nome ?? '',
            // `calcolaCodiceFiscale` rifiuta da sé un sesso che non sia M/F.
            sesso: (persona.sesso ?? '').trim().toUpperCase() as 'M' | 'F',
            dataNascita: persona.dataNascita ?? '',
            codiceBelfiore: luogo.belfiore,
        });
    const codiceProposto = proposta?.ok ? proposta.codice : null;

    const bloccataDa = codiceProposto !== null ? null : luogo.belfiore === null ? 'luogo' : 'anagrafica';

    // ORDINE PER AZIONABILITÀ: chi apre il pannello deve trovare in cima ciò che
    // può chiudere subito. Prima le righe con un codice proposto (un gesto), poi
    // quelle che chiedono di sistemare il luogo di nascita, poi il resto.
    //
    // ⚠️ LA PRIORITÀ 0 CONTIENE DUE GESTI OPPOSTI, ED È UNA SCELTA, non una svista.
    // Ci finisce anche la riga che non ha NIENTE di sbagliato: codice fiscale
    // corretto, colonna `codice_belfiore_nascita` vuota, comune scritto a mano che
    // si risolve — e quindi una proposta che COMBACIA col codice registrato. È la
    // forma più comune che esista in produzione (la colonna è NULL su tutte e 83
    // le righe vere), e sta in cima perché è il lavoro più veloce del pannello:
    // la proposta conferma il codice, quindi si sceglie il comune dalla tendina e
    // la riga sparisce per sempre — un gesto, senza decidere niente.
    // Ciò che NON deve succedere è confonderla con un incoerente, dove lo stesso
    // «un gesto» riscriverebbe il codice fiscale di un bambino. A separarli è
    // `proposta_combacia`: `true` = conferma il luogo, `false` = correggi il
    // codice. Chi disegna la UI di questo blocco parta da quel campo, non dalla
    // priorità — e chi lo tocca sappia che è l'unica cosa che li distingue.
    const priorita: 0 | 1 | 2 = codiceProposto !== null ? 0 : bloccataDa === 'luogo' ? 1 : 2;

    return {
        tipo: persona.tipo,
        id: persona.id,
        nome: persona.nome,
        cognome: persona.cognome,
        scuole_ids: persona.scuoleIds,
        stato,
        codice_attuale: codiceAttuale,
        motivi: esito.motivi,
        non_verificabili: esito.nonVerificabili,
        codice_belfiore: luogo.belfiore,
        luogo_esito: luogo.esito,
        luogo_candidati: luogo.candidati,
        codice_proposto: codiceProposto,
        proposta_bloccata_da: bloccataDa,
        proposta_combacia: codiceProposto !== null && codiceProposto === codiceAttuale,
        priorita,
    };
}

/** Ordinamento stabile: priorità, poi cognome/nome, poi id — uguale su ogni macchina. */
function confronta(a: RigaVerifica, b: RigaVerifica): number {
    if (a.priorita !== b.priorita) return a.priorita - b.priorita;
    const cognomi = (a.cognome ?? '').localeCompare(b.cognome ?? '', 'it');
    if (cognomi !== 0) return cognomi;
    const nomi = (a.nome ?? '').localeCompare(b.nome ?? '', 'it');
    if (nomi !== 0) return nomi;
    return a.id.localeCompare(b.id);
}

export const GET = withRoute('admin/anagrafiche/codici-fiscali:GET', async (request: NextRequest) => {
    const auth = await requireStaff(request);
    if (auth.response) return auth.response;

    const q = parseQuery(request, getQuerySchema);
    if ('response' in q) return q.response;
    const { tipo, stato: statoChiesto, scuola_id: sedeChiesta, limit, offset } = q.data;

    try {
        const supabase = await createAdminClient();
        const plessi = await resolveScuoleAttive(request, supabase, auth.user);

        // Scope VUOTO ⇒ si NEGA. Mai «non so quali sedi ha, allora nessun filtro»:
        // il caso in cui l'utente ha meno diritti sarebbe quello in cui vede di più.
        if (plessi.length === 0) {
            logEvento('anagrafica', 'warn', {
                operazione: OPERAZIONE, esito: 'scope-vuoto', utente: auth.user.id, ruolo: auth.user.role,
            });
            return rifiutoSede('SEDE_NON_ACCESSIBILE');
        }

        // ─── Alunni in scope ─────────────────────────────────────────────────
        // Il filtro di sede sta NELLA STESSA QUERY: è l'unico posto in cui l'AND
        // lo rende vero. Questa lettura serve a due cose — l'elenco degli alunni
        // e la risalita ai genitori — e il tetto vale quindi per entrambe: è
        // detto qui perché la riga `troncato` della risposta non menta.
        const alunni = await selectResiliente(
            COLONNE_ALUNNI,
            (cols) => {
                let query = supabase
                    .from('alunni')
                    .select(cols.join(', '), { count: 'exact' })
                    .in('scuola_id', plessi)
                    .order('cognome', { ascending: true })
                    .limit(LIMITE_SCANSIONE);
                if (sedeChiesta) query = query.eq('scuola_id', sedeChiesta);
                return query;
            },
            OPERAZIONE,
            { livello: 'warn' },
        );
        if (alunni.error) {
            logErrore(
                { operazione: OPERAZIONE, stato: 500, evento: 'anagrafica' },
                new Error('lettura alunni fallita', { cause: alunni.error }),
            );
            return NextResponse.json(
                { error: 'Non è stato possibile leggere l’anagrafica per verificare i codici fiscali.', codice: CODICE_LETTURA_FALLITA },
                { status: 500 },
            );
        }
        const righeAlunni = (alunni.data ?? []) as unknown as Record<string, unknown>[];
        const totaleAlunni = typeof alunni.count === 'number' ? alunni.count : righeAlunni.length;

        const persone: Persona[] = [];
        if (tipo !== 'genitori') {
            for (const riga of righeAlunni) {
                persone.push({
                    tipo: 'alunno',
                    id: String(riga.id),
                    nome: testo(riga.nome),
                    cognome: testo(riga.cognome),
                    sesso: testo(riga.gender),
                    dataNascita: testo(riga.data_nascita),
                    codiceFiscale: riga.codice_fiscale,
                    comune: testo(riga.birth_city),
                    provincia: testo(riga.birth_province),
                    belfioreColonna: riga.codice_belfiore_nascita,
                    scuoleIds: testo(riga.scuola_id) === null ? [] : [String(riga.scuola_id)],
                });
            }
        }

        // ─── Genitori: lo scope passa dal LEGAME, non da una colonna ─────────
        // `parents` NON ha `scuola_id` e non deve averlo: un genitore può avere
        // figli in due plessi. Si parte dagli alunni già ristretti alla sede e si
        // risale — stesso pattern di `admin/parents:GET`.
        let totaleLegami = 0;
        let letteLegami = 0;
        if (tipo !== 'alunni' && righeAlunni.length > 0) {
            const sedePerAlunno = new Map<string, string | null>(
                righeAlunni.map((a) => [String(a.id), testo(a.scuola_id)]),
            );
            // Il filtro `student_id IN (…)` viaggia nell'URL: a lotti, non tutto
            // in una volta (vedi `UUID_PER_LOTTO`). Il conteggio esatto si somma
            // lotto per lotto, così `troncato` resta vero anche a lotti.
            const righeLegami: Record<string, unknown>[] = [];
            for (const lotto of aLotti([...sedePerAlunno.keys()], UUID_PER_LOTTO)) {
                const spazio = LIMITE_SCANSIONE - righeLegami.length;
                const { data: legami, error: erroreLegami, count: contaLegami } = await supabase
                    .from('student_parents')
                    .select('parent_id, student_id', { count: 'exact' })
                    .in('student_id', lotto)
                    // Anche a spazio esaurito il giro si fa: serve il `count`, che
                    // è ciò che rende dichiarabile il troncamento invece che muto.
                    .limit(Math.max(spazio, 1));
                if (erroreLegami) {
                    logErrore(
                        { operazione: OPERAZIONE, stato: 500, evento: 'anagrafica' },
                        new Error('lettura legami fallita', { cause: erroreLegami }),
                    );
                    return NextResponse.json(
                        { error: 'Non è stato possibile leggere l’anagrafica per verificare i codici fiscali.', codice: CODICE_LETTURA_FALLITA },
                        { status: 500 },
                    );
                }
                const lette = (legami ?? []) as unknown as Record<string, unknown>[];
                totaleLegami += typeof contaLegami === 'number' ? contaLegami : lette.length;
                if (spazio > 0) righeLegami.push(...lette.slice(0, spazio));
            }
            letteLegami = righeLegami.length;

            const sediPerGenitore = new Map<string, Set<string>>();
            for (const legame of righeLegami) {
                const sede = sedePerAlunno.get(String(legame.student_id));
                if (!sede) continue;
                const chiave = String(legame.parent_id);
                const insieme = sediPerGenitore.get(chiave) ?? new Set<string>();
                insieme.add(sede);
                sediPerGenitore.set(chiave, insieme);
            }

            // Anche qui a lotti: `idGenitori` può arrivare a `LIMITE_SCANSIONE`,
            // e `id IN (…)` è lo stesso URL della query dei legami.
            for (const lotto of aLotti([...sediPerGenitore.keys()], UUID_PER_LOTTO)) {
                const genitori = await selectResiliente(
                    COLONNE_GENITORI,
                    (cols) => supabase.from('parents').select(cols.join(', ')).in('id', lotto).limit(LIMITE_SCANSIONE),
                    OPERAZIONE,
                    { livello: 'warn' },
                );
                if (genitori.error) {
                    logErrore(
                        { operazione: OPERAZIONE, stato: 500, evento: 'anagrafica' },
                        new Error('lettura genitori fallita', { cause: genitori.error }),
                    );
                    return NextResponse.json(
                        { error: 'Non è stato possibile leggere l’anagrafica per verificare i codici fiscali.', codice: CODICE_LETTURA_FALLITA },
                        { status: 500 },
                    );
                }
                for (const riga of (genitori.data ?? []) as unknown as Record<string, unknown>[]) {
                    persone.push({
                        tipo: 'genitore',
                        id: String(riga.id),
                        nome: testo(riga.first_name),
                        cognome: testo(riga.last_name),
                        sesso: testo(riga.gender),
                        dataNascita: testo(riga.birth_date),
                        codiceFiscale: riga.fiscal_code,
                        comune: testo(riga.birth_city),
                        provincia: testo(riga.birth_province),
                        belfioreColonna: riga.codice_belfiore_nascita,
                        scuoleIds: [...(sediPerGenitore.get(String(riga.id)) ?? [])],
                    });
                }
            }
        }

        // ─── La verifica, in memoria, riga per riga ──────────────────────────
        const tutte: RigaVerifica[] = [];
        for (const persona of persone) {
            const riga = valuta(persona);
            if (riga === null) continue;
            if (statoChiesto !== 'tutti' && riga.stato !== statoChiesto) continue;
            tutte.push(riga);
        }
        tutte.sort(confronta);

        // ─── Il troncamento non deve poter passare inosservato ───────────────
        // Il tetto morde quando le righe LETTE sono esattamente il tetto e il
        // conteggio esatto dice che ce n'erano di più. Un elenco tagliato non
        // produce nessun errore: produce meno bambini in una lista, e nessuno che
        // se ne accorga. Nel log solo numeri.
        //
        // I DUE RAMI SI MISURANO CON LA STESSA FORMULA, e non è pedanteria: due
        // condizioni diverse per la stessa nozione sono due nozioni, e fra sei
        // mesi nessuno saprà più quale delle due è «troncato». Prima qui c'era
        // `totaleLegami > LIMITE_SCANSIONE` — equivalente finché la lettura è una
        // sola, falso da quando i legami si leggono a lotti.
        const troncatoAlunni = righeAlunni.length >= LIMITE_SCANSIONE && totaleAlunni > righeAlunni.length;
        const troncatoLegami = letteLegami >= LIMITE_SCANSIONE && totaleLegami > letteLegami;
        const troncato = troncatoAlunni || troncatoLegami;
        if (troncato) {
            // I due rami hanno DUE coppie di numeri, non un massimo: con un solo
            // `totale` la riga di log non dice quale delle due letture è stata
            // tagliata, e sono due interventi diversi. Sono numeri, quindi
            // passano la redazione a lista bianca senza deroghe.
            logEvento('anagrafica', 'warn', {
                operazione: OPERAZIONE,
                esito: 'scansione-troncata',
                limite: LIMITE_SCANSIONE,
                alunni_totale: totaleAlunni,
                alunni_letti: righeAlunni.length,
                legami_totale: totaleLegami,
                legami_letti: letteLegami,
            });
        }

        const pagina = tutte.slice(offset, offset + limit);

        // Il SUCCESSO si logga: con i soli errori, «nessun log» non distingue
        // «tutto bene» da «non è mai partito niente». Solo conteggi, booleani e
        // un uuid di sede — mai un codice fiscale, mai un nome, mai un comune.
        //
        // Limite DICHIARATO invece che sottinteso: l'evento `anagrafica` è fra le
        // deroghe di `eventi-log.test.ts`, quindi questa riga a livello `info`
        // vive sui Runtime Logs di Vercel e NON arriva in `app_log`. Le due righe
        // che devono sopravvivere al deploy — il troncamento della scansione e il
        // guasto di lettura — sono `warn` e `error`, e quelle si persistono per
        // livello.
        logEvento('anagrafica', 'info', {
            operazione: OPERAZIONE,
            esito: 'ok',
            totale: tutte.length,
            rese: pagina.length,
            scansionati: persone.length,
            troncato,
            sedi: plessi.length,
            sede_id: sedeChiesta ?? (plessi.length === 1 ? plessi[0] : null),
        });

        return NextResponse.json(
            { righe: pagina, totale: tutte.length, scansionati: persone.length, troncato },
            { headers: { [HEADER_TOTALE]: String(tutte.length) } },
        );
    } catch (err) {
        logErrore({ operazione: OPERAZIONE, stato: 500 }, err);
        return NextResponse.json(
            { error: 'Non è stato possibile leggere l’anagrafica per verificare i codici fiscali.', codice: CODICE_LETTURA_FALLITA },
            { status: 500 },
        );
    }
});
