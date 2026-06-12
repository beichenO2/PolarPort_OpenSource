/**
 * PolarPort SDK — CJS entry point for require()-based callers.
 *
 * ESM callers should use PolarPort/src/sdk/index.ts instead.
 * Routes all requests to PolarPort:11050, falls back to SOTAgent:4800.
 */

const path = require('path');
const os = require('os');

const POLARPORT_URL = process.env.POLARPORT_URL || 'http://127.0.0.1:11050';
const SOTAGENT_URL = process.env.SOTAGENT_URL || 'http://127.0.0.1:4800';
const HEARTBEAT_INTERVAL_MS = 30_000;

const _heartbeatTimers = new Map();
const _claimedPorts = new Set();

function _warn(_fn) {
  // CJS entry point — no deprecation warning needed
}

async function _request(baseUrl, method, urlPath, body) {
  const resp = await fetch(new URL(urlPath, baseUrl).toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return resp.json();
}

function _startHeartbeat(port, service, project) {
  const timer = setInterval(async () => {
    try {
      await _request(POLARPORT_URL, 'POST', '/api/heartbeat', { port, service_name: service, project });
    } catch { /* non-fatal */ }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  _heartbeatTimers.set(port, timer);
}

async function claimPort(opts) {
  _warn('claimPort');
  const { service, project, preferred, heartbeat = true } = opts;

  try {
    const result = await _request(POLARPORT_URL, 'POST', '/api/allocate', {
      service_name: service,
      project,
      preferred_port: preferred,
    });
    if (result.ok && result.port != null) {
      _claimedPorts.add(result.port);
      if (heartbeat) _startHeartbeat(result.port, service, project);
      return result.port;
    }
  } catch { /* fallback */ }

  try {
    const result = await _request(SOTAGENT_URL, 'POST', '/api/ports/allocate', {
      service_name: service,
      project,
      preferred_port: preferred,
    });
    if (result.ok && result.port != null) {
      _claimedPorts.add(result.port);
      if (heartbeat) _startHeartbeat(result.port, service, project);
      return result.port;
    }
  } catch { /* fallback to preferred */ }

  if (preferred) return preferred;
  throw new Error('Port allocation failed: PolarPort and SOTAgent both unreachable');
}

async function releasePort(port) {
  _warn('releasePort');
  _claimedPorts.delete(port);
  const timer = _heartbeatTimers.get(port);
  if (timer) { clearInterval(timer); _heartbeatTimers.delete(port); }
  try { await _request(POLARPORT_URL, 'POST', '/api/release', { port }); } catch { /* */ }
}

async function getPort(serviceName) {
  _warn('getPort');
  try {
    const list = await _request(POLARPORT_URL, 'GET', '/api/list');
    if (Array.isArray(list)) {
      const match = list.find(r => r.service_name === serviceName && r.status === 'active');
      if (match) return match.port;
    }
  } catch { /* */ }
  return null;
}

async function discoverService(serviceName) {
  _warn('discoverService');
  const port = await getPort(serviceName);
  return {
    gatewayUrl: null,
    directUrl: port ? `http://127.0.0.1:${port}` : null,
    port,
    degraded: port === null,
  };
}

function setBaseUrl() {
  _warn('setBaseUrl');
}

async function registerCapabilities(source, project, serviceName) {
  _warn('registerCapabilities');
  return { ok: false, registered: 0 };
}

async function call(serviceName, endpoint, opts = {}) {
  _warn('call');
  const port = await getPort(serviceName);
  if (!port) throw new Error(`Service ${serviceName} not found via PolarPort`);
  const method = opts.method || 'GET';
  const url = `http://127.0.0.1:${port}${endpoint}`;
  const resp = await fetch(url, {
    method,
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 10000),
  });
  return resp.json();
}

module.exports = {
  claimPort,
  releasePort,
  getPort,
  discoverService,
  setBaseUrl,
  registerCapabilities,
  call,
};
