# Fixtures

The fixture tests use `createMockIFindAdapter()` so normal CI does not depend on live iFind authorization or network availability.

The `*.golden.json` cases lock the Evidence v1 normalization contract for quote, financials, announcement, news, macro, profile, empty results, unstructured payloads, partial fields, stale data, dedupe, and invalid-schema paths.

Run `npm run smoke:ifind -- <target>` after `npm run build` to manually verify the live iFind MCP path.
