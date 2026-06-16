'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChefHat, UtensilsCrossed } from 'lucide-react';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';
import { allergeniDelGiorno, allergeneLabel, allergeneEmoji, type AllergeniPortate } from '@/lib/mensa/allergeni';

const DEV_COOK = '22222222-2222-2222-2222-555555555555';

interface Portate { primo?: string; secondo?: string; contorno?: string; frutta?: string }
interface MenuGiorno { data: string; attivo: boolean; chiuso: boolean; portate: Portate | null; ingredienti?: Portate | null; allergeni?: AllergeniPortate | null; note?: string | null }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

function CucinaInner() {
  const params = useSearchParams();
  const userId = params.get('userId') || DEV_COOK;
  // l'insegnante arriva con ?sezione=… per restare scoped alla sua classe
  const sezione = params.get('sezione') || undefined;
  const [oggi, setOggi] = useState<MenuGiorno | null>(null);

  const data = new Date().toISOString().slice(0, 10);
  const loadMenu = useCallback(async () => {
    const r = await fetch(`/api/mensa/menu?userId=${userId}&from=${data}&to=${data}`, { headers: hdr(userId) });
    const j = await r.json();
    if (j.success && j.data?.[0]) setOggi(j.data[0]);
  }, [userId, data]);

  useEffect(() => { loadMenu(); }, [loadMenu]);

  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="font-barlow font-black text-2xl text-kidville-green uppercase tracking-wide flex items-center gap-2">
            <ChefHat size={24} /> Cucina
          </h1>
          <p className="font-maven text-sm text-gray-500">Pasti del giorno, allergie e menù {sezione ? `· sezione ${sezione}` : ''} (sola lettura).</p>
        </header>

        {/* Menu del giorno */}
        <div className="bg-white rounded-2xl shadow-sm p-4 md:p-6 mb-4">
          <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-2 flex items-center gap-2"><UtensilsCrossed size={14} /> Menu di oggi</h3>
          {!oggi ? <p className="font-maven text-sm text-gray-400">Caricamento…</p> :
            oggi.chiuso ? <p className="font-maven text-sm text-red-500">Mensa chiusa {oggi.note ? `· ${oggi.note}` : ''}</p> :
            oggi.portate ? (
              <>
                <p className="font-maven text-sm text-kidville-green">
                  {[oggi.portate.primo, oggi.portate.secondo, oggi.portate.contorno, oggi.portate.frutta].filter(Boolean).join('  ·  ') || 'Menu non pubblicato'}
                </p>
                {allergeniDelGiorno(oggi.allergeni).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    <span className="font-maven text-[11px] text-gray-400 mr-1">Allergeni:</span>
                    {allergeniDelGiorno(oggi.allergeni).map(k => (
                      <span key={k} title={allergeneLabel(k)}
                        className="px-1.5 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-600 font-maven text-[10px] font-bold">
                        {allergeneEmoji(k)} {allergeneLabel(k)}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : <p className="font-maven text-sm text-gray-400">Menu non pubblicato per oggi.</p>}
        </div>

        {/* Report pasti + allergie */}
        <div className="bg-white rounded-2xl shadow-sm p-4 md:p-6">
          <MensaReport userId={userId} sezione={sezione} />
        </div>
      </div>
    </div>
  );
}

export default function CucinaPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <CucinaInner />
    </Suspense>
  );
}
