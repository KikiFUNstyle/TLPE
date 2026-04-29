import * as fs from 'node:fs';
import { resolveBackupConfigFromEnv, restoreLatestBackup, sendBackupAlert } from '../services/backup';

async function main() {
  const config = resolveBackupConfigFromEnv(process.env);
  const result = await restoreLatestBackup(config);
  console.log(JSON.stringify({
    status: 'ok',
    action: 'restore-test',
    objectKey: result.objectKey,
    integrity: result.integrity,
    restoredFiles: result.manifest.files.length,
  }, null, 2));
  fs.rmSync(result.restoreDir, { recursive: true, force: true });
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const config = resolveBackupConfigFromEnv(process.env);
    await sendBackupAlert(config, {
      status: 'error',
      action: 'restore-test',
      message,
      timestamp: new Date().toISOString(),
    });
  } catch (alertError) {
    console.error('[runRestoreTest] alert failure', alertError);
  }
  console.error('[runRestoreTest] failure', error);
  process.exitCode = 1;
});
