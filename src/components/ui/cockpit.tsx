'use client';

/**
 * Primitive del COCKPIT Direzione/Segreteria (desktop). Ricostruzione on-token
 * del design DR (`admin/ui.jsx` + `design-export/ds.css`): PageHeader, SectionTitle,
 * StatCard, Tabs, Toolbar, Select, Donut, Bar, IconChip, Drawer, Live, Toggle e le
 * classi tabella. Solo LIGHT: nessun `dark:`, solo token `kidville-*`.
 *
 * Colori-di-stato dinamici (grado/materia o accenti per-dato) passano via prop
 * `tone` mappata sui token semantici (green/info/warn/error/success/neutral/yellow).
 */
import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Search, X, ChevronDown, Check } from 'lucide-react';
import { cx } from '@/lib/ui/cx';
import { SHADOW_CARD, SHADOW_FLOAT } from '@/components/ui/Card';
import { useSediAttive } from '@/lib/context/sede-context';

export type Tone = 'green' | 'info' | 'warn' | 'error' | 'success' | 'neutral' | 'yellow';

/** Classi token per ciascun tono: testo forte, accento bordo, chip morbido. */
export const TONE: Record<Tone, { text: string; border: string; chipBg: string; softBg: string; dot: string }> = {
  green:   { text: 'text-kidville-green',   border: 'border-kidville-green',   chipBg: 'bg-kidville-green/[0.10]',   softBg: 'bg-kidville-green-soft',   dot: 'bg-kidville-green' },
  info:    { text: 'text-kidville-info',    border: 'border-kidville-info',    chipBg: 'bg-kidville-info/[0.10]',    softBg: 'bg-kidville-info-soft',    dot: 'bg-kidville-info' },
  warn:    { text: 'text-kidville-warn',    border: 'border-kidville-warn',    chipBg: 'bg-kidville-warn/[0.10]',    softBg: 'bg-kidville-warn-soft',    dot: 'bg-kidville-warn' },
  error:   { text: 'text-kidville-error',   border: 'border-kidville-error',   chipBg: 'bg-kidville-error/[0.10]',   softBg: 'bg-kidville-error-soft',   dot: 'bg-kidville-error' },
  success: { text: 'text-kidville-success', border: 'border-kidville-success', chipBg: 'bg-kidville-success/[0.10]', softBg: 'bg-kidville-success-soft', dot: 'bg-kidville-success' },
  neutral: { text: 'text-kidville-neutral', border: 'border-kidville-neutral', chipBg: 'bg-kidville-neutral/[0.10]', softBg: 'bg-kidville-neutral-soft', dot: 'bg-kidville-neutral' },
  yellow:  { text: 'text-kidville-yellow',  border: 'border-kidville-yellow',  chipBg: 'bg-kidville-yellow/[0.15]',  softBg: 'bg-kidville-yellow-soft',  dot: 'bg-kidville-yellow' },
};

/** Contenitore pagina cockpit (larghezza desktop, padding DR). */
export function CockpitPage({ children, className, max = 1360 }: { children: React.ReactNode; className?: string; max?: number }) {
  return (
    <div className={cx('mx-auto px-6 pb-16 pt-6 sm:px-8', className)} style={{ maxWidth: max }}>
      {children}
    </div>
  );
}

/** Chip icona quadrato colorato (accento morbido). */
export function IconChip({ icon: Icon, tone = 'green', size = 44, radius = 12, solid = false }: { icon: LucideIcon; tone?: Tone; size?: number; radius?: number; solid?: boolean }) {
  const t = TONE[tone];
  return (
    <div
      className={cx('flex shrink-0 items-center justify-center', solid ? cx(t.softBg.replace('-soft', ''), 'text-kidville-white') : cx(t.chipBg, t.text))}
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={2.1} />
    </div>
  );
}

