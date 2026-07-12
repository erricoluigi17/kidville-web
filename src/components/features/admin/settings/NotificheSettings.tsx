'use client';

import { useState } from 'react';
import { BellRing, ShieldAlert } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint } from './ui';
import { CheckField, SaveRow } from './fields';
import { TIPI_NOTIFICA, type GruppoNotifica } from '@/lib/notifiche/tipi';

// Pannello Impostazioni → Notifiche: un toggle per ogni tipo del catalogo
// (src/lib/notifiche/tipi.ts). Toggle assente = attiva; il gate server-side è
// isNotificaAbilitata(). I tipi `sicurezza` mostrano un avviso dedicato.

interface NotificheConfig {
    toggles?: Record<string, boolean>;
}

const GRUPPI: { id: GruppoNotifica; label: string; sottotitolo: string }[] = [
    { id: 'genitore', label: 'Notifiche ai genitori', sottotitolo: 'Aggiornamenti inviati alle famiglie' },
    { id: 'docente', label: 'Notifiche ai docenti', sottotitolo: 'Aggiornamenti inviati agli insegnanti' },
    { id: 'staff', label: 'Notifiche a segreteria e staff', sottotitolo: 'Aggiornamenti operativi e amministrativi' },
];

export function NotificheSettings({ userId }: { userId: string }) {
    const { settings, save, saving, error } = useAdminSettings(userId);
    const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">Caricamento…</p>;
    const salvati = ((settings.notifiche_config ?? {}) as NotificheConfig).toggles ?? {};
    const toggles = draft ?? salvati;
    const attiva = (tipo: string) => toggles[tipo] !== false;
    const set = (tipo: string, v: boolean) => { setMsg(''); setDraft({ ...toggles, [tipo]: v }); };

    const salva = async () => {
        // Si salva la mappa completa (true espliciti inclusi): il merge shallow
        // lato server sostituisce l'intero oggetto `toggles`.
        const complete: Record<string, boolean> = {};
        for (const tipo of Object.keys(TIPI_NOTIFICA)) complete[tipo] = attiva(tipo);
        const ok = await save({ notifiche_config: { toggles: complete } });
        setMsg(ok ? 'Salvato ✓' : '');
    };

    return (
        <>
            {GRUPPI.map((gruppo) => {
                const voci = Object.entries(TIPI_NOTIFICA).filter(([, t]) => t.gruppo === gruppo.id);
                return (
                    <section key={gruppo.id} className={card}>
                        <h3 className={h3}><BellRing size={16} /> {gruppo.label}</h3>
                        <p className="font-maven text-xs text-kidville-muted -mt-3 mb-4">{gruppo.sottotitolo}</p>
                        <div className="space-y-3">
                            {voci.map(([tipo, t]) => (
                                <div key={tipo}>
                                    <CheckField checked={attiva(tipo)} onChange={(v) => set(tipo, v)}>
                                        <span className="inline-flex items-center gap-1.5">
                                            {t.label}
                                            {t.sicurezza && (
                                                <span className="inline-flex items-center gap-1 text-[10px] bg-kidville-warn-soft text-kidville-warn px-2 py-0.5 rounded-full">
                                                    <ShieldAlert size={11} /> sicurezza
                                                </span>
                                            )}
                                        </span>
                                    </CheckField>
                                    {t.descrizione && <p className="font-maven text-[11px] text-kidville-muted ml-6">{t.descrizione}</p>}
                                    {t.sicurezza && !attiva(tipo) && (
                                        <p className="font-maven text-[11px] text-kidville-warn ml-6 mt-0.5">
                                            Attenzione: questa è una notifica di sicurezza, disattivarla è sconsigliato.
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                        <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
                    </section>
                );
            })}
            <p className={hint}>
                Le notifiche disattivate non vengono create: niente campanella e niente push, per nessun destinatario.
                Le notifiche già in coda non vengono rimosse.
            </p>
        </>
    );
}
