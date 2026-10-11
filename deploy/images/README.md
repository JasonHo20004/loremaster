# S8 image contract and admission

`contracts.json` freezes six separate image names, numeric users, ports,
workdirs, writable paths, required OCI labels, one target platform, and digest
references for builder candidates. S8.3-S8.5 build six purpose-specific final
images from generated allowlisted contexts. Their local acceptance evidence is
in [`plans/s8-images-evidence.md`](../../plans/s8-images-evidence.md). The images
are not a Compose stack or a published release.

Run the image gates from a checkout with pinned Node, pnpm, Docker Engine,
Buildx, and Chromium available:

```bash
pnpm test:s8:image-policy
pnpm build
pnpm build:images
pnpm test:s8:node-images
pnpm test:s8:operator-images
pnpm test:s8:web-image
node scripts/s8-artifacts.mjs
```

`pnpm test:images` runs the build, combined behavior journey, and artifact scan.
The behavior journey creates uniquely named disposable PostgreSQL, Redis,
networks, and volumes, then removes only those named resources. Operator images
require file-backed database URLs. The importer accepts exactly one read-only
`/run/content/pack.json` mount; neither operator is part of API startup.

Builds must use Corepack with pnpm 11.19.0, `pnpm install --frozen-lockfile`,
multi-stage builds, and the profile-specific generated context. A final stage
may contain only compiled output and pruned production dependencies for its
process. Runtime stages use exec-form entrypoints and numeric non-root users;
the Compose contract applies read-only roots, capability drops, bounded
resources, and the named writable paths. Operator entrypoints are distinct
from API/worker/observer. `scripts/s8-image-policy.mjs` rejects floating
bases, root final users, broad root copies, remote `ADD`, secret-like build
arguments or environment values, shell entrypoints, and package installation
in image stages. Image slices also inspect the assembled layers and file tree;
static checks alone cannot prove those properties.

Set `SOURCE_DATE_EPOCH` to the source commit time and emit the five OCI labels
from `contracts.json`. Repeat a build twice from the same commit, lockfile,
allowlist, platform, base digests, and BuildKit version. Compare the context
manifest, production file hashes, image config, and final image digest. Treat
different digests as a failure unless the differing provenance/attestation
metadata is identified and reviewed; timestamps in application layers are not
an accepted source of variation. S8.3-S8.5 own the measured comparison.

The scanner is Trivy 0.74.0 at the digest in
`scripts/s8-scan-image.mjs`. Each candidate or assembled image runs a
HIGH/CRITICAL OS and application scan, SBOM/license inventory, and the
workspace dependency audit. `node scripts/s8-scan-image.mjs <digest-pinned-image>`
fails on any unapproved HIGH/CRITICAL finding. An exception in
`ops/s8/vulnerability-exceptions.json` requires the exact package and CVE,
compensating control, owner, a different reviewer, approval date, and expiry
within 30 days. The ledger is empty. Scanner database updates may change
results without a source change, so every image slice reruns the policy before
composition. Gitleaks and public artifact disclosure remain separate gates.

The 2026-10-02 preflight found 53 HIGH and 4 CRITICAL Debian findings plus 10
HIGH Node.js findings in the newer Node 22.23.3 slim candidate; the NGINX
1.29.5 Alpine candidate had 46 HIGH findings. Those candidate roots are not
copied into the final images. The S8 final stages start from `scratch` and copy
only the required executable, shared libraries, package records, and compiled
application output. The 2026-10-11 scans found no HIGH/CRITICAL finding in the
six assembled images. Rescan them from the reviewed commit before composition;
scanner database results can change without source changes.
