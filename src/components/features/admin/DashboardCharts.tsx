'use client';

import { useTranslations } from 'next-intl';
import {
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_PALETTE,
  CHART_TOOLTIP_BORDER,
} from '@/lib/ui/chart-colors';

// Recharts setta `stroke`/`fill` come attributi di presentazione SVG: lì
// `var(--color-kidville-*)` non è affidabile → si usa il mirror hex documentato
// di `chart-colors.ts` (unico modulo del cockpit dove gli hex sono ammessi).
const PALETTE = CHART_PALETTE;

interface ClassePoint {
  classe: string;
  count: number;
}

/** Distribuzione studenti per classe/sezione — barre con crescita animata. */
export function StudentiPerClasseChart({ data }: { data: ClassePoint[] }) {
  const t = useTranslations('adminNav');
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="classe" tickLine={false} axisLine={false} fontSize={11} stroke={CHART_AXIS} interval={0} angle={data.length > 5 ? -20 : 0} textAnchor={data.length > 5 ? 'end' : 'middle'} height={data.length > 5 ? 48 : 30} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} stroke={CHART_AXIS} width={28} />
        <Tooltip
          cursor={{ fill: 'rgba(0,106,95,0.05)' }}
          formatter={(v) => [Number(v), t('chartAlunni')]}
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
