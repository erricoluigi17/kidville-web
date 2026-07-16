'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChefHat, UtensilsCrossed } from 'lucide-react';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';
import { allergeniDelGiorno, allergeneLabel, allergeneEmoji, type AllergeniPortate } from '@/lib/mensa/allergeni';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';

interface Portate { primo?: string; secondo?: string; contorno?: string; frutta?: string }
interface MenuGiorno { data: string; attivo: boolean; chiuso: boolean; portate: Portate | null; ingredienti?: Portate | null; allergeni?: AllergeniPortate | null; note?: string | null }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

function CucinaInner() {
  const params = useSearchParams();
  const { userId } = useSessionIdentity();
  // l'insegnante arriva con ?sezione=… per restare scoped alla sua classe
  const sezione = params.get('sezione') || undefined;
  const [oggi, setOggi] = useState<MenuGiorno | null>(null);

  const data = new Date().toISOString().slice(0, 10);
  const loadMenu = useCallback(async () => {
    if (!userId) return; // identità non risolta: resta "Caricamento…"
    try {
      const r = await fetch(`/api/mensa/menu?userId=${userId}&from=${data}&to=${data}`, { headers: hdr(userId) }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (j?.success && j.data?.[0]) setOggi(j.data[0]);
    } finally {
      // nessun flag di loading dedicato: l'UI mostra "Caricamento…" finché `oggi` è null
    }
  }, [userId, data]);

  useEffect(() => { loadMenu(); }, [loadMenu]);

  return (
    <CockpitPage max={1152}>
      <PageHeader
        eyebrow="Operativo"
        icon={ChefHat}
        title="Report Cucina"
        subtitle={`Pasti del giorno, allergie e menù ${sezione ? `· sezione ${sezione} ` : ''}(sola lettura).`}
      />

      {/* Menu del giorno */}
      <div className="bg-kidville-white rounded-2xl shadow-sm p-4 md:p-6 mb-4">
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-2 flex items-center gap-2"><UtensilsCrossed size={14} /> Menu di oggi</h3>
        {!oggi ? <p className="font-maven text-sm text-kidville-muted">Caricamento…</p> :
          oggi.chiuso ? <p className="font-maven text-sm text-kidville-error">Mensa chiusa {oggi.note ? `· ${oggi.note}` : ''}</p> :
          oggi.portate ? (
            <>
              <p className="font-maven text-sm text-kidville-green">
                {[oggi.portate.primo, oggi.portate.secondo, oggi.portate.contorno, oggi.portate.frutta].filter(Boolean).join('  ·  ') || 'Menu non pubblicato'}
              </p>
              {allergeniDelGiorno(oggi.allergeni).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  <span className="font-maven text-[11px] text-kidville-muted mr-1">Allergeni:</span>
                  {allergeniDelGiorno(oggi.allergeni).map(k => (
                    <span key={k} title={allergeneLabel(k)}
                      className="px-1.5 py-0.5 rounded-full bg-kidville-error-soft border border-kidville-error/30 text-kidville-error font-maven text-[10px] font-bold">
                      {allergeneEmoji(k)} {allergeneLabel(k)}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : <p className="font-maven text-sm text-kidville-muted">Menu non pubblicato per oggi.</p>}
      </div>

      {/* Report pasti + allergie */}
      <div className="bg-kidville-white rounded-2xl shadow-sm p-4 md:p-6">
        {userId && <MensaReport userId={userId} sezione={sezione} />}
      </div>
    </CockpitPage>
  );
}

export default function CucinaPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">Caricamento…</div>}>
      <CucinaInner />
    </Suspense>
  );
}
