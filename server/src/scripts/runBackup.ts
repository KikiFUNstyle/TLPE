import { createBackup, resolveBackupConfigFromEnv, sendBackupAlert } from '../services/backup';

async function main() {
  const config = resolveBackupConfigFromEnv(process.env);
  const result = await createBackup(config);
  console.log(JSON.stringify({
    status: 'ok',
    action: 'backup',
    objectKey: result.objectKey,
    encryptedSha256: result.encryptedSha256,
    bytesWritten: result.bytesWritten,
    retention: result.retention,
  }, null, 2));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const config = resolveBackupConfigFromEnv(process.env);
    await sendBackupAlert(config, {
      status: 'error',
      action: 'backup',
      message,
      timestamp: new Date().toISOString(),
    });
  } catch (alertError) {
    console.error('[runBackup] alert failure', alertError);
  }
  console.error('[runBackup] failure', error);
  process.exitCode = 1;
});
