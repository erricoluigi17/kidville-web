'use client';

import { useState } from 'react';
import { Package, Plus, Trash2 } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, input, label } from './ui';
import { CheckField, NumberField, SaveRow, ComingSoonBadge } from './fields';

interface ArmadiettoConfig {
    soglia_scorta_bassa: number;
    notifica_genitore_scorta_bassa: boolean;
    richieste_materiale_abilitate: boolean;
    categorie_extra: string[];
}

export function ArmadiettoSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<ArmadiettoConfig | null>(null);
    const [nuova, setNuova] = useState('');
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-gray-400">Caricamento…</p>;
    const cfg = draft ?? ((settings.armadietto_config ?? {}) as ArmadiettoConfig);
    const set = (patch: Partial<ArmadiettoConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };
    const extra = cfg.categorie_extra ?? [];

    const salva = async () => {
        const ok = await save({ armadietto_config: cfg });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><Package size={16} /> Armadietto</h3>

            <div className="grid grid-cols-2 gap-3">
                <NumberField value={cfg.soglia_scorta_bassa ?? 2} min={0} max={20} onChange={(v) => set({ soglia_scorta_bassa: v })}>
                    Soglia scorta bassa (pezzi)
                </NumberField>
            </div>

            <div className="mt-4 space-y-2">
                <CheckField checked={cfg.notifica_genitore_scorta_bassa ?? true} onChange={(v) => set({ notifica_genitore_scorta_bassa: v })}>
                    <>Notifica al genitore quando la scorta è bassa <ComingSoonBadge /></>
                </CheckField>
                <CheckField checked={cfg.richieste_materiale_abilitate ?? true} onChange={(v) => set({ richieste_materiale_abilitate: v })}>
                    Richieste di materiale ai genitori abilitate
                </CheckField>
            </div>

            <div className="mt-4">
                <label className={label}>Categorie materiale extra</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {extra.map((c) => (
                        <span key={c} className="flex items-center gap-1 bg-kidville-cream rounded-full pl-3 pr-2 py-1 font-maven text-sm text-kidville-green capitalize">
                            {c}
                            <button onClick={() => set({ categorie_extra: extra.filter((x) => x !== c) })} className="text-gray-400 hover:text-red-500"><Trash2 size={13} /></button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input value={nuova} onChange={(e) => setNuova(e.target.value)} placeholder="Nuova categoria…" className={`${input} flex-1`} />
                    <button
                        onClick={() => { const v = nuova.trim().toLowerCase(); if (v && !extra.includes(v)) { set({ categorie_extra: [...extra, v] }); setNuova(''); } }}
                        className="px-3 py-2 rounded-full border-2 border-gray-200 font-maven text-sm text-gray-500 flex items-center gap-1"
                    >
                        <Plus size={14} /> Aggiungi
                    </button>
                </div>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>Le categorie extra si aggiungono a quelle standard del materiale armadietto.</p>
        </section>
    );
}
