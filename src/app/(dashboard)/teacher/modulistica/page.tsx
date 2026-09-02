'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Users, HeartPulse } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { logClient } from '@/lib/logging/client';
import { PannelloSemaforo } from '@/components/features/teacher/PannelloSemaforo';
import { PannelloCertificatiMedici } from '@/components/features/teacher/PannelloCertificatiMedici';
import type { ModuloSelezionabile } from '@/components/features/teacher/filtri-modulistica';

interface FormTemplate {
  id: string;
  title: string;
  description: string;
  target_classes: string[];
}

/**
 * ─── «MODULISTICA» DEL DOCENTE — la pagina tiene la CORNICE, i pannelli i filtri ─
 *
 * La sezione è la cornice di tutte e due le schede: la stessa nel semaforo e nei
 * certificati, e per questo vive QUI e non dentro una delle due barre. I pannelli
 * si montano con `key={sezione}` — cambiando sezione rinascono già sulla sezione
 * nuova, coi moduli di QUELLA sezione — e la riportano indietro con `onSezione`
 * invece di tenersene una copia. Il perché per esteso sta in `PannelloSemaforo`.
 *
 * ⚠️ `<Suspense>`: i pannelli montano `useFiltri`, che legge `useSearchParams()`.
 * Senza confine di sospensione questa rotta statica cade in build con
 * `missing-suspense-with-csr-bailout` (il lock
 * `__tests__/architecture/use-search-params-con-suspense.test.ts` racconta perché
 * la stessa pagina del genitore ha imparato la lezione prima di questa).
 */
