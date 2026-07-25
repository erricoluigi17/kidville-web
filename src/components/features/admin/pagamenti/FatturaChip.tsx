'use client';

import { useTranslations } from 'next-intl';
import { Badge, type BadgeTone } from '@/components/ui/Badge';

const CHIP: Record<string, { labelKey: string; tone: BadgeTone }> = {
    in_attesa: { labelKey: 'fatChip_attesa', tone: 'warn' },
    emessa: { labelKey: 'fatChip_fatturata', tone: 'success' },
    scartata: { labelKey: 'fatChip_scartata', tone: 'error' },
};

/**
 * Chip informativo sullo stato di fatturazione di un pagamento.
 * "Da fatturare" compare SOLO sui saldati: l'emissione resta un'azione
 * esplicita della segreteria (FatturaButton), mai automatica.
 */
export function FatturaChip({ stato, fatturaStato }: { stato: string; fatturaStato?: string | null }) {
    const t = useTranslations('adminContabilita');
    const cfg = CHIP[fatturaStato ?? ''] ?? (stato === 'pagato' ? { labelKey: 'fatChip_da_fatturare', tone: 'neutral' as BadgeTone } : null);
    if (!cfg) return null;
    return <Badge tone={cfg.tone}>{t(cfg.labelKey)}</Badge>;
}
