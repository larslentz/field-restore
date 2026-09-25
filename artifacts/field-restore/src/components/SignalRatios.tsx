import type { LoudnessStats } from '@/lib/loudness';

export function PlrStat({ stats, label }: { stats: LoudnessStats; label: string }) {
  const value = stats.plrLu;
  return (
    <div className="stat-cell">
      <div className="stat-value">{Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)} LU` : 'N/A'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function formatDb(value: number, unit: 'dB' | 'dBFS' = 'dB') {
  return Number.isFinite(value) ? `${value.toFixed(2)} ${unit}` : 'N/A';
}

export function LbprStat({ stats, label }: { stats: LoudnessStats; label: string }) {
  // Projects saved before LBPR was added can still contain cached older stats.
  const result = stats.lbpr;
  const value = result?.valueDb ?? NaN;
  const available = Number.isFinite(value);
  return (
    <div className="stat-cell lbpr-cell">
      <div className="stat-value">{available ? `${value.toFixed(2)} dB` : 'N/A'}</div>
      <div className="stat-label">{label}</div>
      <div className="lbpr-meta">DR14-style estimate · final partial 3-second block included</div>
      {available && <div className="lbpr-meta">Rounded: {Math.round(value)} · Unrounded: {String(value)} dB</div>}
      {result?.channels.map((channel, index) => (
        <div className="lbpr-meta" key={index}>
          {result.channels.length === 2 ? (index === 0 ? 'Left' : 'Right') : `Channel ${index + 1}`}:
          {' '}{formatDb(channel.differenceDb)} difference ·
          {' '}sample peak {formatDb(channel.samplePeakDbfs, 'dBFS')} ·
          {' '}loudest 20% RMS {formatDb(channel.loudBlockRmsDbfs, 'dBFS')}
        </div>
      ))}
    </div>
  );
}