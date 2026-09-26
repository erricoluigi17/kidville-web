'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useAgingLabel, bucketScadenze, type AgingBucketId, type AgingPagamento } from '@/lib/pagamenti/aging';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';

const ORDINE: AgingBucketId[] = ['scaduti_oltre_30', 'scaduti_entro_30', 'settimana', 'mese'];
const TONO: Record<AgingBucketId, { testo: string; attivo: string }> = {
    scaduti_oltre_30: { testo: 'text-kidville-error', attivo: 'border-kidville-error bg-kidville-error-soft/50' },
    scaduti_entro_30: { testo: 'text-kidville-error', attivo: 'border-kidville-error bg-kidville-error-soft/50' },
    settimana: { testo: 'text-kidville-warn', attivo: 'border-kidville-warn bg-kidville-warn-soft/50' },
    mese: { testo: 'text-kidville-green', attivo: 'border-kidville-green bg-kidville-green/10' },
};

/** Una riga dell'agenda: `scuola_nome` arriva da `GET /api/pagamenti` (null = sede senza nome). */
type RigaAgenda = AgingPagamento & { scuola_nome?: string | null };

/**
 * Conteggio per sede delle righe di un bucket, in ordine alfabetico (it). Le righe senza
 * sede finiscono sotto `senzaSede`, in fondo: contate, non scartate — altrimenti la somma
 * delle sedi non tornerebbe col numero grande del bucket.
 */
function ripartizionePerSede(items: RigaAgenda[], senzaSede: string): { nome: string; n: number }[] {
    const conta = new Map<string, number>();
    let orfane = 0;
    for (const r of items) {
        const nome = r.scuola_nome?.trim();
        if (nome) conta.set(nome, (conta.get(nome) ?? 0) + 1);
        else orfane += 1;
    }
    const out = [...conta].map(([nome, n]) => ({ nome, n })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
    if (orfane > 0) out.push({ nome: senzaSede, n: orfane });
    return out;
}

interface Props {
    pagamenti: RigaAgenda[];
    /** Data di riferimento YYYY-MM-DD (default: oggi). Espressa come prop per i test. */
    oggi?: string;
    attivo: AgingBucketId | null;
    onSelect: (id: AgingBucketId | null) => void;
    /**
     * Mostrare l'importo accanto al conteggio? Solo la Direzione (titolare, 2026-09-02).
     *
     * Il CONTEGGIO e il clic restano a tutti di proposito: i bucket non sono un cruscotto,
     * sono il filtro con cui la Segreteria trova gli scaduti da sollecitare. Toglierli
     * interi le avrebbe tolto uno strumento di lavoro per nascondere un numero.
     *
     * Il default è `true` perché tutti i richiamanti esistenti mostravano gli importi:
     * un default `false` avrebbe cambiato in silenzio ogni altro uso presente e futuro.
     */
    mostraImporti?: boolean;
    /**
     * Ripartire il conteggio di ogni bucket per sede? Sì quando le sedi accorpate sono più
     * di una (P2b): «3 scaduti» non dice a quale segreteria tocca sollecitarli. I bucket sono
     * aggregati, quindi la sede compare come «Aversa 1 · Giugliano 2» sotto il numero.
     * Default `false`: con una sede sola il rendering resta identico a prima.
     */
    mostraSede?: boolean;
}

/** Agenda scadenze: 4 bucket di aging cliccabili che filtrano la lista. */
export function AgendaScadenze({ pagamenti, oggi, attivo, onSelect, mostraImporti = true, mostraSede = false }: Props) {
    const agingLabel = useAgingLabel();
    const t = useTranslations('adminContabilita');
    const locale = useLocale();
    const rif = oggi ?? new Date().toISOString().slice(0, 10);
    const buckets = useMemo(() => bucketScadenze(pagamenti, rif), [pagamenti, rif]);

    return (
        <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {ORDINE.map((id) => {
                const b = buckets[id];
                const on = attivo === id;
                return (
                    <button
                        key={id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onSelect(on ? null : id)}
                        className={cx(
                            'rounded-xl border-2 px-3 py-2 text-left transition-colors',
                            on ? TONO[id].attivo : 'border-kidville-line bg-kidville-white hover:border-kidville-green'
                        )}
                    >
                        <span className="block font-barlow text-[11px] font-bold uppercase tracking-[0.04em] text-kidville-neutral">
                            {agingLabel(id)}
                        </span>
                        <span className="mt-0.5 flex items-baseline gap-1.5">
                            <span className={cx('font-barlow text-xl font-black leading-none', TONO[id].testo)}>{b.count}</span>
                            {mostraImporti && (
                                <span className="font-maven text-[11px] text-kidville-muted">{formatEuro(b.totale)}</span>
                            )}
                        </span>
                        {mostraSede && b.count > 0 && (() => {
                            const sedi = ripartizionePerSede(b.items, t('sedeBadgeNonIndicata'));
                            // Ciò che si LEGGE è una frase sola, tutta dal catalogo: la cornice
                            // («Ripartizione per sede: {elenco}») e la voce («{nome} {n}») sono
                            // messaggi ICU, e la congiunzione fra le voci la decide `Intl.ListFormat`
                            // sulla lingua corrente («A 1, B 2 e C 3» / «A 1, B 2, and C 3»).
                            // Nessuna punteggiatura cablata qui: senza pausa lo screen reader diceva
                            // «Aversa 1 Giugliano 2», il numero di una sede attaccato alla successiva.
                            const elenco = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
                                sedi.map((s) => t('sedeRipartizioneVoce', { nome: s.nome, n: s.n })),
                            );
                            return (
                                <span data-testid="agenda-sedi" className="mt-1 block font-maven text-[11px] leading-snug text-kidville-sub">
                                    <span className="sr-only">{t('sedeRipartizione', { elenco })}</span>
                                    {/* Ciò che si VEDE: nomi e numeri separati dal «·», nascosto allo
                                        screen reader perché la stessa informazione l'ha già letta sopra. */}
                                    <span aria-hidden="true">
                                        {sedi.map((s, i) => (
                                            <span key={s.nome} className="inline-block">
                                                {i > 0 && <span className="px-1">·</span>}
                                                {s.nome} <span className="font-bold text-kidville-ink">{s.n}</span>
                                            </span>
                                        ))}
                                    </span>
                                </span>
                            );
                        })()}
                    </button>
                );
            })}
        </div>
    );
}
