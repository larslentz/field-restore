import { withoutLegacyDcModules, type EditModule } from './edit-chain';

export interface ChainPreset {
  name: string;
  modules: EditModule[];
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
    entry.name.length <= MAX_NAME_LENGTH && Array.isArray(entry.modules) &&
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

export function saveChainPreset(storage: Pick<Storage, 'getItem' | 'setItem'>, name: string, modules: EditModule[]): ChainPreset[] {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > MAX_NAME_LENGTH) throw new Error('Enter a preset name of 1–60 characters.');
  const existing = readChainPresets(storage);
  if (existing.some((preset) => preset.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase())) {
    throw new Error('A preset with this name already exists. Choose a different name.');
  }
  const updated = [...existing, {
    name: trimmedName,
    modules: withoutLegacyDcModules(modules).map((module) => ({ ...module, params: { ...module.params } })),
  }];
  storage.setItem(STORAGE_KEY, JSON.stringify(updated));
  return updated;
}