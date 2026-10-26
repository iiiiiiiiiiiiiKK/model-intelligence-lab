import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Bar,
  BarChart,
  Cell,
} from 'recharts';
import { useI18n } from '../../i18n';
import { formatDateShort, formatNumber, formatScore } from '../../lib/format';
import { EmptyState } from '../ui/States';
import type { BenchmarkDimension } from '../../../shared/types';

const ACCENT = '#B5E94B';
const CYAN = '#5DDBCA';
const GRID = 'rgba(41,67,43,0.6)';

const SERIES_COLORS = ['#B5E94B', '#5DDBCA', '#F3B66D', '#C79BF2', '#FF7474', '#8FBE33'];

/**
 * Multi-model trend. Every series gets a distinct colour plus a text label in
 * the tooltip, so the chart stays readable without relying on colour alone.
 */
export function TrendChart({
  series,
  height = 240,
}: {
  series: Array<{ modelId: string; displayName: string; points: Array<{ at: string; score: number }> }>;
  height?: number;
}) {
  const { locale, t } = useI18n();

  const chartData = useMemo(() => {
    const timestamps = [...new Set(series.flatMap((s) => s.points.map((p) => p.at)))].sort();
    return timestamps.map((at) => {
      const row: Record<string, string | number | null> = { at };
      for (const entry of series) {
        const point = entry.points.find((p) => p.at === at);
        row[entry.displayName] = point ? point.score : null;
      }
      return row;
    });
  }, [series]);

  if (series.length === 0 || chartData.length === 0) {
    return (
      <EmptyState
        title={t('state.noData')}
        description={t('home.empty.trend')}
      />
    );
  }

  return (
    <div>
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="at"
              tickFormatter={(value: string) => formatDateShort(value, locale)}
              tick={{ fontSize: 10 }}
              stroke={GRID}
              minTickGap={24}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tick={{ fontSize: 10 }}
              stroke={GRID}
              width={44}
            />
            <Tooltip
              contentStyle={{
                background: '#102B1B',
                border: '1px solid #29432B',
                borderRadius: 6,
                fontSize: 12,
              }}
              labelFormatter={(value) => formatDateShort(String(value), locale)}
              formatter={(value: number, name: string) => [formatScore(value, locale), name]}
            />
            {series.map((entry, index) => (
              <Line
                key={entry.modelId}
                type="monotone"
                dataKey={entry.displayName}
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={1.75}
                dot={{ r: 2.5, strokeWidth: 0, fill: SERIES_COLORS[index % SERIES_COLORS.length] }}
                activeDot={{ r: 4 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((entry, index) => (
          <li key={entry.modelId} className="flex items-center gap-1.5 text-2xs text-lab-muted">
            <span
              className="h-1.5 w-3 rounded-sm"
              style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }}
              aria-hidden="true"
            />
            {entry.displayName}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Dimension averages as a compact horizontal bar chart plus a data table. */
export function DimensionChart({
  values,
  height = 200,
}: {
  values: Record<string, number>;
  height?: number;
}) {
  const { locale, t } = useI18n();
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return <EmptyState title={t('state.noData')} />;
  }

  const data = entries.map(([dimension, value]) => ({
    dimension,
    label: t(`dimension.${dimension}` as never),
    value,
  }));

  return (
    <div className="space-y-3">
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="2 4" horizontal={false} />
            <XAxis type="number" domain={[0, 1]} tick={{ fontSize: 10 }} stroke={GRID} />
            <YAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 10 }}
              stroke={GRID}
              width={96}
            />
            <Tooltip
              contentStyle={{
                background: '#102B1B',
                border: '1px solid #29432B',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(value: number) => [formatScore(value, locale), t('misc.score')]}
            />
            <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false} barSize={14}>
              {data.map((entry, index) => (
                <Cell key={entry.dimension} fill={index % 2 === 0 ? ACCENT : CYAN} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* Text alternative for the same data — required for accessibility. */}
      <table className="w-full text-2xs">
        <caption className="sr-only-focusable">{t('home.dimensionProfile')}</caption>
        <tbody>
          {data.map((entry) => (
            <tr key={entry.dimension} className="border-b border-lab-border/50 last:border-0">
              <th scope="row" className="py-1.5 text-left font-normal text-lab-muted">
                {entry.label}
              </th>
              <td className="py-1.5 text-right font-mono text-lab-text">
                {formatNumber(entry.value, locale, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Per-dimension comparison of two runs, drawn as paired bars. */
export function ComparisonBars({
  baseline,
  current,
  baselineLabel,
  currentLabel,
  height = 240,
}: {
  baseline: Record<string, number>;
  current: Record<string, number>;
  baselineLabel: string;
  currentLabel: string;
  height?: number;
}) {
  const { locale, t } = useI18n();
  const dimensions = [...new Set([...Object.keys(baseline), ...Object.keys(current)])];
  if (dimensions.length === 0) return <EmptyState title={t('state.noData')} />;

  const data = dimensions.map((dimension) => ({
    label: t(`dimension.${dimension as BenchmarkDimension}` as never),
    baseline: baseline[dimension] ?? 0,
    current: current[dimension] ?? 0,
  }));

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke={GRID} interval={0} angle={-12} textAnchor="end" height={48} />
          <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} stroke={GRID} width={44} />
          <Tooltip
            contentStyle={{
              background: '#102B1B',
              border: '1px solid #29432B',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => [formatScore(value, locale), name]}
          />
          <Bar dataKey="baseline" name={baselineLabel} fill={CYAN} radius={[3, 3, 0, 0]} isAnimationActive={false} barSize={16} />
          <Bar dataKey="current" name={currentLabel} fill={ACCENT} radius={[3, 3, 0, 0]} isAnimationActive={false} barSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
