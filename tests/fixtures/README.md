# Contract fixtures

**Provenance: synthetic.** Every fixture in this directory was hand-written from the provider documentation
shapes referenced in `docs/TZ.md` §27. None of them is a captured live response yet (G01–G09 are blocked,
see `docs/feasibility.md`). When a G-test is executed, replace or add a fixture captured from the real
response, strip tokens, names, phone numbers and IDs, and change the `_provenance` field to
`"captured <date> <account type>"`.

Tests in `tests/contract/` prove that our parsers handle these shapes; they do **not** prove the provider
behaves this way.
