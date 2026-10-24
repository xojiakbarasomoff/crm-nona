/**
 * Tests against REAL local services (not mocks): SeaweedFS S3 gateway and the official ClamAV
 * daemon image. Start them with:
 *   docker compose -f infra/docker-compose.yml --profile services up -d seaweedfs clamav
 * then `npm run test:services`. The suite fails (does not skip) if the services are unreachable.
 */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Core } from '../../apps/api/src/core';
import { ClamdScanner, newObjectKey, S3Storage } from '@crm/integrations';
import { login, makeApp, makeCore, newLead } from '../integration/helpers';
import { docx, DOCX_MIME } from './zip';

const S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:58333',
  region: 'us-east-1',
  bucket: process.env.TEST_S3_BUCKET ?? 'crm-files-test',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? 'crm_local_access',
  secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'crm_local_secret_only_for_dev',
  forcePathStyle: true,
  serverSideEncryption: null,
};
const CLAMD = { host: process.env.TEST_CLAMD_HOST ?? '127.0.0.1', port: Number(process.env.TEST_CLAMD_PORT ?? 53310) };
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe('S3-compatible object storage (SeaweedFS, real service)', () => {
  const storage = new S3Storage(S3);

  it('bucket is reachable with credentials', async () => {
    expect(await storage.ping()).toBe(true);
  });

  it('round-trips binary data and deletes it', async () => {
    const key = newObjectKey();
    const data = Buffer.from([0, 1, 2, 255, ...Buffer.from('%PDF-1.4 real s3')]);
    await storage.put(key, data);
    expect((await storage.get(key)).equals(data)).toBe(true);
    await storage.delete(key);
    await expect(storage.get(key)).rejects.toThrow();
  });

  it('objects are private: anonymous HTTP read is denied', async () => {
    const key = newObjectKey();
    await storage.put(key, Buffer.from('%PDF-1.4 secret'));
    const anon = await fetch(`${S3.endpoint}/${S3.bucket}/${key}`);
    expect([401, 403]).toContain(anon.status);
    await storage.delete(key);
  });

  it('wrong credentials are rejected', async () => {
    const bad = new S3Storage({ ...S3, secretAccessKey: 'wrong-secret' });
    expect(await bad.ping()).toBe(false);
    await expect(bad.put(newObjectKey(), Buffer.from('x'))).rejects.toThrow();
  });

  it('rejects path-like keys before any request', async () => {
    await expect(storage.get('../etc/passwd')).rejects.toThrow('Invalid storage key');
  });
});

describe('ClamAV daemon (official clamav/clamav image, real signatures)', () => {
  const scanner = new ClamdScanner(CLAMD.host, CLAMD.port, 60_000);

  it('detects the EICAR test file by its real signature name', async () => {
    const r = await scanner.scan(Buffer.from(EICAR));
    expect(r.verdict).toBe('infected');
    expect(r.detail).toMatch(/Eicar/i);
  });

  it('passes a clean PDF', async () => {
    const r = await scanner.scan(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'));
    expect(r).toMatchObject({ verdict: 'clean' });
  });

  it('scans inside archives and streams files larger than one INSTREAM chunk', async () => {
    const big = docx([{ name: 'word/media/padding.bin', data: Buffer.alloc(300 * 1024, 0x41) }, { name: 'eicar.com', data: Buffer.from(EICAR) }]);
    expect(big.length).toBeGreaterThan(256 * 1024);
    const r = await scanner.scan(big);
    expect(r.verdict).toBe('infected');
    expect(r.detail).toMatch(/Eicar/i);
    expect((await scanner.scan(docx())).verdict).toBe('clean');
  });

  it('documents the EICAR rule: the test string is only a signature at the start of a file', async () => {
    expect((await scanner.scan(Buffer.from(`%PDF-1.4 ${EICAR}`))).verdict).toBe('clean');
  });
});

describe('end-to-end attachment flow on real S3 + real ClamAV', () => {
  let core: Core;
  let app: INestApplication;

  beforeAll(async () => {
    core = makeCore({
      env: {
        STORAGE_DRIVER: 's3',
        S3_ENDPOINT: S3.endpoint,
        S3_BUCKET: S3.bucket,
        S3_ACCESS_KEY_ID: S3.accessKeyId,
        S3_SECRET_ACCESS_KEY: S3.secretAccessKey,
        S3_FORCE_PATH_STYLE: 'true',
        SCANNER: 'clamav',
        CLAMD_HOST: CLAMD.host,
        CLAMD_PORT: String(CLAMD.port),
      },
    });
    app = await makeApp(core);
  });
  afterAll(async () => {
    await app.close();
    await core.close();
  });

  const upload = (cookie: string, q: string, body: Buffer, name: string, mime = 'application/pdf') =>
    request(app.getHttpServer())
      .post(`/api/v1/attachments?${q}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', cookie.match(/crm_csrf=([^;]+)/)![1]!)
      .set('Content-Type', mime)
      .set('X-File-Name', encodeURIComponent(name))
      .send(body);

  it('clean file: stored in S3, scanned by clamd, downloaded through the signed app URL', async () => {
    expect(core.deps.adapters.storage.descriptor.name).toBe('s3-private');
    expect(core.deps.adapters.scanner.descriptor.kind).toBe('clamav');
    const lead = await newLead(app, core);
    const owner = await login(app, (await core.deps.prisma.user.findUniqueOrThrow({ where: { id: lead.ownerId! } })).email);
    const pdf = Buffer.from('%PDF-1.4\n% real services e2e\n%%EOF');
    const up = await upload(owner.cookie, `ownerType=lead&ownerId=${lead.id}`, pdf, 'shartnoma.pdf');
    expect(up.status).toBe(201);
    const row = await core.deps.prisma.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect((await core.deps.adapters.storage.get(row.objectKey)).equals(pdf)).toBe(true); // really in the bucket
    await core.attachments.scanPending();
    const scanned = await core.deps.prisma.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(scanned.scanState).toBe('clean');
    expect(scanned.scanDetail).toMatch(/OK/);
    const link = await owner.post(`/api/v1/attachments/${up.body.id}/link`);
    const dl = await owner.get(link.body.url);
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).equals(pdf)).toBe(true);
  });

  it('infected file: clamd verdict quarantines it and the S3 object is deleted', async () => {
    const lead = await newLead(app, core);
    const owner = await login(app, (await core.deps.prisma.user.findUniqueOrThrow({ where: { id: lead.ownerId! } })).email);
    // A valid DOCX (passes type sniffing) carrying the EICAR test file inside the archive.
    const up = await upload(owner.cookie, `ownerType=lead&ownerId=${lead.id}`, docx([{ name: 'eicar.com', data: Buffer.from(EICAR) }]), 'zararli.docx', DOCX_MIME);
    expect(up.status).toBe(201);
    await core.attachments.scanPending();
    const row = await core.deps.prisma.attachment.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(row.scanState).toBe('infected');
    expect(row.scanDetail).toMatch(/Eicar/i);
    await expect(core.deps.adapters.storage.get(row.objectKey)).rejects.toThrow();
    expect((await owner.post(`/api/v1/attachments/${up.body.id}/link`)).body.error.code).toBe('FILE_INFECTED');
  });

  it('readiness reports storage', async () => {
    const r = await request(app.getHttpServer()).get('/ready');
    expect(r.body.checks.storage).toBe('ok');
  });
});
