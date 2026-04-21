# Tunnet TypeScript Simulator Scaffold

This TypeScript scaffold provides:

- Flow parsing for `dot-product.txt` and `two-dot-two-product.txt`
- Core synchronized tick simulator
- Device behavior for:
  - endpoint
  - relay
  - hub
  - filter
- Demo topology runner to validate the tick loop

## Install / run

```bash
pnpm install
pnpm check
pnpm start
```

`pnpm start` writes:

- `out/phase3-topology.graphml` (yEd-compatible GraphML)
- `out/phase4-topology.graphml`
- `out/phase5-topology.graphml`

Web viewer:

```bash
pnpm dev
```

Then open the URL printed by Vite (typically `http://localhost:5173`).
`pnpm dev` runs both:
- topology data build in watch mode (`src/viewer-build.ts`)
- Vite dev server with live reload

Manual one-off data export:

```bash
pnpm viewer:build
```

Production build:

```bash
pnpm web:build
pnpm web:preview
```

## Current status

- `src/flow-parser.ts`: reads node / edge lines and merges both flow files.
- `src/simulator.ts`: deterministic tick engine with seeded RNG.
- `src/topology.ts`:
  - `createEndpointOnlyTopology`: endpoint inventory scaffold from flows
  - `createTwoEndpointRelayDemo`: runnable mini-topology for simulator smoke test
  - `synthesizePhase1Topology`: first concrete topology synthesis pass with configured entities
  - `synthesizePhase2Topology`: pair-based synthesis that can cover both A->B and B->A on one rail
  - `synthesizePhase3Topology`: mixed gadget synthesis (pair rails + configured hub cycles)
  - `synthesizePhase4RingTopology`: full ring of hub+filter endpoint gadgets (full-edge target)
  - `synthesizePhase5HierarchicalRings`: region rings + core ring ("tree of rings") demand-shaped backbone
- `src/index.ts`: simple CLI entrypoint that parses files and runs a 40-tick demo.
- `src/graphml.ts`: GraphML export with endpoint IP labels/colors and configurable device settings.
- `src/verification.ts`: per-edge single-packet verification (isolated trials).

## Semantics implemented from docs

- No autonomous routing: packets only follow wired device logic.
- Endpoints:
  - consume packets addressed to self
  - destroy sensitive packets not addressed to self
  - bounce non-sensitive wrong-destination packets back with TTL decrement
- Relays: 0 <-> 1 transfer each tick (no TTL decrement).
- Hubs: 3-port clockwise/counterclockwise remap (no TTL decrement).
- Filters:
  - one operating port
  - source/destination mask match with wildcard support
  - match/differ operation
  - send-back/drop action
  - collision handling: drop inbound / drop outbound / send back outbound
  - TTL decrement on operating-port analysis

## Phase 1 synthesis behavior

- Selects a deterministic disjoint subset of flow edges (strict endpoint single-port compliance).
- Realizes each selected edge as:
  - endpoint -> relay -> one-way filter -> relay -> endpoint
- One-way filter is configured using Tunnet semantics:
  - `operatingPort=1`
  - `operation=match`
  - `mask=*.*.*.*`
  - `action=drop`
  - `collisionHandling=send_back_outbound`

## Next implementation step

Upgrade synthesis from disjoint-edge baseline to shared-device topologies:

1. Convert each flow edge (`src -> dst`) into path requirements.
2. Place hub/filter gadgets that satisfy endpoint single-port constraints while supporting multi-flow endpoints.
3. Validate candidate topology by simulation score (delivery, drops, TTL failures).
