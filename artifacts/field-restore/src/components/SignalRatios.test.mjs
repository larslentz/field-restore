import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LbprStat } from './SignalRatios.tsx';

test('LBPR shows a dimensionless total and separate left and right measurements without descriptions', () => {
  const stats = {
    lbpr: {
      valueDb: 10.625,
      channels: [
        { differenceDb: 12.5, samplePeakDbfs: -1, loudBlockRmsDbfs: -13.5 },
        { differenceDb: 8.75, samplePeakDbfs: -2, loudBlockRmsDbfs: -10.75 },
      ],
    },
  };
  const html = renderToStaticMarkup(React.createElement(LbprStat, {
    stats, label: 'Loud-Block Peak-to-RMS (LBPR)',
  }));
  assert.match(html, /10\.63/);
  assert.match(html, /\(11\)/);
  assert.match(html, /Loud-Block Peak-to-RMS \(LBPR\)/);
  assert.match(html, /Left<\/span><strong[^>]*>12\.50<\/strong>/);
  assert.match(html, /Right<\/span><strong[^>]*>8\.75<\/strong>/);
  assert.doesNotMatch(html, /dB|sample peak|loudest 20%|DR14/);
});

test('LBPR keeps unavailable and silent-channel results clear', () => {
  const oldProject = renderToStaticMarkup(React.createElement(LbprStat, {
    stats: {}, label: 'Loud-Block Peak-to-RMS (LBPR)',
  }));
  assert.match(oldProject, /N\/A/);
  const silentRight = renderToStaticMarkup(React.createElement(LbprStat, {
    stats: { lbpr: { valueDb: NaN, channels: [
      { differenceDb: 7, samplePeakDbfs: -3, loudBlockRmsDbfs: -10 },
      { differenceDb: NaN, samplePeakDbfs: -Infinity, loudBlockRmsDbfs: -Infinity },
    ] } }, label: 'Loud-Block Peak-to-RMS (LBPR)',
  }));
  assert.match(silentRight, /Left<\/span><strong[^>]*>7\.00<\/strong>/);
  assert.match(silentRight, /Right<\/span><strong>N\/A<\/strong>/);
});