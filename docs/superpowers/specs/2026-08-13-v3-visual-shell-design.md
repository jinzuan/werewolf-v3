# V3 Visual System And Match Shell

## Scope

Build a standalone V3 frontend surface on `feat/ui` while preserving all legacy
gameplay, network, store, and server files. The new routes use mock data only:

- `/` lobby
- `/game` match
- `/spectate` spectator
- `/settings` player settings
- `/monitor` AI match console

## Architecture

The implementation has four layers:

1. `src/styles/tokens.ts` exposes typed design values for TypeScript consumers.
2. `src/styles/v3.css` exposes the same values as CSS custom properties and
   defines the responsive layout primitives.
3. `src/ui` contains reusable controls that consume semantic V3 classes.
4. `src/components/shell` and `src/pages/v3` compose controls into the five
   route skeletons.

Legacy modules remain present and are not imported by the new application
entry. Removal work is documented in `src/LEGACY_CLEANUP.md`.

## Visual Direction

The product uses a restrained dark competitive-board-game theme. Neutral
surfaces carry most of the interface, purple marks night-state hierarchy, gold
marks focus and primary action, and red is reserved for wolves, death, and
danger.

The signature element is a thin phase rail in the top status bar. It connects
the current phase, countdown, connection, and live state without introducing
decorative gradients, glow fields, or unstable layout.

## Component Contracts

- Buttons support primary, secondary, danger, quiet, and icon treatments.
- Cards are flat solid surfaces with an 8px radius and never imply nesting.
- Modals use a centered surface on desktop and a bottom drawer on mobile.
- Progress bars expose semantic normal, warning, and danger states.
- Chat bubbles distinguish self, other, wolf, system, and private visibility.
- Badges always pair state color with readable text.

## Responsive Behavior

- At 1440px, match and monitor views use three columns.
- From 768px to 1439px, they use two columns with secondary content moved below.
- Below 768px, content becomes a single ordered flow; page navigation scrolls
  horizontally and modal surfaces become bottom drawers.
- Stable grid tracks, minimum widths, and overflow guards prevent horizontal
  scrolling at 390px, 768px, and 1440px.

## Accessibility And Motion

All interactive elements have visible focus rings and disabled semantics.
Controls use icons from Lucide where applicable and include labels or tooltips.
Motion is limited to 120-180ms state transitions. Reduced-motion removes
translation, pulsing, and smooth scrolling while retaining immediate updates.

## Verification

Run `npm run build`. Inspect the five routes at 390px, 768px, and 1440px,
checking text wrapping, stable control dimensions, focus visibility, and
horizontal overflow.
