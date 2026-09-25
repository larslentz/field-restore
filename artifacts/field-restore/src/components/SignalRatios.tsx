import React from 'react';
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

function formatRatio(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : 'N/A';
}

export function LbprStat({ stats, label }: { stats: LoudnessStats; label: string }) {
  // Projects saved before LBPR was added can still contain cached older stats.
  const result = stats.lbpr;
  const value = result?.valueDb ?? NaN;
  const available = Number.isFinite(value);
  return (
    <div className="stat-cell lbpr-cell">
      <div className="stat-value" title={available ? `Unrounded: ${value}` : undefined}>
        {available ? <>{formatRatio(value)} <span className="lbpr-rounded">({Math.round(value)})</span></> : 'N/A'}
      </div>
      <div className="stat-label">{label}</div>
      {!!result?.channels.length && <div className="lbpr-channels">
        {result.channels.map((channel, index) => (
          <span className="lbpr-channel" key={index}>
            <span>{result.channels.length === 2 ? (index === 0 ? 'Left' : 'Right') : `Channel ${index + 1}`}</span>
            <strong title={Number.isFinite(channel.differenceDb) ? `Unrounded: ${channel.differenceDb}` : undefined}>
              {formatRatio(channel.differenceDb)}
            </strong>
          </span>
        ))}
      </div>}
    </div>
  );
}