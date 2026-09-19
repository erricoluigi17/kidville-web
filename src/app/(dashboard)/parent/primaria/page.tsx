'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckSquare, ClipboardList, FileText, BarChart3, BookOpen, CalendarDays, ChevronRight } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';

/**
 * Le sezioni dell'hub «Scuola», nell'ordine in cui il genitore le legge.
 *
 * ⚠️ «Compiti» sta QUI, e non solo nel menu. Fino al 2026-09-19 la bacheca dei
 * compiti (`/parent/compiti`) esisteva completa ma questo elenco ne aveva sei di
 * voci, e nessuna era quella: l'hub è la destinazione della tab «Scuola» della
 * bottom-nav *e* della scorciatoia in home, quindi la via naturale finiva su una
 * schermata che i compiti non li nominava. Restavano Menu → Didattica → Compiti
 * e il tocco su una notifica push — e i genitori riferivano di non vedere i
 * compiti mentre il database diceva che i compiti c'erano.
 *
 * L'ICONA è la stessa della voce di menu (`BottomNav`, id `compiti`):
 * `ClipboardList`. I TOKEN sono quelli canonici della funzione «compiti»
 * (`TINTA_FUNZIONE.compiti` = `#E6720A` = `--color-kidville-warn`), quindi la
 * coppia `warn-soft`/`warn`, già usata qui sotto.
 *
 * ⚠️ Il colore RESO, però, non è lo stesso del menu. `globals.css:1121`
 * ridipinge `.text-kidville-warn` con `--color-kidville-warn-strong`
 * (`#A64F09`), perché `#E6720A` sulle fasce chiare come `warn-soft` sta sotto i
 * 4,5:1 di WCAG AA; nel menu la tinta arriva invece come stile INLINE
 * (`style={{ color: it.tint }}`), che quella regola non aggancia, e lì resta
 * `#E6720A`. Quindi: menu `#E6720A`, hub e home `#A64F09`. È una divergenza
 * deliberata, ed è il prezzo del contrasto, non una svista da allineare.
 *
 * La voce «Note» qui sotto usa la STESSA coppia Tailwind e subisce lo STESSO
 * remap, ma la sua divergenza non è la stessa: la sua tinta canonica è
 * `TINTA_FUNZIONE.note` = `#B5651D` (`kv-subj-storia`), non `#E6720A`. Quindi
 * «Compiti» va `#E6720A` → `#A64F09` e «Note» `#B5651D` → `#A64F09`: stessa
 * destinazione, due partenze.
 */
const SEZIONI = [
  { href: '/parent/lezioni', labelKey: 'hubLezioni', subKey: 'hubLezioniSub', icon: BookOpen, bg: 'bg-kidville-info-soft', fg: 'text-kidville-info' },
  { href: '/parent/compiti', labelKey: 'hubCompiti', subKey: 'hubCompitiSub', icon: ClipboardList, bg: 'bg-kidville-warn-soft', fg: 'text-kidville-warn' },
  { href: '/parent/primaria/orario', labelKey: 'hubOrario', subKey: 'hubOrarioSub', icon: CalendarDays, bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
  { href: '/parent/primaria/valutazioni', labelKey: 'hubValutazioni', subKey: 'hubValutazioniSub', icon: BarChart3, bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
  { href: '/parent/primaria/note', labelKey: 'hubNote', subKey: 'hubNoteSub', icon: AlertTriangle, bg: 'bg-kidville-warn-soft', fg: 'text-kidville-warn' },
  { href: '/parent/primaria/assenze', labelKey: 'hubPresenze', subKey: 'hubPresenzeSub', icon: CheckSquare, bg: 'bg-kidville-yellow-soft', fg: 'text-kidville-yellow-dark' },
  { href: '/parent/primaria/pagelle', labelKey: 'hubPagelle', subKey: 'hubPagelleSub', icon: FileText, bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' },
] as const;

export default function PrimariahubPage() {
  const t = useTranslations('parentPrimaria');
  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow={t('eyebrow')}
        title={t('hubTitolo')}
        className="mb-5"
      />

      <div className="space-y-3">
        {SEZIONI.map((s) => {
          const Icon = s.icon;
          return (
            <Link key={s.href} href={s.href}>
              <div className="flex items-center gap-4 rounded-card border border-kidville-line bg-white p-4 shadow-sm active:scale-[0.98] transition-transform">
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${s.bg} ${s.fg}`}>
                  <Icon size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{t(s.labelKey)}</p>
                  <p className="font-maven text-xs text-kidville-muted">{t(s.subKey)}</p>
                </div>
                <ChevronRight size={18} className="text-kidville-muted/60 flex-shrink-0" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
