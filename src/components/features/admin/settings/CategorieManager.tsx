'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Tag, Plus, Trash2, Lock, AlertTriangle } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { hdr, card, h3, input, label, btnPrimary, hint, checkboxRow, checkbox, checkboxLabel } from './ui';

interface Props { userId: string; scuolaId: string }

/**
 * `mensile` e `importo_mensile_default` arrivano solo dopo la migrazione dei servizi mensili: sul
 * database degli E2E (non migrato) le chiavi mancano, e «assente» vale «non mensile».
 */
export interface Categoria {
    id: string; nome: string; slug?: string; colore?: string; icona?: string;
    is_sistema: boolean; ordine: number;
    mensile?: boolean | null; importo_mensile_default?: number | string | null;
}

const ROUTE = '/api/admin/settings/categorie';
const PAGINA = '/admin/impostazioni';

type Esito = { tipo: 'ok' | 'errore'; testo: string } | null;

/**
 * Esegue una chiamata alla route e riporta l'esito: `''` = riuscita, altrimenti il messaggio.
 * Il rifiuto si logga col solo `stato` (numero): il corpo può contenere il nome di una categoria.
 */
async function chiama(url: string, init: RequestInit, fallback: string, evento: string): Promise<string> {
    try {
        const res = await fetch(url, init);
        if (!res.ok) {
            logClient({ livello: 'error', evento: 'fetch', messaggio: evento, route: PAGINA, stato: res.status });
            return await messaggioErrore(res, fallback);
        }
        return '';
    } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}: ${nomeErrore(err)}`, route: PAGINA });
        return fallback;
    }
}

function importoIniziale(c: Categoria): string {
    const v = c.importo_mensile_default;
    return v === null || v === undefined || v === '' ? '' : String(v);
}

interface RigaProps {
    c: Categoria;
    onSalva: (c: Categoria, mensile: boolean, importo: number | null) => Promise<void>;
    onNonValido: () => void;
}

/** Controlli «Mensile» di una categoria NON di sistema. */
function ControlliMensile({ c, onSalva, onNonValido }: RigaProps) {
    const t = useTranslations('adminSettings');
    const eraMensile = c.mensile === true;
    const [mensile, setMensile] = useState(eraMensile);
    const [importo, setImporto] = useState(importoIniziale(c));
    const [conferma, setConferma] = useState(false);
    const [invio, setInvio] = useState(false);

    const esegui = async () => {
        let valore: number | null = null;
        if (mensile && importo.trim() !== '') {
            valore = Number(importo.replace(',', '.'));
            if (!Number.isFinite(valore) || valore < 0) { onNonValido(); return; }
            valore = Math.round(valore * 100) / 100;
        }
        setInvio(true);
        await onSalva(c, mensile, valore);
        setInvio(false);
        setConferma(false);
    };
    const salva = () => {
        // Togliere «Mensile» a chi lo era: prima si avvisa, perché gli iscritti smettono di
        // ricevere la voce mensile. Niente `window.confirm`: l'avviso sta in pagina.
        if (eraMensile && !mensile) { setConferma(true); return; }
        void esegui();
    };

    return (
        <div className="mt-2 flex flex-wrap items-end gap-3 border-t border-kidville-line pt-2">
            <label className={checkboxRow}>
                <input type="checkbox" className={checkbox} checked={mensile}
                    onChange={e => { setMensile(e.target.checked); setConferma(false); }} />
                <span className={checkboxLabel}>{t('catMensile')}</span>
            </label>
            {mensile && (
                <div>
                    <label htmlFor={`cat-imp-${c.id}`} className={label}>{t('catImportoMensile')}</label>
                    <input id={`cat-imp-${c.id}`} type="number" inputMode="decimal" min={0} step="0.01"
                        value={importo} onChange={e => setImporto(e.target.value)} className={`${input} w-36`} />
                </div>
            )}
            <button type="button" onClick={salva} disabled={invio} className={btnPrimary}>{t('catSalva')}</button>
            {conferma && (
                <div role="alert" className="basis-full flex flex-wrap items-center gap-3 rounded-2xl bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error-strong">
                    <AlertTriangle size={15} className="shrink-0" strokeWidth={1.8} />
                    <span>{t('catTogliMensileAvviso')}</span>
                    <button type="button" onClick={() => { void esegui(); }} disabled={invio} className={btnPrimary}>{t('catConferma')}</button>
                    <button type="button" onClick={() => setConferma(false)} className="font-maven text-sm text-kidville-green underline">{t('catAnnulla')}</button>
                </div>
            )}
        </div>
    );
}

export function CategorieManager({ userId, scuolaId }: Props) {
    const t = useTranslations('adminSettings');
    const [cats, setCats] = useState<Categoria[]>([]);
    const [nuovo, setNuovo] = useState('');
    const [esito, setEsito] = useState<Esito>(null);

    const load = useCallback(() => {
        fetch(`${ROUTE}?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) })
            .then(r => r.json()).then(d => { if (d.success) setCats(d.data); })
            .catch(err => {
                // Un catch che non logga è un bug: senza questa riga «non ci sono categorie» e
                // «la lettura è morta» sono la stessa cosa.
                logClient({ livello: 'error', evento: 'fetch', messaggio: `settings-categorie-non-caricate: ${nomeErrore(err)}`, route: PAGINA });
                setEsito({ tipo: 'errore', testo: t('erroreCaricamentoDati') });
            });
    }, [userId, scuolaId, t]);
    useEffect(() => { load(); }, [load]);

    const riporta = (err: string, ok: string) => setEsito(err ? { tipo: 'errore', testo: err } : { tipo: 'ok', testo: ok });

    const add = async () => {
        if (!nuovo.trim()) return;
        const err = await chiama(
            ROUTE,
            { method: 'POST', headers: hdr(userId), body: JSON.stringify({ nome: nuovo.trim(), scuola_id: scuolaId }) },
            t('erroreSalvataggio'), 'settings-categoria-nuova-respinta',
        );
        riporta(err, t('catAggiunta'));
        // Il testo NON si azzera quando il server ha detto di no: cancellarlo costringerebbe a riscriverlo.
        if (!err) setNuovo('');
        load();
    };
    const del = async (id: string) => {
        const err = await chiama(
            `${ROUTE}?userId=${userId}&id=${id}&scuola_id=${scuolaId}`,
            { method: 'DELETE', headers: hdr(userId) },
            t('erroreSalvataggio'), 'settings-categoria-elimina-respinta',
        );
        riporta(err, t('catEliminata'));
        load();
    };
    const salvaMensile = async (c: Categoria, mensile: boolean, importo: number | null) => {
        const err = await chiama(
            ROUTE,
            {
                method: 'PATCH', headers: hdr(userId),
                body: JSON.stringify({ id: c.id, scuola_id: scuolaId, mensile, importo_mensile_default: importo }),
            },
            t('erroreSalvataggio'), 'settings-categoria-mensile-respinta',
        );
        riporta(err, t('catSalvata'));
        load();
    };

    return (
        <section className={card}>
            <h3 className={h3}><Tag size={16} /> {t('spCategorie')}</h3>
            <p className={`${hint} mb-3`}>{t('catAiuto')}</p>
            <ul className="mb-3 space-y-2">
                {cats.map(c => (
                    <li key={`${c.id}-${c.mensile === true}-${importoIniziale(c)}`} className="rounded-2xl bg-kidville-cream px-3 py-2 font-maven text-sm text-kidville-green">
                        <span className="flex items-center gap-2">
                            <span>{c.icona} {c.nome}</span>
                            {c.mensile === true && (
                                <span data-testid="badge-mensile" className="rounded-pill bg-kidville-white px-2 py-0.5 text-[11px] font-bold">{t('catMensile')}</span>
                            )}
                            {c.is_sistema ? <Lock size={11} className="text-kidville-sub" aria-hidden="true" /> :
                                <button type="button" onClick={() => del(c.id)} aria-label={`${t('spEliminaCategoria')}: ${c.nome}`} className="text-kidville-sub hover:text-kidville-error"><Trash2 size={13} /></button>}
                        </span>
                        {!c.is_sistema && (
                            <ControlliMensile c={c} onSalva={salvaMensile}
                                onNonValido={() => setEsito({ tipo: 'errore', testo: t('catImportoNonValido') })} />
                        )}
                    </li>
                ))}
            </ul>
            <div className="flex gap-2">
                <input value={nuovo} onChange={e => setNuovo(e.target.value)} placeholder={t('nuovaCategoriaPlaceholder')} aria-label={t('nuovaCategoriaPlaceholder')} className={`${input} flex-1`} />
                <button type="button" onClick={add} className={btnPrimary}><Plus size={14} /> {t('aggiungi')}</button>
            </div>
            <p className="font-maven text-[11px] text-kidville-sub mt-2"><Lock size={10} className="inline" />{t('spCategoriaSistemaHint')}</p>
            {esito && (
                esito.tipo === 'errore' ? (
                    <div role="alert" className="mt-3 flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error-strong">
                        <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} />
                        <span>{esito.testo}</span>
                    </div>
                ) : (
                    <p role="status" className="mt-3 font-maven text-sm text-kidville-green">{esito.testo}</p>
                )
            )}
        </section>
    );
}
