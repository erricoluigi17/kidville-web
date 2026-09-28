import { z } from 'zod';

/**
 * LE ROUTINE DEL DIARIO, DECISE DALLA SEDE (2026-09-28).
 *
 * `admin_settings.diario_config` porta due cose, e questo modulo è l'unico posto che le legge:
 *
 *  · `routine_attive` — le routine BASE accese. Fino al 2026-09-28 il codice ne leggeva solo
 *    `umore`: spegnere «Pasto» dalle impostazioni non toglieva il pasto a nessuno. Da oggi ogni
 *    routine base accende o spegne i SUOI tipi di voce (`TIPI_DI_ROUTINE`).
 *  · `routine_personalizzate` — le routine che la segreteria aggiunge da sé (crema solare,
 *    biberon…), ognuna con il suo tipo di risposta. Il tipo di voce è `routine:<id>`.
 *
 * Il modulo è puro e condiviso: lo usano l'editor della maestra, la pagina del genitore, la card
 * della home, il pannello delle impostazioni e le rotte che scrivono. Una regola sola.
 */

// ─── Le routine base ─────────────────────────────────────────────────────────

export const ROUTINE_BASE = ['pasto', 'sonno', 'cambio', 'attivita', 'umore'] as const;
export type RoutineBase = (typeof ROUTINE_BASE)[number];

/** I tipi di voce base, nell'ordine in cui la maestra vede i bottoni (quello di sempre). */
export const TIPI_BASE = ['attivita', 'merenda', 'pranzo', 'nanna_inizio', 'nanna_fine', 'bagno', 'umore'] as const;
export type TipoBase = (typeof TIPI_BASE)[number];

/**
 * Quale routine accende ciascun tipo base. È la corrispondenza che il pannello ha sempre
 * promesso («Pasto», «Sonno», «Cambio») e che il codice non aveva mai scritto da nessuna parte.
 */
export const ROUTINE_DI_TIPO: Readonly<Record<TipoBase, RoutineBase>> = {
    attivita: 'attivita',
    merenda: 'pasto',
    pranzo: 'pasto',
    nanna_inizio: 'sonno',
    nanna_fine: 'sonno',
    bagno: 'cambio',
    umore: 'umore',
};

/**
 * Le routine di una sede che non ha mai scelto: quelle di sempre. L'umore resta fuori, come
 * prima (`umoreAttivo` lo considerava spento a configurazione assente).
 */
export const ROUTINE_PREDEFINITE: readonly RoutineBase[] = ['pasto', 'sonno', 'cambio', 'attivita'];

function eRoutineBase(v: unknown): v is RoutineBase {
    return typeof v === 'string' && (ROUTINE_BASE as readonly string[]).includes(v);
}

function eTipoBase(v: unknown): v is TipoBase {
    return typeof v === 'string' && (TIPI_BASE as readonly string[]).includes(v);
}

/**
 * Le routine base accese, da `diario_config.routine_attive` così com'è salvato.
 *
 *  · ASSENTE (o non una lista) → le routine predefinite. Una sede nuova nasce con
 *    `diario_config = {}`, e la GET di configurazione restituisce `null`: lì non si spegne niente.
 *  · LISTA VUOTA → tutto spento. È una scelta, e va rispettata.
 *  · Si accettano i NOMI delle routine (le sedi vere) e i CODICI dei tipi (il seed E2E scrive
 *    `pranzo`, `nanna_inizio`…): due vocabolari, un significato.
 */
export function routineBaseAttive(raw: unknown): Set<RoutineBase> {
    if (!Array.isArray(raw)) return new Set(ROUTINE_PREDEFINITE);
    const accese = new Set<RoutineBase>();
    for (const v of raw) {
        if (eRoutineBase(v)) accese.add(v);
        else if (eTipoBase(v)) accese.add(ROUTINE_DI_TIPO[v]);
    }
    return accese;
}

// ─── Le routine della scuola ─────────────────────────────────────────────────

export const RISPOSTE = ['spunta', 'scelta', 'orario', 'testo'] as const;
export type Risposta = (typeof RISPOSTE)[number];

/** Limiti: gemelli nel pannello, nella validazione del salvataggio e in quella della scrittura. */
export const MAX_ROUTINE_PERSONALIZZATE = 20;
export const MAX_OPZIONI = 10;
export const MAX_NOME = 40;
export const MAX_OPZIONE = 40;
export const MAX_TESTO = 200;

/** L'id di una routine della scuola: 8 caratteri minuscoli o cifre, generati dal pannello. */
export const ID_ROUTINE_RE = /^[a-z0-9]{8}$/;

const PREFISSO = 'routine:';
const ORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const zTesto = (max: number) => z.string().trim().min(1).max(max);

/**
 * Una routine aggiunta dalla segreteria. `opzioni` e `multipla` contano solo per la scelta.
 *
 * Il nome e le opzioni sono DATI scritti dalla scuola, non testi dell'app: non si traducono, e non
 * entrano mai nei log (il tipo di voce porta solo l'id).
 */
export const zRoutinePersonalizzata = z
    .object({
        id: z.string().regex(ID_ROUTINE_RE),
        nome: zTesto(MAX_NOME),
        emoji: z.string().trim().min(1).max(16),
        risposta: z.enum(RISPOSTE),
        opzioni: z.array(zTesto(MAX_OPZIONE)).max(MAX_OPZIONI).default([]),
        multipla: z.boolean().default(false),
        attiva: z.boolean().default(true),
    })
    .superRefine((r, ctx) => {
        if (r.risposta !== 'scelta') return;
        const diverse = new Set(r.opzioni.map((o) => o.toLocaleLowerCase('it')));
        if (r.opzioni.length < 2 || diverse.size !== r.opzioni.length) {
            ctx.addIssue({ code: 'custom', path: ['opzioni'], message: 'Una scelta vuole almeno due opzioni, diverse fra loro.' });
        }
    });

