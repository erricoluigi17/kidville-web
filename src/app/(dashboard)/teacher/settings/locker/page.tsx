'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
    Settings, Plus, Trash2, GripVertical, ToggleLeft, ToggleRight,
    ChevronUp, ChevronDown, Package, Save, ArrowLeft,
} from 'lucide-react';
import Link from 'next/link';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

// ─── Tipi ────────────────────────────────────────────────────────────────────

interface MaterialeConfig {
    id: string;
    nome: string;
    icona: string;
    unita: string;
    livello_allerta: number;
    livello_emergenza: number;
    ordine: number;
    attivo: boolean;
    classe_sezione?: string;
}

const CLASSI = ['Girasoli', 'Coccinelle', 'Tulipani', 'Margherite'];
const ICONE_SUGGERITE = ['🧷', '🧻', '🧴', '👕', '🍼', '🧸', '📦', '🎒', '💊', '🥤'];

// ─────────────────────────────────────────────────────────────────────────────

function LockerSettingsInner() {
    const search = useSearchParams();
    const userId = getCurrentTeacherId(search);
    const [classeFilter, setClasseFilter] = useState('Girasoli');
    const [materiali, setMateriali]       = useState<MaterialeConfig[]>([]);
    const [loading, setLoading]           = useState(true);
    const [saving, setSaving]             = useState<string | null>(null); // id materiale in salvataggio

    // Form nuovo materiale
    const [showAddForm, setShowAddForm]   = useState(false);
    const [newMat, setNewMat]             = useState({
        nome: '', icona: '📦', unita: 'pz', livello_allerta: 5, livello_emergenza: 2,
    });
    const [addError, setAddError]         = useState('');

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const fetchMateriali = async (classe: string) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/locker/materials?classe_sezione=${classe}&userId=${userId}`);
            const data = await res.json();
            setMateriali(Array.isArray(data) ? data : []);
        } catch (e) { console.error(e); }
        finally { setLoading(false); }
    };

    useEffect(() => { fetchMateriali(classeFilter); }, [classeFilter]);

    // ── Toggle attivo ─────────────────────────────────────────────────────────
    const toggleAttivo = async (mat: MaterialeConfig) => {
        setSaving(mat.id);
        try {
            await fetch(`/api/locker/materials?userId=${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ id: mat.id, attivo: !mat.attivo }),
            });
            setMateriali(ms => ms.map(m => m.id === mat.id ? { ...m, attivo: !m.attivo } : m));
        } finally { setSaving(null); }
    };

    // ── Modifica soglie ───────────────────────────────────────────────────────
    const updateSoglie = async (mat: MaterialeConfig, field: 'livello_allerta' | 'livello_emergenza', val: number) => {
        setSaving(mat.id);
        try {
            await fetch(`/api/locker/materials?userId=${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ id: mat.id, [field]: val }),
            });
            setMateriali(ms => ms.map(m => m.id === mat.id ? { ...m, [field]: val } : m));
        } finally { setSaving(null); }
    };

    // ── Sposta ordine ─────────────────────────────────────────────────────────
    const moveOrdine = async (mat: MaterialeConfig, dir: 'up' | 'down') => {
        const idx = materiali.findIndex(m => m.id === mat.id);
        const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= materiali.length) return;

        const newList = [...materiali];
        [newList[idx], newList[targetIdx]] = [newList[targetIdx], newList[idx]];
        setMateriali(newList);

        // Salva ordine per entrambi
        setSaving(mat.id);
        await Promise.all([
            fetch(`/api/locker/materials?userId=${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ id: mat.id, ordine: targetIdx + 1 }),
            }),
            fetch(`/api/locker/materials?userId=${userId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ id: newList[idx].id, ordine: idx + 1 }),
            }),
        ]);
        setSaving(null);
    };

    // ── Elimina ───────────────────────────────────────────────────────────────
    const deleteMat = async (mat: MaterialeConfig) => {
        if (!confirm(`Eliminare "${mat.nome}"? Questa azione non può essere annullata.`)) return;
        setSaving(mat.id);
        try {
            await fetch(`/api/locker/materials?id=${mat.id}&userId=${userId}`, { method: 'DELETE', headers: { 'x-user-id': userId } });
            setMateriali(ms => ms.filter(m => m.id !== mat.id));
        } finally { setSaving(null); }
    };

    // ── Aggiungi nuovo ────────────────────────────────────────────────────────
    const addMateriale = async () => {
        if (!newMat.nome.trim()) { setAddError('Inserisci un nome'); return; }
        setSaving('new');
        try {
            const res = await fetch('/api/locker/materials', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({
                    ...newMat,
                    classe_sezione: classeFilter,
                    ordine: materiali.length + 1,
                }),
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json.error);
            setMateriali(ms => [...ms, json.data]);
            setNewMat({ nome: '', icona: '📦', unita: 'pz', livello_allerta: 5, livello_emergenza: 2 });
            setShowAddForm(false);
            setAddError('');
        } catch (e: any) {
            setAddError(e.message);
        } finally { setSaving(null); }
    };

    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
                <Link href="/teacher/locker"
                    className="p-2 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
                    <ArrowLeft size={18} />
                </Link>
                <div>
                    <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase flex items-center gap-2">
                        <Settings size={22} /> Impostazioni Materiali
                    </h1>
                    <p className="text-xs text-gray-400 font-maven mt-0.5">
                        Configura i materiali che i genitori consegnano quotidianamente
                    </p>
                </div>
            </div>

            {/* Filtro classe */}
            <div className="flex gap-2 mb-6 overflow-x-auto pb-1">
                {CLASSI.map(c => (
                    <button key={c} onClick={() => setClasseFilter(c)}
                        className={`px-4 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all
                            ${classeFilter === c ? 'bg-kidville-green text-kidville-yellow shadow' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                        {c}
                    </button>
                ))}
            </div>

            {/* Lista materiali */}
            {loading ? (
                <div className="flex items-center justify-center py-12 gap-2 text-gray-400">
                    <div className="w-4 h-4 border-2 border-gray-300 border-t-kidville-green rounded-full animate-spin" />
                    Caricamento...
                </div>
            ) : (
                <div className="space-y-3 mb-5">
                    {materiali.map((mat, idx) => (
                        <div key={mat.id}
                            className={`bg-white rounded-2xl border-2 p-4 transition-all
                                ${mat.attivo ? 'border-gray-100' : 'border-dashed border-gray-200 opacity-60'}`}>
                            <div className="flex items-center gap-3">
                                {/* Ordine */}
                                <div className="flex flex-col gap-0.5">
                                    <button onClick={() => moveOrdine(mat, 'up')} disabled={idx === 0}
                                        className="text-gray-300 hover:text-gray-500 disabled:opacity-20 transition-colors">
                                        <ChevronUp size={14} />
                                    </button>
                                    <button onClick={() => moveOrdine(mat, 'down')} disabled={idx === materiali.length - 1}
                                        className="text-gray-300 hover:text-gray-500 disabled:opacity-20 transition-colors">
                                        <ChevronDown size={14} />
                                    </button>
                                </div>

                                {/* Icona */}
                                <div className="w-10 h-10 bg-gray-50 rounded-xl flex items-center justify-center text-xl flex-shrink-0">
                                    {mat.icona}
                                </div>

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <p className="font-maven font-bold text-kidville-green">{mat.nome}</p>
                                        <span className="text-xs text-gray-400">{mat.unita}</span>
                                    </div>
                                    <div className="flex items-center gap-3 mt-1">
                                        <span className="text-xs text-kidville-warn">
                                            🟡 Allerta: <strong>{mat.livello_allerta}</strong>
                                        </span>
                                        <span className="text-xs text-kidville-error">
                                            🔴 Urgente: <strong>{mat.livello_emergenza}</strong>
                                        </span>
                                    </div>
                                </div>

                                {/* Azioni */}
                                <div className="flex items-center gap-2">
                                    {saving === mat.id ? (
                                        <div className="w-4 h-4 border-2 border-gray-200 border-t-kidville-green rounded-full animate-spin" />
                                    ) : (
                                        <>
                                            <button onClick={() => toggleAttivo(mat)} title={mat.attivo ? 'Disattiva' : 'Attiva'}
                                                className="text-gray-300 hover:text-kidville-green transition-colors">
                                                {mat.attivo
                                                    ? <ToggleRight size={24} className="text-kidville-green" />
                                                    : <ToggleLeft size={24} />}
                                            </button>
                                            {!mat.id.startsWith('default') && (
                                                <button onClick={() => deleteMat(mat)} title="Elimina"
                                                    className="text-gray-300 hover:text-red-400 transition-colors">
                                                    <Trash2 size={16} />
                                                </button>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Soglie inline edit */}
                            {mat.attivo && (
                                <div className="flex gap-4 mt-3 pt-3 border-t border-gray-50">
                                    <div className="flex-1">
                                        <label className="text-[10px] text-kidville-warn font-bold block mb-1">Soglia Allerta (🟡)</label>
                                        <input type="number" min={1} max={50}
                                            value={mat.livello_allerta}
                                            onChange={e => updateSoglie(mat, 'livello_allerta', parseInt(e.target.value) || 1)}
                                            className="w-full border border-gray-100 rounded-lg px-2 py-1 text-sm text-center" />
                                    </div>
                                    <div className="flex-1">
                                        <label className="text-[10px] text-kidville-error font-bold block mb-1">Soglia Urgente (🔴)</label>
                                        <input type="number" min={0} max={20}
                                            value={mat.livello_emergenza}
                                            onChange={e => updateSoglie(mat, 'livello_emergenza', parseInt(e.target.value) || 0)}
                                            className="w-full border border-gray-100 rounded-lg px-2 py-1 text-sm text-center" />
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}

                    {materiali.length === 0 && (
                        <div className="text-center py-10 text-gray-400">
                            <Package size={40} className="mx-auto mb-2 opacity-30" />
                            <p className="text-sm">Nessun materiale configurato per {classeFilter}</p>
                        </div>
                    )}
                </div>
            )}

            {/* Form aggiungi */}
            {showAddForm ? (
                <div className="bg-white border-2 border-kidville-green/20 rounded-2xl p-5 mb-4">
                    <h3 className="font-maven font-bold text-kidville-green mb-4">Nuovo Materiale</h3>

                    {/* Icona */}
                    <div className="mb-4">
                        <label className="text-xs font-bold text-gray-500 mb-2 block">Icona</label>
                        <div className="flex gap-2 flex-wrap">
                            {ICONE_SUGGERITE.map(ic => (
                                <button key={ic} onClick={() => setNewMat(n => ({ ...n, icona: ic }))}
                                    className={`w-10 h-10 text-xl rounded-xl border-2 transition-all
                                        ${newMat.icona === ic ? 'border-kidville-green bg-kidville-green/5' : 'border-gray-100 hover:border-gray-200'}`}>
                                    {ic}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Nome */}
                    <div className="mb-3">
                        <label className="text-xs font-bold text-gray-500 mb-1 block">Nome materiale</label>
                        <input
                            value={newMat.nome}
                            onChange={e => setNewMat(n => ({ ...n, nome: e.target.value }))}
                            placeholder="es. Bavaglini"
                            className="w-full border-2 border-gray-100 rounded-xl px-3 py-2 text-sm focus:border-kidville-green outline-none" />
                    </div>

                    {/* Unità + Soglie */}
                    <div className="grid grid-cols-3 gap-2 mb-4">
                        <div>
                            <label className="text-xs text-gray-400 block mb-1">Unità</label>
                            <input value={newMat.unita} onChange={e => setNewMat(n => ({ ...n, unita: e.target.value }))}
                                className="w-full border border-gray-100 rounded-lg px-2 py-1.5 text-sm" />
                        </div>
                        <div>
                            <label className="text-xs text-kidville-warn block mb-1">🟡 Allerta</label>
                            <input type="number" value={newMat.livello_allerta}
                                onChange={e => setNewMat(n => ({ ...n, livello_allerta: parseInt(e.target.value) || 1 }))}
                                className="w-full border border-gray-100 rounded-lg px-2 py-1.5 text-sm text-center" />
                        </div>
                        <div>
                            <label className="text-xs text-kidville-error block mb-1">🔴 Urgente</label>
                            <input type="number" value={newMat.livello_emergenza}
                                onChange={e => setNewMat(n => ({ ...n, livello_emergenza: parseInt(e.target.value) || 0 }))}
                                className="w-full border border-gray-100 rounded-lg px-2 py-1.5 text-sm text-center" />
                        </div>
                    </div>

                    {addError && <p className="text-kidville-error text-xs mb-3">{addError}</p>}

                    <div className="flex gap-2">
                        <button onClick={addMateriale} disabled={saving === 'new'}
                            className="flex-1 bg-kidville-green text-kidville-yellow py-2.5 rounded-xl font-bold text-sm flex items-center justify-center gap-1 disabled:opacity-50">
                            <Save size={14} /> {saving === 'new' ? 'Salvataggio...' : 'Salva Materiale'}
                        </button>
                        <button onClick={() => { setShowAddForm(false); setAddError(''); }}
                            className="px-4 py-2.5 rounded-xl border text-gray-500 text-sm">
                            Annulla
                        </button>
                    </div>
                </div>
            ) : (
                <button
                    id="add-material-btn"
                    onClick={() => setShowAddForm(true)}
                    className="w-full py-3 border-2 border-dashed border-kidville-green/30 rounded-2xl text-kidville-green text-sm font-bold hover:bg-kidville-green/5 transition-colors flex items-center justify-center gap-2">
                    <Plus size={16} /> Aggiungi Materiale per {classeFilter}
                </button>
            )}

            {/* Info */}
            <div className="mt-6 bg-blue-50 rounded-2xl p-4 text-xs text-kidville-info font-maven">
                <strong>ℹ️ Come funziona:</strong>
                <ul className="mt-1 space-y-1 list-disc list-inside opacity-80">
                    <li>I materiali configurati qui appaiono nel form "Carico Genitore" e nel portale genitore</li>
                    <li>Disattiva un materiale per nasconderlo senza perderlo</li>
                    <li>Le soglie determinano il colore del semaforo (🟡 allerta, 🔴 urgente)</li>
                    <li>Ogni classe può avere materiali diversi</li>
                </ul>
            </div>
        </div>
    );
}

export default function LockerSettingsPage() {
    return (
        <Suspense fallback={null}>
            <LockerSettingsInner />
        </Suspense>
    );
}
