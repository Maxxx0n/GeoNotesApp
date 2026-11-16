import { File, Paths } from 'expo-file-system';

// Small per-device preferences, persisted as JSON in Documents/settings.json.
export type Settings = { ghostMode: boolean };

const DEFAULTS: Settings = { ghostMode: true };
const settingsFile = () => new File(Paths.document, 'settings.json');

export function loadSettings(): Settings {
  try {
    const file = settingsFile();
    return file.exists ? { ...DEFAULTS, ...JSON.parse(file.textSync()) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(patch: Partial<Settings>) {
  try {
    settingsFile().write(JSON.stringify({ ...loadSettings(), ...patch }));
  } catch (e) {
    console.log('Could not save settings', e);
  }
}
