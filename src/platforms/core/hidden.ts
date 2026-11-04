/**
 * Attaches values to a state object that are needed to build the request but must not be part of the approved snapshot
 * (names, resource names): non-enumerable, so they are never stored or compared for drift.
 */
export function withHidden<S extends object, H extends object>(state: S, hidden: H): S & { readonly __hidden: H } {
  Object.defineProperty(state, "__hidden", { value: hidden, enumerable: false });
  return state as S & { readonly __hidden: H };
}
