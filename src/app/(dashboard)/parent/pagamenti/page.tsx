'use client';

import { Suspense } from 'react';
import { StoricoPagamenti } from '@/components/features/parent/pagamenti/StoricoPagamenti';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

// L'identità viene dalla sessione (URL → localStorage → /api/me), senza demo.
function Inner() {
    const { userId } = useSessionIdentity();
    return (
        <div className="px-4 pt-6 pb-24">
            <header className="mb-5">
                <p className="font-barlow font-bold text-[11px] uppercase tracking-[0.14em] text-kidville-yellow-dark">
                    Servizi
                </p>
                <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide leading-none">
                    Pagamenti
                </h1>
                <p className="font-maven text-xs text-kidville-muted mt-1">Storico pagamenti effettuati e da effettuare.</p>
            </header>
            {userId && <StoricoPagamenti userId={userId} />}
        </div>
    );
}

export default function ParentPagamentiPage() {
    return (
        <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
            <Inner />
        </Suspense>
    );
}
