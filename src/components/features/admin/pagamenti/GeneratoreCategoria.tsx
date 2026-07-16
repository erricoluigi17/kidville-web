'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Layers, RefreshCw } from 'lucide-react';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { cx } from '@/lib/ui/cx';

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
        fetch(`/api/admin/students?stato=iscritto&scuola_id=${scuolaId}&limit=1000`, { headers: hdr(userId) })
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
        if (!descrizione.trim()) { setError('Inserisci una causale/descrizione'); return; }
        if (!importo || importo <= 0) { setError('Inserisci un importo maggiore di 0'); return; }
        if (target.length === 0) { setError('Nessun alunno nel target selezionato'); return; }
        setLoading(true); setError(null); setDone(null);
        try {
            const qs = new URLSearchParams();
            if (scuolaId) qs.set('scuola_id', scuolaId);
            if (classe) qs.set('classe_sezione', classe);
            if (gruppo.trim()) qs.set('gruppo', gruppo.trim());
            const res = await fetch(`/api/pagamenti/genera?${qs.toString()}`, { headers: hdr(userId) });
            const j = await res.json();
            if (!res.ok || !j.success) { setError(j.error || "Errore nel calcolo dell'anteprima"); return; }
            setAnteprima({ candidati: j.data.candidati || [], giaGenerati: j.data.gia_generati || 0 });
        } catch {
            setError('Errore di rete');
        } finally { setLoading(false); }
    };

    const genera = async () => {
        if (!anteprima) return;
        if (anteprima.candidati.length === 0) { setError('Nessun alunno da generare (tutti già presenti nel gruppo)'); return; }
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
            if (!res.ok) { setError(j.error || 'Errore nella generazione'); return; }
            setDone(`Generati ${j.data.generati} pagamenti${acconti ? ' rateali' : ''}.`);
            setAnteprima(null);
        } catch {
            setError('Errore di rete');
        } finally { setLoading(false); }
    };

    return (
        <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Categoria</label>
                    <select value={categoriaId} onChange={(e) => applyCategoria(categorie.find((c) => c.id === e.target.value))}
                        className={GC_SELECT}>
                        {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                    </select>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Classe (vuoto = tutti gli iscritti)</label>
                    <select value={classe} onChange={(e) => { setClasse(e.target.value); setAnteprima(null); }}
                        className={GC_SELECT}>
                        <option value="">Tutti ({alunni.length})</option>
                        {classi.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Causale / descrizione</label>
                    <input type="text" value={descrizione} onChange={(e) => { setDescrizione(e.target.value); setAnteprima(null); }}
                        className={GC_INPUT} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">Importo (€)</label>
                        <input type="number" min={0} step="0.01" value={importo || ''}
                            onChange={(e) => { setImporto(e.target.value === '' ? 0 : Number(e.target.value)); setAnteprima(null); }}
                            className={GC_INPUT} />
                    </div>
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">{acconti ? '1ª scadenza' : 'Scadenza'}</label>
                        <input type="date" value={scadenza} onChange={(e) => { setScadenza(e.target.value); setAnteprima(null); }}
                            className={GC_INPUT} />
                    </div>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Gruppo (evita duplicati)</label>
                    <input type="text" value={gruppo} onChange={(e) => { setGruppo(e.target.value); setAnteprima(null); }}
                        className={GC_INPUT} />
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={obbligatorio} onChange={(e) => { setObbligatorio(e.target.checked); setAnteprima(null); }}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                    <span className="font-maven text-xs text-kidville-green">Obbligatorio</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={acconti} onChange={(e) => { setAcconti(e.target.checked); setAnteprima(null); }}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                    <span className="font-maven text-xs text-kidville-green">Dividi in acconti</span>
                </label>
                {acconti && (
                    <div className="flex items-center gap-2">
                        <span className="font-maven text-xs text-kidville-muted">N° rate</span>
                        <input type="number" min={2} max={24} value={nRate}
                            onChange={(e) => { setNRate(Math.max(2, Number(e.target.value) || 2)); setAnteprima(null); }}
                            className={cx(GC_INPUT, 'w-16')} />
                        <span className="font-maven text-[11px] text-kidville-muted">mensili, ~€ {importo ? (importo / nRate).toFixed(2) : '0'} cad.</span>
                    </div>
                )}
            </div>

            {anteprima && !done && (
                <div className="space-y-1 rounded-card border-[1.5px] border-kidville-line bg-kidville-cream/50 p-4">
                    <p className="font-maven text-sm font-bold text-kidville-green">Anteprima generazione</p>
                    <p className="font-maven text-xs text-kidville-ink">
                        Da generare: {anteprima.candidati.length} pagament{anteprima.candidati.length === 1 ? 'o' : 'i'} da € {importo.toFixed(2)}
                        {acconti && nRate >= 2 ? ` in ${nRate} rate` : ''} · totale € {(anteprima.candidati.length * importo).toFixed(2)}
                    </p>
                    <p className="font-maven text-xs text-kidville-muted">Già presenti (saltati per gruppo): {anteprima.giaGenerati}</p>
                    <p className="font-maven text-xs text-kidville-muted">
                        Scadenza {acconti ? '1ª rata ' : ''}{new Date(scadenza).toLocaleDateString('it-IT')} · {classe || 'tutti gli iscritti'}
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
                    Anteprima ({target.length} alunni)
                </button>
            ) : (
                <div className="flex flex-wrap gap-2">
                    <button onClick={() => setAnteprima(null)} disabled={loading}
                        className="inline-flex items-center gap-2 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-5 py-2.5 font-maven text-sm font-bold text-kidville-muted transition-colors hover:border-kidville-green hover:text-kidville-green disabled:opacity-50">
                        Modifica
                    </button>
                    <button onClick={genera} disabled={loading || anteprima.candidati.length === 0} className={GC_BTN_PRIMARY}>
                        {loading ? <RefreshCw size={15} className="animate-spin" /> : <Layers size={15} />}
                        Conferma generazione ({anteprima.candidati.length})
                    </button>
                </div>
            )}
        </div>
    );
}
