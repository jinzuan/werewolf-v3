# V3 Legacy Visual Cleanup Inventory

This iteration intentionally leaves legacy code in place. The new V3 routes do
not import the items below, but they should be removed in a dedicated cleanup
change after behavior and migration ownership are confirmed.

## Tooling And Template Branding

- `vite-plugin-trae-solo-badge` in `package.json`.
- `react-dev-locator` and development locator configuration in `vite.config.ts`.
- Legacy package name `trae-project` in `package.json`.
- `src/assets/react.svg`, `public/favicon.svg`, and template page metadata.
- Any remaining TRAE badge, watermark, template title, or starter copy.

## Legacy Visual Runtime

- `src/components/DynamicBackground.tsx` and route-level Canvas atmosphere.
- `src/components/Header.tsx` glass header, glow treatments, and emoji branding.
- Light day theme variables and `.app-theme--day`.
- Full-page gradients, decorative glow, bokeh, text shimmer, and floating motion.
- Heavy `backdrop-filter` glass surfaces and 16px+ card radii.

## Legacy Components And Styles

- Old `Home`, `GameLobby`, `LobbyHome`, `LobbyShell`, and `RoomCard` visuals.
- Old `.btn-*`, `.card*`, `.lobby-*`, `.day-*`, `.night-*`, `.wolf-*`, and
  duplicate Tailwind theme variables in `src/index.css`.
- Page-level hard-coded purple and gold values in legacy components.
- Repeated theme definitions and duplicate `borderRadius` / `boxShadow` entries
  in `tailwind.config.js`.

## Invalid Product Controls

- Player-facing API Key, model, temperature, max token, and timeout controls in
  `src/pages/Settings.tsx`.
- AI-count sliders in legacy room creation flows.
- Debug card changes, host identity reveal, generic show-identity controls, and
  production debug overlays.
- Full prompt, server path, or unredacted stack displays in monitoring surfaces.

## Migration Note

Do not delete these files until their business behavior has either moved into
the V3 routes or been explicitly retired. Visual cleanup should be separated
from gameplay, protocol, persistence, and server changes.
