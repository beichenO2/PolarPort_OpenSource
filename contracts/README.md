# PolarPort Contracts

| Schema | Purpose | Example |
|--------|---------|---------|
| `port-api.schema.json` | HTTP API surface (`/api/allocate` / `/api/release` / `/api/heartbeat` / `/api/list`) | `examples/port-api.example.json` |

`port-api.schema.json` also defines `PortRow` and `PortStatus` types; an
example row is in `examples/port-row.example.json`.

## Equivalence with SOTAgent

PolarPort's HTTP API is request/response-equivalent to SOTAgent's
historic `/api/ports/*` family (see SOTAgent commit `dd31806`). The
SOTAgent facade translates `/api/ports/allocate` etc. → PolarPort's
`/api/allocate` 1:1 — clients of SOTAgent's old SDK keep working until
the facade sunset trigger fires (grep=0 + capability registry status=
migrated; see 任务书/260505/决策记录.md §B).

## Change history

- 2026-05-08: initial split out of SOTAgent (260505 batch decision A1).
