/**
 * capability-register — On startup, register PolarPort's capabilities with
 * SOTAgent's capability registry and flip legacy `sotagent.ports.*` entries
 * to `migrated`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOTAGENT_BASE = process.env.SOTAGENT_URL ?? 'http://127.0.0.1:4800';

interface Capability {
  id: string;
  [key: string]: unknown;
}

interface CapabilitiesFile {
  project: string;
  capabilities: Capability[];
}

/**
 * Read capabilities.json and POST to SOTAgent /api/capabilities/register-batch.
 * Then flip `sotagent.ports.*` entries to `migrated`.
 *
 * Non-blocking: logs warnings on failure, never throws.
 */
export async function registerCapabilities(): Promise<void> {
  let caps: CapabilitiesFile;
  try {
    const raw = readFileSync(join(__dirname, '..', 'capabilities.json'), 'utf-8');
    caps = JSON.parse(raw);
  } catch (err) {
    console.warn('[polarport] capability-register: failed to read capabilities.json:', err);
    return;
  }

  try {
    const resp = await fetch(`${SOTAGENT_BASE}/api/capabilities/register-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilities: caps.capabilities,
        project: caps.project,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) {
      console.warn(`[polarport] capability-register: register-batch returned ${resp.status}`);
      return;
    }

    console.log(`[polarport] capability-register: registered ${caps.capabilities.length} capabilities`);
  } catch (err) {
    console.warn('[polarport] capability-register: failed to reach SOTAgent:', err);
    return;
  }

  // Flip legacy sotagent.ports.* entries to migrated
  try {
    const legacyIds = ['sotagent.ports.allocate', 'sotagent.ports.list'];
    for (const capId of legacyIds) {
      await fetch(`${SOTAGENT_BASE}/api/capabilities/${encodeURIComponent(capId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'migrated', migrated_to: 'PolarPort' }),
        signal: AbortSignal.timeout(3000),
      });
    }
    console.log('[polarport] capability-register: flipped legacy sotagent.ports.* to migrated');
  } catch (err) {
    console.warn('[polarport] capability-register: failed to flip legacy entries (non-fatal):', err);
  }
}
