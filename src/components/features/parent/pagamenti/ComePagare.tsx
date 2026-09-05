'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, Info, Landmark, Banknote } from 'lucide-react';
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
                className={`flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-pill px-3 font-barlow text-[13px] font-extrabold uppercase tracking-[0.05em] motion-safe:transition-colors ${
                    attivo ? 'bg-kidville-green text-kidville-white' : 'text-kidville-sub hover:text-kidville-green'
                }`}
            >
                <Icona size={15} aria-hidden="true" /> {etichetta}
            </button>
        );
    };

    return (
        <div className="kv-come-pagare rounded-card border border-kidville-line bg-kidville-white p-4">
            <p className="font-barlow font-bold uppercase text-xs tracking-wide text-kidville-green mb-1">
                {t('comePagareTitolo')}
            </p>
            <p className="font-maven text-xs text-kidville-sub">{t('comePagareIntro')}</p>

            <div role="tablist" className="mt-3 flex gap-1 rounded-pill bg-kidville-cream p-1">
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
                className="mt-3 space-y-4"
            >
                {blocchi.map((b) => {
                    const copiatoQui = copiato === b.chiave;
                    // Legato a una costante e non letto da `b` dentro il ramo: così
                    // TypeScript lo restringe da solo e non serve nessun cast.
                    const iban = b.iban;
                    return (
                        <div key={b.chiave} className="space-y-2">
                            {mostraNomi && b.nomi.length > 0 && (
                                <p className="font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-sub">
                                    {/* `count` non è decorativo: un blocco può fondere due plessi e
                                        quello accanto averne uno solo, nella stessa pagina. */}
                                    {t('sediDelBlocco', { count: b.nomi.length, sedi: b.nomi.join(' · ') })}
                                </p>
                            )}

                            <div className="rounded-[14px] border border-kidville-line px-3 py-2.5">
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="font-maven text-[11px] uppercase tracking-wide text-kidville-sub">
                                        {t('intestatoA')}
                                    </span>
                                    {b.intestatario ? (
                                        <span className="min-w-0 flex-1 text-right font-maven text-sm font-bold text-kidville-ink break-words">
                                            {b.intestatario}
                                        </span>
                                    ) : (
                                        // Un'assenza non si scrive col peso di un valore.
                                        <span className="min-w-0 flex-1 text-right font-maven text-sm text-kidville-sub break-words">
                                            {t('intestatarioNonDisponibile')}
                                        </span>
                                    )}
                                </div>

                                {iban ? (
                                    <div className="mt-2 flex items-center justify-between gap-2 border-t border-kidville-line pt-2">
                                        <div className="min-w-0">
                                            <span className="block font-maven text-[11px] uppercase tracking-wide text-kidville-sub">
                                                {t('ibanEtichetta')}
                                            </span>
                                            <span className="block font-mono text-sm font-bold text-kidville-ink break-all">
                                                {iban}
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            className={BTN_COPIA_AA}
                                            onClick={() => copiaIban(b.chiave, iban)}
                                            aria-label={t('ariaCopiaIban')}
                                        >
                                            {copiatoQui
                                                ? <><Check size={14} /> {t('copiato')}</>
                                                : <><Copy size={14} /> {t('copia')}</>}
                                        </button>
                                    </div>
                                ) : (
                                    <p className="mt-2 flex items-start gap-1 border-t border-kidville-line pt-2 font-maven text-[11px] text-kidville-sub">
                                        <Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                                        <span>{t('ibanNonDisponibile')}</span>
                                    </p>
                                )}
                            </div>

                            <CausaleBonifico voci={b.voci} incorporata />
                        </div>
                    );
                })}
            </div>

            <div
                role="tabpanel"
                id={idPannello('contanti')}
                aria-labelledby={idTab('contanti')}
                hidden={metodo !== 'contanti'}
                className="mt-3 space-y-2"
            >
                <p className="font-maven text-sm text-kidville-ink">{t('contantiTesto')}</p>
                <p className="flex items-start gap-1.5 rounded-[14px] bg-kidville-cream px-3 py-2.5 font-maven text-xs text-kidville-sub">
                    <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{t('contantiNota730')}</span>
                </p>
            </div>
        </div>
    );
}