function ContenutoModulistica() {
  const t = useTranslations('teacherServizi');
  const { userId: teacherId } = useSessionIdentity();
  const parametri = useSearchParams();

  const [sezioni, setSezioni] = useState<string[]>([]);
  // Un `?class_name=` incollato apre la sezione giusta. Resta una PROPOSTA finché
  // l'elenco vero non arriva: se non è una sezione di questo docente viene
  // scartata qui sotto, non passata alla barra — una cornice inesistente
  // produrrebbe un elenco vuoto che sembra un archivio vuoto.
  const [sezione, setSezione] = useState(() => parametri.get('class_name') ?? '');
  const [moduli, setModuli] = useState<ModuloSelezionabile[]>([]);
  /**
   * La sezione PER CUI i moduli in `moduli` sono stati letti — non un booleano
   * «pronti».
   *
   * 🔴 Con un booleano il difetto era questo, ed è stato misurato: la prima lettura
   * parte con la sezione ancora vuota, `moduliPronti` diventa `true` e il pannello
   * nasce con zero moduli; quando la sezione arriva, la `key` cambia e il pannello
   * rinasce — ma i moduli di QUELLA sezione non sono ancora tornati, quindi rinasce
   * di nuovo senza. Da lì in poi la `key` non cambia più: la barra resta senza
   * modulo scelto per sempre, il semaforo non fa nessuna richiesta e l'elenco è
   * vuoto senza un errore, senza un log e senza niente da toccare.
   *
   * Confrontare la sezione dei moduli con quella corrente rende la condizione di
   * nascita ESATTA: il pannello si monta quando la risposta che ha in mano è la
   * risposta alla domanda che sta facendo.
   */
  const [sezioneDeiModuli, setSezioneDeiModuli] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'semaforo' | 'medici'>('semaforo');
  const [toast, setToast] = useState('');

  // Sezione reale del docente (niente 'Girasoli' cablato): da educator-sections.
  useEffect(() => {
    if (!teacherId) return;
    fetch(`/api/educator-sections?userId=${teacherId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const trovate: string[] = d?.sectionNames ?? [];
        setSezioni(trovate);
        setSezione((precedente) => (trovate.includes(precedente) ? precedente : trovate[0] ?? ''));
      })
      .catch((err) => {
        // Un catch che non logga è un bug: senza sezioni la pagina resta ferma
        // sullo spinner, e nessuno saprebbe distinguerlo da «nessuna sezione».
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `sezioni del docente: ${err instanceof Error ? err.name : 'errore di rete'}`,
          route: '/teacher/modulistica',
        });
      });
  }, [teacherId]);

  const caricaModuli = useCallback(async () => {
    if (!teacherId) return; // identità non risolta: lo spinner resta
    try {
      // Il fallimento è un VALORE e non un `catch`: uno `setState` dentro un
      // `catch` gira in modo sincrono quando `fetch` lancia sincrono, e in un
      // effetto è ciò che `react-hooks/set-state-in-effect` vieta (ERRORE).
      const res = await fetch('/api/admin/forms').catch(() => null);
      const dati = await res?.json().catch(() => null);
      if (!res?.ok || !Array.isArray(dati)) {
        logClient({
          livello: res ? 'warn' : 'error',
          evento: 'fetch',
          messaggio: 'moduli di autorizzazione non letti',
          route: '/teacher/modulistica',
          ...(res ? { stato: res.status } : null),
        });
        setModuli([]);
        return;
      }
      const dellaSezione = (dati as FormTemplate[]).filter((m) => m.target_classes?.includes(sezione));
      setModuli(dellaSezione.map((m) => ({ id: m.id, title: m.title })));
    } finally {
      // Su ogni uscita: se restasse indietro, la pagina non monterebbe mai il
      // pannello e resterebbe sullo spinner per sempre.
      setSezioneDeiModuli(sezione);
    }
  }, [teacherId, sezione]);

  useEffect(() => {
    void caricaModuli();
  }, [caricaModuli]);

  const mostraToast = (messaggio: string) => {
    setToast(messaggio);
    setTimeout(() => setToast(''), 3000);
  };

  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col px-4 pt-5">
      {/* Header verde (DR) */}
      <PageHeaderCard
        eyebrow={t('modulisticaEyebrow')}
        title={t('modulisticaTitolo')}
        subtitle={t('modulisticaSottotitolo', { sezione: sezione || '…' })}
      />

      {/* Tabs */}
      <div className="mt-5 mb-6 flex gap-4 border-b border-kidville-line">
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'semaforo' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => setActiveTab('semaforo')}
        >
          <Users size={16} aria-hidden="true" /> {t('modulisticaTabSemaforo')}
        </button>
        <button
          className={`pb-3 px-2 font-barlow font-bold uppercase tracking-wide transition-colors flex items-center gap-1.5 ${activeTab === 'medici' ? 'text-kidville-green border-b-2 border-kidville-green' : 'text-kidville-muted hover:text-kidville-ink'}`}
          onClick={() => setActiveTab('medici')}
        >
          <HeartPulse size={16} aria-hidden="true" /> {t('modulisticaTabMedici')}
        </button>
      </div>

      {/* La cornice deve esistere PRIMA della barra: finché i moduli della sezione
          non sono noti, una barra montata adesso nascerebbe senza modulo scelto e
          nessun effetto avrebbe il diritto di riscriverle lo stato. */}
      {!teacherId || sezioneDeiModuli !== sezione ? (
        <div className="flex min-h-[40vh] flex-1 flex-col items-center justify-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-kidville-green/30 border-t-kidville-green" />
          <p className="font-maven text-kidville-muted">{t('modulisticaCaricamento')}</p>
        </div>
      ) : activeTab === 'semaforo' ? (
        <PannelloSemaforo
          key={`semaforo:${sezione}`}
          teacherId={teacherId}
          sezioni={sezioni}
          sezione={sezione}
          moduli={moduli}
          onSezione={setSezione}
          onToast={mostraToast}
        />
      ) : (
        <PannelloCertificatiMedici
          key={`medici:${sezione}`}
          teacherId={teacherId}
          sezioni={sezioni}
          sezione={sezione}
          onSezione={setSezione}
          onToast={mostraToast}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className="animate-slideIn fixed bottom-6 right-6 z-[60] flex items-center gap-3 rounded-2xl bg-kidville-green px-6 py-4 font-maven font-semibold text-white shadow-2xl">
          {toast}
        </div>
      )}

      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out forwards;
        }
        .animate-slideIn {
          animation: slideIn 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  );
}

export default function TeacherModulisticaPage() {
  return (
    <Suspense fallback={null}>
      <ContenutoModulistica />
    </Suspense>
  );
}
