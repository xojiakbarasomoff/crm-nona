/**
 * Creates the private bucket for STORAGE_DRIVER=s3 if it does not exist (idempotent) and checks
 * that anonymous access is denied.
 *   npm run storage:init
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@crm/api/core';

async function main() {
  const { storage } = loadConfig();
  if (storage.driver !== 's3') throw new Error('STORAGE_DRIVER is not s3');
  const s3 = storage.s3;
  const client = new S3Client({ region: s3.region, ...(s3.endpoint ? { endpoint: s3.endpoint } : {}), forcePathStyle: s3.forcePathStyle, credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } });
  try {
    await client.send(new HeadBucketCommand({ Bucket: s3.bucket }));
    console.log(`bucket ${s3.bucket} exists`);
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: s3.bucket }));
    console.log(`bucket ${s3.bucket} created`);
  }
  if (s3.endpoint) {
    const anon = await fetch(`${s3.endpoint.replace(/\/$/, '')}/${s3.bucket}/`);
    console.log(`anonymous list: HTTP ${anon.status} (${anon.status === 403 || anon.status === 401 ? 'denied — OK' : 'CHECK BUCKET POLICY'})`);
  }
}

main().catch((err) => {
  console.error('storage:init failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