export type RoutinePersonalizzata = z.infer<typeof zRoutinePersonalizzata>;

/** La lista intera, com'è validata al salvataggio: ids unici, al massimo 20. */
export const zRoutinePersonalizzate = z
    .array(zRoutinePersonalizzata)
    .max(MAX_ROUTINE_PERSONALIZZATE)
    .superRefine((lista, ctx) => {
        const visti = new Set<string>();
        lista.forEach((r, i) => {
            if (visti.has(r.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'Id di routine ripetuto.' });
            visti.add(r.id);
        });
    });

/**
 * Le routine della scuola da `diario_config.routine_personalizzate`, lette con sospetto: una voce
 * rovinata si scarta da sola, senza far cadere la lista (è ciò che la maestra vede a schermo).
 */
export function routinePersonalizzate(raw: unknown): RoutinePersonalizzata[] {
    if (!Array.isArray(raw)) return [];
    const viste = new Set<string>();
    const lette: RoutinePersonalizzata[] = [];
    for (const voce of raw) {
        const r = zRoutinePersonalizzata.safeParse(voce);
        if (!r.success || viste.has(r.data.id)) continue;
        viste.add(r.data.id);
        lette.push(r.data);
    }
    return lette;
}

/** Il tipo di voce di una routine della scuola. */
export function tipoDiRoutine(id: string): string {
    return `${PREFISSO}${id}`;
}

/** L'id della routine della scuola dietro un tipo di voce, o `null` se il tipo non è di quelle. */
export function idDiTipo(tipo: string): string | null {
    if (!tipo.startsWith(PREFISSO)) return null;
    const id = tipo.slice(PREFISSO.length);
    return ID_ROUTINE_RE.test(id) ? id : null;
}

/** Questo tipo di voce è di una routine aggiunta dalla scuola? */
export function eRoutinePersonalizzata(tipo: string): boolean {
    return idDiTipo(tipo) !== null;
}

// ─── Che cosa vede la maestra ────────────────────────────────────────────────

/**
 * I tipi di voce che la maestra può segnare in questa sede: i base delle routine accese,
 * nell'ordine di sempre, poi le routine della scuola ATTIVE, nell'ordine della segreteria.
 */
export function tipiAttivi(cfg: { routine_attive?: unknown; routine_personalizzate?: unknown }): string[] {
    const accese = routineBaseAttive(cfg.routine_attive);
    const base = TIPI_BASE.filter((t) => accese.has(ROUTINE_DI_TIPO[t]));
    const scuola = routinePersonalizzate(cfg.routine_personalizzate).filter((r) => r.attiva).map((r) => tipoDiRoutine(r.id));
    return [...base, ...scuola];
}

// ─── Il valore segnato per un bambino ────────────────────────────────────────

type FormaRisposta = Pick<RoutinePersonalizzata, 'risposta' | 'opzioni' | 'multipla'>;

/** Ciò che la maestra ha segnato è una risposta valida per questa routine? `null` non lo è. */
export function valoreRoutineValido(def: FormaRisposta, valore: unknown): boolean {
    switch (def.risposta) {
        case 'spunta':
            return valore === true;
        case 'orario':
            return typeof valore === 'string' && ORA_RE.test(valore);
        case 'testo':
            return typeof valore === 'string' && valore.trim().length > 0 && valore.trim().length <= MAX_TESTO;
        case 'scelta': {
            if (!Array.isArray(valore) || valore.length === 0) return false;
            if (!def.multipla && valore.length !== 1) return false;
            if (new Set(valore).size !== valore.length) return false;
            return valore.every((v) => typeof v === 'string' && def.opzioni.includes(v));
        }
    }
}

/**
 * I `dettagli` di una voce di routine della scuola: una FOTOGRAFIA della definizione (nome, icona,
 * tipo di risposta) più il valore. La fotografia è ciò che tiene leggibile la voce quando la
 * segreteria rinomina, spegne o cancella la routine: le voci già scritte restano visibili ai
 * genitori (decisione del titolare, 2026-09-28), e senza la fotografia non saprebbero più cosa dire.
 */
export function dettagliRoutine(def: Pick<RoutinePersonalizzata, 'nome' | 'emoji' | 'risposta'>, valore: unknown): Record<string, unknown> {
    return { nome: def.nome, emoji: def.emoji, risposta: def.risposta, valore: valore ?? null };
}

/**
 * La voce salvata dice qualcosa? Si legge dalla fotografia, senza la definizione: serve anche a
 * chi la definizione non ce l'ha (il genitore, il filtro della rotta) o l'ha persa (routine
 * cancellata). La scelta qui non si confronta con le opzioni: quelle possono essere cambiate dopo.
 */
export function routineCompilata(dettagli: Record<string, unknown> | null | undefined): boolean {
    const risposta = dettagli?.risposta;
    const valore = dettagli?.valore;
    switch (risposta) {
        case 'spunta':
            return valore === true;
        case 'orario':
            return typeof valore === 'string' && ORA_RE.test(valore);
        case 'testo':
            return typeof valore === 'string' && valore.trim().length > 0;
        case 'scelta':
            return Array.isArray(valore) && valore.some((v) => typeof v === 'string' && v.trim().length > 0);
        default:
            return false;
    }
}
