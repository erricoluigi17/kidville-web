import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppRole, AppUser } from '@/lib/auth/predicati-ruolo';
import { vedeTutteLeClassi, scuoleDiUtente } from '@/lib/auth/scope';
import { sezioniDiUtente } from '@/lib/sezioni/docenti';
import {
    getFigliDiGenitoreEsito,
    getGenitoriDiAlunni,
    verificaLegameGenitore,
    type EsitoLegame,
} from '@/lib/anagrafiche/legami';
import { STATI_CON_CANALE_FAMIGLIA } from '@/lib/alunni/stato';
import { figliAttiviDi, idDeiFigli } from '@/lib/anno/visibilita-genitore';
import { logEvento } from '@/lib/logging/logger';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * CON CHI SI PUÒ APRIRE UNA CHAT — la regola, in un posto solo
 * ════════════════════════════════════════════════════════════════════════════
 *
 * «Un genitore deve poter contattare solo le proprie insegnanti, così come le
 * insegnanti possono contattare solo i propri genitori: quando clicchi su nuova
 * chat, non devono proprio comparire le altre persone.»
 *
 * ─── PERCHÉ ESISTE QUESTO FILE ───────────────────────────────────────────────
 *
 * Perché quella domanda viveva in TRE posti che non davano la stessa risposta —
 * la rubrica del genitore, la rubrica della maestra, e il gate che apre il
 * thread — e ognuno dei tre aveva una falla sua. Misurato in produzione il
 * 2026-09-07, su 706 genitori e 273 conversazioni:
 *
 *  · **150 genitori** vedevano, fra le «proprie insegnanti», una persona che
 *    insegnante non è: in `utenti_sezioni` ci sono 6 righe di `segreteria` e 1 di
 *    `admin` — assegnazioni operative legittime — e la rubrica non guardava il
 *    ruolo. Comparivano etichettate `user_role: 'maestra'`.
 *  · **32 genitori** vedevano almeno un docente CESSATO (`attivo = false`): 8
 *    righe di `utenti_sezioni` appartengono a educator disattivati.
 *  · **9 genitori** ricadevano in un fallback che, quando un figlio non aveva
 *    sezione, restituiva **tutti i 63 docenti di 5 sedi** — Demo ed E2E comprese,
 *    9 dei quali disattivati.
 *  · **12 docenti su 60** vedevano i genitori di UNA sola delle proprie sezioni:
 *    `.limit(1)` **senza `order`**, quindi nemmeno sempre la stessa.
 *  · il gate di scrittura (`chat/threads:POST`) controllava **solo la propria
 *    metà** del thread: che chi chiama sia partecipante e che il bambino sia suo.
 *    Dell'altra metà niente — bastava conoscere l'uuid di una qualunque
 *    insegnante, anche di un'altra sede, per aprirci sopra una conversazione.
 *    Di lì sono nati **32 thread fuori sezione**, che crescevano di circa uno al
 *    giorno.
 *
 * ─── DUE COSE CHE QUESTA REGOLA NON CONFONDE ────────────────────────────────
 *
 * 1. **`non-deciso` non è `no`.** Una lettura fallita non autorizza a negare: chi
 *    riceve `non-deciso` risponde **500**, mai 403. È la stessa distinzione che
 *    `verificaLegameGenitore` fa da sempre, e la ragione è che negare su un
 *    guasto significa dire a una famiglia «questa non è la tua insegnante»
 *    perché una query è andata storta.
 * 2. **Lo stato dell'alunno è una LISTA BIANCA** (`STATI_CON_CANALE_FAMIGLIA`),
 *    non una lista nera. Uno stato sconosciuto chiude, non apre. È lo stesso
 *    predicato che il ramo docente usava già, e che il ramo genitore non aveva:
 *    **6 genitori di bambini ritirati** potevano ancora aprire una chat.
 *
 * ─── COSA QUESTA REGOLA NON FA ──────────────────────────────────────────────
 *
 * Non tocca i thread GIÀ APERTI, i 32 fuori sezione compresi: vale su chi si può
 * *iniziare* a contattare. Tutti e 273 hanno il legame genitore↔alunno valido —
 * sono adulti legittimi che parlano con un docente della scuola giusta, sulla
 * sezione sbagliata. Chiudere d'ufficio una conversazione in corso fra una
 * famiglia e un'insegnante è un danno certo per riparare un rischio che non si è
 * materializzato; se un giorno la si vorrà, è una decisione della Direzione su
 * casi nominati, non un effetto collaterale di un rilascio.
 *
 * ─── L'ANNO SCOLASTICO (PR 4.4) ──────────────────────────────────────────────
 *
 * Dove c'è lo schema dell'anno, il figlio e la sua sezione li dice `figli_attivi`, tanto nella vetrina quanto al gate: un figlio
 * non attivo non apre conversazioni, e la sezione è quella della frequenza. Schema indietro: `alunni.section_id`, come prima.
 * Un guasto della funzione è `non-deciso`.
 */

