'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, Info, Landmark, Banknote, Building2, MapPin } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import { BTN_COPIA_AA, CausaleBonifico, type VoceCausale } from './CausaleBonifico';

/**
 * Le coordinate di UNA sede, come le compone il server (`GET /api/pagamenti` →
 * `sedi`), che a sua volta le prende da `admin_settings.fiscale_config` /
 * `aruba_config` — le stesse che finiscono nel riquadro «Dati per il bonifico»
 * delle email di sollecito.
 *
 * `iban` arriva GIÀ leggibile a gruppi di quattro ed è `null` quando manca o non
 * supera il mod-97: a schermo non deve mai comparire un IBAN sbagliato, e un
 * campo vuoto è meno dannoso di uno errato. `intestatario` è la denominazione del
 * cedente (nessun campo nuovo: decisione del titolare nello spec del 2026-09-05).
 */
export interface SedeBonifico {
    id: string;
    nome: string;
    iban: string | null;
    intestatario: string | null;
}

/** Un conto: una o più sedi che condividono la stessa coppia (IBAN, intestatario). */
interface BloccoConto {
    chiave: string;
    /** I nomi delle sedi che pagano su questo conto, nell'ordine in cui il server le manda. */
    nomi: string[];
    iban: string | null;
    intestatario: string | null;
    voci: VoceCausale[];
}

/**
 * Raggruppa le voci per conto.
 *
 * Il conto è UNO per la cooperativa, ma la configurazione è PER SEDE e il codice
 * non può darlo per scontato: due sedi con le stesse coordinate si fondono in un
 * blocco solo (che le nomina entrambe), due sedi con coordinate diverse restano
 * due blocchi. Le voci di una sede che il server non ha descritto — risposta di
 * un backend più vecchio, oppure DB della CI senza `fiscale_config` — finiscono
 * in un blocco di ripiego senza coordinate: la causale resta comunque a schermo,
 * ed è l'unica cosa che il genitore non deve perdere.
 *
 * Esportata per essere misurabile da sola: è la regola, non un dettaglio del JSX.
 */
export function raggruppaPerConto(sedi: SedeBonifico[], voci: VoceCausale[]): BloccoConto[] {
    const perId = new Map(sedi.map((s) => [s.id, s]));
    const blocchi: BloccoConto[] = [];
    const indice = new Map<string, BloccoConto>();

    for (const sede of sedi) {
        const vociSede = voci.filter((v) => v.scuola_id === sede.id);
        if (vociSede.length === 0) continue;
        // La chiave è la COPPIA: due sedi con lo stesso IBAN ma intestatari diversi
        // restano due blocchi (il bonifico va intestato a chi lo riceve davvero).
        const chiave = `${sede.iban ?? ''} ${sede.intestatario ?? ''}`;
        const esistente = indice.get(chiave);
        if (esistente) {
            esistente.nomi.push(sede.nome);
            esistente.voci.push(...vociSede);
            continue;
        }
        const blocco: BloccoConto = {
            chiave,
            nomi: [sede.nome],
            iban: sede.iban,
            intestatario: sede.intestatario,
            voci: [...vociSede],
        };
        indice.set(chiave, blocco);
        blocchi.push(blocco);
    }

    const orfane = voci.filter((v) => !perId.has(v.scuola_id));
    if (orfane.length > 0) {
        blocchi.push({ chiave: 'senza-coordinate', nomi: [], iban: null, intestatario: null, voci: orfane });
    }
    return blocchi;
}

type Metodo = 'bonifico' | 'contanti';
const METODI: Metodo[] = ['bonifico', 'contanti'];

/** Etichetta di un campo del conto: piccola, quieta, sempre SOPRA il suo valore. */
const ETICHETTA = 'font-maven text-[11px] uppercase tracking-[0.08em] text-kidville-sub';

