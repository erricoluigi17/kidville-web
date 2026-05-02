'use client';

import { Package, TrendingDown } from 'lucide-react';

interface InventoryItem {
    alunno_id: string;
    materiale: string;
    quantita: number;
    unita: string;
    livello_allerta: number | string;
    livello_emergenza: number | string;
    icona?: string; // opzionale se presente nel DB
}

interface Props {
    item: InventoryItem;
    onLoad: () => void;
}

function getSemaforoColor(qty: number, gialla: any, rossa: any) {
    const sogliaGialla = parseInt(gialla) || 5;
    const sogliaRossa = parseInt(rossa) || 2;

    if (qty <= sogliaRossa) return { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', bar: 'bg-red-500', label: '🔴 Esaurito' };
    if (qty <= sogliaGialla) return { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', bar: 'bg-amber-400', label: '🟡 In esaurimento' };
    return { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', bar: 'bg-emerald-500', label: '🟢 Ok' };
}

export function InventoryCard({ item, onLoad }: Props) {
    const semaforo = getSemaforoColor(item.quantita, item.livello_allerta, item.livello_emergenza);

    // Placeholder icona basata sul nome se non presente
    const icon = item.icona || (item.materiale.toLowerCase().includes('pannolin') ? '🧷' : '📦');

    const maxBar = Math.max(15, item.quantita + 5);
    const pct = Math.min(100, (item.quantita / maxBar) * 100);

    return (
        <div className={`rounded-2xl border-2 ${semaforo.border} ${semaforo.bg} p-3 transition-all hover:shadow-md`}>
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-xl shadow-sm flex-shrink-0">
                    {icon}
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                        <span className="font-maven font-bold text-sm text-kidville-green truncate uppercase">{item.materiale}</span>
                        <span className={`font-barlow font-black text-lg ${semaforo.text}`}>
                            {item.quantita}<span className="text-xs font-maven font-normal ml-0.5">{item.unita || 'pz'}</span>
                        </span>
                    </div>

                    <div className="h-2 bg-white rounded-full overflow-hidden mb-1">
                        <div
                            className={`h-full ${semaforo.bar} rounded-full transition-all duration-500`}
                            style={{ width: `${pct}%` }}
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <span className={`text-xs font-maven ${semaforo.text}`}>{semaforo.label}</span>
                        <TrendingDown size={12} className={item.quantita <= (parseInt(item.livello_allerta as string) || 5) ? semaforo.text : 'opacity-0'} />
                    </div>
                </div>

                <button
                    onClick={onLoad}
                    className="w-9 h-9 rounded-xl bg-kidville-green text-kidville-yellow flex items-center justify-center hover:opacity-90 active:scale-95 transition-all flex-shrink-0"
                >
                    <Package size={16} />
                </button>
            </div>
        </div>
    );
}
