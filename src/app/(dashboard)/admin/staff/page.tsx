'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarClock, Users } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { StaffPanel } from '@/components/features/admin/settings/StaffPanel';
import { ScadenzeDocumenti, statoDaUrl } from '@/components/features/admin/personale/ScadenzeDocumenti';
import { CockpitPage, PageHeader, Tabs } from '@/components/ui/cockpit';

/**
 * `/admin/staff` — due linguette: il PERSONALE (ruoli, sede, classi) e le
 * SCADENZE dei documenti d'identità.
 *
 * ⚠️ `?tab=` E `?stato=` SI LEGGONO DALL'URL, ed è la ragione per cui questa
 * pagina esiste in questa forma.
 *
 * Il collegamento della notifica di scadenza punta a
 * `/admin/staff?tab=scadenze&stato=scaduto`, e deve atterrare sul pannello
 * GIÀ FILTRATO. Una notifica che apre una lista da rifiltrare a mano è una
 * notifica che si impara a ignorare: la prima volta si cerca la riga, la
 * seconda si rimanda, la terza non si apre più — ed è la stessa dinamica per cui
 * il modulo dell'anagrafica ha un allarme a soglie invece che un promemoria
 * quotidiano. Il valore di `?stato=` è validato (`statoDaUrl`): un valore
 * inventato non filtra niente invece di svuotare la tabella in silenzio.
 *
 * Il tab NON viene riscritto nell'URL quando si clicca: è una lettura sola, e
 * basta a far funzionare il bersaglio della notifica. Chi vorrà l'indirizzo
 * condivisibile dovrà spingere lo stato nel router — che è un'altra cosa, e ha
 * il suo costo (una `push` a ogni clic, e il tasto Indietro che ripercorre i
 * filtri invece di uscire dalla pagina).
 */

type StaffTab = 'personale' | 'scadenze';

function StaffInner() {
  const { userId } = useSessionIdentity();
  const t = useTranslations('adminStudents');
  const searchParams = useSearchParams();

  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<StaffTab>(tabParam === 'scadenze' ? 'scadenze' : 'personale');
  // Lo stato iniziale del filtro si legge UNA volta, all'apertura: è il
  // bersaglio della notifica, non un controllo che debba restare sincronizzato.
  const [statoIniziale] = useState(() => statoDaUrl(searchParams.get('stato')));

  return (
    <CockpitPage max={1100}>
      <PageHeader
        icon={activeTab === 'scadenze' ? CalendarClock : Users}
        title={t('staffPageTitolo')}
        subtitle={t('staffPageSottotitolo')}
      />
      <Tabs
        value={activeTab}
        onChange={(id) => setActiveTab(id as StaffTab)}
        options={[
          { id: 'personale', label: t('scadTabPersonale'), icon: Users },
          { id: 'scadenze', label: t('scadTabScadenze'), icon: CalendarClock },
        ]}
      />
      {activeTab === 'scadenze' ? (
        <ScadenzeDocumenti userId={userId} statoIniziale={statoIniziale} />
      ) : (
        userId && <StaffPanel userId={userId} />
      )}
    </CockpitPage>
  );
}

export default function AdminStaffPage() {
  return (
    <Suspense fallback={null}>
      <StaffInner />
    </Suspense>
  );
}
