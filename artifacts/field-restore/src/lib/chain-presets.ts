import { withoutLegacyDcModules, type EditModule } from './edit-chain';

export interface ChainPreset {
  name: string;
  modules: EditModule[];
  /** Fingerprint of the audio used to capture any noise-only samples. Older presets have no identity. */
  sourceFingerprint?: string;
}

const STORAGE_KEY = 'field-restore-chain-presets-v1';
const MAX_NAME_LENGTH = 60;
const EDITABLE_TYPES = new Set(['gain', 'fade', 'eq', 'hum', 'wind', 'noise', 'region', 'ambient']);

export function parseChainPresets(raw: string | null): ChainPreset[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Saved presets could not be read. Your existing presets were not changed.');
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) =>
    entry !== null && typeof entry === 'object' &&
    typeof entry.name === 'string' && entry.name.trim().length > 0 &&
    entry.name.length <= MAX_NAME_LENGTH &&
    (entry.sourceFingerprint === undefined || typeof entry.sourceFingerprint === 'string') &&
    Array.isArray(entry.modules) &&
    entry.modules.every((module: unknown) =>
      module !== null && typeof module === 'object' &&
      typeof (module as EditModule).id === 'string' &&
      EDITABLE_TYPES.has((module as EditModule).type) &&
      typeof (module as EditModule).name === 'string' &&
      typeof (module as EditModule).enabled === 'boolean' &&
      (module as EditModule).params !== null &&
      typeof (module as EditModule).params === 'object' &&
      !Array.isArray((module as EditModule).params) &&
      Object.values((module as EditModule).params).every((value) => typeof value === 'string' || typeof value === 'number')
    )
  )) throw new Error('Saved presets could not be read. Your existing presets were not changed.');
  return parsed as ChainPreset[];
}

export function readChainPresets(storage: Pick<Storage, 'getItem'>): ChainPreset[] {
  return parseChainPresets(storage.getItem(STORAGE_KEY));
}

export function preparePresetModules(preset: ChainPreset, currentFingerprint: string | null): { modules: EditModule[]; discardedSamples: boolean } {
  const sameSource = Boolean(currentFingerprint && preset.sourceFingerprint && currentFingerprint === preset.sourceFingerprint);
  let discardedSamples = false;
  const modules = withoutLegacyDcModules(preset.modules).map((module) => {
    if (module.type !== 'noise' || sameSource) return { ...module, params: { ...module.params } };
    const params = { ...module.params };
    const hasSample = params.mode === 'Sample' || Object.keys(params).some((key) => /^profile\d+$/.test(key));
    if (!hasSample) return { ...module, params };
    discardedSamples = true;
    delete params.sampleStart;
    delete params.sampleEnd;
    for (const key of Object.keys(params)) if (/^profile\d+$/.test(key)) delete params[key];
    return { ...module, params: { ...params, mode: 'Automatic' } };
  });
  return { modules, discardedSamples };
}

export function saveChainPreset(storage: Pick<Storage, 'getItem' | 'setItem'>, name: string, modules: EditModule[], sourceFingerprint?: string | null): ChainPreset[] {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > MAX_NAME_LENGTH) throw new Error('Enter a preset name of 1–60 characters.');
  const existing = readChainPresets(storage);
  if (existing.some((preset) => preset.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase())) {
    throw new Error('A preset with this name already exists. Choose a different name.');
  }
  const updated = [...existing, {
    name: trimmedName,
    modules: withoutLegacyDcModules(modules).map((module) => ({ ...module, params: { ...module.params } })),
    ...(sourceFingerprint ? { sourceFingerprint } : {}),
  }];
  storage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}