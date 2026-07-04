'use client';

/**
 * Dropdown dei risultati della ricerca globale TopBar (M7.2). Interroga
 * /api/admin/search con debounce 300ms e mostra i 4 gruppi (alunni, staff,
 * classi, moduli) con lo stesso linguaggio visivo del dropdown SedeSelector
 * (card bianca SHADOW_FLOAT, righe hover cream). Il click naviga via router
 * preservando ?userId= quando presente; la chiusura su Esc/blur è gestita
 * dall'input in AdminTopBar (onMouseDown preventDefault evita il blur
 * prima del click sul risultato).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { GraduationCap, Users, LayoutGrid, FileText, SearchX } from 'lucide-react';
import { SHADOW_FLOAT } from '@/components/ui/Card';

interface SearchItem {
  id: string;
  label: string;
  sub: string;
  href: string;
}

interface SearchGroups {
  alunni: SearchItem[];
  utenti: SearchItem[];
  sezioni: SearchItem[];
  moduli: SearchItem[];
}

const GROUPS: { key: keyof SearchGroups; label: string; icon: LucideIcon }[] = [
  { key: 'alunni', label: 'Alunni', icon: GraduationCap },
  { key: 'utenti', label: 'Staff', icon: Users },
  { key: 'sezioni', label: 'Classi', icon: LayoutGrid },
  { key: 'moduli', label: 'Moduli', icon: FileText },
];

interface Props {
  query: string;
  userId: string | null;
  onNavigate: () => void;
}

export function AdminSearchPanel({ query, userId, onNavigate }: Props) {
  const router = useRouter();
  const [groups, setGroups] = useState<SearchGroups | null>(null);

  useEffect(() => {
    let active = true;
    const q = query.trim();
    const t = setTimeout(() => {
      if (q.length < 2) {
        if (active) setGroups(null);
        return;
      }
      const par = new URLSearchParams({ q });
      if (userId) par.set('userId', userId);
      fetch(`/api/admin/search?${par.toString()}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (active && j?.success) setGroups(j.data);
        })
        .catch(() => {});
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [query, userId]);

  const q = query.trim();
  if (q.length < 2) return null;
  const total = groups ? GROUPS.reduce((s, g) => s + groups[g.key].length, 0) : null;

  return (
    <div
      className="absolute left-0 right-0 top-[calc(100%+8px)] z-[60] max-h-[420px] overflow-y-auto rounded-[14px] bg-kidville-white p-1.5"
      style={{ boxShadow: SHADOW_FLOAT }}
    >
      {groups == null ? (
        <div className="px-3 py-3 font-maven text-[12.5px] text-kidville-muted">Ricerca in corso…</div>
      ) : total === 0 ? (
        <div className="flex items-center gap-2 px-3 py-3 font-maven text-[12.5px] text-kidville-muted">
          <SearchX size={15} /> Nessun risultato per “{q}”
        </div>
      ) : (
        GROUPS.map(({ key, label, icon: Icon }) =>
          groups[key].length > 0 ? (
            <div key={key} className="py-1">
              <div className="px-2.5 pb-1 pt-1.5 font-barlow text-[11px] font-bold uppercase tracking-[0.06em] text-kidville-neutral">
                {label}
              </div>
              {groups[key].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    router.push(userId ? `${item.href}?userId=${userId}` : item.href);
                    onNavigate();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left hover:bg-kidville-cream"
                >
                  <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-kidville-cream text-kidville-green">
                    <Icon size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-maven text-[13.5px] font-semibold text-kidville-ink">{item.label}</span>
                    <span className="block truncate font-maven text-[11.5px] text-kidville-muted">{item.sub}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null
        )
      )}
    </div>
  );
}
