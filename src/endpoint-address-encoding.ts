import type { EndpointAddress } from "./recovered-endpoint-scheduler.js";

/**
 * Numeric mapping from wiki-style dotted quads into {@link EndpointAddress} for tooling.
 * General **`plus_one_*`** rows are still hypotheses; BN shows the scheduler reads a **5-byte row**
 * (`sub_1402f5840` @ **`0x1402f5b8d`** → **`sub_1402f9a40`** arg3), not the wiki string directly.
 */
export type AddressEncodingStrategy =
  | "identity"
  | "plus_one_all_octets"
  /**
   * Like **`plus_one_all_octets`**, but wiki regional mainframes **`0.1.0.0`**, **`0.2.0.0`**, **`0.3.0.0`**
   * use the **`sub_1402f9a40`** tuple **`(4,1,1,1)`** (`r13 == 4` and second..fourth bytes **1** @ **`0x1402f9ba7`**–**`0x1402f9e46`**),
   * not **`(1,b+1,1,1)`** from naive plus-one.
   */
  | "plus_one_all_octets_regional_mainframe"
  | "plus_one_first_octet";

export function parseEndpointAddressString(address: string): EndpointAddress {
  const parts = address.split(".").map((v) => Number(v));
  if (parts.length !== 4 || parts.some((v) => Number.isNaN(v))) {
    throw new Error(`Invalid endpoint address: ${address}`);
  }
  return { a: parts[0]!, b: parts[1]!, c: parts[2]!, d: parts[3]! };
}

export function encodeEndpointAddressForStrategy(
  addr: EndpointAddress,
  strategy: AddressEncodingStrategy,
): EndpointAddress {
  switch (strategy) {
    case "identity":
      return addr;
    case "plus_one_first_octet":
      return { ...addr, a: addr.a + 1 };
    case "plus_one_all_octets":
      return {
        a: addr.a + 1,
        b: addr.b + 1,
        c: addr.c + 1,
        d: addr.d + 1,
      };
    case "plus_one_all_octets_regional_mainframe": {
      if (addr.a === 0 && addr.c === 0 && addr.d === 0 && addr.b >= 1 && addr.b <= 3) {
        return { a: 4, b: 1, c: 1, d: 1 };
      }
      return {
        a: addr.a + 1,
        b: addr.b + 1,
        c: addr.c + 1,
        d: addr.d + 1,
      };
    }
  }
}