/**
 * «Come pagare» — bonifico o contanti, con l'intestatario e l'IBAN della propria
 * sede e le causali per voce incorporate.
 *
 * IL DIFETTO CHE CHIUDE (spec 2026-09-05): la pagina diceva CHE COSA scrivere nel
 * bonifico e non DOVE mandarlo. L'IBAN esisteva già in Impostazioni → Fiscale e
 * usciva soltanto nelle email di sollecito; il genitore che apriva l'app non
 * aveva modo di arrivarci.
 *
 * I contanti si dichiarano perché sono accettati davvero (in segreteria), e
 * insieme si dichiara che NON sono detraibili (L. 160/2019, la stessa regola che
 * `metodoTracciabile` applica in contabilità): dire la prima cosa senza la
 * seconda costerebbe al genitore la detrazione, in silenzio.
 *
 * ─── IL SECONDO GIRO (2026-09-05), dalle schermate a 390px ────────────────────
 * Quattro cose che il disegno di partenza sbagliava, e come sono state raddrizzate:
 *  1. L'IBAN andava a capo IN MEZZO a un gruppo di quattro («…1010 00 / 00 0123
 *     456») perché il bottone gli stava accanto e gli mangiava la riga — e il
 *     punto di rottura CAMBIAVA fra «Copia» e «Copiato». Oggi il valore ha la
 *     riga tutta per sé, senza `break-all`: l'unico posto dove può andare a capo
 *     è lo spazio fra un gruppo e l'altro. Il bottone sta sotto, a tutta larghezza.
 *  2. «Intestato a» era un'etichetta a sinistra col valore allineato a DESTRA:
 *     su un telefono la ragione sociale andava a capo lasciando «soc. coop.» orfano
 *     su una riga sua, con il margine sinistro frastagliato. Oggi è etichetta sopra,
 *     valore sotto, entrambi a bandiera sinistra.
 *  3. La card diceva due volte la stessa cosa: l'introduzione spiegava la causale e
 *     cinque righe dopo la spiegava di nuovo. Oggi l'introduzione ANNUNCIA i due
 *     passi — il conto e la causale — e ciascun passo ha il proprio titolo numerato.
 *  4. La riga dei plessi galleggiava sopra il riquadro, in maiuscolo su nomi propri.
 *     Oggi è la prima riga DENTRO il riquadro, in tondo, con la sua icona.
 */
