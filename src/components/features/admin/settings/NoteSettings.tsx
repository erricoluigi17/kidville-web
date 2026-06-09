'use client';

import { useState } from 'react';
import { StickyNote, Plus, Trash2 } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, input, label } from './ui';
import { CheckField, SaveRow } from './fields';

interface NoteConfig {
    firma_otp_richiesta: boolean;
    visibile_genitore_immediata: boolean;
    categorie: string[];
    notifica_admin_su_creazione: boolean;
}

export function NoteSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<NoteConfig | null>(null);
    const [nuova, setNuova] = useState('');
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-gray-400">Caricamento…</p>;
    const cfg = draft ?? ((settings.note_config ?? {}) as NoteConfig);
    const set = (patch: Partial<NoteConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };
    const categorie = cfg.categorie ?? [];

    const salva = async () => {
        const ok = await save({ note_config: cfg });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><StickyNote size={16} /> Note disciplinari</h3>

            <div className="space-y-2">
                <CheckField checked={cfg.firma_otp_richiesta ?? true} onChange={(v) => set({ firma_otp_richiesta: v })}>
                    Presa visione del genitore con firma OTP
                </CheckField>
                <CheckField checked={cfg.visibile_genitore_immediata ?? true} onChange={(v) => set({ visibile_genitore_immediata: v })}>
                    Nota visibile al genitore subito dopo la creazione
                </CheckField>
                <CheckField checked={cfg.notifica_admin_su_creazione ?? true} onChange={(v) => set({ notifica_admin_su_creazione: v })}>
                    Notifica alla segreteria a ogni nuova nota
                </CheckField>
            </div>

            <div className="mt-4">
                <label className={label}>Categorie nota</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {categorie.map((c) => (
                        <span key={c} className="flex items-center gap-1 bg-kidville-cream rounded-full pl-3 pr-2 py-1 font-maven text-sm text-kidville-green capitalize">
                            {c}
                            <button onClick={() => set({ categorie: categorie.filter((x) => x !== c) })} className="text-gray-400 hover:text-red-500"><Trash2 size={13} /></button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input value={nuova} onChange={(e) => setNuova(e.target.value)} placeholder="Nuova categoria…" className={`${input} flex-1`} />
                    <button
                        onClick={() => { const v = nuova.trim().toLowerCase(); if (v && !categorie.includes(v)) { set({ categorie: [...categorie, v] }); setNuova(''); } }}
                        className="px-3 py-2 rounded-full border-2 border-gray-200 font-maven text-sm text-gray-500 flex items-center gap-1"
                    >
                        <Plus size={14} /> Aggiungi
                    </button>
                </div>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>Se la firma OTP è disattivata, la presa visione del genitore avviene con semplice conferma.</p>
        </section>
    );
}
