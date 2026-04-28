import * as assert from "node:assert/strict";
import {
  expandBuilderState,
  expandLinks,
  mapMaskForSegment,
  mapMaskForSegmentIndex,
  parseBuilderInstanceId,
  unmapMaskForSegment,
} from "./clone-engine";
import {
  addLinkRootOneWirePerPort,
  crossLayerBlockSlotFromSegments,
  innerOuterSlottedExpansionTouchesVoidBand,
  innerMiddleSlottedHitsColumn0_0_3,
  outerLeafEntityId,
  rebuildStateWithOuterLeafEndpoints,
  removeLinksTouchingInstancePort,
  type BuilderEntityRoot,
  type BuilderLinkRoot,
  type BuilderState,
} from "./state";

assert.equal(mapMaskForSegment("*.*.1.*", "middle16", 0), "*.*.1.*");
assert.equal(mapMaskForSegment("*.*.1.*", "middle16", 1), "*.*.2.*");
assert.equal(mapMaskForSegment("*.*.1.*", "middle16", 3), "*.*.0.*");

assert.equal(mapMaskForSegment("*.1.*.*", "middle16", 0), "*.1.*.*");
assert.equal(mapMaskForSegment("*.1.*.*", "middle16", 3), "*.1.*.*");
assert.equal(mapMaskForSegment("*.1.*.*", "middle16", 4), "*.2.*.*");

assert.equal(mapMaskForSegment("*.1.*.*", "outer64", 15), "*.1.*.*");
assert.equal(mapMaskForSegment("*.1.*.*", "outer64", 16), "*.2.*.*");
assert.equal(mapMaskForSegment("*.*.1.*", "outer64", 4), "*.*.2.*");
// Segment-indexed mapping aligns buckets to parent boundaries (outer64 groups of 4 -> middle16 segment).
assert.equal(mapMaskForSegmentIndex("*.*.1.*", "outer64", 1, 3), "*.*.1.*", "segments 1..3 stay in same group");
assert.equal(mapMaskForSegmentIndex("*.*.1.*", "outer64", 1, 4), "*.*.2.*", "segment 4 enters next group of 4");
assert.equal(unmapMaskForSegment("*.*.0.*", "middle16", 3), "*.*.1.*");
assert.equal(unmapMaskForSegment("*.1.*.*", "middle16", 3), "*.1.*.*");
assert.equal(unmapMaskForSegment("*.0.*.*", "middle16", 4), "*.3.*.*");

assert.deepEqual(parseBuilderInstanceId("e1@3"), { rootId: "e1", segmentIndex: 3 });
assert.deepEqual(parseBuilderInstanceId("ol-ep-12@12"), { rootId: "ol-ep-12", segmentIndex: 12 });
assert.equal(parseBuilderInstanceId("nope"), null);

assert.equal(crossLayerBlockSlotFromSegments("middle16", 1, "outer64", 6), 2);
assert.equal(crossLayerBlockSlotFromSegments("middle16", 1, "outer64", 9), undefined);

const iEnt: BuilderEntityRoot = {
  id: "i1",
  groupId: "i1",
  templateType: "hub",
  layer: "inner4",
  segmentIndex: 0,
  x: 0.1,
  y: 0.1,
  settings: {},
};
const oEnt: BuilderEntityRoot = { ...iEnt, id: "o1", layer: "outer64" };
assert.equal(innerOuterSlottedExpansionTouchesVoidBand(iEnt, oEnt, 0), false);
assert.equal(innerOuterSlottedExpansionTouchesVoidBand(iEnt, oEnt, 12), true, "slot 12 maps inner0→outer12 (0.0.3.0)");
const mEnt: BuilderEntityRoot = { ...iEnt, id: "m1", layer: "middle16" };
assert.equal(innerMiddleSlottedHitsColumn0_0_3(iEnt, mEnt, 2), false);
assert.equal(innerMiddleSlottedHitsColumn0_0_3(iEnt, mEnt, 3), true, "inner↔middle lane 3 = 0.0.3.x column");

const a: BuilderEntityRoot = {
  id: "a",
  groupId: "a",
  templateType: "filter",
  layer: "middle16",
  segmentIndex: 0,
  x: 0.1,
  y: 0.1,
  settings: {},
};
const b: BuilderEntityRoot = { ...a, id: "b", groupId: "b" };
const strays: BuilderLinkRoot = {
  id: "l1",
  groupId: "l1",
  fromEntityId: "a",
  fromPort: 0,
  toEntityId: "b",
  toPort: 1,
  fromSegmentIndex: 3,
  toSegmentIndex: 5,
};
const straysOut = expandLinks([strays], [a, b]);
assert.equal(
  straysOut.length,
  15,
  "two roots on same middle layer: pins ignored, mirrored links skip the 0.0.3.* void segment",
);
assert.equal(straysOut[0].fromInstanceId, "a@0");
assert.equal(straysOut[0].toInstanceId, "b@0");

const same: BuilderLinkRoot = {
  id: "l2",
  groupId: "l2",
  fromEntityId: "a",
  fromPort: 0,
  toEntityId: "a",
  toPort: 1,
  fromSegmentIndex: 0,
  toSegmentIndex: 2,
};
const selfOut = expandLinks([same], [a]);
assert.equal(selfOut.length, 12, "same-root template delta +2 on middle16 skips pairs touching the 0.0.3.* void segment");
assert.equal(selfOut[0].fromInstanceId, "a@0");
assert.equal(selfOut[0].toInstanceId, "a@2");
assert.equal(selfOut[0].fromPort, 0);
assert.equal(selfOut[0].toPort, 1);
assert.equal(selfOut[11].fromInstanceId, "a@13");
assert.equal(selfOut[11].toInstanceId, "a@15");

