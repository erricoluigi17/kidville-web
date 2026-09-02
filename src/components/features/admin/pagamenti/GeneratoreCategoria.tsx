'use client';

import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { Layers, RefreshCw } from 'lucide-react';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { useRuoloCockpit } from '@/lib/context/admin-identity';
import { eDirezioneCockpit } from '@/lib/auth/ruoli';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

const GC_INPUT = 'w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';
const GC_SELECT = `${GC_INPUT} cursor-pointer hover:border-kidville-green/50`;
const GC_BTN_PRIMARY = 'inline-flex items-center gap-2 rounded-pill bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50';

interface Categoria { id: string; nome: string; slug: string }
interface Alunno { id: string; nome?: string; cognome?: string; classe_sezione?: string | null; section_id?: string | null }
interface Props { userId: string; scuolaId: string }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

function addMonths(iso: string, n: number): string {
    const d = new Date(iso + 'T00:00:00');
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
}

// Genera un pagamento una tantum (es. Iscrizione, Divisa) per una classe o tutti
// gli iscritti, con importo unico, causale e scadenza. Opzione divisione in acconti.
export function GeneratoreCategoria({ userId, scuolaId }: Props) {
    const t = useTranslations('adminContabilita');
    // Vedi GeneratoreRette: il TOTALE è riservato alla Direzione, il conteggio no.
    // L'importo unitario resta visibile perché lo digita chi sta guardando: nasconderlo
    // sarebbe nascondere a una persona ciò che ha appena scritto lei.
    const eDirezione = eDirezioneCockpit(useRuoloCockpit());
    const f = useDateFormat();
    const [categorie, setCategorie] = useState<Categoria[]>([]);
    const [alunni, setAlunni] = useState<Alunno[]>([]);
    const [categoriaId, setCategoriaId] = useState('');
    const [classe, setClasse] = useState('');
    const [descrizione, setDescrizione] = useState('');
    const [importo, setImporto] = useState<number>(0);
    const [scadenza, setScadenza] = useState(() => new Date().toISOString().slice(0, 10));
    const [obbligatorio, setObbligatorio] = useState(true);
    const [gruppo, setGruppo] = useState('');
    const [acconti, setAcconti] = useState(false);
    const [nRate, setNRate] = useState(3);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Anteprima OBBLIGATORIA: si genera solo sui candidati mostrati; qualunque
    // modifica ai campi la invalida e riparte dall'anteprima.
    const [anteprima, setAnteprima] = useState<{ candidati: Alunno[]; giaGenerati: number } | null>(null);

    // imposta categoria + suggerimenti di descrizione/gruppo coerenti
    const applyCategoria = useCallback((cat?: Categoria) => {
        setCategoriaId(cat?.id || '');
        setAnteprima(null);
        if (cat) {
            setDescrizione(cat.nome);
            setGruppo(`${cat.slug || cat.nome.toLowerCase()}-${new Date().getFullYear()}`);
        }
    }, []);

    useEffect(() => {
        fetch(`/api/admin/settings/categorie?userId=${userId}`, { headers: hdr(userId) })
            .then((r) => r.json())
            .then((d) => {
                if (d.success) {
                    const cats = (d.data as Categoria[]).filter((c) => c.slug !== 'retta');
                    setCategorie(cats);
                    if (cats[0]) applyCategoria(cats[0]);
                }
            }).catch(() => {});
        fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=${LIMITE_ELENCO_ALUNNI}`, { headers: hdr(userId) })
            .then((r) => r.json())
            .then((d) => {
                const lista: Alunno[] = Array.isArray(d) ? d : (d.data || []);
                setAlunni(lista.filter((a) => a.classe_sezione != null || a.section_id != null));
            }).catch(() => {});
    }, [userId, scuolaId, applyCategoria]);

    const classi = useMemo(() => {
        const set = new Set<string>();
        alunni.forEach((a) => a.classe_sezione && set.add(a.classe_sezione));
        return Array.from(set).sort();
    }, [alunni]);

    const target = useMemo(
        () => alunni.filter((a) => !classe || a.classe_sezione === classe),
        [alunni, classe]
    );

    const buildRate = useCallback(() => {
        const base = Math.floor((importo / nRate) * 100) / 100;
        const arr: { importo: number; scadenza: string }[] = [];
        for (let i = 0; i < nRate; i++) {
            const imp = i === nRate - 1 ? Math.round((importo - base * (nRate - 1)) * 100) / 100 : base;
            arr.push({ importo: imp, scadenza: addMonths(scadenza, i) });
        }
        return arr;
    }, [importo, nRate, scadenza]);

    const caricaAnteprima = async () => {
        if (!descrizione.trim()) { setError(t('gencErrCausale')); return; }
        if (!importo || importo <= 0) { setError(t('gencErrImporto')); return; }
        if (target.length === 0) { setError(t('gencErrNessunTarget')); return; }
        setLoading(true); setError(null); setDone(null);
        try {
            const qs = new URLSearchParams();
            if (scuolaId) qs.set('scuola_id', scuolaId);
            if (classe) qs.set('classe_sezione', classe);
            if (gruppo.trim()) qs.set('gruppo', gruppo.trim());
            const res = await fetch(`/api/pagamenti/genera?${qs.toString()}`, { headers: hdr(userId) });
            const j = await res.json();
            if (!res.ok || !j.success) { setError(messaggioDaCorpo(j, t('gencErrAnteprima'))); return; }
            setAnteprima({ candidati: j.data.candidati || [], giaGenerati: j.data.gia_generati || 0 });
        } catch {
            setError(t('gencErrRete'));
        } finally { setLoading(false); }
    };

    const genera = async () => {
        if (!anteprima) return;
        if (anteprima.candidati.length === 0) { setError(t('gencErrNessunGenerare')); return; }
        setLoading(true); setError(null); setDone(null);
        try {
            const body: Record<string, unknown> = {
                categoria_id: categoriaId || null,
                descrizione: descrizione.trim(),
                importo,
                scadenza,
                obbligatorio,
                gruppo: gruppo.trim() || null,
                alunno_ids: anteprima.candidati.map((a) => a.id),
            };
            if (acconti && nRate >= 2) body.rate = buildRate();
            const res = await fetch('/api/pagamenti/genera', { method: 'POST', headers: hdr(userId), body: JSON.stringify(body) });
            const j = await res.json();
            if (!res.ok) { setError(messaggioDaCorpo(j, t('gencErrGenerazione'))); return; }
            setDone(`${t('gencDoneGenerati')} ${j.data.generati} ${acconti ? t('gencDonePagamentiRateali') : t('gencDonePagamenti')}.`);
            setAnteprima(null);
        } catch {
            setError(t('gencErrRete'));
        } finally { setLoading(false); }
    };

    return (
        <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('gencCategoria')}</label>
                    <select value={categoriaId} onChange={(e) => applyCategoria(categorie.find((c) => c.id === e.target.value))}
                        className={GC_SELECT}>
                        {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                    </select>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('gencClasseLabel')}</label>
                    <select value={classe} onChange={(e) => { setClasse(e.target.value); setAnteprima(null); }}
                        className={GC_SELECT}>
                        <option value="">{t('gencOpzioneTutti')} ({alunni.length})</option>
                        {classi.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('gencCausaleDescrizione')}</label>
                    <input type="text" value={descrizione} onChange={(e) => { setDescrizione(e.target.value); setAnteprima(null); }}
                        className={GC_INPUT} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('gencImportoLabel')}</label>
                        <input type="number" min={0} step="0.01" value={importo || ''}
                            onChange={(e) => { setImporto(e.target.value === '' ? 0 : Number(e.target.value)); setAnteprima(null); }}
                            className={GC_INPUT} />
                    </div>
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">{acconti ? t('gencPrimaScadenza') : t('gencScadenza')}</label>
                        <input type="date" value={scadenza} onChange={(e) => { setScadenza(e.target.value); setAnteprima(null); }}
                            className={GC_INPUT} />
                    </div>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">{t('gencGruppoLabel')}</label>
                    <input type="text" value={gruppo} onChange={(e) => { setGruppo(e.target.value); setAnteprima(null); }}
                        className={GC_INPUT} />
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={obbligatorio} onChange={(e) => { setObbligatorio(e.target.checked); setAnteprima(null); }}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                    <span className="font-maven text-xs text-kidville-green">{t('gencObbligatorio')}</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={acconti} onChange={(e) => { setAcconti(e.target.checked); setAnteprima(null); }}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                    <span className="font-maven text-xs text-kidville-green">{t('gencDividiAcconti')}</span>
                </label>
                {acconti && (
                    <div className="flex items-center gap-2">
                        <span className="font-maven text-xs text-kidville-muted">{t('gencNRate')}</span>
                        <input type="number" min={2} max={24} value={nRate}
                            onChange={(e) => { setNRate(Math.max(2, Number(e.target.value) || 2)); setAnteprima(null); }}
                            className={cx(GC_INPUT, 'w-16')} />
                        <span className="font-maven text-[11px] text-kidville-muted">{t('gencMensili')} ~{formatEuro(importo ? importo / nRate : 0)} {t('gencCadauno')}</span>
                    </div>
                )}
            </div>

            {anteprima && !done && (
                <div className="space-y-1 rounded-card border-[1.5px] border-kidville-line bg-kidville-cream/50 p-4">
                    <p className="font-maven text-sm font-bold text-kidville-green">{t('gencAnteprimaGenerazione')}</p>
                    <p className="font-maven text-xs text-kidville-ink">
                        {t('gencDaGenerare')} {anteprima.candidati.length} {anteprima.candidati.length === 1 ? t('gencPagamentoSing') : t('gencPagamentoPlur')} {t('gencDa')} {formatEuro(importo)}
                        {acconti && nRate >= 2 ? ` ${t('gencInRate1')}${nRate}${t('gencInRate2')}` : ''}
                        {eDirezione ? ` · ${t('gencTotale')} ${formatEuro(anteprima.candidati.length * importo)}` : ''}
                    </p>
                    <p className="font-maven text-xs text-kidville-muted">{t('gencGiaPresenti')} {anteprima.giaGenerati}</p>
                    <p className="font-maven text-xs text-kidville-muted">
                        {t('gencScadenzaPre')} {acconti ? t('gencPrimaRata') : ''}{f.dataBreve(scadenza)} · {classe || t('gencTuttiIscritti')}
                    </p>
                </div>
            )}

            {done && (
                <div className="bg-kidville-success-soft text-kidville-success rounded-card p-4 font-maven text-sm flex items-center gap-2">
                    <SaveCheck size={18} /> {done}
                </div>
            )}
            {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}

            {!anteprima ? (
                <button onClick={caricaAnteprima} disabled={loading} className={GC_BTN_PRIMARY}>
                    {loading ? <RefreshCw size={15} className="animate-spin" /> : <Layers size={15} />}
                    {t('gencAnteprima')} ({target.length} {t('gencAlunni')})
                </button>
            ) : (
                <div className="flex flex-wrap gap-2">
                    <button onClick={() => setAnteprima(null)} disabled={loading}
                        className="inline-flex items-center gap-2 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-5 py-2.5 font-maven text-sm font-bold text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green disabled:opacity-50">
                        {t('gencModifica')}
                    </button>
                    <button onClick={genera} disabled={loading || anteprima.candidati.length === 0} className={GC_BTN_PRIMARY}>
                        {loading ? <RefreshCw size={15} className="animate-spin" /> : <Layers size={15} />}
                        {t('gencConfermaGenerazione')} ({anteprima.candidati.length})
                    </button>
                </div>
            )}
        </div>
    );
}
