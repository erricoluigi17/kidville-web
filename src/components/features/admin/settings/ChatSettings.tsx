'use client';

import { useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, label } from './ui';
import { CheckField, TimeField, TextField, PillMultiSelect, SaveRow } from './fields';

interface ChatConfig {
    abilitata_genitori: boolean;
    orario_docenti_da: string;
    orario_docenti_a: string;
    giorni_attivi: number[];
    broadcast_solo_admin: boolean;
    risposta_fuori_orario_msg: string;
}

const GIORNI = [
    { id: '1', label: 'Lun' }, { id: '2', label: 'Mar' }, { id: '3', label: 'Mer' },
    { id: '4', label: 'Gio' }, { id: '5', label: 'Ven' }, { id: '6', label: 'Sab' },
];

export function ChatSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<ChatConfig | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-gray-400">Caricamento…</p>;
    const cfg = draft ?? ((settings.chat_config ?? {}) as ChatConfig);
    const set = (patch: Partial<ChatConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };
    const giorni = (cfg.giorni_attivi ?? [1, 2, 3, 4, 5]).map(String);

    const salva = async () => {
        const ok = await save({ chat_config: cfg });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><MessageCircle size={16} /> Chat</h3>

            <div className="space-y-2">
                <CheckField checked={cfg.abilitata_genitori ?? true} onChange={(v) => set({ abilitata_genitori: v })}>
                    Chat abilitata per i genitori
                </CheckField>
                <CheckField checked={cfg.broadcast_solo_admin ?? true} onChange={(v) => set({ broadcast_solo_admin: v })}>
                    Messaggi broadcast riservati alla segreteria
                </CheckField>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
                <TimeField value={cfg.orario_docenti_da ?? '08:00'} onChange={(v) => set({ orario_docenti_da: v })}>Docenti disponibili dalle</TimeField>
                <TimeField value={cfg.orario_docenti_a ?? '17:00'} onChange={(v) => set({ orario_docenti_a: v })}>Docenti disponibili fino alle</TimeField>
            </div>

            <div className="mt-4">
                <label className={label}>Giorni attivi</label>
                <PillMultiSelect
                    options={GIORNI}
                    selected={giorni}
                    onChange={(v) => set({ giorni_attivi: v.map(Number).sort() })}
                />
            </div>

            <div className="mt-4">
                <TextField value={cfg.risposta_fuori_orario_msg ?? ''} onChange={(v) => set({ risposta_fuori_orario_msg: v })} placeholder="Messaggio mostrato fuori orario…">
                    Messaggio fuori orario
                </TextField>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>Fuori orario i messaggi restano inviabili: il genitore vede il banner con il messaggio configurato.</p>
        </section>
    );
}
