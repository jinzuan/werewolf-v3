/**
 * Compatibility entry point for the V3 pages that have not moved to the
 * feature folders yet.  Authority and projection state live together in the
 * M6 coordinator so a room change can clear every dependent projection in
 * one state transition.
 */
export {
  authorityStore,
  useV3Store,
} from './v3/authorityStore';
export type {
  V3Session,
  V3Store,
} from './v3/authorityStore';
