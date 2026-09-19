'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Megaphone } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, hint, label } from './ui';
import { CheckField, NumberField, PillMultiSelect, SaveRow, ComingSoonBadge } from './fields';
import { DEFAULT_AVVISI_CONFIG } from '@/lib/scuole/admin-settings-default';

interface AvvisiConfig {
    ruoli_pubblicazione: string[];
    conferma_lettura_abilitata: boolean;
    allegati_max_mb: number;
    scadenza_default_giorni: number;
    /**
     * Giorni prima della scadenza delle ADESIONI in cui il cron
     * `notifiche-promemoria` sollecita chi non ha ancora risposto. `0` = spento.
     *
     * ⚠️ Ha EFFETTO LATO SERVER, a differenza delle tre chiavi qui sopra: la
     * legge `@/lib/avvisi/promemoria-adesioni`, sede per sede. È per questo che
     * vive anche in `DEFAULT_AVVISI_CONFIG` e nella RPC gemella
     * `avvisi_config_default()`, e che qui NON porta il `ComingSoonBadge`.
     */
    promemoria_giorni_prima: number;
}

export function AvvisiSettings({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId, scuolaId);
    const [draft, setDraft] = useState<AvvisiConfig | null>(null);
    const [msg, setMsg] = useState('');

    const RUOLI = [
        { id: 'admin', label: t('ruoloSegreteriaAdmin') },
        { id: 'teacher', label: t('ruoloDocenti') },
    ];

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const cfg = draft ?? ((settings.avvisi_config ?? {}) as AvvisiConfig);
    const set = (patch: Partial<AvvisiConfig>) => { setMsg(''); setDraft({ ...cfg, ...patch }); };

    const salva = async () => {
        const ok = await save({ avvisi_config: cfg });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><Megaphone size={16} /> {t('avTitolo')}</h3>

            <label className={label}>{t('avChiPubblica')}</label>
            <PillMultiSelect options={RUOLI} selected={cfg.ruoli_pubblicazione ?? ['admin', 'teacher']} onChange={(v) => set({ ruoli_pubblicazione: v })} />

            <div className="grid grid-cols-2 gap-3 mt-4">
                <NumberField value={cfg.allegati_max_mb ?? 10} min={1} max={100} onChange={(v) => set({ allegati_max_mb: v })}>
                    {t('avAllegatiMax')}
                </NumberField>
                <NumberField value={cfg.scadenza_default_giorni ?? 30} min={1} max={365} onChange={(v) => set({ scadenza_default_giorni: v })}>
                    <>{t('avScadenzaDefault')} <ComingSoonBadge /></>
                </NumberField>
            </div>

            {/*
              * Il promemoria delle adesioni. **Niente `ComingSoonBadge`**, ed è una
              * differenza di sostanza e non di grafica: quel badge significa «la
              * schermata lo mostra, il server non lo legge», ed è vero per la
              * scadenza qui sopra. Questo campo il server lo legge eccome — è la
              * soglia con cui `promemoriaAdesioni` decide, sede per sede, chi
              * sollecitare stanotte. Metterci il badge direbbe alla segreteria
              * l'esatto contrario della verità.
              *
              * 🔴 IL RIPIEGO SI IMPORTA, non si riscrive. Un `?? 3` a mano qui
              * sarebbe il quinto posto in cui lo stesso default è espresso (la
              * costante TypeScript, la RPC `avvisi_config_default()`, il
              * provisioning, il cron) e il primo destinato a restare indietro: è
              * alla lettera la storia raccontata dal commento di
              * `DEFAULT_AVVISI_CONFIG`, dove quattro copie divergenti avevano
              * lasciato due sedi su tre senza poter pubblicare un avviso.
              */}
            <div className="mt-4">
                <NumberField
                    value={cfg.promemoria_giorni_prima ?? DEFAULT_AVVISI_CONFIG.promemoria_giorni_prima}
                    min={0}
                    max={30}
                    onChange={(v) => set({ promemoria_giorni_prima: v })}
                >
                    {t('avPromemoriaAdesioni')}
                </NumberField>
                <p className={hint}>{t('avPromemoriaAdesioniAiuto')}</p>
            </div>

            <div className="mt-4">
                <CheckField checked={cfg.conferma_lettura_abilitata ?? true} onChange={(v) => set({ conferma_lettura_abilitata: v })}>
                    {t('avConfermaLettura')}
                </CheckField>
            </div>

            <SaveRow onSave={salva} saving={saving} msg={msg} error={error} />
            <p className={hint}>{t('avHint')}</p>
        </section>
    );
}