export type MotivoAbbinamento =
    | 'consentito'
    /** Il genitore non risulta legato a quel bambino. */
    | 'legame-famiglia-assente'
    /** Il bambino non è più raggiungibile dalla famiglia (ritirato, stato ignoto). */
    | 'alunno-senza-canale'
    /** Il bambino non ha una sezione: non esiste «la sua maestra» da indovinare. */
    | 'alunno-senza-sezione'
    /** Educator, ma non di QUELLA sezione. */
    | 'operatore-fuori-sezione'
    /** Staff di direzione, ma il bambino è di un altro plesso. */
    | 'operatore-fuori-sede'
    /** `utenti.attivo === false`: non lavora più qui. */
    | 'operatore-non-attivo'
    /** Né insegnante né staff di direzione (es. la cuoca). */
    | 'operatore-non-e-insegnante'
    /** Una lettura è fallita. **500, mai 403.** */
    | 'non-deciso';

export interface FattoAlunno {
    id: string;
    sectionId: string | null;
    scuolaId: string | null;
    stato: string | null;
    /**
     * Le sezioni delle frequenze attive, dove c'è lo schema dell'anno: un bambino vivo in due sedi ne ha due, e vuota vuol dire
     * senza sezione. `undefined` = schema indietro, e vale `sectionId`.
     */
    sezioniAttive?: readonly string[];
    /** `false` = la funzione non lo dà fra i figli attivi. `undefined` = schema indietro. */
    attivo?: boolean;
}

export interface FattoOperatore {
    id: string;
    ruolo: AppRole | null;
    /** `null` NON è `false`: la colonna è `boolean DEFAULT true` *nullable*. */
    attivo: boolean | null;
    sezioni: readonly string[];
    scuole: readonly string[];
}

export interface FattiAbbinamento {
    alunno: FattoAlunno | null;
    operatore: FattoOperatore | null;
    legame: EsitoLegame;
}

export interface EsitoAbbinamento {
    consentito: boolean;
    motivo: MotivoAbbinamento;
}

const no = (motivo: MotivoAbbinamento): EsitoAbbinamento => ({ consentito: false, motivo });

/**
 * LA REGOLA. Pura: zero I/O, zero mock, si prova con una tabella di casi.
 *
 * L'ordine dei controlli è una precedenza, non un caso: si guarda prima ciò che
 * riguarda la FAMIGLIA (il legame, il bambino) e poi ciò che riguarda
 * l'OPERATORE, perché il primo motivo è quello che si racconta all'utente e
 * «tuo figlio non ha ancora una sezione» è più utile di «quella persona non
 * insegna nella sua sezione».
 */
