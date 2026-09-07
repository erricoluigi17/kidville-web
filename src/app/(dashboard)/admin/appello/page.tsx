'use client';

/**
 * APPELLO nel cockpit (segreteria/direzione).
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * IL BUCO CHE CHIUDE. Per la PRIMARIA la schermata esisteva già — è un re-export
 * della pagina docente dentro `ClasseShell` — ma si raggiungeva solo passando da
 * `/admin/primaria` → tab «Registri» → select classe → card «Appello»: tre clic e
 * nessuna voce di menu. Per NIDO e INFANZIA non esisteva affatto: l'appello 0-6 viveva
 * unicamente nell'area docente.
 *
 * UNA VOCE SOLA, non due. Il menu del cockpit è un elenco di LAVORI, non di motori:
 * «correggere l'appello di una classe» è un lavoro solo, e due voci costringerebbero
 * la segreteria a sapere quale motore sta dietro quale classe — una distinzione che
 * esiste nel nostro codice, non nella sua giornata.
 *
 * PERCHÉ LA PRIMARIA È UN LINK e non un montaggio qui dentro. Quella pagina legge
 * `useParams().sectionId`: senza un segmento di rotta non ha identità. E `ClasseShell`
 * non è una cornice decorativa — porta gli otto tab della classe, il nome e il badge
 * «Modalità segreteria». Rimontarla qui significherebbe due punti di montaggio per la
 * stessa schermata. Il link è più onesto: il registro della primaria vive nell'hub
 * della sua classe, e questa voce è la via diretta che mancava.
 *
 * PERCHÉ `sections/scoped` E NON `educator-sections`. Quest'ultima mappa i ruoli a
 * mano e non conosce `segreteria`: la fa cadere nel ramo «educator», che filtra per
 * sezioni assegnate — e la segreteria non ne ha. Risponderebbe `200 []`, cioè un
 * elenco vuoto e nessun errore. `sections/scoped` invece raggruppa già per sede,
 * restituisce `school_type` (i due fatti che servono qui) e la segreteria la tratta
 * bene. È la stessa route che `/admin/diary` usa per lo stesso scopo.
 *
 * ⚠️ NON è una vista di sola lettura. `requireDocente` ammette già `segreteria` e
 * `vedeTutteLeClassi` non la restringe: nascondere i comandi sarebbe teatro, perché il
 * permesso resta comunque. Ogni scrittura porta `registrato_da` con l'id di chi l'ha
 * fatta, e la rettifica di un'ora finisce in `audit_scritture_docente`.
 *
 * ⚠️ Il MOTIVO della giustifica (dato sanitario, art. 9 GDPR) non arriva a questa
 * schermata: `colonneConMotivo` non lo chiede nemmeno al database quando chi guarda
 * vede tutte le classi. È muta per costruzione, non per un `if` in questo file.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { CheckSquare, ExternalLink, LayoutGrid, CalendarDays } from 'lucide-react';
import { CockpitPage, PageHeader, CockpitSelect } from '@/components/ui/cockpit';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { AppelloGiornaliero } from '@/components/features/teacher/attendance/AppelloGiornaliero';
import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable';

interface SezioneScoped { id: string; name: string; school_type: string }
interface ScuolaScoped { scuolaId: string; scuolaNome: string; sezioni: SezioneScoped[] }

type Tab = 'oggi' | 'mese';

/** La primaria ha un motore suo, e una schermata sua che vive dentro `ClasseShell`. */
const ePrimaria = (tipo: string) => tipo === 'primaria';

