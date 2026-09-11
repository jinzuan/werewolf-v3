# V3 cleanup record

The browser entry point is the V3 runtime and its route tree. Retired
single-player pages, pre-V3 network clients, old stores, hooks, utilities, and
visual components are not part of the source tree. New code must be reachable
from `src/main.tsx` through the V3 router or be covered by an explicit test
entry point.

Build-time dependencies are retained only when a V3 source import consumes
them. Template branding and unrelated starter assets are outside the gameplay
runtime and must not be reintroduced as route dependencies.
