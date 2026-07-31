'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { ChefHat, UtensilsCrossed } from 'lucide-react';
import { MensaReport } from '@/components/features/admin/mensa/MensaReport';
import { allergeniDelGiorno, useAllergeneLabel, allergeneEmoji, type AllergeniPortate } from '@/lib/mensa/allergeni';
import { CockpitPage, PageHeader } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { SedeRequired } from '@/lib/context/sede-context';

interface Portate { primo?: string; secondo?: string; contorno?: string; frutta?: string }
interface MenuGiorno { data: string; attivo: boolean; chiuso: boolean; portate: Portate | null; ingredienti?: Portate | null; allergeni?: AllergeniPortate | null; note?: string | null }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

function CucinaInner() {
  const t = useTranslations('adminMensa');
  const params = useSearchParams();
  const { userId } = useSessionIdentity();
  // l'insegnante arriva con ?sezione=… per restare scoped alla sua classe
  const sezione = params.get('sezione') || undefined;

  return (
    <CockpitPage max={1152}>
      <PageHeader
        eyebrow={t('eyebrowOperativo')}
        icon={ChefHat}
        title={t('cucinaTitolo')}
        subtitle={sezione ? t('cucinaSottotitoloConSezione', { sezione }) : t('cucinaSottotitolo')}
      />

      {/* La sede è OBBLIGATORIA, come nella sorella `/admin/mensa`. Questa pagina
          era rimasta all'era mono-sede: menu del giorno e report NOMINATIVO con i
          conflitti di allergene partivano senza `scuola_id`, e il server ripiegava
          sul primo plesso utile — una sede sola presentata come «la» cucina.
          Per la cuoca (un plesso solo) il guard è trasparente. */}
      <SedeRequired cosa={t('sedeRequiredCosa')}>
        {(scuolaId) => <CucinaContenuti userId={userId} scuolaId={scuolaId} sezione={sezione} />}
      </SedeRequired>
    </CockpitPage>
  );
}

function CucinaContenuti({ userId, scuolaId, sezione }: { userId: string | null; scuolaId: string; sezione?: string }) {
  const t = useTranslations('adminMensa');
  const allergeneLabel = useAllergeneLabel();
  const [oggi, setOggi] = useState<MenuGiorno | null>(null);

  const data = new Date().toISOString().slice(0, 10);
  const loadMenu = useCallback(async () => {
    if (!userId) return; // identità non risolta: resta "Caricamento…"
    try {
      const qs = new URLSearchParams({ userId, from: data, to: data, scuola_id: scuolaId });
      const r = await fetch(`/api/mensa/menu?${qs}`, { headers: hdr(userId) }).catch(() => null);
      const j = await r?.json().catch(() => null);
      if (j?.success && j.data?.[0]) setOggi(j.data[0]);
    } finally {
      // nessun flag di loading dedicato: l'UI mostra "Caricamento…" finché `oggi` è null
    }
  }, [userId, data, scuolaId]);

  useEffect(() => { loadMenu(); }, [loadMenu]);

  return (
    <>
      {/* Menu del giorno */}
      <div className="bg-kidville-white rounded-2xl shadow-sm p-4 md:p-6 mb-4">
        <h3 className="font-barlow font-bold text-kidville-green uppercase text-sm mb-2 flex items-center gap-2"><UtensilsCrossed size={14} /> {t('menuDiOggi')}</h3>
        {!oggi ? <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p> :
          oggi.chiuso ? <p className="font-maven text-sm text-kidville-error">{t('mensaChiusa')} {oggi.note ? `· ${oggi.note}` : ''}</p> :
          oggi.portate ? (
            <>
              <p className="font-maven text-sm text-kidville-green">
                {[oggi.portate.primo, oggi.portate.secondo, oggi.portate.contorno, oggi.portate.frutta].filter(Boolean).join('  ·  ') || t('menuNonPubblicato')}
              </p>
              {allergeniDelGiorno(oggi.allergeni).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  <span className="font-maven text-[11px] text-kidville-muted mr-1">{t('allergeni')}</span>
                  {allergeniDelGiorno(oggi.allergeni).map(k => (
                    <span key={k} title={allergeneLabel(k)}
                      className="px-1.5 py-0.5 rounded-full bg-kidville-error-soft border border-kidville-error/30 text-kidville-error font-maven text-[10px] font-bold">
                      {allergeneEmoji(k)} {allergeneLabel(k)}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : <p className="font-maven text-sm text-kidville-muted">{t('menuNonPubblicatoOggi')}</p>}
      </div>

      {/* Report pasti + allergie */}
      <div className="bg-kidville-white rounded-2xl shadow-sm p-4 md:p-6">
        {userId && <MensaReport userId={userId} scuolaId={scuolaId} sezione={sezione} />}
      </div>
    </>
  );
}

export default function CucinaPage() {
  const t = useTranslations('adminMensa');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-muted">{t('caricamento')}</div>}>
      <CucinaInner />
    </Suspense>
  );
}
