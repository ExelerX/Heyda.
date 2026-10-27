import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { b64ToBytes, bytesToB64, desktop, isNative } from './platform';

/** Saves a backup file: a save dialog on Windows, the share sheet on phones. */
export async function saveBackupFile(bytes: Uint8Array): Promise<boolean> {
  const name = `heyda-sicherung-${new Date().toISOString().slice(0, 10)}.heyda`;
  if (desktop) return desktop.saveFile(name, bytesToB64(bytes));
  if (!isNative) throw new Error('Hier kann keine Datei gespeichert werden.');
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.write(bytes);
  try {
    await Sharing.shareAsync(file.uri, { mimeType: 'application/octet-stream', dialogTitle: 'Sicherung speichern' });
    return true;
  } finally {
    // The share sheet copied it where the user chose; don't leave a copy lying around.
    setTimeout(() => {
      try {
        if (file.exists) file.delete();
      } catch {
        // ignore
      }
    }, 60_000);
  }
}

/** Lets the user pick a backup file. Returns its bytes, or null if cancelled. */
export async function pickBackupFile(): Promise<Uint8Array | null> {
  if (desktop) {
    const f = await desktop.openFile();
    return f ? b64ToBytes(f.dataB64) : null;
  }
  if (!isNative) return null;
  const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: '*/*' });
  if (r.canceled || !r.assets[0]) return null;
  const file = new File(r.assets[0].uri);
  if (file.size > 5 * 1024 * 1024) throw new Error('Die Datei ist zu groß für eine Sicherung.');
  const bytes = await file.bytes();
  try {
    file.delete();
  } catch {
    // ignore
  }
  return bytes;
}
