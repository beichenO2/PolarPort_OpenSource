/**
 * PolarPort SDK — client library for port allocation.
 *
 * Canonical port SDK for the Polarisor ecosystem.
 * Routes to PolarPort first, falls back to SOTAgent if PolarPort is unreachable.
 */

const POLARPORT_DEFAULT_URL = 'http://127.0.0.1:11050';
const SOTAGENT_DEFAULT_URL = 'http://127.0.0.1:4800';
const HEARTBEAT_INTERVAL_MS = 30_000;

let _polarportUrl = process.env.POLARPORT_URL ?? POLARPORT_DEFAULT_URL;
let _sotagentUrl = process.env.SOTAGENT_URL ?? SOTAGENT_DEFAULT_URL;
const _heartbeatTimers = new Map<number, ReturnType<typeof setInterval>>();
const _claimedPorts = new Set<number>();

export interface ClaimPortOptions {
  service: string;
  project: string;
  preferred?: number;
  heartbeat?: boolean;
}

export interface ReleasePortOptions {
  port: number;
}

export interface ListPortsOptions {
  all?: boolean;
}

function setPolarportUrl(url: string): void { _polarportUrl = url; }
function setSotagentUrl(url: string): void { _sotagentUrl = url; }

async function _request(baseUrl: string, method: string, urlPath: string, body?: unknown): Promise<any> {
  const u = new URL(urlPath, baseUrl);
  const data = body ? JSON.stringify(body) : null;
  const resp = await fetch(u.toString(), {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ?? undefined,
    signal: AbortSignal.timeout(5000),
  });
  return resp.json();
}

function _startHeartbeat(port: number, service: string, project: string): void {
  const timer = setInterval(async () => {
    try {
      await _request(_polarportUrl, 'POST', '/api/heartbeat', { port, service_name: service, project });
    } catch {
      // heartbeat failure is non-fatal
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  _heartbeatTimers.set(port, timer);
}

/**
 * Claim a port for a service/project pair.
 *
 * Tries PolarPort first; on failure, falls back to SOTAgent's /api/ports/allocate.
 * Routes to PolarPort (:11050) as the single source of truth.
 */
export async function claimPort(opts: ClaimPortOptions): Promise<number> {
  const { service, project, preferred, heartbeat = true } = opts;

  try {
    const result = await _request(_polarportUrl, 'POST', '/api/allocate', {
      service_name: service,
      project,
      preferred_port: preferred,
    });
    if (result.ok && result.port != null) {
      const port: number = result.port;
      _claimedPorts.add(port);
      if (heartbeat) _startHeartbeat(port, service, project);
      return port;
    }
    console.warn(`[polarport-sdk] PolarPort refused: ${result.message}, falling back to SOTAgent`);
  } catch {
    console.warn('[polarport-sdk] PolarPort unreachable, falling back to SOTAgent');
  }

  // Fallback to SOTAgent
  const result = await _request(_sotagentUrl, 'POST', '/api/ports/allocate', {
    service_name: service,
    project,
    preferred_port: preferred,
  });
  if (result.ok && result.port != null) {
    const port: number = result.port;
    _claimedPorts.add(port);
    if (heartbeat) _startHeartbeat(port, service, project);
    return port;
  }
  throw new Error(`Port allocation failed: ${result.message || JSON.stringify(result)}`);
}

/**
 * Release a previously claimed port.
 */
export async function releasePort(opts: ReleasePortOptions | number): Promise<void> {
  const port = typeof opts === 'number' ? opts : opts.port;
  _claimedPorts.delete(port);
  const timer = _heartbeatTimers.get(port);
  if (timer) { clearInterval(timer); _heartbeatTimers.delete(port); }

  try { await _request(_polarportUrl, 'POST', '/api/release', { port }); }
  catch { /* non-fatal */ }
}

/**
 * List currently allocated ports.
 */
export async function listPorts(opts?: ListPortsOptions): Promise<any[]> {
  const all = opts?.all === true ? 'true' : undefined;
  const query = all ? `?all=${all}` : '';
  try {
    const result = await _request(_polarportUrl, 'GET', `/api/list${query}`);
    return Array.isArray(result) ? result : [];
  } catch {
    // Fallback to SOTAgent
    try {
      const result = await _request(_sotagentUrl, 'GET', '/api/ports');
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }
}