/** Header pagina: chip icona + titolo barlow-black + sottotitolo + azioni. */
export function PageHeader({ icon: Icon, title, subtitle, actions, eyebrow }: { icon?: LucideIcon; title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3.5">
        {Icon && (
          <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[15px] bg-kidville-green text-kidville-yellow">
            <Icon size={26} strokeWidth={2.1} />
          </div>
        )}
        <div className="min-w-0">
          {eyebrow && <div className="font-barlow text-[12px] font-bold uppercase tracking-[0.14em] text-kidville-warn">{eyebrow}</div>}
          <h1 className="font-barlow text-[34px] font-black uppercase leading-none text-kidville-green">{title}</h1>
          {subtitle && <p className="mt-1 font-maven text-sm text-kidville-ink/80">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2.5">{actions}</div>}
    </div>
  );
}

/** Titolo di sezione dentro una card. */
export function SectionTitle({ icon: Icon, title, sub, action }: { icon?: LucideIcon; title: string; sub?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3.5 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && <span className="flex shrink-0 text-kidville-green"><Icon size={20} strokeWidth={2.1} /></span>}
        <div className="min-w-0">
          <h2 className="font-barlow text-[19px] font-extrabold uppercase leading-[1.05] tracking-[0.01em] text-kidville-green">{title}</h2>
          {sub && <div className="mt-0.5 font-maven text-[12.5px] text-kidville-muted">{sub}</div>}
        </div>
      </div>
      {action}
    </div>
  );
}

/** Stat-card con accento (bordo left o top) + chip icona + valore grande. */
export function StatCard({ icon: Icon, label, value, sub, tone = 'green', accent = 'left' }: { icon?: LucideIcon; label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone; accent?: 'left' | 'top' }) {
  const t = TONE[tone];
  return (
    <div
      className={cx('flex items-center gap-3 rounded-card bg-kidville-white px-4 py-3.5', accent === 'left' ? cx('border-l-4', t.border) : cx('border-t-4', t.border))}
      style={{ boxShadow: SHADOW_CARD }}
    >
      {Icon && (
        <div className={cx('flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[11px]', t.chipBg, t.text)}>
          <Icon size={19} strokeWidth={2.1} />
        </div>
      )}
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className={cx('font-barlow text-[26px] font-black leading-none', t.text)}>{value}</span>
          {sub && <span className="font-maven text-xs text-kidville-muted">{sub}</span>}
        </div>
        <div className="mt-1 font-barlow text-[11.5px] font-bold uppercase tracking-[0.04em] text-kidville-neutral">{label}</div>
      </div>
    </div>
  );
}

export interface TabOption { id: string; label: string; count?: number; icon?: LucideIcon }

/** Tabs sottolineate (DR ui.jsx Tabs). */
export function Tabs({ value, options, onChange, className }: { value: string; options: TabOption[]; onChange: (id: string) => void; className?: string }) {
  return (
    <div className={cx('mb-5 flex flex-wrap gap-1 border-b-[1.5px] border-kidville-line', className)}>
      {options.map((o) => {
        const on = value === o.id;
        const Icon = o.icon;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cx('relative mr-3 inline-flex items-center gap-1.5 px-1 pb-3 font-barlow text-base font-extrabold uppercase tracking-[0.02em] transition-colors', on ? 'text-kidville-green' : 'text-kidville-neutral hover:text-kidville-green')}
          >
            {Icon && <Icon size={17} strokeWidth={2.1} />}
            {o.label}
            {o.count != null && (
              <span className={cx('inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-pill px-1.5 font-barlow text-[11px] font-extrabold', on ? 'bg-kidville-green text-kidville-white' : 'bg-kidville-neutral-soft text-kidville-neutral')}>
                {o.count}
              </span>
            )}
            {on && <span className="absolute inset-x-0 -bottom-[1.5px] h-[3px] rounded-[3px] bg-kidville-green" />}
          </button>
        );
      })}
    </div>
  );
}

