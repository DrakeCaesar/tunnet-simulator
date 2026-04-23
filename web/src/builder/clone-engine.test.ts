import assert from "node:assert/strict";
import { mapMaskForSegment } from "./clone-engine";

assert.equal(mapMaskForSegment("*.*.1.*", "middle16", 0), "*.*.1.*");
assert.equal(mapMaskForSegment("*.*.1.*", "middle16", 1), "*.*.2.*");
assert.equal(mapMaskForSegment("*.*.1.*", "middle16", 3), "*.*.0.*");

assert.equal(mapMaskForSegment("*.1.*.*", "middle16", 0), "*.1.*.*");
assert.equal(mapMaskForSegment("*.1.*.*", "middle16", 3), "*.1.*.*");
assert.equal(mapMaskForSegment("*.1.*.*", "middle16", 4), "*.2.*.*");

assert.equal(mapMaskForSegment("*.1.*.*", "outer64", 15), "*.1.*.*");
assert.equal(mapMaskForSegment("*.1.*.*", "outer64", 16), "*.2.*.*");
assert.equal(mapMaskForSegment("*.*.1.*", "outer64", 4), "*.*.2.*");

console.log("clone-engine mask mapping checks passed");