export function decidiAbbinamento(f: FattiAbbinamento): EsitoAbbinamento {
    if (f.legame === 'non-deciso') return no('non-deciso');
    if (f.legame !== 'si') return no('legame-famiglia-assente');
    if (!f.alunno) return no('non-deciso');

    if (!STATI_CON_CANALE_FAMIGLIA.includes(f.alunno.stato as never)) return no('alunno-senza-canale');
    if (f.alunno.attivo === false) return no('alunno-senza-canale');
    if (!f.operatore) return no('non-deciso');
    if (f.operatore.attivo === false) return no('operatore-non-attivo');

    if (f.operatore.ruolo === 'educator') {
        const sezioni = f.alunno.sezioniAttive ?? (f.alunno.sectionId ? [f.alunno.sectionId] : []);
        if (sezioni.length === 0) return no('alunno-senza-sezione');
        return sezioni.some((s) => f.operatore?.sezioni.includes(s))
            ? { consentito: true, motivo: 'consentito' }
            : no('operatore-fuori-sezione');
    }

    // Direzione e segreteria vedono tutte le classi del proprio plesso: per loro il
    // confine è la SEDE. È questo ramo che tiene in piedi i 35 thread già aperti in
    // cui `chat_threads.teacher_id` è un operatore di staff, e la rubrica di
    // `/admin/messaggi`, che è per sede da sempre.
    if (f.operatore.ruolo && vedeTutteLeClassi({ id: f.operatore.id, role: f.operatore.ruolo })) {
        if (!f.alunno.scuolaId) return no('non-deciso');
        return f.operatore.scuole.includes(f.alunno.scuolaId)
            ? { consentito: true, motivo: 'consentito' }
            : no('operatore-fuori-sede');
    }

    return no('operatore-non-e-insegnante');
}

/** I fatti, in blocco. Letture fisse, mai una per riga. */
export async function fattiAbbinamento(
    supabase: SupabaseClient,
    args: { operatoreId: string; genitoreId: string; alunnoId: string },
): Promise<FattiAbbinamento> {
    const [legame, alunnoRes, operatoreRes, attivi] = await Promise.all([
        verificaLegameGenitore(supabase, args.genitoreId, args.alunnoId),
        supabase.from('alunni').select('id, section_id, scuola_id, stato').eq('id', args.alunnoId).maybeSingle(),
        supabase.from('utenti').select('id, ruolo, attivo, scuola_id').eq('id', args.operatoreId).maybeSingle(),
        figliAttiviDi(supabase, args.genitoreId),
    ]);

    // La riga l'ha già scritta `figliAttiviDi`. Un guasto non nega e non apre: è `non-deciso`, 500.
    if (attivi.stato === 'guasto') return { alunno: null, operatore: null, legame: 'non-deciso' };
    const frequenze = attivi.stato === 'ok' ? attivi.righe.filter((r) => r.alunno_id === args.alunnoId) : null;

    // PostgREST non lancia (AGENTS.md, regola 7): senza questi due rami una lettura
    // negata dalla RLS o uno schema indietro uscirebbero come «il bambino non
    // esiste», cioè come un DINIEGO — e un diniego travestito da fatto è
    // esattamente ciò che questa regola distingue con `non-deciso`.
    if (alunnoRes.error) {
        logEvento('chat', 'error', { operazione: 'chat/rubrica:fatti', esito: 'alunno-non-letto', entita_id: args.alunnoId }, alunnoRes.error);
        return { alunno: null, operatore: null, legame: 'non-deciso' };
    }
    if (operatoreRes.error) {
        logEvento('chat', 'error', { operazione: 'chat/rubrica:fatti', esito: 'operatore-non-letto', utente: args.operatoreId }, operatoreRes.error);
        return { alunno: null, operatore: null, legame: 'non-deciso' };
    }

    const a = alunnoRes.data as { id: string; section_id: string | null; scuola_id: string | null; stato: string | null } | null;
    const u = operatoreRes.data as { id: string; ruolo: AppRole | null; attivo: boolean | null; scuola_id: string | null } | null;

    /**
     * ⚠️ SI LEGGE SOLO CIÒ CHE LA REGOLA GUARDERÀ, e non è micro-ottimizzazione.
     *
     * La prima versione chiedeva SEMPRE sia le sezioni sia le sedi. Ma
     * `decidiAbbinamento` è una biforcazione: per un `educator` legge le sezioni ed
     * esce prima di nominare le sedi; per lo staff fa l'opposto. Una delle due
     * letture era quindi sempre buttata via — un round trip in più su OGNI apertura
     * di conversazione, per sempre.
     *
     * Misurato dove si vede: la spec E2E della chat è passata da ~16 s a ~30 s — il
     * tetto per test di Playwright — quando questo gate è entrato in `chat/threads:POST`.
     */
    let sezioni: readonly string[] = [];
    let scuole: readonly string[] = [];
    if (u) {
        if (u.ruolo === 'educator') {
            sezioni = await sezioniDiUtente(supabase, u.id);
        } else if (u.ruolo && vedeTutteLeClassi({ id: u.id, role: u.ruolo })) {
            scuole = await scuoleDiUtente(supabase, { id: u.id, role: u.ruolo, scuola_id: u.scuola_id });
        }
        // Né docente né staff di direzione: la regola risponde
        // `operatore-non-e-insegnante` senza guardare né sezioni né sedi.
    }

    return {
        alunno: a
            ? {
                id: a.id,
                sectionId: a.section_id,
                scuolaId: a.scuola_id,
                stato: a.stato,
                ...(frequenze
                    ? {
                        attivo: frequenze.length > 0,
                        sezioniAttive: frequenze.map((r) => r.section_id).filter((s): s is string => !!s),
                    }
                    : {}),
            }
            : null,
        operatore: u ? { id: u.id, ruolo: u.ruolo, attivo: u.attivo, sezioni, scuole } : null,
        legame,
    };
}

