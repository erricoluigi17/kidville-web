'use client';

import type { LucideIcon } from 'lucide-react';
import { Newspaper, PenSquare, Inbox, Tag, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tabs } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';

export type VistaNews = 'elenco' | 'editor' | 'proposte' | 'categorie' | 'digest';

// `labelKey` = chiave i18n (namespace adminComunicazioni), risolta dentro il
// componente. La pagina consuma VISTE_NEWS solo per gli `id`.
export const VISTE_NEWS: { id: VistaNews; labelKey: string; icon: LucideIcon }[] = [
    { id: 'elenco', labelKey: 'navElenco', icon: Newspaper },
    { id: 'editor', labelKey: 'navEditor', icon: PenSquare },
    { id: 'proposte', labelKey: 'navProposte', icon: Inbox },
    { id: 'categorie', labelKey: 'navCategorie', icon: Tag },
    { id: 'digest', labelKey: 'navDigest', icon: Mail },
];

/**
 * Navigazione della sezione News: pills scrollabili su mobile (pattern
 * /admin/pagamenti → ContabilitaNav), Tabs cockpit da md in su. Il sync con
 * `?vista=` vive nella pagina, qui solo value/onChange.
 */
export function NewsNav({ value, onChange }: { value: VistaNews; onChange: (v: VistaNews) => void }) {
    const t = useTranslations('adminComunicazioni');
    return (
        <>
            <div className="md:hidden mb-4 min-w-0 overflow-x-auto">
                <div className="flex w-max gap-2">
                    {VISTE_NEWS.map((v) => {
                        const Icon = v.icon;
                        const on = value === v.id;
                        return (
                            <button
                                key={v.id}
                                type="button"
                                aria-pressed={on}
                                onClick={() => onChange(v.id)}
                                className={cx(
                                    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill px-3.5 py-1.5 font-barlow text-[12.5px] font-extrabold uppercase tracking-[0.03em] transition-colors',
                                    'outline-none focus-visible:ring-2 focus-visible:ring-kidville-green focus-visible:ring-offset-1',
                                    on
                                        ? 'bg-kidville-green text-kidville-white'
                                        : 'bg-kidville-white text-kidville-ink/70 ring-[1.5px] ring-inset ring-kidville-line hover:text-kidville-green hover:ring-kidville-green/50'
                                )}
                            >
                                <Icon size={14} strokeWidth={2.2} /> {t(v.labelKey)}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className="hidden md:block">
                <Tabs
                    value={value}
                    onChange={(id) => onChange(id as VistaNews)}
                    options={VISTE_NEWS.map(({ id, labelKey, icon }) => ({ id, label: t(labelKey), icon }))}
                />
            </div>
        </>
    );
}
