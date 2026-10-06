import { useRef, useState } from 'react';
import { Download, FolderOpen } from 'lucide-react';
import { downloadBlob } from '@/lib/audio';
import { BACKUP_EXTENSION, backupConflict, readProjectBackup, serializeProjectBackup, type ProjectBackup } from '@/lib/project-backup';
import { loadProject, saveRestoredProject, type ProjectInput, type ProjectRecord } from '@/lib/project-store';
import { loadProject as loadLegacyProject, removeReplacedProject } from '@/lib/persistence';
import { verifyBackupSource, type VerifiedFileHandle } from '@/lib/file-access';
import { filenameWord } from '@/lib/project-metadata';

interface Props {
  capture: () => ProjectInput;
  onExported: (id: string) => void;
  onRestored: (record: ProjectRecord, source: VerifiedFileHandle) => void;
  blocked: boolean;
}

export function ProjectBackupPanel({ capture, onExported, onRestored, blocked }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [backup, setBackup] = useState<ProjectBackup | null>(null);
  const [conflict, setConflict] = useState<ReturnType<typeof backupConflict>>(null);
  const [storedConflict, setStoredConflict] = useState<ProjectRecord | null>(null);
  const [legacySnapshot, setLegacySnapshot] = useState<string | null>(null);
  const [verified, setVerified] = useState<VerifiedFileHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const disabled = busy || blocked;
  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : 'Unable to back up or restore this project.');

  const exportBackup = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const project = capture();
      const text = serializeProjectBackup(project);
      await downloadBlob(new Blob([text], { type: 'application/json' }), `${filenameWord(project.title).slice(0, 180) || 'project'}${BACKUP_EXTENSION}`);
      onExported(project.id!);
      setMessage(window.fieldRestoreDesktop ? 'Editable project backup saved. Keep the original audio file alongside it.' : 'Editable project backup download started. Keep the downloaded file and original audio outside browser storage.');
    } catch (caught) { if ((caught as Error).name !== 'AbortError') fail(caught); }
    finally { setBusy(false); }
  };

  const importBackup = async (file: File) => {
    setBusy(true); setError(''); setMessage(''); setBackup(null); setVerified(null);
    try {
      const next = await readProjectBackup(file);
      const stored = await loadProject(next.project.id);
      const legacy = loadLegacyProject();
      setStoredConflict(stored);
      setConflict(backupConflict(next, stored, legacy));
      setLegacySnapshot(JSON.stringify(legacy));
      setBackup(next);
    } catch (caught) { fail(caught); }
    finally { setBusy(false); }
  };

  const relink = async (file: File) => {
    if (!backup) return;
    setBusy(true); setError(''); setVerified(null);
    try {
      await window.fieldRestoreDesktop?.protectSource(file);
      setVerified(await verifyBackupSource(file, backup.project.source));
    } catch (caught) { fail(caught); }
    finally { setBusy(false); }
  };

  const restore = async (copy: boolean) => {
    if (!backup || !verified) return;
    setBusy(true); setError('');
    try {
      // A legacy save is independent of IndexedDB; check before explicit replacement.
      const legacy = loadLegacyProject();
      if (!copy && JSON.stringify(legacy) !== legacySnapshot) {
        throw new Error('A local project changed during restore. Cancel and import the backup again.');
      }
      const { file, metadata, fingerprint } = verified;
      const record = await saveRestoredProject({
        ...backup.project,
        id: copy ? crypto.randomUUID() : backup.project.id,
        title: copy ? `${backup.project.title} (restored copy)` : backup.project.title,
        savedAt: new Date().toISOString(),
        source: { ...backup.project.source, name: file.name, size: file.size, lastModified: file.lastModified,
          format: metadata.format, bitsPerSample: metadata.bitsPerSample, frameCount: metadata.frameCount, fingerprint },
      }, copy ? undefined : storedConflict?.savedAt);
      let legacyWarning = '';
      if (!copy && legacy?.id === backup.project.id) {
        try {
          if (!removeReplacedProject(legacy.id, legacy.savedAt)) legacyWarning = ' A newer legacy save was kept.';
        } catch { legacyWarning = ' The old browser save could not be removed; the restored project is saved in the project database.'; }
      }
      onRestored(record, verified);
      setBackup(null); setVerified(null);
      setMessage(`Backup restored and saved in this app’s local storage. The source audio remains external; relink it after reopening.${legacyWarning}`);
    } catch (caught) { fail(caught); }
    finally { setBusy(false); }
  };

  return <section className="panel" data-testid="project-backup-panel">
    <div className="panel-header"><div className="section-title">Editable project backup</div></div>
    <div className="panel-body space-y-3">
      <p className="text-xs text-muted-foreground">Save a portable .fieldrestore file with your current edits, markers, regions, trim, metadata and exact description text. Audio stays in its original WAV, FLAC, or MP4 file; keep both files. No uploads or automatic migration. Browser and desktop storage are independent.</p>
      <p className="text-xs text-muted-foreground">Backup does not update Save project or recover a pending description draft. Resolve draft recovery first. The built-in demo has no external source; import a recording before backing up.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="secondary-btn" disabled={disabled} onClick={() => void exportBackup()} data-testid="button-backup-export"><Download size={14} /> Back up editable project</button>
        <button type="button" className="secondary-btn" disabled={disabled} onClick={() => inputRef.current?.click()} data-testid="button-backup-import"><FolderOpen size={14} /> Import project backup</button>
      </div>
      <input ref={inputRef} type="file" className="hidden" accept=".fieldrestore,application/json" data-testid="input-project-backup" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importBackup(file); }} />
      {backup && <div className="border rounded-md p-3 space-y-3" data-testid="backup-restore-review">
        <p className="text-sm font-medium">Restore “{backup.project.title}”</p>
        <p className="text-xs text-muted-foreground">Backup saved {new Date(backup.project.savedAt).toLocaleString()}. Required source: {backup.project.source.name}. Choose the original audio to verify it before restoring.</p>
        <label className="block text-xs">Relink original WAV, FLAC, or MP4
          <input type="file" accept=".wav,.flac,.mp4,audio/mp4,video/mp4" disabled={disabled} className="block mt-2 max-w-full" data-testid="input-backup-source" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void relink(file); }} />
        </label>
        {verified && <p className="text-xs" data-testid="backup-source-verified">Source fingerprint and audio format verified.</p>}
        <p className="text-xs text-muted-foreground">Restoring replaces the open workspace. Back it up first if you want to keep unsaved changes. Local description drafts are not applied or deleted automatically.</p>
        {conflict && <p className="text-xs" data-testid="backup-conflict">This project identity already exists locally: “{conflict.title}”, saved {new Date(conflict.savedAt).toLocaleString()}. Restore a separate copy to keep it, or explicitly replace its saved edits and metadata.</p>}
        <div className="flex flex-wrap gap-2">
          {conflict && <button type="button" className="secondary-btn" disabled={disabled || !verified} onClick={() => void restore(true)} data-testid="button-backup-copy">Restore as a copy</button>}
          <button type="button" className="primary-btn" disabled={disabled || !verified} onClick={() => void restore(false)} data-testid="button-backup-restore">{conflict ? 'Replace saved project and open' : 'Restore and open project'}</button>
          <button type="button" className="secondary-btn" disabled={busy} onClick={() => { setBackup(null); setVerified(null); setError(''); }} data-testid="button-backup-cancel">Cancel restore</button>
        </div>
      </div>}
      {busy && <p className="text-xs" role="status">Working locally…</p>}
      {error && <p className="text-xs text-[#a34935]" role="alert" data-testid="backup-error">{error}</p>}
      {message && <p className="text-xs" role="status" data-testid="backup-status">{message}</p>}
    </div>
  </section>;
}