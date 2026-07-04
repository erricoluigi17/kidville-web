'use client';

import { useState } from 'react';
import { Save, LayoutGrid } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, btnPrimary, hint } from './ui';

type Matrice = Record<string, Record<string, boolean>>;

const GRADI = ['nido', 'infanzia', 'primaria'];
const FUNZIONI: { id: string; label: string }[] = [
    { id: 'registro', label: 'Registro' },
    { id: 'valutazioni', label: 'Valutazioni' },
    { id: 'note', label: 'Note disciplinari' },
    { id: 'orario', label: 'Orario' },
    { id: 'appello', label: 'Appello' },
    { id: 'diario', label: 'Diario' },
    { id: 'gallery', label: 'Galleria' },
    { id: 'mensa', label: 'Mensa' },
    { id: 'chat', label: 'Chat' },
    { id: 'avvisi', label: 'Avvisi' },
    { id: 'armadietto', label: 'Armadietto' },
    { id: 'modulistica', label: 'Modulistica' },
    { id: 'pagelle', label: 'Pagelle' },
];

export function FunzioniMatricePanel({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [matrice, setMatrice] = useState<Matrice | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>;
    const m = matrice ?? ((settings.funzioni_matrice ?? {}) as Matrice);

    const toggle = (grado: string, funzione: string) => {
        setMsg('');
        setMatrice({ ...m, [grado]: { ...(m[grado] ?? {}), [funzione]: !m[grado]?.[funzione] } });
    };

    const salva = async () => {
        const ok = await save({ funzioni_matrice: m });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><LayoutGrid size={16} /> Funzioni e moduli per grado</h3>
            <p className="font-maven text-xs text-kidville-muted mb-3">
                Quali moduli sono attivi per ciascun grado scolastico. Le funzioni spente non compaiono a docenti e genitori e le relative API sono bloccate.
            </p>
            <div className="overflow-x-auto">
                <table className="w-full text-sm font-maven">
                    <thead>
                        <tr className="text-kidville-muted">
                            <th className="p-2 text-left">Funzione</th>
                            {GRADI.map((g) => <th key={g} className="p-2 text-center capitalize">{g}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {FUNZIONI.map((f) => (
                            <tr key={f.id} className="border-t border-kidville-line">
                                <td className="p-2 text-kidville-ink">{f.label}</td>
                                {GRADI.map((g) => (
                                    <td key={g} className="p-2 text-center">
                                        <input
                                            type="checkbox"
                                            checked={!!m[g]?.[f.id]}
                                            onChange={() => toggle(g, f.id)}
                                            className="w-4 h-4 rounded text-kidville-green cursor-pointer"
                                        />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="mt-4 flex items-center gap-3">
                <button onClick={salva} disabled={saving} className={btnPrimary}>
                    <Save size={14} /> {saving ? 'Salvataggio…' : 'Salva'}
                </button>
                {msg && <span className="font-maven text-sm text-kidville-success">{msg}</span>}
                {error && <span className="font-maven text-sm text-kidville-error">{error}</span>}
            </div>
            <p className={hint}>Modifiche valide per tutti gli utenti della scuola; effetto immediato al refresh.</p>
        </section>
    );
}
