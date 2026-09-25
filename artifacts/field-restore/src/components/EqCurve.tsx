import { lowEndShelfFrequencyResponseDb, moduleCoreFrequencyResponseDb } from '@/lib/frequency-response';
import { isFixedLowRumble, lowEndShelfEnabled, lowEndShelfFollowsWind, type EditModule } from '@/lib/edit-chain';

const WIDTH = 440;
const HEIGHT = 174;
const LEFT = 38;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 26;

export function EqCurve({ module, sampleRate, profile = 'module' }: {
  module: EditModule;
  sampleRate: number;
  profile?: 'module' | 'low-end';
}) {
  const maxFrequency = Math.min(20000, sampleRate / 2 * 0.99);
  if (maxFrequency <= 20) return null;
  const lowEndOnly = profile === 'low-end';
  const highPass = !lowEndOnly && isFixedLowRumble(module);
  const automaticWind = module.type === 'wind' && !isFixedLowRumble(module);
  const applied = module.enabled && (!lowEndOnly || lowEndShelfEnabled(module.params));
  const ceiling = highPass ? 12 : 18;
  const floor = highPass ? -48 : -18;
  const x = (frequency: number) => LEFT + Math.log(frequency / 20) / Math.log(maxFrequency / 20) * (WIDTH - LEFT - RIGHT);
  const y = (db: number) => TOP + (ceiling - Math.max(floor, Math.min(ceiling, db))) / (ceiling - floor) * (HEIGHT - TOP - BOTTOM);
  const path = Array.from({ length: 161 }, (_, index) => {
    const frequency = 20 * (maxFrequency / 20) ** (index / 160);
    const response = lowEndOnly
      ? lowEndShelfFrequencyResponseDb(module, sampleRate, frequency)
      : moduleCoreFrequencyResponseDb(module, sampleRate, frequency);
    return `${index === 0 ? 'M' : 'L'}${x(frequency).toFixed(2)} ${y(response).toFixed(2)}`;
  }).join(' ');
  const levels = highPass ? [0, -12, -24, -36, -48] : [12, 0, -12];
  const ticks = [20, 100, 1000, 10000, 20000].filter((frequency) => frequency <= maxFrequency);
  let description: string;
  if (lowEndOnly) {
    description = `Configured low-end shelf response, ${module.params.lowEndGain} decibels at ${module.params.lowEndFrequency} hertz, Q ${module.params.lowEndQ}.`;
    if (automaticWind) description += ` Wind reduction varies over time and is not shown. ${lowEndShelfFollowsWind(module.params) ? 'When enabled, this shelf follows detected wind.' : 'When enabled, this shelf applies to the whole recording.'}`;
  } else if (highPass) {
    description = `High-pass response, cutoff ${module.params.cutoff} hertz, Q ${module.params.q}. Low-end recovery is not included.`;
  } else if (module.params.mode === 'low-shelf') {
    description = `Low-shelf response, ${module.params.gain} decibels at ${module.params.frequency} hertz, Q ${module.params.q}`;
  } else {
    description = `Three-band response, low ${module.params.low}, mid ${module.params.mid}, high ${module.params.high} decibels`;
  }
  const title = lowEndOnly
    ? 'Bring Back the Low End · shelf response'
    : highPass ? 'Frequency response · Low Rumble Removal' : 'Frequency response · this module';
  const status = !module.enabled ? 'Bypassed · not applied'
    : lowEndOnly && !lowEndShelfEnabled(module.params) ? 'Off · not applied'
    : lowEndOnly && automaticWind && lowEndShelfFollowsWind(module.params) ? 'Detected wind only' : 'Applied';

  return <figure className={`eq-curve ${applied ? '' : 'bypassed'}`} data-testid={lowEndOnly ? `eq-curve-low-end-${module.id}` : `eq-curve-${module.id}`}>
    <figcaption className="eq-curve-heading"><span>{title}</span><span>{status}</span></figcaption>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="eq-curve-plot" role="img" aria-label={`${description} ${applied ? 'Applied as configured.' : 'Not applied.'}`}>
      {levels.map((level) => <g key={level}>
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(level)} y2={y(level)} className={level === 0 ? 'eq-curve-zero' : 'eq-curve-grid'} />
        <text x={LEFT - 6} y={y(level) + 3} textAnchor="end" className="eq-curve-axis">{level > 0 ? '+' : ''}{level}</text>
      </g>)}
      {ticks.map((frequency) => <g key={frequency}>
        <line x1={x(frequency)} x2={x(frequency)} y1={TOP} y2={HEIGHT - BOTTOM} className="eq-curve-grid" />
        <text x={x(frequency)} y={HEIGHT - 7} textAnchor={frequency === 20 ? 'start' : frequency === ticks.at(-1) ? 'end' : 'middle'} className="eq-curve-axis">{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</text>
      </g>)}
      <path d={path} className="eq-curve-line" data-testid="eq-response-path" />
    </svg>
    {lowEndOnly && automaticWind && <p className="eq-curve-note">Static shelf profile only · wind reduction varies over time and is not shown. {lowEndShelfFollowsWind(module.params) ? 'When enabled, the shelf follows detected wind with the fade timing above.' : 'When enabled, the shelf applies to the whole recording.'}</p>}
    {module.type === 'eq' && module.params.mode !== 'low-shelf' && <p className="eq-curve-note">Mid and high controls share the upper band in this processor.</p>}
  </figure>;
}