const m: BuilderEntityRoot = { ...a, id: "m1", groupId: "m1", layer: "middle16" };
const o: BuilderEntityRoot = { ...a, id: "o1", groupId: "o1", layer: "outer64" };
const cross: BuilderLinkRoot = {
  id: "l3",
  groupId: "l3",
  fromEntityId: "m1",
  fromPort: 0,
  toEntityId: "o1",
  toPort: 0,
};
const crossOut = expandLinks([cross], [m, o]);
assert.equal(crossOut.length, 60, "legacy cross-layer skips the 0.0.3.* void base columns");

const crossSlotted: BuilderLinkRoot = { ...cross, crossLayerBlockSlot: 2 };
const crossSlottedOut = expandLinks([crossSlotted], [m, o]);
assert.equal(crossSlottedOut.length, 15, "middle→outer with lane 2 skips the 0.0.3.* void segment");
assert.equal(crossSlottedOut[0].fromInstanceId, "m1@0");
assert.equal(crossSlottedOut[0].toInstanceId, "o1@2");
assert.equal(crossSlottedOut[1].fromInstanceId, "m1@1");
assert.equal(crossSlottedOut[1].toInstanceId, "o1@6");

const legacy: BuilderLinkRoot = { ...cross, fromSegmentIndex: 3, toSegmentIndex: 5 };
const legacyOut = expandLinks([legacy], [m, o]);
assert.equal(legacyOut.length, 60, "cross-entity with stray pins: still mirrored, excluding void base columns");

const mini: BuilderState = {
  version: 1,
  entities: [m, o],
  links: [cross],
  nextId: 10,
};
const exp = expandBuilderState(mini, { builderView: false });
assert.equal(exp.links.length, 60, "full expand matches");

const h1: BuilderEntityRoot = {
  ...a,
  id: "h1",
  groupId: "h1",
  layer: "outer64",
  templateType: "hub",
};
const h2: BuilderEntityRoot = { ...h1, id: "h2", groupId: "h2" };
const slDelta: BuilderLinkRoot = {
  id: "l4",
  groupId: "l4",
  fromEntityId: "h1",
  fromPort: 0,
  toEntityId: "h2",
  toPort: 1,
  sameLayerSegmentDelta: 2,
};
const slOut = expandLinks([slDelta], [h1, h2]);
assert.equal(slOut.length, 56, "outer same-layer delta +2 skips pairs touching the 0.0.3.* void band");
assert.equal(slOut[0].fromInstanceId, "h1@0");
assert.equal(slOut[0].toInstanceId, "h2@2");
assert.equal(slOut[55].fromInstanceId, "h1@61");
assert.equal(slOut[55].toInstanceId, "h2@63");

let endpointWireState = rebuildStateWithOuterLeafEndpoints({
  version: 1,
  entities: [h1],
  links: [],
  nextId: 20,
});
const endpoint0 = outerLeafEntityId(0);
const endpoint5 = outerLeafEntityId(5);
const firstEndpointWire = addLinkRootOneWirePerPort(endpointWireState, endpoint0, 0, h1.id, 0, {
  sameLayerSegmentDelta: 0,
});
assert.ok(firstEndpointWire.link, "static endpoint link can be created");
endpointWireState = firstEndpointWire.state;
assert.equal(endpointWireState.links.length, 1);
const removedViaMirror = removeLinksTouchingInstancePort(endpointWireState, endpoint5, 5, 0);
assert.equal(removedViaMirror.links.length, 0, "static endpoint mirrored wire can be removed from any mirror");

endpointWireState = firstEndpointWire.state;
const secondEndpointWire = addLinkRootOneWirePerPort(endpointWireState, endpoint5, 0, h1.id, 1, {
  sameLayerSegmentDelta: 0,
});
assert.ok(secondEndpointWire.link, "replacement endpoint link can be created from a mirrored endpoint");
assert.equal(
  secondEndpointWire.state.links.length,
  1,
  "static endpoint mirrored port overlap replaces the prior root link",
);
assert.equal(secondEndpointWire.state.links[0]?.fromEntityId, endpoint5);

let crossLayerPortState: BuilderState = {
  version: 1,
  entities: [m, o],
  links: [],
  nextId: 30,
};
const firstCrossLayerWire = addLinkRootOneWirePerPort(crossLayerPortState, m.id, 0, o.id, 0, {
  crossLayerBlockSlot: 1,
});
assert.ok(firstCrossLayerWire.link, "cross-layer slotted link can be created");
crossLayerPortState = firstCrossLayerWire.state;
const secondCrossLayerWire = addLinkRootOneWirePerPort(crossLayerPortState, m.id, 0, o.id, 1, {
  crossLayerBlockSlot: 2,
});
assert.ok(secondCrossLayerWire.link, "cross-layer link from the same port replaces the prior link");
assert.equal(secondCrossLayerWire.state.links.length, 1);
assert.equal(secondCrossLayerWire.state.links[0]?.crossLayerBlockSlot, 2);
assert.equal(secondCrossLayerWire.state.links[0]?.toPort, 1);

crossLayerPortState = secondCrossLayerWire.state;
const reversedCrossLayerWire = addLinkRootOneWirePerPort(crossLayerPortState, o.id, 1, m.id, 1, {
  crossLayerBlockSlot: 2,
});
assert.ok(reversedCrossLayerWire.link, "cross-layer link ending on an occupied port replaces in reverse direction");
assert.equal(reversedCrossLayerWire.state.links.length, 1);
assert.equal(reversedCrossLayerWire.state.links[0]?.fromEntityId, o.id);
assert.equal(reversedCrossLayerWire.state.links[0]?.fromPort, 1);

console.log("clone-engine mask mapping checks passed");
console.log("clone-engine pinned link checks passed");