/** IL GATE — la stessa regola della rubrica, applicata alla scrittura. */
export async function abbinamentoConsentito(
    supabase: SupabaseClient,
    args: { operatoreId: string; genitoreId: string; alunnoId: string },
): Promise<EsitoAbbinamento> {
    return decidiAbbinamento(await fattiAbbinamento(supabase, args));
}

// ─── LE RUBRICHE ────────────────────────────────────────────────────────────

export interface VoceRubrica {
    utenteId: string;
    ruolo: AppRole;
    alunno: {
        id: string;
        nome: string | null;
        cognome: string | null;
        classeSezione: string | null;
        scuolaId: string | null;
    };
}

export type MotivoRubricaVuota =
    /** Nessun bambino collegato a questo account. */
    | 'nessun-figlio'
    /** I figli ci sono, ma nessuno ha una classe assegnata. */
    | 'figli-senza-sezione'
    /** La classe c'è, ma non ha nessuna insegnante attiva assegnata. */
    | 'sezione-senza-docenti'
    /** Il docente non ha nessuna sezione in `utenti_sezioni`. */
    | 'nessuna-sezione-assegnata'
    /** Le sezioni ci sono, ma nessuna famiglia con un account. */
    | 'sezioni-senza-famiglie';

export interface EsitoRubrica {
    voci: VoceRubrica[];
    /**
     * Perché è vuota, quando lo è. Serve alla UI per NON dire «li hai già
     * contattati tutti» a chi non ha nessun contatto possibile — che dopo questa
     * stretta sarebbe una bugia detta con un'emoji a 23 famiglie.
     */
    motivoVuota: MotivoRubricaVuota | null;
    /** Una lettura è fallita: chi risponde a un client faccia 500, non «nessuno». */
    errore: { code?: string } | null;
}

const vuota = (motivoVuota: MotivoRubricaVuota | null, errore: { code?: string } | null = null): EsitoRubrica =>
    ({ voci: [], motivoVuota, errore });

/**
 * La rubrica di una FAMIGLIA: le insegnanti delle sezioni dei propri figli.
 *
 * Solo `ruolo = 'educator'` e solo attive. La segreteria assegnata a una sezione
 * — che in produzione capita, 6 righe — resta fuori: è la lettura letterale della
 * richiesta, e la segreteria continua a poter iniziare lei la conversazione da
 * `/admin/messaggi`, dove la sua rubrica è per sede e non cambia.
 */
