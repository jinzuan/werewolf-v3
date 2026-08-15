/**
 * Match feature entry points.  The v3 page paths remain compatibility
 * adapters for the current router while the match feature owns the result
 * projection and shared match contracts.
 */
export { GamePage } from '../../pages/v3/GamePage';
export { SpectatePage } from '../../pages/v3/SpectatePage';
export { MonitorPage } from '../../pages/v3/MonitorPage';
export { MatchResultPage } from './MatchResultPage';
export * from './resultModel';
