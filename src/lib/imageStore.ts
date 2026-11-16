import { Directory, File, Paths } from 'expo-file-system';

// Images pinned in AR, one folder per kind: Documents/drawings/, Documents/photos/. Notes
// store only the file name: the absolute Documents path changes when the app is reinstalled
// or restored from a backup.
export type ImageKind = 'drawing' | 'photo';

const FOLDERS: Record<ImageKind, string> = { drawing: 'drawings', photo: 'photos' };
const folder = (kind: ImageKind) => new Directory(Paths.document, FOLDERS[kind]);

function newFile(kind: ImageKind, extension: string): File {
  const dir = folder(kind);
  dir.create({ intermediates: true, idempotent: true });
  return new File(dir, `${kind}-${Date.now()}${extension}`);
}

export function saveDrawingPng(base64: string): string {
  const file = newFile('drawing', '.png');
  file.write(base64, { encoding: 'base64' });
  return file.name;
}

// Copy a picked image (which lives in a temporary cache) into Documents.
export function savePhoto(sourceUri: string): string {
  const source = new File(sourceUri);
  const file = newFile('photo', source.extension || '.jpg');
  source.copySync(file);
  return file.name;
}

export function imageUri(kind: ImageKind, name: string): string {
  return new File(folder(kind), name).uri;
}

// Delete images no note references. Call only when `keep` matches what's persisted
// (on launch, after Save World Map), so the saved map never points at a missing file.
export function pruneImages(keep: Record<ImageKind, Set<string>>) {
  for (const kind of Object.keys(FOLDERS) as ImageKind[]) {
    const dir = folder(kind);
    if (!dir.exists) continue;
    for (const entry of dir.list()) {
      if (entry instanceof File && !keep[kind].has(entry.name)) entry.delete();
    }
  }
}

export function clearImages() {
  for (const kind of Object.keys(FOLDERS) as ImageKind[]) {
    const dir = folder(kind);
    if (dir.exists) dir.delete();
  }
}
