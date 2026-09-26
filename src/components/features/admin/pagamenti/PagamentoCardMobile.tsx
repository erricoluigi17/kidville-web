'use client';

import { ChevronRight, MapPin } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FatturaChip } from './FatturaChip';
import { STATI_PAGAMENTO } from './stati';
import { Badge } from '@/components/ui/Badge';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import type { PagamentoRow } from './RegistraIncassoModal';

/**
 * Il nome della sede che `GET /api/pagamenti` mette su ogni riga (`scuola_nome`, null se la
 * sede non ha nome). Opzionale qui e non in `PagamentoRow`: le altre fonti di righe
 * (modali, dettaglio) non lo portano, e la sede la chiede solo chi accorpa più sedi.
 */
export type ConSede = { scuola_nome?: string | null };

/**
 * Badge discreto della sede di una riga (P2b). Il prefisso «Sede:» è solo per lo screen
 * reader (messaggio ICU `sedeBadge`, e solo quando il nome c'è): a vista il nome basta, e il
 * badge resta corto. Una riga senza sede NON sparisce
 * in silenzio: con più sedi accorpate un vuoto verrebbe letto come «la sede che ho in mente».
 *
 * Resta MAIUSCOLO come ogni Badge del design system (`uppercase tracking-[0.06em]`), per
 * scelta: aggiungere `normal-case tracking-normal` da `className` non lo cambia, perché fra
 * due utility di pari specificità decide l'ordine nel foglio di stile — `uppercase` vince e
 * `tracking-normal` no, e ne usciva un maiuscolo senza spaziatura (vedi `inCorso` in Badge.tsx).
 * Qui si aggiunge solo `max-w-full`, che il Badge non dichiara e quindi non entra in conflitto.
 */
export function BadgeSede({ nome, className }: { nome?: string | null; className?: string }) {
    const t = useTranslations('adminContabilita');
    const pulito = nome?.trim();
    return (
        <Badge tone={pulito ? 'neutral' : 'warn'} className={cx('max-w-full', className)} data-testid="sede-badge">
            <MapPin size={11} aria-hidden="true" className="shrink-0" />
            {pulito ? (
                <>
                    {/* Letto: «Sede: Kidville Aversa», frase intera dal catalogo (ICU). Visto: il
                        solo nome, nascosto allo screen reader per non leggerlo due volte. */}
                    <span className="sr-only">{t('sedeBadge', { nome: pulito })}</span>
                    <span aria-hidden="true" className="truncate">{pulito}</span>
                </>
            ) : (
                // Senza nome il messaggio dice già «Sede»: nessun prefisso, altrimenti lo screen
                // reader leggeva «Sede Sede non indicata».
                <span className="truncate">{t('sedeBadgeNonIndicata')}</span>
            )}
        </Badge>
    );
}

interface Props {
    pagamento: PagamentoRow & { scadenza?: string | null } & ConSede;
    alunnoLabel: string;
    sezioneLabel?: string | null;
    sospeso?: boolean;
    /**
     * Mostrare la sede della riga? Sì quando le sedi accorpate sono più di una (P2b).
     * Default `false`: con una sede sola il badge ripeterebbe ovunque la stessa parola,
     * e ogni richiamante esistente resta identico a prima.
     */
    mostraSede?: boolean;
    onIncassa: () => void;
    onApri: () => void;
}

/** Card compatta per la lista pagamenti su mobile (sotto lg la tabella diventa card-list). */
export function PagamentoCardMobile({ pagamento, alunnoLabel, sezioneLabel, sospeso, mostraSede = false, onIncassa, onApri }: Props) {
    const t = useTranslations('adminContabilita');
    const st = STATI_PAGAMENTO[pagamento.stato] ?? STATI_PAGAMENTO.da_pagare;
    const residuo = Math.max(0, Number(pagamento.importo) - Number(pagamento.importo_pagato || 0));
    const saldato = pagamento.stato === 'pagato';

    return (
        <div className={cx('kv-admin-rowcard rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3', pagamento.stato === 'scaduto' && 'bg-kidville-error-soft/40')}>
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="truncate font-maven text-sm font-bold text-kidville-green">
                        {alunnoLabel}
                        {sospeso && (
                            <Badge tone="error" className="ml-1 align-middle">{t('cardmSospeso')}</Badge>
                        )}
                    </p>
                    {sezioneLabel && <p className="font-maven text-xs text-kidville-muted">{sezioneLabel}</p>}
                    {mostraSede && <BadgeSede nome={pagamento.scuola_nome} className="mt-1" />}
                </div>
                <Badge tone={st.tone} className="shrink-0">{st.label}</Badge>
            </div>

            <p className="mt-1 truncate font-maven text-xs text-kidville-ink">{pagamento.descrizione}</p>

            <div className="mt-2 flex items-center justify-between font-maven text-xs">
                <span className="text-kidville-muted">
                    {t('cardmTotale')} {formatEuro(pagamento.importo)} · {t('cardmPagato')} {formatEuro(pagamento.importo_pagato || 0)}
                </span>
                {!saldato && <span className="font-bold text-kidville-green">{t('cardmRestano')} {formatEuro(residuo)}</span>}
            </div>

            {/* `flex-wrap`: il Badge non va a capo e FatturaChip può rendere DUE chip (fattura + coda).
                Senza, «Errore in coda» spinge «Dettagli» fuori dalla card a 360/375 px; col wrap
                i bottoni scendono a destra (il loro `ml-auto`) solo quando non c'è spazio. */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <FatturaChip stato={pagamento.stato} fatturaStato={pagamento.fattura_stato} codaStato={pagamento.coda_stato} />
                <div className="ml-auto flex items-center gap-2">
                    {!saldato && (
                        <button type="button" onClick={onIncassa}
                            className="inline-flex min-h-[44px] items-center justify-center rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-xs font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark">
                            {t('cardmIncassa')}
                        </button>
                    )}
                    <button type="button" onClick={onApri}
                        className="inline-flex min-h-[44px] items-center justify-center gap-0.5 rounded-pill border-[1.5px] border-kidville-line px-3 py-1 font-maven text-xs font-bold text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green">
                        {t('cardmDettagli')} <ChevronRight size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
}
