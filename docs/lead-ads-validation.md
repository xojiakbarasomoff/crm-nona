# Lead Ads change — validation

Base: `f6ae20ddc23a27a179a57dda60b10b56ec3ff3ae` (`main`).

- `npm run typecheck`: passed.
- `npm run lint`: passed (zero warnings).
- `npm test`: 112 tests passed in 10 files. Includes Graph request contracts,
  mixed live/demo routing, OAuth state expiry/replay/session binding, missing permissions,
  token encryption, and rejection of foreign Pages/forms.
- `npm run build`: API, worker and Next.js production builds passed.
- `git diff --check`: passed.
- OpenAPI: generated with `node --conditions=development --import tsx packages/contracts/src/openapi/generate.ts`;
  only new Lead Ads paths retained in the checked-in artifact to avoid unrelated historical API changes.
- Local runtime: Node 24.22.1; repository declares Node 22 and build targets Node 22.

The PostgreSQL/Redis integration test in `tests/integration/lead-ads-login.test.ts` is supplied
but was **not run**: this workspace has no running database/Redis test services and cannot provision
the required native services in its current sandbox. The test covers the HTTP OAuth/setup flow,
signed webhook → Graph retrieval → contact/lead/form answers, deduplication, RBAC and live readiness.

No production database, Meta account, ad campaign, Railway deployment or remote Git branch was changed.
NONA Travel live-account delivery still requires deploy, Page authorization and a genuine test submission
as described in `docs/lead-ads-setup.md`. Local fixture tests do not prove Meta delivery.

GitHub connection at inspection: installed account `palmupuz-creator`; target repository owner
`xojiakbarasomoff`. Repository permissions returned `pull: true`, `push: false`.