export async function rubricaDiFamiglia(supabase: SupabaseClient, genitoreId: string): Promise<EsitoRubrica> {
    const attivi = await figliAttiviDi(supabase, genitoreId);
    if (attivi.stato === 'guasto') return vuota(null, attivi.errore);
    const frequenze = attivi.stato === 'ok' ? attivi.righe : null;
    const figli = frequenze ? idDeiFigli(frequenze) : (await getFigliDiGenitoreEsito(supabase, genitoreId)).figli;
    if (figli.length === 0) return vuota('nessun-figlio');

    const { data: righeAlunni, error: erroreAlunni } = await supabase
        .from('alunni')
        .select('id, nome, cognome, classe_sezione, section_id, scuola_id, stato')
        .in('id', figli)
        .in('stato', [...STATI_CON_CANALE_FAMIGLIA]);
    if (erroreAlunni) {
        logEvento('chat', 'error', { operazione: 'chat/rubrica:famiglia', esito: 'alunni-non-letti', utente: genitoreId }, erroreAlunni);
        return vuota(null, erroreAlunni);
    }
    const alunni = (righeAlunni ?? []) as Array<{
        id: string; nome: string | null; cognome: string | null;
        classe_sezione: string | null; section_id: string | null; scuola_id: string | null;
    }>;
    if (alunni.length === 0) return vuota('nessun-figlio');

    // Sezione e sede di ogni bambino: quelle delle frequenze, o quella in anagrafica con lo schema indietro.
    const postiDi = (a: (typeof alunni)[number]): Array<{ sezione: string; sede: string | null }> =>
        frequenze
            ? frequenze
                .filter((f) => f.alunno_id === a.id && f.section_id)
                .map((f) => ({ sezione: f.section_id as string, sede: f.scuola_id }))
            : a.section_id ? [{ sezione: a.section_id, sede: a.scuola_id }] : [];

    const sezioni = [...new Set(alunni.flatMap((a) => postiDi(a).map((p) => p.sezione)))];
    if (sezioni.length === 0) return vuota('figli-senza-sezione');

    const { data: legami, error: erroreLegami } = await supabase
        .from('utenti_sezioni')
        .select('section_id, utente_id')
        .in('section_id', sezioni);
    if (erroreLegami) {
        logEvento('chat', 'error', { operazione: 'chat/rubrica:famiglia', esito: 'legami-sezione-non-letti', utente: genitoreId }, erroreLegami);
        return vuota(null, erroreLegami);
    }

    const idDocenti = [...new Set((legami ?? []).map(r => r.utente_id as string))];
    if (idDocenti.length === 0) return vuota('sezione-senza-docenti');

    const { data: righeUtenti, error: erroreUtenti } = await supabase
        .from('utenti')
        .select('id, ruolo, attivo')
        .in('id', idDocenti);
    if (erroreUtenti) {
        logEvento('chat', 'error', { operazione: 'chat/rubrica:famiglia', esito: 'docenti-non-letti', utente: genitoreId }, erroreUtenti);
        return vuota(null, erroreUtenti);
    }

    // ⚠️ Il filtro di RUOLO e quello di ATTIVITÀ stanno QUI e non nella query: sono
    // la politica, non un dettaglio di lettura, e devono dire la stessa cosa che
    // dice `decidiAbbinamento` al gate di scrittura.
    const ammessi = new Map(
        ((righeUtenti ?? []) as Array<{ id: string; ruolo: AppRole | null; attivo: boolean | null }>)
            .filter(u => u.ruolo === 'educator' && u.attivo !== false)
            .map(u => [u.id, u.ruolo as AppRole]),
    );
    if (ammessi.size === 0) return vuota('sezione-senza-docenti');

    const perSezione = new Map<string, string[]>();
    for (const r of legami ?? []) {
        const id = r.utente_id as string;
        if (!ammessi.has(id)) continue;
        const s = r.section_id as string;
        perSezione.set(s, [...(perSezione.get(s) ?? []), id]);
    }

    const voci: VoceRubrica[] = [];
    const visti = new Set<string>();
    for (const a of alunni) {
        for (const { sezione, sede } of postiDi(a)) {
            for (const utenteId of perSezione.get(sezione) ?? []) {
                const chiave = `${utenteId}:${a.id}`;
                if (visti.has(chiave)) continue;
                visti.add(chiave);
                voci.push({
                    utenteId,
                    ruolo: ammessi.get(utenteId) as AppRole,
                    alunno: { id: a.id, nome: a.nome, cognome: a.cognome, classeSezione: a.classe_sezione, scuolaId: sede },
                });
            }
        }
    }
    return { voci, motivoVuota: voci.length === 0 ? 'sezione-senza-docenti' : null, errore: null };
}