function AdminAppelloInner() {
  const t = useTranslations('adminAltro');
  const { userId } = useSessionIdentity();
  const [scuole, setScuole] = useState<ScuolaScoped[]>([]);
  const [scuolaId, setScuolaId] = useState('');
  const [sezioneId, setSezioneId] = useState('');
  const [scopedLoaded, setScopedLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>('oggi');

  useEffect(() => {
    if (!userId) return;
    let active = true;
    // Tutti e tre i gradi in una richiesta sola: il selettore li mostra insieme,
    // etichettati, perché è la classe che la segreteria cerca — non il motore.
    fetch(`/api/admin/sections/scoped?grado=nido,infanzia,primaria&userId=${userId}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!active || !d?.success) return;
        const list: ScuolaScoped[] = (d.data ?? []).filter((g: ScuolaScoped) => g.sezioni.length > 0);
        setScuole(list);
        const first = list[0];
        setScuolaId(cur => cur || (first?.scuolaId ?? ''));
        setSezioneId(cur => cur || (first?.sezioni[0]?.id ?? ''));
      })
      .catch((err) => {
        // Senza questa riga la schermata direbbe «nessuna classe disponibile» sia
        // quando davvero non ce ne sono, sia quando l'elenco non si è potuto leggere:
        // due cose diverse, con rimedi opposti, indistinguibili a schermo e in SQL.
        logClient({ livello: 'error', evento: 'fetch', messaggio: `appello-classi-non-caricate: ${nomeErrore(err)}`, route: '/admin/appello' });
      })
      .finally(() => { if (active) setScopedLoaded(true); });
    return () => { active = false; };
  }, [userId]);

  const scuola = useMemo(() => scuole.find(s => s.scuolaId === scuolaId) ?? null, [scuole, scuolaId]);
  const sezione = useMemo(
    () => (scuola?.sezioni ?? []).find(s => s.id === sezioneId) ?? null,
    [scuola, sezioneId],
  );

  const pickScuola = (id: string) => {
    setScuolaId(id);
    setSezioneId(scuole.find(s => s.scuolaId === id)?.sezioni[0]?.id ?? '');
  };

  return (
    <CockpitPage max={1100}>
      <PageHeader
        eyebrow={t('appelloEyebrow')}
        icon={CheckSquare}
        title={t('appelloTitle')}
        subtitle={t('appelloSubtitle')}
      />

      {scopedLoaded && scuole.length === 0 ? (
        <div className="rounded-card bg-kidville-white p-8 text-center shadow-sm">
          <p className="font-maven text-sm text-kidville-sub">{t('appelloNessunaSezione')}</p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {scuole.length > 1 && (
              <label className="flex items-center gap-2">
                <span className="font-maven text-sm text-kidville-ink/70">{t('appelloLabelSede')}</span>
                <CockpitSelect
                  value={scuolaId}
                  onChange={pickScuola}
                  options={scuole.map(s => ({ value: s.scuolaId, label: s.scuolaNome }))}
                />
              </label>
            )}
            <label className="flex items-center gap-2">
              <span className="font-maven text-sm text-kidville-ink/70">{t('appelloLabelClasse')}</span>
              <CockpitSelect
                value={sezioneId}
                onChange={setSezioneId}
                options={(scuola?.sezioni ?? []).map(s => ({ value: s.id, label: `${s.name} (${s.school_type})` }))}
              />
            </label>
          </div>

          {sezione && ePrimaria(sezione.school_type) ? (
            <div className="rounded-card bg-kidville-white p-6 shadow-sm">
              <p className="font-maven mb-3 text-sm text-kidville-sub">
                {t('appelloPrimariaSpiegazione', { classe: sezione.name })}
              </p>
              <Link
                href={`/admin/primaria/${sezione.id}/appello${userId ? `?userId=${userId}` : ''}`}
                className="font-maven inline-flex min-h-11 items-center gap-2 rounded-pill bg-kidville-green px-5 text-sm text-kidville-yellow"
              >
                <ExternalLink size={14} /> {t('appelloPrimariaApri')}
              </Link>
            </div>
          ) : sezione ? (
            <>
              {/* Gli stessi due tab della schermata docente: la giornata e il mese. */}
              <div className="mb-4 flex gap-2">
                {([['oggi', LayoutGrid], ['mese', CalendarDays]] as const).map(([id, Icona]) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    aria-pressed={tab === id}
                    className={`font-maven inline-flex min-h-11 items-center gap-1.5 rounded-pill px-4 text-sm transition ${
                      tab === id ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-sub'
                    }`}
                  >
                    <Icona size={14} /> {t(id === 'oggi' ? 'appelloTabOggi' : 'appelloTabMese')}
                  </button>
                ))}
              </div>

              {tab === 'oggi' ? (
                <AppelloGiornaliero sezione={sezione.name} sectionId={sezione.id} />
              ) : (
                <MonthlyAttendanceTable sezione={sezione.name} sectionId={sezione.id} />
              )}
            </>
          ) : null}
        </>
      )}
    </CockpitPage>
  );
}

function AppelloFallback() {
  const t = useTranslations('adminAltro');
  return <div className="p-8 font-maven text-kidville-sub">{t('caricamento')}</div>;
}

export default function AdminAppelloPage() {
  // `useSearchParams` (dentro `useSessionIdentity`) esige il confine di Suspense.
  return (
    <Suspense fallback={<AppelloFallback />}>
      <AdminAppelloInner />
    </Suspense>
  );
}
