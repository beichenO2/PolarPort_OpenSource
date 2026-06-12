/**
 * server.ts — PolarPort Hono server. Mounts the four endpoints documented in
 * `contracts/port-api.schema.json` and starts on a port claimed via SOTAgent's
 * port-sdk (so PolarPort itself plays by the ecosystem's own rules).
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import path from 'node:path';
import { PortRegistry } from './registry.js';
import { registerCapabilities } from './capability-register.js';

const DATA_DIR = process.env.POLARPORT_DATA_DIR
  ?? path.join(process.env.HOME ?? '', 'Polarisor', 'PolarPort', 'data');
const DB_PATH = process.env.POLARPORT_DB ?? path.join(DATA_DIR, 'ports.sqlite');
const DEFAULT_PORT = Number(process.env.POLARPORT_PORT ?? 11050);

export function createApp(registry: PortRegistry): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true, service: 'polar-port' }));

  app.get('/api/list', (c) => {
    const all = c.req.query('all') === 'true';
    return c.json(all ? registry.listAll() : registry.listActive());
  });

  app.post('/api/allocate', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'invalid_json' }, 400);
    }
    const sn = body.service_name;
    const pj = body.project;
    if (typeof sn !== 'string' || !sn) return c.json({ ok: false, message: 'service_name_required' }, 400);
    if (typeof pj !== 'string' || !pj) return c.json({ ok: false, message: 'project_required' }, 400);

    const preferred = typeof body.preferred_port === 'number' ? body.preferred_port : undefined;
    if (preferred != null && !PortRegistry.isPortCompliant(preferred)) {
      return c.json(
        { ok: false, message: `port ${preferred} not compliant: must end with 0 or 5` },
        400,
      );
    }

    try {
      const result = await registry.allocate({
        service_name: sn,
        project: pj,
        device_id: typeof body.device_id === 'string' ? body.device_id : undefined,
        preferred_port: preferred,
        range_start: typeof body.range_start === 'number' ? body.range_start : undefined,
        range_end: typeof body.range_end === 'number' ? body.range_end : undefined,
      });
      return c.json({
        ok: true,
        port: result.port,
        service_name: sn,
        project: pj,
        reused: result.reused,
        reactivated: result.reactivated,
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'no_compliant_port_available') {
        return c.json({ ok: false, message: 'no_compliant_port_available' }, 503);
      }
      return c.json(
        { ok: false, message: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  app.post('/api/release', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'invalid_json' }, 400);
    }
    const port = body.port;
    if (typeof port !== 'number') return c.json({ ok: false, message: 'port_required' }, 400);
    const ok = registry.release(port);
    return c.json({ ok, port });
  });

  app.post('/api/heartbeat', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'invalid_json' }, 400);
    }
    const port = body.port;
    if (typeof port !== 'number') return c.json({ ok: false, message: 'port_required' }, 400);

    const active = registry.getActive(port);
    if (active) {
      registry.touch(port);
      return c.json({ ok: true, port, last_verified: new Date().toISOString() });
    }

    const sn = typeof body.service_name === 'string' ? body.service_name : undefined;
    const pj = typeof body.project === 'string' ? body.project : undefined;
    if (sn && pj) {
      const row = registry.getRow(port);
      if (!row) return c.json({ ok: false, message: `port ${port} not registered` }, 404);
      if (row.service_name !== sn || row.project !== pj) {
        return c.json(
          {
            ok: false,
            message: `port ${port} owned by ${row.service_name}/${row.project}, not ${sn}/${pj}`,
          },
          409,
        );
      }
      const reactivated = await registry.reactivate(
        port,
        sn,
        pj,
        typeof body.device_id === 'string' ? body.device_id : undefined,
      );
      if (reactivated) return c.json({ ok: true, port, reactivated: true });
      return c.json(
        { ok: false, message: `port ${port} status ${row.status}, currently bound elsewhere` },
        410,
      );
    }
    return c.json({ ok: false, message: `port ${port} not active or unregistered` }, 404);
  });

  // ─── Preferred Port Reservations ───

  app.post('/api/ports/reserve', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, message: 'invalid_json' }, 400);
    }
    const sn = body.service_name;
    const pj = body.project;
    const port = body.preferred_port;
    if (typeof sn !== 'string' || !sn) return c.json({ ok: false, message: 'service_name_required' }, 400);
    if (typeof pj !== 'string' || !pj) return c.json({ ok: false, message: 'project_required' }, 400);
    if (typeof port !== 'number') return c.json({ ok: false, message: 'preferred_port_required' }, 400);

    try {
      const ok = registry.reservePreferred(sn, pj, port);
      return c.json({ ok: true, service_name: sn, project: pj, preferred_port: port });
    } catch (err) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.delete('/api/ports/reserve/:service_name/:project', (c) => {
    const sn = c.req.param('service_name');
    const pj = c.req.param('project');
    const ok = registry.releasePreferred(sn, pj);
    return c.json({ ok, service_name: sn, project: pj });
  });

  app.get('/api/ports/reserved', (c) => {
    return c.json(registry.listReservedPreferred());
  });

  app.post('/api/verify', async (c) => {
    const result = await registry.verifyAll();
    return c.json({ ok: true, ...result });
  });

  return app;
}

async function main(): Promise<void> {
  const registry = new PortRegistry(DB_PATH);
  const app = createApp(registry);

  let port = DEFAULT_PORT;
  try {
    const sotagentBase = process.env.SOTAGENT_URL ?? 'http://127.0.0.1:4800';
    const r = await fetch(`${sotagentBase}/api/ports/allocate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_name: 'polar-port', project: 'PolarPort', preferred_port: DEFAULT_PORT }),
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const data = (await r.json()) as { ok?: boolean; port?: number };
      if (data.ok && typeof data.port === 'number') port = data.port;
    }
  } catch {
    /* SOTAgent unreachable — fall back to DEFAULT_PORT */
  }

  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`PolarPort listening on http://127.0.0.1:${info.port}`);
    registerCapabilities().catch((err) => console.warn('[polarport] capability registration failed (non-fatal):', err));

    registry.verifyAll().catch((err) => console.warn('[polarport] initial verify failed:', err));

    const DAILY_MS = 24 * 60 * 60 * 1000;
    const dailyTimer = setInterval(() => {
      registry.verifyAll().catch((err) => console.warn('[polarport] daily verify failed:', err));
    }, DAILY_MS);
    dailyTimer.unref();
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  void main();
}