/**
 * La rubrica di un'INSEGNANTE: le famiglie dei bambini delle proprie sezioni.
 *
 * ⚠️ Per `section_id`, e per **tutte** le sezioni. Prima era `.limit(1)` senza
 * `order` su `utenti_sezioni` e poi `.eq('classe_sezione', <nome>)`: 12 docenti su
 * 60 vedevano i genitori di una sola classe, e il filtro per NOME cadeva su una
 * sezione il cui testo diverge dal `sections.name` — 200 con un elenco vuoto,
 * senza una riga che lo dicesse.
 */
export async function rubricaDiOperatore(supabase: SupabaseClient, operatore: AppUser): Promise<EsitoRubrica> {
    const plessi = await scuoleDiUtente(supabase, operatore);
    const sezioni = await sezioniDiUtente(supabase, operatore.id);
    if (sezioni.length === 0) return vuota('nessuna-sezione-assegnata');

    const { data: righeAlunni, error: erroreAlunni } = await supabase
        .from('alunni')
        .select('id, nome, cognome, classe_sezione, section_id, scuola_id')
        .in('section_id', sezioni)
        .in('scuola_id', plessi)
        .in('stato', [...STATI_CON_CANALE_FAMIGLIA]);
    if (erroreAlunni) {
        logEvento('chat', 'error', { operazione: 'chat/rubrica:operatore', esito: 'alunni-non-letti', utente: operatore.id }, erroreAlunni);
        return vuota(null, erroreAlunni);
    }
    const alunni = (righeAlunni ?? []) as Array<{
        id: string; nome: string | null; cognome: string | null;
        classe_sezione: string | null; section_id: string | null; scuola_id: string | null;
    }>;
    if (alunni.length === 0) return vuota('sezioni-senza-famiglie');

    const genitoriPerAlunno = await getGenitoriDiAlunni(supabase, alunni.map(a => a.id));
    const idGenitori = [...new Set([...genitoriPerAlunno.values()].flat())];
    if (idGenitori.length === 0) return vuota('sezioni-senza-famiglie');

    const { data: righeUtenti, error: erroreUtenti } = await supabase
        .from('utenti')
        .select('id, ruolo')
        .in('id', idGenitori)
        .eq('ruolo', 'genitore');
    if (erroreUtenti) {
        logEvento('chat', 'error', { operazione: 'chat/rubrica:operatore', esito: 'genitori-non-letti', utente: operatore.id }, erroreUtenti);
        return vuota(null, erroreUtenti);
    }
    const conAccount = new Set(((righeUtenti ?? []) as Array<{ id: string }>).map(u => u.id));

    const voci: VoceRubrica[] = [];
    const visti = new Set<string>();
    for (const a of alunni) {
        for (const genitoreId of genitoriPerAlunno.get(a.id) ?? []) {
            if (!conAccount.has(genitoreId)) continue;
            const chiave = `${genitoreId}:${a.id}`;
            if (visti.has(chiave)) continue;
            visti.add(chiave);
            voci.push({
                utenteId: genitoreId,
                ruolo: 'genitore',
                alunno: { id: a.id, nome: a.nome, cognome: a.cognome, classeSezione: a.classe_sezione, scuolaId: a.scuola_id },
            });
        }
    }
    return { voci, motivoVuota: voci.length === 0 ? 'sezioni-senza-famiglie' : null, errore: null };
}
