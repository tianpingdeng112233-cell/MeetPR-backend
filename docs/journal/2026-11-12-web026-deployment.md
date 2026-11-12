# Web 026 — Unified coach communication deployment

## Authorization and scope

David directly approved the final interactive HTML and requested implementation through release on 2026-11-12. This delivery only replaces bundled `web/` assets; backend source, runtime configuration, API and migrations are unchanged.

Upstream: [plan-web PR #163](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/pull/163), source commit `72e2e02c093d45776c88bf3cb8ded8df1f10d076`, main merge `bc1832a9aca588654987e52af31171a58fc7d39f`. [Approved spec](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/blob/bc1832a9aca588654987e52af31171a58fc7d39f/specs/026-unified-communication/SPEC.md), [implementation and independent review evidence](https://github.com/tianpingdeng112233-cell/meetpr-plan-web/blob/bc1832a9aca588654987e52af31171a58fc7d39f/docs/journal/2026-11-12-026-A.md).

## Baseline and build

- Backend/CN deployed baseline: `160bacc26a3f1455d85feb92b4e2d2f4e9ba14a3`; deploy run 42963633217. Old live entry `index-DdP-PD4T.js`, SHA256 `7b0012e603943ba90a839db989b158feb401576b1c2cd1c10eff8576f9a0c5ab` verified against Git.
- Fresh managed backend worktree; existing dirty main checkout was untouched. Baseline typecheck/lint passed; 189 test files, 2163 passed / 6 skipped.
- Frontend: 122 test files / 1530 passed; TypeScript and Vite build passed. Independent Standards and Spec each completed two rounds, no unresolved blocker. Browser checks use isolated HTTP fixtures against the actual application, without sending real user messages.
- Production build command: `VITE_API_BASE='' VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk npm run build`.
- Output entry: `index-BoECzI9j.js`; CSS `index-CCESVbej.css`. Copy exact `dist/` into `web/`.

## Migration and deployment boundary

No migration delta from the already-running CN image. Existing 0085/0086 application evidence remains valid; 0084 stays gated off. Release follows CN SAE workflow with the exact merge SHA after image-build success. Global catch-up is outside this release: its last known deployment predates current staging migrations and its health TLS endpoint did not verify.

## Deployment evidence

- [Backend artifact PR #400](https://github.com/tianpingdeng112233-cell/MeetPR-backend/pull/400) merged as `0a8f1dcfd56be6e1567a78f086a5df5c4b824eb1`.
- PR CI [43160277088](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43160277088) and exact-SHA image build [43160606056](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43160606056) passed.
- CN SAE [deployment 43161055914](https://github.com/tianpingdeng112233-cell/MeetPR-backend/actions/runs/43161055914) succeeded on 2026-11-12 with explicit `image_sha=0a8f1dcfd56be6e1567a78f086a5df5c4b824eb1` and `migrations_applied=true`. Change order and health/login/same-origin bundle smoke gates passed.
- Independent HTTP verification at 05:25 UTC: `/health` returned 200 / `status: ok`; served build ID and both asset SHA256 values exactly matched the reviewed artifact below. Both CN install URLs were retained.
- Browser loaded the actual deployed JS/CSS with isolated API fixtures: student hover, two/eight clips, 40px rows, side arrows, target-specific draft restoration, Enter feedback/chat routing, and right rail collapse/reopen passed; no page errors. Screenshot visually inspected. These fixtures do not constitute a real authenticated messaging or media-playback smoke; no real user messages were sent.
- This follow-up records deployment only; its documentation commit does not change the running artifact or require another runtime rollout.

## Local delivery gates

Typecheck, lint, format check and build passed. Full rerun: 189 files, 2163 passed / 6 skipped. First post-swap full test run hit `Parse Error: Expected HTTP/, RTSP/ or ICE/` in the intensity round-trip API test; its source is unchanged. Isolated run and six further consecutive runs passed, then the full suite passed without a code change. Similar transient HTTP parse failure is documented in `docs/journal/2026-11-02-037-web142-deployment.md`. Local Node is v25.9.0; required CI uses Node 22. No claim of fixing the unrelated flake; no speculative instrumentation or backend patch was added. Further diagnosis phases were not pursued because the isolated trigger did not reproduce and no backend behavior changed.

Production-build browser fixture verification also passed, including an existing browser carrying the old collapsed floating-chat preference. The new sidebar uses its own preference key. Same-origin API marker and both CN install URLs verified in the bundle.

Artifact SHA256:

- `index-BoECzI9j.js`: `88a8e174fdfaca176e1c00165383eb6af1346efea1573e7520f9d315a214fd0a`
- `index-CCESVbej.css`: `34aaed8a3a9e4690da3cda9fac607b522957fa22f5c4cc6e4df052b69db5495f`
- Build ID: `1794460338852`

Verified zero diff from deployed baseline in `src/`, `db/`, `.github/`, Dockerfile, package manifests and lockfile.
