/**
 * registry.ts — sqlite-backed port registry.
 *
 * Migrated from SOTAgent's port allocation logic (db.ts allocatePort family
 * + web.ts /api/ports/* handlers, commit dd31806). Surface and semantics are
 * preserved 1:1 so the SOTAgent facade can transparently forward.
 *
 * Compliance rule (kept from SOTAgent): allocated ports must end in 0 or 5
 * to keep dashboard scanning predictable.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { KNOWN_RESERVATIONS, KNOWN_SERVICES } from './known-services.js';

export type PortStatus = 'active' | 'released' | 'stale';

export interface PortRow {
  port: number;
  service_name: string;
  project: string;
  device_id: string | null;
  status: PortStatus;
  allocated_at: string;
  last_verified: string;
}

export interface AllocateInput {
  service_name: string;
  project: string;
  device_id?: string;
  preferred_port?: number;
  range_start?: number;
  range_end?: number;
}

export interface AllocateResult {
  port: number;
  reused: boolean;
  reactivated: boolean;
}

export interface PreferredReservation {
  service_name: string;
  project: string;
  preferred_port: number;
  created_at: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS ports (
  port           INTEGER PRIMARY KEY,
  service_name   TEXT    NOT NULL,
  project        TEXT    NOT NULL,
  device_id      TEXT,
  status         TEXT    NOT NULL DEFAULT 'active',
  allocated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_verified  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ports_identity ON ports(service_name, project, status);
CREATE INDEX IF NOT EXISTS idx_ports_status ON ports(status);
`;

const DEFAULT_RANGE_START = 8000;
const DEFAULT_RANGE_END = 19999;

export class PortRegistry {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(DDL);

    // Execute migration 002
    const migrationPath = join(
      import.meta.dirname || dirname(new URL(import.meta.url).pathname),
      'migrations',
      '002_preferred_reservations.sql',
    );
    if (existsSync(migrationPath)) {
      this.db.exec(readFileSync(migrationPath, 'utf-8'));
    }

    this.seedKnownReservations();
    this.seedKnownServices();
  }

  static isPortCompliant(port: number): boolean {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const last = port % 10;
    return last === 0 || last === 5;
  }

  static async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * Ask PolarProcess to kill the old process on a port and prepare for restart.
   * Best-effort — PolarProcess may not be running.
   */
  static async requestProcessRestart(serviceName: string, port: number): Promise<void> {
    const ppUrl = process.env.POLARPROCESS_URL ?? 'http://127.0.0.1:11055';
    try {
      await fetch(`${ppUrl}/api/services/${encodeURIComponent(serviceName)}/restart`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[PortRegistry] Requested PolarProcess restart for ${serviceName} (port ${port})`);
    } catch {
      console.warn(`[PortRegistry] PolarProcess unreachable, cannot restart ${serviceName}`);
    }
  }

  listAll(): PortRow[] {
    return this.db.prepare('SELECT * FROM ports ORDER BY port').all() as PortRow[];
  }

  listActive(): PortRow[] {
    return this.db
      .prepare("SELECT * FROM ports WHERE status = 'active' ORDER BY port")
      .all() as PortRow[];
  }

  getRow(port: number): PortRow | null {
    return (
      (this.db.prepare('SELECT * FROM ports WHERE port = ?').get(port) as PortRow | undefined) ??
      null
    );
  }

  getActive(port: number): PortRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM ports WHERE port = ? AND status = 'active'")
        .get(port) as PortRow | undefined) ?? null
    );
  }

  /**
   * Reserve a preferred port for a service/project pair.
   * Idempotent: if already reserved by same identity, no-op.
   * Returns true if reserved (new or existing).
   */
  reservePreferred(service_name: string, project: string, preferred_port: number): boolean {
    if (!PortRegistry.isPortCompliant(preferred_port)) {
      throw new Error(`preferred_port ${preferred_port} not compliant: must end with 0 or 5`);
    }
    const result = this.db.prepare(
      `INSERT INTO preferred_reservations (service_name, project, preferred_port)
       VALUES (?, ?, ?)
       ON CONFLICT(service_name, project) DO UPDATE SET
         preferred_port = excluded.preferred_port`,
    ).run(service_name, project, preferred_port);
    return result.changes > 0;
  }

  /**
   * Release a preferred port reservation.
   * Returns true if a reservation was deleted.
   */
  releasePreferred(service_name: string, project: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM preferred_reservations WHERE service_name = ? AND project = ?`,
    ).run(service_name, project);
    return result.changes > 0;
  }

  /**
   * List all preferred port reservations.
   */
  listReservedPreferred(): PreferredReservation[] {
    return this.db.prepare(
      'SELECT * FROM preferred_reservations ORDER BY preferred_port',
    ).all() as PreferredReservation[];
  }

  /**
   * Check if a port is reserved by someone OTHER than the given identity.
   * Returns the reservation info if blocked, null if free to claim.
   */
  isPortReservedByOthers(port: number, service_name: string, project: string): PreferredReservation | null {
    return (this.db.prepare(
      `SELECT * FROM preferred_reservations WHERE preferred_port = ? AND NOT (service_name = ? AND project = ?)`,
    ).get(port, service_name, project) as PreferredReservation | undefined) ?? null;
  }

  /**
   * Seed known service preferred reservations. Idempotent.
   */
  seedKnownReservations(): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO preferred_reservations (service_name, project, preferred_port) VALUES (?, ?, ?)`,
    );
    for (const s of KNOWN_RESERVATIONS) {
      if (!PortRegistry.isPortCompliant(s.port)) continue;
      stmt.run(s.service_name, s.project, s.port);
    }
  }

  /**
   * Register a known port directly (bypasses compliance — for external tools).
   * Idempotent: skips if the same identity already owns the port.
   */
  registerKnownPort(service_name: string, project: string, port: number): boolean {
    const row = this.getRow(port);
    if (row) {
      if (row.service_name === service_name && row.project === project) {
        if (row.status !== 'active') {
          this.db
            .prepare(
              `UPDATE ports SET status = 'active', last_verified = datetime('now') WHERE port = ?`,
            )
            .run(port);
        }
        return false;
      }
      // Reclaim released/stale rows for the canonical known-service identity
      if (row.status === 'released' || row.status === 'stale') {
        this.db
          .prepare(
            `UPDATE ports SET service_name = ?, project = ?, device_id = NULL, status = 'active',
                    allocated_at = datetime('now'), last_verified = datetime('now') WHERE port = ?`,
          )
          .run(service_name, project, port);
        return true;
      }
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO ports (port, service_name, project, device_id, status, allocated_at, last_verified)
         VALUES (?, ?, ?, NULL, 'active', datetime('now'), datetime('now'))`,
      )
      .run(port, service_name, project);
    return true;
  }

  /** Seed all ecosystem known services. Runs on every startup; idempotent. */
  seedKnownServices(): void {
    for (const s of KNOWN_SERVICES) {
      this.registerKnownPort(s.service_name, s.project, s.port);
    }
  }

  /**
   * Idempotent allocation. Mirrors SOTAgent.allocatePort behaviour:
   *  1) reuse an existing active row for (service_name, project)
   *  2) honour preferred_port if compliant + free
   *  3) revive a released/stale row owned by the same identity
   *  4) scan the range for a compliant + unused port
   */
  async allocate(input: AllocateInput): Promise<AllocateResult> {
    const sn = input.service_name;
    const pj = input.project;

    const existingActive = this.db
      .prepare(
        `SELECT * FROM ports WHERE service_name = ? AND project = ? AND status = 'active' LIMIT 1`,
      )
      .get(sn, pj) as PortRow | undefined;
    if (existingActive) {
      const portBusy = await PortRegistry.isPortInUse(existingActive.port);
      if (portBusy) {
        await PortRegistry.requestProcessRestart(sn, existingActive.port);
        await new Promise(r => setTimeout(r, 2000));
      }
      this.touch(existingActive.port);
      return { port: existingActive.port, reused: true, reactivated: false };
    }

    const tryClaim = async (port: number, mark: 'active' = 'active'): Promise<boolean> => {
      if (!PortRegistry.isPortCompliant(port)) return false;
      if (await PortRegistry.isPortInUse(port)) return false;
      const existing = this.getRow(port);
      if (existing && existing.status === 'active' && existing.service_name !== sn) return false;
      this.db
        .prepare(
          `INSERT INTO ports (port, service_name, project, device_id, status, allocated_at, last_verified)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(port) DO UPDATE SET
             service_name = excluded.service_name,
             project      = excluded.project,
             device_id    = excluded.device_id,
             status       = excluded.status,
             allocated_at = excluded.allocated_at,
             last_verified= excluded.last_verified`,
        )
        .run(port, sn, pj, input.device_id ?? null, mark);
      return true;
    };

    if (input.preferred_port != null) {
      // Check if this preferred port is reserved by another service
      const blockedBy = this.isPortReservedByOthers(input.preferred_port, sn, pj);
      if (blockedBy) {
        // Port is reserved by another identity — skip preferred, go to step 3
        // Don't tryClaim it
      } else {
        if (await tryClaim(input.preferred_port)) {
          return { port: input.preferred_port, reused: false, reactivated: false };
        }
      }
    }

    const reusable = this.db
      .prepare(
        `SELECT * FROM ports WHERE service_name = ? AND project = ? AND status IN ('released','stale') LIMIT 1`,
      )
      .get(sn, pj) as PortRow | undefined;
    if (reusable) {
      if (await tryClaim(reusable.port)) {
        return { port: reusable.port, reused: false, reactivated: true };
      }
    }

    const start = input.range_start ?? DEFAULT_RANGE_START;
    const end = input.range_end ?? DEFAULT_RANGE_END;
    const taken = new Set(
      (
        this.db
          .prepare("SELECT port FROM ports WHERE status = 'active'")
          .all() as { port: number }[]
      ).map((r) => r.port),
    );
    for (let p = start; p <= end; p++) {
      if (taken.has(p)) continue;
      if (await tryClaim(p)) {
        return { port: p, reused: false, reactivated: false };
      }
    }
    throw new Error('no_compliant_port_available');
  }

  release(port: number): boolean {
    const result = this.db
      .prepare(`UPDATE ports SET status = 'released', last_verified = datetime('now') WHERE port = ?`)
      .run(port);
    return result.changes > 0;
  }

  touch(port: number): boolean {
    const result = this.db
      .prepare(`UPDATE ports SET last_verified = datetime('now') WHERE port = ? AND status = 'active'`)
      .run(port);
    return result.changes > 0;
  }

  /**
   * Reactivate a non-active row owned by the given identity, only if the port
   * is not currently bound by another listener.
   */
  async reactivate(port: number, service_name: string, project: string, device_id?: string): Promise<boolean> {
    const row = this.getRow(port);
    if (!row || row.service_name !== service_name || row.project !== project) return false;
    if (row.status === 'active') return true;
    if (await PortRegistry.isPortInUse(port)) return false;
    this.db
      .prepare(
        `UPDATE ports SET status = 'active', device_id = ?, allocated_at = datetime('now'), last_verified = datetime('now') WHERE port = ?`,
      )
      .run(device_id ?? null, port);
    return true;
  }

  /**
   * Verify all active ports via TCP probe. Updates last_verified for reachable
   * ports, releases unreachable ones. Returns a summary.
   */
  async verifyAll(): Promise<{ verified: number; released: number; errors: string[] }> {
    const active = this.listActive();
    let verified = 0;
    let released = 0;
    const errors: string[] = [];

    for (const row of active) {
      try {
        const inUse = await PortRegistry.isPortInUse(row.port);
        if (inUse) {
          this.touch(row.port);
          verified++;
        } else {
          this.release(row.port);
          released++;
          console.log(`[verify] released stale port ${row.port} (${row.service_name})`);
        }
      } catch (err) {
        errors.push(`port ${row.port}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(`[verify] complete: ${verified} verified, ${released} released, ${errors.length} errors`);
    return { verified, released, errors };
  }

  close(): void {
    this.db.close();
  }
}
