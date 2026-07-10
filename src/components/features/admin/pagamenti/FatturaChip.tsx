'use client';

import { Badge, type BadgeTone } from '@/components/ui/Badge';

const CHIP: Record<string, { label: string; tone: BadgeTone }> = {
    in_attesa: { label: 'In attesa SDI', tone: 'warn' },
    emessa: { label: 'Fatturata', tone: 'success' },
    scartata: { label: 'Scartata', tone: 'error' },
};

/**
 * Chip informativo sullo stato di fatturazione di un pagamento.
 * "Da fatturare" compare SOLO sui saldati: l'emissione resta un'azione
 * esplicita della segreteria (FatturaButton), mai automatica.
 */
export function FatturaChip({ stato, fatturaStato }: { stato: string; fatturaStato?: string | null }) {
    const cfg = CHIP[fatturaStato ?? ''] ?? (stato === 'pagato' ? { label: 'Da fatturare', tone: 'neutral' as BadgeTone } : null);
    if (!cfg) return null;
    return <Badge tone={cfg.tone}>{cfg.label}</Badge>;
}
