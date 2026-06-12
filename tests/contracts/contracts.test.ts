/**
 * PolarPort contract + integration tests.
 *
 * Run: npm test  (vitest run)
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { PortRegistry } from '../../src/registry.js';
import { createApp } from '../../src/server.js';

const REPO = import.meta.dirname ?? new URL('.', import.meta.url).pathname;

function loadJson(rel: string) {
  return JSON.parse(readFileSync(join(REPO, '..', '..' , rel), 'utf-8'));
}

function makeValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  if (typeof addFormats === 'function') addFormats(ajv);
  else if (typeof (addFormats as any)?.default === 'function') (addFormats as any).default(ajv);
  return ajv;
}

describe('PolarPort contract tests', () => {
  it('port-api.example.json validates against port-api.schema.json', () => {
    const ajv = makeValidator();
    const schema = loadJson('contracts/port-api.schema.json');
    const example = loadJson('contracts/examples/port-api.example.json');
    const validate = ajv.compile(schema);
    expect(validate(example)).toBe(true);
  });

  it('port-row.example.json validates against the PortRow definition', () => {
    const ajv = makeValidator();
    const root = loadJson('contracts/port-api.schema.json');
    root.$id = 'https://polarisor.local/polarport/port-api.schema.json';
    ajv.addSchema(root);
    const validate = ajv.getSchema(`${root.$id}#/definitions/PortRow`);
    expect(validate).toBeTruthy();
    const example = loadJson('contracts/examples/port-row.example.json');
    expect(validate!(example)).toBe(true);
  });

  it('PortRegistry: isPortCompliant accepts ports ending 0 or 5 only', () => {
    expect(PortRegistry.isPortCompliant(8000)).toBe(true);
    expect(PortRegistry.isPortCompliant(8005)).toBe(true);
    expect(PortRegistry.isPortCompliant(8001)).toBe(false);
    expect(PortRegistry.isPortCompliant(0)).toBe(false);
    expect(PortRegistry.isPortCompliant(70000)).toBe(false);
  });

  it('PortRegistry: idempotent allocate returns the same port for a repeat caller', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'polarport-'));
    const dbPath = join(tmp, 'ports.sqlite');
    const reg = new PortRegistry(dbPath);
    const first = await reg.allocate({
      service_name: 'svc-a',
      project: 'ProjectA',
      range_start: 18000,
      range_end: 18099,
    });
    expect(typeof first.port).toBe('number');
    expect(PortRegistry.isPortCompliant(first.port)).toBe(true);
    const second = await reg.allocate({
      service_name: 'svc-a',
      project: 'ProjectA',
      range_start: 18000,
      range_end: 18099,
    });
    expect(second.port).toBe(first.port);
    expect(second.reused).toBe(true);
    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('PortRegistry: release flips status and frees the slot for re-allocation', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'polarport-'));
    const dbPath = join(tmp, 'ports.sqlite');
    const reg = new PortRegistry(dbPath);
    const a1 = await reg.allocate({ service_name: 'svc-a', project: 'P', range_start: 19000, range_end: 19099 });
    expect(reg.release(a1.port)).toBe(true);
    const row = reg.getRow(a1.port);
    expect(row?.status).toBe('released');
    const a2 = await reg.allocate({ service_name: 'svc-a', project: 'P', range_start: 19000, range_end: 19099 });
    expect(a2.port).toBe(a1.port);
    expect(a2.reactivated).toBe(true);
    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('PortRegistry: listActive vs listAll filter correctly', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'polarport-'));
    const dbPath = join(tmp, 'ports.sqlite');
    const reg = new PortRegistry(dbPath);
    const a = await reg.allocate({ service_name: 'svc-a', project: 'P', range_start: 18100, range_end: 18199 });
    const b = await reg.allocate({ service_name: 'svc-b', project: 'P', range_start: 18100, range_end: 18199 });
    reg.release(a.port);
    const active = reg.listActive();
    const all = reg.listAll();
    expect(active.find((r) => r.port === a.port)?.status).toBeUndefined();
    expect(active.find((r) => r.port === b.port)?.status).toBe('active');
    expect(all.length).toBeGreaterThanOrEqual(2);
    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('createApp HTTP integration: allocate + heartbeat + list + release round-trip', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'polarport-http-'));
    const dbPath = join(tmp, 'ports.sqlite');
    const reg = new PortRegistry(dbPath);
    const app = createApp(reg);

    const allocRes = await app.request('/api/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_name: 'svc-x', project: 'PX', range_start: 17000, range_end: 17099 }),
    });
    expect(allocRes.status).toBe(200);
    const alloc = await allocRes.json() as any;
    expect(alloc.ok).toBe(true);
    expect(typeof alloc.port).toBe('number');

    const hbRes = await app.request('/api/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: alloc.port }),
    });
    expect(hbRes.status).toBe(200);

    const listRes = await app.request('/api/list');
    const list = await listRes.json() as any[];
    expect(list.find((r) => r.port === alloc.port)).toBeTruthy();

    const relRes = await app.request('/api/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: alloc.port }),
    });
    expect(relRes.status).toBe(200);
    const rel = await relRes.json() as any;
    expect(rel.ok).toBe(true);

    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('createApp: rejects malformed payloads', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'polarport-http-'));
    const reg = new PortRegistry(join(tmp, 'ports.sqlite'));
    const app = createApp(reg);

    const r1 = await app.request('/api/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r1.status).toBe(400);

    const r2 = await app.request('/api/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_name: 'svc', project: 'P', preferred_port: 8001 }),
    });
    expect(r2.status).toBe(400);

    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  });
});
