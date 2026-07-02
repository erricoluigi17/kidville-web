'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Layers, CheckCircle2, RefreshCw } from 'lucide-react';

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

    // imposta categoria + suggerimenti di descrizione/gruppo coerenti
    const applyCategoria = useCallback((cat?: Categoria) => {
        setCategoriaId(cat?.id || '');
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

    const genera = async () => {
        if (!descrizione.trim()) { setError('Inserisci una causale/descrizione'); return; }
        if (!importo || importo <= 0) { setError('Inserisci un importo maggiore di 0'); return; }
        if (target.length === 0) { setError('Nessun alunno nel target selezionato'); return; }
        setLoading(true); setError(null); setDone(null);
        try {
            const body: Record<string, unknown> = {
                categoria_id: categoriaId || null,
                descrizione: descrizione.trim(),
                importo,
                scadenza,
                obbligatorio,
                gruppo: gruppo.trim() || null,
                alunno_ids: target.map((a) => a.id),
            };
            if (acconti && nRate >= 2) body.rate = buildRate();
            const res = await fetch('/api/pagamenti/genera', { method: 'POST', headers: hdr(userId), body: JSON.stringify(body) });
            const j = await res.json();
            if (!res.ok) { setError(j.error || 'Errore nella generazione'); return; }
            setDone(`Generati ${j.data.generati} pagamenti${acconti ? ' rateali' : ''}.`);
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
                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green">
                        {categorie.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                    </select>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Classe (vuoto = tutti gli iscritti)</label>
                    <select value={classe} onChange={(e) => setClasse(e.target.value)}
                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green">
                        <option value="">Tutti ({alunni.length})</option>
                        {classi.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Causale / descrizione</label>
                    <input type="text" value={descrizione} onChange={(e) => setDescrizione(e.target.value)}
                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">Importo (€)</label>
                        <input type="number" min={0} step="0.01" value={importo || ''}
                            onChange={(e) => setImporto(e.target.value === '' ? 0 : Number(e.target.value))}
                            className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                    </div>
                    <div>
                        <label className="font-maven text-xs text-kidville-muted mb-1 block">{acconti ? '1ª scadenza' : 'Scadenza'}</label>
                        <input type="date" value={scadenza} onChange={(e) => setScadenza(e.target.value)}
                            className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                    </div>
                </div>
                <div>
                    <label className="font-maven text-xs text-kidville-muted mb-1 block">Gruppo (evita duplicati)</label>
                    <input type="text" value={gruppo} onChange={(e) => setGruppo(e.target.value)}
                        className="w-full border-2 border-kidville-line rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={obbligatorio} onChange={(e) => setObbligatorio(e.target.checked)}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                    <span className="font-maven text-xs text-kidville-green">Obbligatorio</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={acconti} onChange={(e) => setAcconti(e.target.checked)}
                        className="w-4 h-4 rounded border-kidville-muted text-kidville-green focus:ring-kidville-green" />
                    <span className="font-maven text-xs text-kidville-green">Dividi in acconti</span>
                </label>
                {acconti && (
                    <div className="flex items-center gap-2">
                        <span className="font-maven text-xs text-kidville-muted">N° rate</span>
                        <input type="number" min={2} max={24} value={nRate}
                            onChange={(e) => setNRate(Math.max(2, Number(e.target.value) || 2))}
                            className="w-16 border-2 border-kidville-line rounded-lg px-2 py-1 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                        <span className="font-maven text-[11px] text-kidville-muted">mensili, ~€ {importo ? (importo / nRate).toFixed(2) : '0'} cad.</span>
                    </div>
                )}
            </div>

            {done && (
                <div className="bg-kidville-success-soft text-kidville-success rounded-xl p-4 font-maven text-sm flex items-center gap-2">
                    <CheckCircle2 size={18} /> {done}
                </div>
            )}
            {error && <p className="font-maven text-xs text-kidville-error">{error}</p>}

            <button onClick={genera} disabled={loading}
                className="px-5 py-2.5 rounded-full bg-kidville-green text-white font-maven font-bold text-sm flex items-center gap-2 disabled:opacity-50">
                {loading ? <RefreshCw size={15} className="animate-spin" /> : <Layers size={15} />}
                Genera per {target.length} alunni
            </button>
        </div>
    );
}
