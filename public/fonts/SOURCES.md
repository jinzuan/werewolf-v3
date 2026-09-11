# Bundled CJK fonts

The bundled subsets are generated from the trusted Noto CJK families served by
Google Fonts CSS API on 2026-08-16:

- Noto Sans SC: <https://fonts.google.com/specimen/Noto+Sans+SC>
- Noto Serif SC: <https://fonts.google.com/specimen/Noto+Serif+SC>
- upstream source and license: <https://github.com/notofonts/noto-cjk>
- Google Fonts family metadata: <https://github.com/google/fonts/tree/main/ofl/notosanssc> and <https://github.com/google/fonts/tree/main/ofl/notoserifsc>
- API responses used the pinned Google Fonts revisions `notosanssc/v40` and `notoserifsc/v35`.

Each weight was requested from `https://fonts.googleapis.com/css2` with its
family and a `text=` subset. The product code point corpus was split into two
700-character CJK requests plus one punctuation/number request. The resulting
WOFF2 files are stored locally so the application does not depend on a remote
font at runtime. The internal CSS family names are prefixed with `WW` and do
not claim the upstream reserved family name.

The corpus is checked from `src`, `shared`, `server` (excluding data assets),
`index.html`, and `v3plan/RULESET.md` by
`node scripts/check-font-coverage.mjs`. The checker reads each WOFF2 cmap via
Fontconfig and verifies every required CJK glyph, product punctuation, and
ASCII/full-width digit in all five shipped weight groups.

All font files are distributed under the SIL Open Font License 1.1 in
`LICENSE-OFL.txt`.
