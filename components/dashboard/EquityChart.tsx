'use client';
import { useEffect, useRef } from 'react';
import { AreaSeries, createChart, IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { EquitySnapshot } from '../../lib/types';

export function EquityChart({ snapshots }: { snapshots: EquitySnapshot[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      height: 260,
      layout: { background: { color: 'transparent' }, textColor: '#7c879a', fontFamily: 'JetBrains Mono, monospace' },
      grid: { horzLines: { color: '#171e29' }, vertLines: { color: '#171e29' } },
      rightPriceScale: { borderColor: '#1d2530' },
      timeScale: { borderColor: '#1d2530', timeVisible: true },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: '#eab308',
      topColor: 'rgba(234, 179, 8, 0.28)',
      bottomColor: 'rgba(234, 179, 8, 0.02)',
      lineWidth: 2,
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    resize();
    window.addEventListener('resize', resize);

    return () => {
      window.removeEventListener('resize', resize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(
      snapshots.map((s) => ({ time: Math.floor(s.ts / 1000) as Time, value: s.totalEquityQuote })),
    );
  }, [snapshots]);

  if (snapshots.length === 0) {
    return <div className="empty">No equity history yet.</div>;
  }

  return <div ref={containerRef} />;
}