/** Toolbar: ricerca (opzionale) + filtri/azioni a destra. */
export function Toolbar({ search, onSearch, placeholder = 'Cerca…', children }: { search?: string; onSearch?: (v: string) => void; placeholder?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {onSearch && (
        <div className="relative min-w-[220px] flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-kidville-neutral"><Search size={17} /></span>
          <input
            value={search ?? ''}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={placeholder}
            className="h-[42px] w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white pl-10 pr-3.5 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green"
          />
        </div>
      )}
      {children}
    </div>
  );
}

/** Select brandizzato (native). */
export function CockpitSelect({ value, onChange, options, className }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx('h-[42px] cursor-pointer rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 font-maven text-[13.5px] text-kidville-ink outline-none focus:border-kidville-green', className)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Barra di avanzamento orizzontale. `colorVar` per tinte per-dato (es. var(--kv-grade-*)). */
export function Bar({ value, max, tone = 'green', colorVar, height = 8 }: { value: number; max: number; tone?: Tone; colorVar?: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  return (
    <div className="w-full overflow-hidden rounded-pill bg-kidville-neutral-soft" style={{ height }}>
      <div className={cx('h-full rounded-pill', !colorVar && TONE[tone].dot)} style={{ width: pct + '%', ...(colorVar ? { background: colorVar } : null) }} />
    </div>
  );
}

/** Anello donut SVG con etichetta centrale. */
export function Donut({ value, max, size = 116, stroke = 12, label, sub, tone = 'green', colorVar }: { value: number; max: number; size?: number; stroke?: number; label: React.ReactNode; sub?: React.ReactNode; tone?: Tone; colorVar?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const color = colorVar ?? {
    green: '#006A5F', info: '#2A6FDB', warn: '#E6720A', error: '#E53935', success: '#43A047', neutral: '#8A958F', yellow: '#FDC400',
  }[tone];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF1EE" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <div className="font-barlow font-black text-kidville-green" style={{ fontSize: size * 0.27 }}>{label}</div>
        {sub && <div className="mt-0.5 font-maven text-[11px] text-kidville-muted">{sub}</div>}
      </div>
    </div>
  );
}

/** Indicatore "Live" con pallino pulsante. */
export function Live({ label = 'Live' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-maven text-xs font-semibold text-kidville-success">
      <span className="h-2 w-2 animate-pulse rounded-pill bg-kidville-success" />
      {label}
    </span>
  );
}

/** Toggle switch (on/off). */
export function Toggle({ on, onClick, disabled }: { on: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cx('relative h-[26px] w-[44px] shrink-0 rounded-pill transition-colors disabled:opacity-50', on ? 'bg-kidville-green' : 'bg-kidville-neutral-soft')}
    >
      <span className={cx('absolute top-[3px] h-5 w-5 rounded-pill bg-kidville-white shadow transition-transform', on ? 'translate-x-[21px]' : 'translate-x-[3px]')} />
    </button>
  );
}

/* ── Tabella cockpit: classi condivise (th uppercase muted, righe hover cream) ── */
export const TABLE_WRAP = 'overflow-x-auto';
export const TABLE = 'w-full border-collapse';
export const TH = 'whitespace-nowrap px-3 pb-2.5 text-left font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-neutral';
export const TD = 'border-t border-kidville-line px-3 py-2.5 align-middle';
export const TROW = 'transition-colors hover:bg-kidville-cream';

/** Drawer / slide-over destro con scrim. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 460 }: { open: boolean; onClose: () => void; title?: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[95]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-kidville-ink/30 backdrop-blur-[1px]" onClick={onClose} />
      <div
        className="absolute inset-y-0 right-0 flex max-w-[92%] flex-col bg-kidville-white"
        style={{ width, boxShadow: SHADOW_FLOAT }}
      >
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-3 border-b border-kidville-line px-6 py-5">
            <div className="min-w-0">
              {typeof title === 'string' ? <h2 className="font-barlow text-2xl font-black uppercase leading-none text-kidville-green">{title}</h2> : title}
              {subtitle && <div className="mt-1 font-maven text-[13px] text-kidville-muted">{subtitle}</div>}
            </div>
            <button type="button" onClick={onClose} aria-label="Chiudi" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green">
              <X size={19} />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="border-t border-kidville-line px-6 py-4">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Selettore sede della TopBar: MULTI-select (Fase B). Le sedi accessibili e la
 * selezione vivono nel contesto condiviso (@/lib/context/sede-context), che
 * persiste il cookie `sedi_attive` e fa ri-scopare i dati server-side. Il
 * dropdown resta aperto durante il toggle (selezione multipla); "Tutte le sedi"
 * azzera il filtro. Con una sola sede accessibile il toggle è inerte (già "tutte").
 */
export function SedeSelector({ userId }: { userId?: string | null }) {
  const { sedi, effettive, toggle, tutte } = useSediAttive();
  const [open, setOpen] = useState(false);
  const [totAlunni, setTotAlunni] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = userId ? `?userId=${userId}` : '';
    // `x-sedi`: segnala lo scope attivo (il server scopa dal cookie) e fa
    // ri-conteggiare al cambio selezione. effettive è così referenziato (deps).
    fetch(`/api/admin/dashboard${q}`, { headers: { 'x-sedi': effettive.join(',') } })
      .then((r) => r.json())
      .then((d) => { const n = d?.studenti?.iscritti ?? d?.data?.studenti?.iscritti; if (typeof n === 'number') setTotAlunni(n); })
      .catch(() => {});
  }, [userId, effettive]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const sel = new Set(effettive);
  const tutteAttive = effettive.length === sedi.length; // include il caso "cookie vuoto"
  const strutture = (n: number) => `${n} struttur${n === 1 ? 'a' : 'e'}`;
  const nome = tutteAttive
    ? 'Tutte le sedi'
    : effettive.length === 1
      ? (sedi.find((s) => s.id === effettive[0])?.nome ?? '1 sede')
      : `${effettive.length} sedi`;
  const meta = `${totAlunni != null ? `${totAlunni} alunni · ` : ''}${strutture(tutteAttive ? sedi.length : effettive.length)}`;

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2.5 rounded-[12px] bg-kidville-white/[0.12] px-3 py-[7px] text-kidville-white">
        <span className="flex text-kidville-yellow"><SchoolIcon /></span>
        <span className="text-left leading-[1.1]">
          <span className="block font-barlow text-sm font-extrabold uppercase">{nome}</span>
          <span className="block font-maven text-[10.5px] text-kidville-white/70">{meta}</span>
        </span>
        <ChevronDown size={16} className="text-kidville-white/80" />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+8px)] z-[60] w-[264px] rounded-[14px] bg-kidville-white p-1.5" style={{ boxShadow: SHADOW_FLOAT }}>
          <SedeRow active={tutteAttive} nome="Tutte le sedi" meta={`${sedi.length} ${sedi.length === 1 ? 'struttura' : 'strutture'}`} onClick={() => { tutte(); }} />
          {sedi.map((s) => (
            <SedeRow key={s.id} active={!tutteAttive && sel.has(s.id)} nome={s.nome} meta="" onClick={() => { toggle(s.id); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function SedeRow({ active, nome, meta, onClick }: { active: boolean; nome: string; meta: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx('flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2.5 text-left', active ? 'bg-kidville-green-soft' : 'hover:bg-kidville-cream')}>
      <span className={cx('flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]', active ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-green')}><SchoolIcon /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-barlow text-[14.5px] font-extrabold uppercase text-kidville-green">{nome}</span>
        {meta && <span className="block truncate font-maven text-[11.5px] text-kidville-muted">{meta}</span>}
      </span>
      {active && <Check size={16} className="shrink-0 text-kidville-green" />}
    </button>
  );
}

function SchoolIcon() {
  // building/scuola (lucide "School" equivalente compatto)
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 22v-4a2 2 0 0 0-4 0v4" /><path d="m18 10 4 2v10H2V12l4-2" /><path d="M18 5v17" /><path d="m4 6 8-4 8 4" /><path d="M6 5v17" /><circle cx="12" cy="9" r="2" />
    </svg>
  );
}
