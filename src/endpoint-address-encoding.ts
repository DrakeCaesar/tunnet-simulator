import type { EndpointAddress } from "./recovered-endpoint-scheduler.js";

/**
 * Numeric mapping from wiki-style dotted quads into {@link EndpointAddress} for tooling.
 * This is **not** verified against in-game node layout; BN / save tracing is required for that.
 */
export type AddressEncodingStrategy =
  | "identity"
  | "plus_one_all_octets"
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
  }
}
