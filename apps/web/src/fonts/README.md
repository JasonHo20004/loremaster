# Vendored web fonts

The public web image serves fonts from its own origin because the production
Content Security Policy is `font-src 'self'`. These files are copied unchanged
from the npm tarballs below. Each tarball was checked against the registry
`dist.integrity` value before extraction. Only the Latin variable-weight
subsets are vendored.

| File                                  | Source package                           | SHA-256                                                            |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `cinzel-latin-wght-normal.woff2`      | `@fontsource-variable/cinzel@5.3.0`      | `09941fb1c169c38fd414536b37690057fc01b3117a5c63dd6571186540c8f370` |
| `eb-garamond-latin-wght-normal.woff2` | `@fontsource-variable/eb-garamond@5.3.0` | `88603384163d301aebd5bd769832a8bfe3c9004ec24178417b9817f0ad32c63b` |
| `eb-garamond-latin-wght-italic.woff2` | `@fontsource-variable/eb-garamond@5.3.0` | `c664773f7e1d42d36326aa457becf7674236168c74cf7d74e87e5778ef7640f9` |

Package integrity:

- `@fontsource-variable/cinzel@5.3.0`:
  `sha512-eFcU0TwaAP5QESF2pV8VoOPJJXJ6sSGm/6mXMwqTdMBPAJMaLhfa6oISHuOtFeddsoHP9RYm4Io0j1j3mNEz2Q==`
- `@fontsource-variable/eb-garamond@5.3.0`:
  `sha512-656OJsA9Vv24yhqRZFEzXnzS2AYgKdEILLgHJYLzzXndgcWFKfSXFqzbRI5/6Yk1Yt7UfWrUeppE5nRQPQMwlQ==`

Both families are licensed under the SIL Open Font License 1.1. The license
texts are kept beside the fonts as `OFL-cinzel.txt` and `OFL-eb-garamond.txt`.
Every file in this directory must also be listed in
`ops/build-contexts/web-public.allowlist`.
