'use client';

import { Suspense } from 'react';
import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// L'identità viene dalla sessione (URL → localStorage → /api/me), senza demo.
function Inner() {
    const { userId } = useSessionIdentity();
    return (
        <div className="px-4 pt-5 pb-24">
            <PageHeaderCard
                eyebrow="Servizi"
                title="Pagamenti"
                subtitle="Storico pagamenti effettuati e da effettuare."
                className="mb-5"
            />
            {userId && <StoricoPagamenti userId={userId} />}
        </div>
    );
}

export default function ParentPagamentiPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
            <Inner />
        </Suspense>
    );
}
