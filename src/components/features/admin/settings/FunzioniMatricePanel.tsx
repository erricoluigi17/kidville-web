'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Save, LayoutGrid } from 'lucide-react';
import { useAdminSettings } from './useAdminSettings';
import { card, h3, btnPrimary, hint } from './ui';

type Matrice = Record<string, Record<string, boolean>>;

// `id` è il dato (grado/funzione), `labelKey` la chiave i18n mostrata all'utente.
const GRADI: { id: string; labelKey: string }[] = [
    { id: 'nido', labelKey: 'fmGradoNido' },
    { id: 'infanzia', labelKey: 'fmGradoInfanzia' },
    { id: 'primaria', labelKey: 'fmGradoPrimaria' },
];
const FUNZIONI: { id: string; labelKey: string }[] = [
    { id: 'registro', labelKey: 'fmFunzRegistro' },
    { id: 'valutazioni', labelKey: 'fmFunzValutazioni' },
    { id: 'note', labelKey: 'fmFunzNote' },
    { id: 'orario', labelKey: 'fmFunzOrario' },
    { id: 'appello', labelKey: 'fmFunzAppello' },
    { id: 'diario', labelKey: 'fmFunzDiario' },
    { id: 'gallery', labelKey: 'fmFunzGallery' },
    { id: 'mensa', labelKey: 'fmFunzMensa' },
    { id: 'chat', labelKey: 'fmFunzChat' },
    { id: 'avvisi', labelKey: 'fmFunzAvvisi' },
    { id: 'armadietto', labelKey: 'fmFunzArmadietto' },
    { id: 'modulistica', labelKey: 'fmFunzModulistica' },
    { id: 'pagelle', labelKey: 'fmFunzPagelle' },
];

export function FunzioniMatricePanel({ userId, scuolaId }: { userId: string; scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { settings, save, saving, error } = useAdminSettings(userId, scuolaId);
    const [matrice, setMatrice] = useState<Matrice | null>(null);
    const [msg, setMsg] = useState('');

    if (!settings) return <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>;
    const m = matrice ?? ((settings.funzioni_matrice ?? {}) as Matrice);

    const toggle = (grado: string, funzione: string) => {
        setMsg('');
        setMatrice({ ...m, [grado]: { ...(m[grado] ?? {}), [funzione]: !m[grado]?.[funzione] } });
    };

    const salva = async () => {
        const ok = await save({ funzioni_matrice: m });
        setMsg(ok ? t('salvato') : '');
    };

    return (
        <section className={card}>
            <h3 className={h3}><LayoutGrid size={16} /> {t('fmTitolo')}</h3>
            <p className="font-maven text-xs text-kidville-muted mb-3">
                {t('fmDesc')}
            </p>
            <div className="overflow-x-auto">
                <table className="w-full text-sm font-maven">
                    <thead>
                        <tr className="text-kidville-muted">
                            <th className="p-2 text-left">{t('fmColFunzione')}</th>
                            {GRADI.map((g) => <th key={g.id} className="p-2 text-center capitalize">{t(g.labelKey)}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {FUNZIONI.map((f) => (
                            <tr key={f.id} className="border-t border-kidville-line">
                                <td className="p-2 text-kidville-ink">{t(f.labelKey)}</td>
                                {GRADI.map((g) => (
                                    <td key={g.id} className="p-2 text-center">
                                        <input
                                            type="checkbox"
                                            checked={!!m[g.id]?.[f.id]}
                                            onChange={() => toggle(g.id, f.id)}
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
                    <Save size={14} /> {saving ? t('salvataggioInCorso') : t('salva')}
                </button>
                {msg && <span className="font-maven text-sm text-kidville-success">{msg}</span>}
                {error && <span className="font-maven text-sm text-kidville-error">{error}</span>}
            </div>
            <p className={hint}>{t('fmHint')}</p>
        </section>
    );
}
