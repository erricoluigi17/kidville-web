'use client';

// Skeleton di caricamento della schermata chat: riproduce header + lista thread
// (avatar + due righe) per una percezione di caricamento migliore rispetto al
// solo spinner. Nessuna dipendenza extra: usa animate-pulse di Tailwind.

function SkeletonRow() {
    return (
        <div className="w-full flex items-center gap-3 px-4 py-3.5">
            <div className="w-11 h-11 rounded-full bg-kidville-line/70 flex-shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
                <div className="h-3 w-2/5 rounded bg-kidville-line/70" />
                <div className="h-2.5 w-3/4 rounded bg-kidville-line/50" />
            </div>
        </div>
    );
}

export function ChatListSkeleton() {
    const rows = [0, 1, 2, 3, 4];
    return (
        <div
            className="px-4 pt-5 pb-24 animate-pulse"
            aria-busy="true"
            aria-label="Caricamento chat"
        >
            {/* Header — sagoma della card verde (PageHeaderCard) */}
            <div className="mb-4 h-[104px] rounded-3xl bg-kidville-line/70" />

            {/* Desktop: due colonne (lista + area conversazione) */}
            <div className="hidden md:flex gap-4 h-[calc(100vh-200px-var(--kv-appbar-h,0px))] min-h-[500px] mb-24">
                <div className="w-80 flex-shrink-0 bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden">
                    <div className="px-4 py-3 border-b border-kidville-line">
                        <div className="h-3 w-24 rounded bg-kidville-line/70" />
                    </div>
                    <div className="divide-y divide-kidville-line/70">
                        {rows.map(i => <SkeletonRow key={i} />)}
                    </div>
                </div>
                <div className="flex-1 bg-white rounded-3xl border border-kidville-line shadow-sm flex items-center justify-center">
                    <div className="w-20 h-20 rounded-full bg-kidville-line/50" />
                </div>
            </div>

            {/* Mobile: singolo pannello lista */}
            <div className="md:hidden bg-white rounded-3xl border border-kidville-line shadow-sm overflow-hidden">
                <div className="divide-y divide-kidville-line/70">
                    {rows.map(i => <SkeletonRow key={i} />)}
                </div>
            </div>
        </div>
    );
}
