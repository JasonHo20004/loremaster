# S8 build contexts

The six `.allowlist` files contain exact repository-relative file paths. A new
source file is not admitted by an existing directory entry. Update and review
the appropriate list when a build actually needs a new input.

Generate a context into a new directory outside the checkout:

```bash
node scripts/s8-context.mjs api /tmp/loremaster-api-context
```

Valid profiles are `web-public`, `api`, `worker`, `observer`, `migration`, and
`importer`. The generator rejects traversal, symlinks, directories, tests,
fixtures, environment files, source maps, and unlisted files. It copies only
allowlisted bytes and writes a sorted SHA-256 manifest without timestamps.
Runtime images must copy named build output and production dependencies from
their own context, never the repository root.

`pnpm test:s8:image-policy` validates the lists and generates each profile in
an isolated temporary directory. A future image build must use the generated
context, not the checkout. The context manifest is build evidence and must not
be copied into a final image unless a reviewed image contract explicitly needs
it.
