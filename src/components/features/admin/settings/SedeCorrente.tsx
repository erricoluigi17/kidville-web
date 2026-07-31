'use client';

import { MapPin } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSediAttive } from '@/lib/context/sede-context';

/**
 * «Stai configurando: <sede>» in testa a ogni pannello delle Impostazioni.
 *
 * Non è decorazione. Ogni riga di `admin_settings` vale per UN plesso, e i
 * pannelli sono identici fra loro: senza il nome scritto sopra, l'unico indizio
 * di quale scuola si stia configurando è la pillola del selettore in cima alla
 * shell — a volte fuori schermo, sempre fuori dal campo visivo di chi sta
 * spuntando una casella. Con tre plessi, «ho tolto la chat ai docenti» e «ho
 * tolto la chat ai docenti DI AVERSA» sono due frasi diverse.
 *
 * Con un plesso solo la riga non aggiunge nulla e non compare.
 */
export function SedeCorrente({ scuolaId }: { scuolaId: string }) {
    const t = useTranslations('adminSettings');
    const { sedi } = useSediAttive();
    if (sedi.length < 2) return null;
    const nome = sedi.find((s) => s.id === scuolaId)?.nome ?? t('sedeSconosciuta');
    return (
        <p className="mb-4 flex items-center gap-1.5 font-maven text-[13px] text-kidville-sub">
            <MapPin size={14} className="shrink-0 text-kidville-green" aria-hidden="true" />
            {t('sedeInConfigurazione')} <strong className="text-kidville-green">{nome}</strong>
        </p>
    );
}