export function ComePagare({ sedi, voci }: { sedi: SedeBonifico[]; voci: VoceCausale[] }) {
    const t = useTranslations('pagamenti');
    const idBase = useId();
    const [metodo, setMetodo] = useState<Metodo>('bonifico');
    const [copiato, setCopiato] = useState<string | null>(null);
    const tabRefs = useRef<Record<Metodo, HTMLButtonElement | null>>({ bonifico: null, contanti: null });

    if (voci.length === 0) return null;

    const blocchi = raggruppaPerConto(sedi, voci);
    // I nomi delle sedi si mostrano solo quando ce n'è più d'una in pagina:
    // ripetere l'unico plesso della famiglia sarebbe rumore.
    const mostraNomi = blocchi.reduce((n, b) => n + b.nomi.length, 0) > 1;

    const idTab = (m: Metodo) => `${idBase}-tab-${m}`;
    const idPannello = (m: Metodo) => `${idBase}-panel-${m}`;

    const vaiA = (m: Metodo) => {
        setMetodo(m);
        tabRefs.current[m]?.focus();
    };

    // Tastiera dei tab (WAI-ARIA Tabs, attivazione automatica): frecce con
    // avvolgimento + Home/End. Il fuoco segue la selezione, e il `tabIndex`
    // roving tiene UN solo tab nell'ordine di tabulazione.
    const suTasto = (e: React.KeyboardEvent, m: Metodo) => {
        const i = METODI.indexOf(m);
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            vaiA(METODI[(i + 1) % METODI.length]);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            vaiA(METODI[(i - 1 + METODI.length) % METODI.length]);
        } else if (e.key === 'Home') {
            e.preventDefault();
            vaiA(METODI[0]);
        } else if (e.key === 'End') {
            e.preventDefault();
            vaiA(METODI[METODI.length - 1]);
        }
    };

    const copiaIban = async (chiave: string, iban: string) => {
        // Negli appunti va la forma ELETTRONICA dell'IBAN (ISO 13616, senza spazi):
        // è quella che ogni home banking accetta. A schermo resta quella a gruppi
        // di quattro, che è quella che si rilegge.
        try {
            await navigator.clipboard.writeText(iban.replace(/\s+/g, ''));
            setCopiato(chiave);
            setTimeout(() => setCopiato(null), 2000);
        } catch {
            // `navigator.clipboard` negato (contesto non sicuro / permesso rifiutato):
            // non è un guasto del prodotto ma non si ingoia in silenzio (AGENTS: niente
            // catch muto). Nessun dato personale nel messaggio: l'IBAN non ci entra.
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: 'copia IBAN negli appunti non riuscita',
                route: '/parent/pagamenti',
            });
        }
    };

    const tab = (m: Metodo, etichetta: string, Icona: typeof Landmark) => {
        const attivo = metodo === m;
        return (
            <button
                key={m}
                type="button"
                role="tab"
                id={idTab(m)}
                ref={(el) => { tabRefs.current[m] = el; }}
                aria-selected={attivo}
                aria-controls={idPannello(m)}
                tabIndex={attivo ? 0 : -1}
                onClick={() => setMetodo(m)}
                onKeyDown={(e) => suTasto(e, m)}
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-pill px-3 font-barlow text-[13px] font-extrabold uppercase tracking-[0.05em] motion-safe:transition-colors ${
                    attivo ? 'bg-kidville-green text-kidville-white' : 'text-kidville-sub hover:text-kidville-green'
                }`}
            >
                <Icona size={16} aria-hidden="true" /> {etichetta}
            </button>
        );
    };

    /**
     * Titolo di un passo. Il numero non è un vezzo: dice che le due cose vanno fatte
     * TUTTE E DUE, e in quest'ordine. Il pallino porta `bg-kidville-green`, che è la
     * classe su cui la regola d'Alto Contrasto della card lo ribalta in giallo pieno
     * con la cifra nera — nessuna superficie nuova da dipingere a mano.
     */
    const passo = (numero: string, titolo: string) => (
        <p className="flex items-center gap-2 font-barlow text-[13px] font-extrabold uppercase tracking-[0.06em] text-kidville-green">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-kidville-green font-barlow text-[11px] font-black text-kidville-white">
                {numero}
            </span>
            {titolo}
        </p>
    );

    return (
        <div className="kv-come-pagare rounded-card border border-kidville-line bg-kidville-white p-4">
            <p className="font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">
                {t('comePagareTitolo')}
            </p>
            {/* `text-pretty` (text-wrap: pretty) e non un a-capo scritto a mano: toglie
                la riga orfana — «e la causale.» da sola in fondo — senza congelare DOVE
                cade l'a-capo, che dipende dalla larghezza dello schermo e dalla lingua. */}
            <p className="mt-1 font-maven text-xs leading-relaxed text-pretty text-kidville-sub">{t('comePagareIntro')}</p>

            <div
                role="tablist"
                aria-label={t('ariaMetodoPagamento')}
                className="mt-4 flex gap-1 rounded-pill bg-kidville-cream p-1"
            >
                {tab('bonifico', t('metodoBonifico'), Landmark)}
                {tab('contanti', t('metodoContanti'), Banknote)}
            </div>

            {/* I due pannelli restano nel DOM (`hidden` su quello inattivo): così
                `aria-controls` punta sempre a un elemento che esiste davvero. */}
            <div
                role="tabpanel"
                id={idPannello('bonifico')}
                aria-labelledby={idTab('bonifico')}
                hidden={metodo !== 'bonifico'}
                className="mt-4 space-y-6"
            >
                {blocchi.map((b) => {
                    const copiatoQui = copiato === b.chiave;
                    // Legato a una costante e non letto da `b` dentro il ramo: così
                    // TypeScript lo restringe da solo e non serve nessun cast.
                    const iban = b.iban;
                    return (
                        <div key={b.chiave}>
                            {passo('1', t('passoConto'))}

                            <div className="mt-2 rounded-input border border-kidville-line">
                                {mostraNomi && b.nomi.length > 0 && (
                                    <p className="flex items-center gap-2 border-b border-kidville-line px-3 py-2 font-maven text-[11px] leading-relaxed text-pretty text-kidville-sub">
                                        <Building2 size={14} className="shrink-0" aria-hidden="true" />
                                        {/* `count` non è decorativo: un blocco può fondere due plessi e
                                            quello accanto averne uno solo, nella stessa pagina. */}
                                        <span className="min-w-0 break-words">
                                            {t('sediDelBlocco', { count: b.nomi.length, sedi: b.nomi.join(' · ') })}
                                        </span>
                                    </p>
                                )}

                                <div className="space-y-3 p-3">
                                    <div>
                                        <p className={ETICHETTA}>{t('intestatoA')}</p>
                                        {b.intestatario ? (
                                            <p className="mt-1 break-words font-maven text-[15px] font-bold leading-snug text-kidville-ink sm:text-base">
                                                {b.intestatario}
                                            </p>
                                        ) : (
                                            // Un'assenza non si scrive col peso di un valore.
                                            <p className="mt-1 break-words font-maven text-sm leading-snug text-pretty text-kidville-sub">
                                                {t('intestatarioNonDisponibile')}
                                            </p>
                                        )}
                                    </div>

                                    {iban ? (
                                        <div>
                                            <p className={ETICHETTA}>{t('ibanEtichetta')}</p>
                                            {/* NIENTE `break-all` (e niente bottone di fianco): l'IBAN
                                                arriva dal server già a gruppi di quattro separati da
                                                spazi, e con il ritorno a capo normale può spezzarsi
                                                SOLO lì. Un IBAN tagliato a metà di un gruppo si
                                                ricopia sbagliato a mano. */}
                                            <p className="mt-1 font-mono text-sm font-bold leading-snug text-kidville-ink sm:text-base">
                                                {iban}
                                            </p>
                                        </div>
                                    ) : (
                                        <p className="flex items-start gap-2 font-maven text-[11px] leading-relaxed text-pretty text-kidville-sub">
                                            <Info size={14} className="mt-[2px] shrink-0" aria-hidden="true" />
                                            <span>{t('ibanNonDisponibile')}</span>
                                        </p>
                                    )}
                                </div>

                                {iban && (
                                    <div className="px-3 pb-3">
                                        {/* Il testo visibile È il nome accessibile: nessun `aria-label`
                                            che dica una cosa diversa da quella scritta (WCAG 2.5.3).
                                            `w-full sm:w-auto`: sul telefono prende la riga intera —
                                            così premerlo non toglie spazio all'IBAN — ma su desktop
                                            un bottone largo 680px sarebbe una fascia, non un comando. */}
                                        <button
                                            type="button"
                                            className={`${BTN_COPIA_AA} w-full sm:w-auto`}
                                            onClick={() => copiaIban(b.chiave, iban)}
                                        >
                                            {copiatoQui
                                                ? <><Check size={15} aria-hidden="true" /> {t('copiato')}</>
                                                : <><Copy size={15} aria-hidden="true" /> {t('copiaIban')}</>}
                                        </button>
                                    </div>
                                )}
                            </div>

                            <div className="mt-4">{passo('2', t('passoCausale'))}</div>
                            <div className="mt-2">
                                <CausaleBonifico voci={b.voci} incorporata />
                            </div>
                        </div>
                    );
                })}
            </div>

            <div
                role="tabpanel"
                id={idPannello('contanti')}
                aria-labelledby={idTab('contanti')}
                hidden={metodo !== 'contanti'}
                className="mt-4 space-y-3"
            >
                <p className="flex items-start gap-2 font-maven text-sm leading-relaxed text-pretty text-kidville-ink">
                    <MapPin size={16} className="mt-[3px] shrink-0 text-kidville-green" aria-hidden="true" />
                    <span>{t('contantiTesto')}</span>
                </p>
                <p className="flex items-start gap-2 rounded-input bg-kidville-cream px-3 py-3 font-maven text-xs leading-relaxed text-pretty text-kidville-sub">
                    <Info size={14} className="mt-[2px] shrink-0" aria-hidden="true" />
                    <span>{t('contantiNota730')}</span>
                </p>
            </div>
        </div>
    );
}
