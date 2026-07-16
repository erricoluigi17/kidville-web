'use client';

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import {
  BRAND,
  CHART_AXIS,
  CHART_GRID,
  CHART_PALETTE,
  CHART_TOOLTIP_BORDER,
} from '@/lib/ui/chart-colors';

// Recharts setta `stroke`/`fill` come attributi di presentazione SVG: lì
// `var(--color-kidville-*)` non è affidabile → si usa il mirror hex documentato
// di `chart-colors.ts` (unico modulo del cockpit dove gli hex sono ammessi).
const GREEN = BRAND.green;
const YELLOW = BRAND.yellow;

const PALETTE = CHART_PALETTE;

const euroFmt = new Intl.NumberFormat('it-IT', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

// Formatter tick asse Y incassi: numero it-IT (separatore migliaia '.') senza valuta.
const tickFmt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });

interface TrendPoint {
  mese: string;
  label: string;
  incassato: number;
}

interface ClassePoint {
  classe: string;
  count: number;
}

/** Andamento incassi ultimi 6 mesi — area che si disegna progressivamente. */
export function TrendIncassiChart({ data }: { data: TrendPoint[] }) {
  // Asse Y a tick uniformi: passo adattivo (~5 tick) e formato it-IT coerente,
  // così spariscono i tick disuniformi (450/900) e il formato misto 'k'/grezzo.
  const maxVal = Math.max(0, ...data.map((d) => d.incassato));
  const step = maxVal <= 2500 ? 500 : maxVal <= 5000 ? 1000 : maxVal <= 10000 ? 2000 : 5000;
  const top = Math.max(step, Math.ceil(maxVal / step) * step);
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
        <defs>
          <linearGradient id="incassiFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GREEN} stopOpacity={0.35} />
            <stop offset="100%" stopColor={GREEN} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} stroke={CHART_AXIS} />
        <YAxis
          domain={[0, top]}
          ticks={ticks}
          tickFormatter={(v) => tickFmt.format(Number(v))}
          tickLine={false}
          axisLine={false}
          fontSize={12}
          stroke={CHART_AXIS}
          width={44}
        />
        <Tooltip
          formatter={(v) => [euroFmt.format(Number(v)), 'Incassato']}
          contentStyle={{ borderRadius: 12, border: `1px solid ${CHART_TOOLTIP_BORDER}`, fontFamily: 'inherit' }}
        />
        <Area
          type="monotone"
          dataKey="incassato"
          stroke={GREEN}
          strokeWidth={3}
          fill="url(#incassiFill)"
          isAnimationActive
          animationDuration={1400}
          animationEasing="ease-out"
          dot={{ r: 3, fill: YELLOW, stroke: GREEN, strokeWidth: 2 }}
          activeDot={{ r: 5 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Distribuzione studenti per classe/sezione — barre con crescita animata. */
export function StudentiPerClasseChart({ data }: { data: ClassePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="classe" tickLine={false} axisLine={false} fontSize={11} stroke={CHART_AXIS} interval={0} angle={data.length > 5 ? -20 : 0} textAnchor={data.length > 5 ? 'end' : 'middle'} height={data.length > 5 ? 48 : 30} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} stroke={CHART_AXIS} width={28} />
        <Tooltip
          cursor={{ fill: 'rgba(0,106,95,0.05)' }}
          formatter={(v) => [Number(v), 'Alunni']}
          contentStyle={{ borderRadius: 12, border: `1px solid ${CHART_TOOLTIP_BORDER}`, fontFamily: 'inherit' }}
        />
        <Bar dataKey="count" radius={[8, 8, 0, 0]} isAnimationActive animationDuration={1200} animationEasing="ease-out">
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
