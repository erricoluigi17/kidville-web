'use client';

// =============================================================================
// ClasseShell — cornice persistente per-classe (header + 8 tab + contenuto).
// Componente UNICO condiviso tra il flusso docente (/teacher/primaria) e il
// cockpit Direzione/Segreteria (/admin/primaria). Riceve solo il PREFISSO di
// base; risolve internamente sectionId da useParams() e costruisce i percorsi.
// =============================================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useSearchParams } from 'next/navigation';
import { ArrowLeft, LayoutGrid, ClipboardList, CheckSquare, Star, AlertTriangle, CalendarDays, BarChart3, GraduationCap, FolderLock, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useTeacherIdentity } from '@/lib/auth/use-teacher-identity';

/**
 * I tab, in ordine. `seg` è il segmento dell'URL — che NON si traduce, è una
 * rotta — e `chiave` è l'etichetta nel catalogo `shared`.
 *
 * ⚠️ L'etichetta è una CHIAVE e non più una stringa: fino al 2026-08-03 questo
 * array conteneva «Panoramica», «Registro», «Appello»… scritti a mano, e il
 * componente non passava affatto da next-intl. Con l'interfaccia in inglese
 * l'intera cornice della classe — otto tab, il titolo e il badge — restava in
 * italiano, sia sotto /teacher sia dentro il cockpit. Non era una traduzione
 * dimenticata in un angolo: è la barra di navigazione di tutta l'area Primaria.
 */
const NAV = [
  { seg: '', chiave: 'classeShellTabPanoramica', icon: LayoutGrid },
  { seg: 'registro', chiave: 'classeShellTabRegistro', icon: ClipboardList },
  { seg: 'appello', chiave: 'classeShellTabAppello', icon: CheckSquare },
  { seg: 'valutazioni', chiave: 'classeShellTabValutazioni', icon: Star },
  { seg: 'note', chiave: 'classeShellTabNote', icon: AlertTriangle },
  { seg: 'orario', chiave: 'classeShellTabOrario', icon: CalendarDays },
  { seg: 'prospetto', chiave: 'classeShellTabProspetto', icon: BarChart3 },
  { seg: 'scrutinio', chiave: 'classeShellTabScrutinio', icon: GraduationCap },
  { seg: 'fascicolo', chiave: 'classeShellTabFascicolo', icon: FolderLock },
] as const;

export function ClasseShell({ basePrefix, children }: { basePrefix: string; children: React.ReactNode }) {
  const t = useTranslations('shared');
  const params = useParams();
  const search = useSearchParams();
  const pathname = usePathname();
  const sectionId = params?.sectionId as string;
  // Identità a due passaggi (SSR → idratazione): gli href dei tab sono
  // renderizzati, quindi l'uuid NON può essere letto da localStorage dentro il
  // render. `withUser` lo omette finché non è risolto: mai `userId=null`.
  const { userId, pronta, withUser } = useTeacherIdentity(search);
  const [nomeClasse, setNomeClasse] = useState('');
  const [ruolo, setRuolo] = useState('');
  // `?userId=` solo se c'è: la stringa «null» non è un id, e senza identità
  // locale la richiesta la risolve comunque la sessione (resolveIdentity).
  const q = userId ? `?userId=${encodeURIComponent(userId)}` : '';

  useEffect(() => {
    // `pronta` evita la chiamata del passaggio di idratazione, che partirebbe
    // senza identità e verrebbe subito rifatta: una GET in più per pagina.
    if (!sectionId || !pronta) return;
    fetch(`/api/primaria/classe/${sectionId}${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data.section) setNomeClasse(d.data.section.name);
      })
      .catch(() => {});
  }, [sectionId, q, pronta]);

  useEffect(() => {
    if (!pronta) return;
    fetch(`/api/primaria/me${q}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setRuolo(d.data.ruolo || ''); })
      .catch(() => {});
  }, [q, pronta]);

  // Staff = opera per conto del docente titolare (admin/coordinator/segreteria).
  const isStaff = ruolo === 'admin' || ruolo === 'coordinator' || ruolo === 'segreteria';
  const base = `${basePrefix}/${sectionId}`;

  // Nel cockpit (/admin) la cornice persistente (sidebar desktop / topbar mobile)
  // è fornita da admin/layout: ClasseShell NON deve comportarsi da pagina a sé
  // (niente min-h-screen, niente header sticky a tutto schermo che copre la
  // topbar mobile z-30). Sotto /teacher resta lo shell standalone invariato.
  const inCockpit = basePrefix.startsWith('/admin');

  return (
    <div className={inCockpit ? '' : 'min-h-screen bg-kidville-cream/40'}>
      {/* top: sotto /teacher la var --kv-appbar-h (layout) fa scorrere lo sticky
          SOTTO la AppBar persistente; sotto /admin la var non esiste → 0px. */}
      <header className={`${inCockpit ? 'lg:sticky lg:top-0' : 'sticky top-[var(--kv-appbar-h,0px)]'} z-20 bg-kidville-green`}>
        <div className="max-w-5xl mx-auto px-4 pt-3">
          <div className="flex items-center gap-3 pb-3">
            {/* Dentro c'è solo una freccia: senza nome uno screen reader annuncia
                «link», e basta (WCAG 4.1.2). Il nome ora è TRADOTTO: un
                `aria-label` italiano dentro un'interfaccia inglese è la voce che
                l'utente sente, non un dettaglio che si vede solo leggendo. */}
            <Link href={withUser(basePrefix)} aria-label={t('classeShellIndietro')} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25">
              <ArrowLeft size={18} />
            </Link>
            <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-white">
              {/* Il nome della classe è un DATO («3 ANNI A»): resta com'è, e la
                  frase che lo contiene si interpola invece di concatenarsi —
                  «Class 3A» in inglese non ha lo stesso ordine dell'italiano. */}
              {nomeClasse ? t('classeShellClasse', { nome: nomeClasse }) : t('classeShellClasseSenzaNome')}
            </h1>
            <span className="rounded-pill bg-white/15 px-2.5 py-0.5 text-[11px] font-barlow font-bold uppercase tracking-wide text-white">
              {t('classeShellPrimaria')}
            </span>
            {isStaff && (
              <span className="rounded-pill bg-kidville-yellow px-2.5 py-0.5 text-[11px] font-barlow font-bold uppercase tracking-wide text-kidville-green">
                {t('classeShellModalitaSegreteria')}
              </span>
            )}
          </div>
          <nav className="flex gap-1.5 overflow-x-auto pb-3">
            {NAV.map(({ seg, chiave, icon: Icon }) => {
              const href = withUser(seg ? `${base}/${seg}` : base);
              const active = seg ? pathname === `${base}/${seg}` : pathname === base;
              return (
                <Link
                  key={seg || 'panoramica'}
                  href={href}
                  className={`font-barlow inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-[12.5px] font-bold uppercase tracking-wide transition ${
                    active ? 'bg-white text-kidville-green' : 'bg-white/14 text-white hover:bg-white/25'
                  }`}
                >
                  <Icon size={14} />
                  {t(chiave)}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Avviso-ponte NON bloccante: mostrato UNA sola volta (solo su Panoramica),
          non ripetuto su ogni tab della classe. */}
      {isStaff && pathname === base && (
        <div className="max-w-5xl mx-auto px-4 pt-3">
          <p className="font-maven flex items-start gap-2 rounded-card bg-kidville-warn-soft px-3 py-2 text-xs text-kidville-warn">
            <Info size={14} className="mt-0.5 shrink-0" />
            {t('classeShellAvvisoSegreteria')}
          </p>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-5">{children}</main>
    </div>
  );
}
