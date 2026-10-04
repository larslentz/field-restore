import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LbprMethodology } from '../components/LbprMethodology.tsx';
import { PlrStat } from '../components/SignalRatios.tsx';

test('LBPR methodology documents the complete calculation and its boundary conditions', () => {
  const html = renderToStaticMarkup(React.createElement(LbprMethodology));
  for (const formula of [
    'B = max(1, round(3 × f_s))', 'J = ceil(N / B)', 'N_j = min(B, N − j × B)',
    'E_c,j = Σ', 'M_c,j = E_c,j / N_j', 'R_c,j = √M_c,j',
    'L_c,j = 10 × log10(M_c,j) = 20 × log10(R_c,j)',
    'k_c = ceil(0.20 × m_c)', 'A_c = (1 / k_c) × Σ',
    'p_c = max', 'P_c = 20 × log10(p_c)', 'D_c = P_c − A_c',
    'LBPR = (1 / C) × Σ', 'Stereo LBPR = (D_Left + D_Right) / 2',
    'PLR = true peak (dBTP) − integrated loudness (LUFS)',
  ]) assert.ok(html.includes(formula), `Missing formula: ${formula}`);
  assert.match(html, /final partial block/);
  assert.match(html, /Only exact-zero blocks are excluded/);
  assert.match(html, /Every selected block has equal weight/);
  assert.match(html, /every channel has a finite D_c/);
  assert.doesNotMatch(html, /TT DR|MAAT|DR14|Interpretation notes/i);
});

test('PLR readouts show the measured value in LU and unavailable inputs as N/A', () => {
  const render = (plrLu) => renderToStaticMarkup(React.createElement(PlrStat, {
    stats: { plrLu }, label: 'PLR · Peak-to-loudness ratio',
  }));
  assert.match(render(17.5), /\+17\.5 LU/);
  assert.match(render(0), />0\.0 LU</);
  assert.match(render(NaN), /N\/A/);
  assert.match(render(undefined), /N\/A/);
});