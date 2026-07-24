'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { StickyNote, Plus, Trash2 } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, input, label } from './ui';
import { CheckField, SaveRow, ComingSoonBadge } from './fields';

interface NoteConfig {
    firma_otp_richiesta: boolean;
    visibile_genitore_immediata: boolean;
    categorie: string[];
    notifica_admin_su_creazione: boolean;
}

export function NoteSettings({ userId }: { userId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<NoteConfig | null>(null);
    const [nuova, setNuova] = useState('');
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.note_config ?? {}) as NoteConfig);
    const set = (patch: Partial<NoteConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };
    const categorie = cfg.categorie ?? [];

    const salva = async () => {
        const ok = await save({ note_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><StickyNote size={16} /> {t('noTitolo')}</h3>

            <div className="space-y-2">
                <CheckField checked={cfg.firma_otp_richiesta ?? true} onChange={(v) => set({ firma_otp_richiesta: v })}>
                    <>{t('noPresaVisioneOtp')} <ComingSoonBadge /></>
                </CheckField>
                <CheckField checked={cfg.visibile_genitore_immediata ?? true} onChange={(v) => set({ visibile_genitore_immediata: v })}>
                    {t('noVisibileSubito')}
                </CheckField>
                <CheckField checked={cfg.notifica_admin_su_creazione ?? true} onChange={(v) => set({ notifica_admin_su_creazione: v })}>
                    {t('noNotificaAdmin')}
                </CheckField>
            </div>

            <div className="mt-4">
                <label className={label}>{t('noCategorieNota')}</label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {categorie.map((c) => (
                        <span key={c} className="flex items-center gap-1 bg-kidville-cream rounded-full pl-3 pr-2 py-1 font-maven text-sm text-kidville-green capitalize">
                            {c}
                            <button onClick={() => set({ categorie: categorie.filter((x) => x !== c) })} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={13} /></button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input value={nuova} onChange={(e) => setNuova(e.target.value)} placeholder={t('nuovaCategoriaPlaceholder')} className={`${input} flex-1`} />
                    <button
                        onClick={() => { const v = nuova.trim().toLowerCase(); if (v && !categorie.includes(v)) { set({ categorie: [...categorie, v] }); setNuova(''); } }}
                        className="px-3 py-2 rounded-full border-2 border-kidville-line font-maven text-sm text-kidville-muted flex items-center gap-1"
                    >
                        <Plus size={14} /> {t('aggiungi')}
                    </button>
                </div>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('noHint')}</p>
        </section>
    );
}
