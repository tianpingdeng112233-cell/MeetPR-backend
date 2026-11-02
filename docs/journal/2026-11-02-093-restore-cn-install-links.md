# Restore CN installation links — 2026-11-02

David requested immediate restoration of the latest published installation links after an athlete could not download from the invitation page. This restores the existing spec 093 behavior; no new product behavior or application package is introduced.

- Root cause: the November 1 and November 2 web rebuilds omitted both Vite installation URLs. The deployed `index-C0tMUIgh.js` returned null for both platforms. The reported invite remains valid.
- Backend base: `83a475f`, whose runtime code, database migrations, workflow and web assets match the last successfully deployed `5d8ee71`; differences are documentation only. No new migration or runtime configuration is required. Rollback image: `sha-5d8ee71f1438078127c71c616d4fd13cde4141f0`.
- Web source remains exactly `02a22155fcb98926a40c8377edaf4217103c20c3` (merged web PR #142). Rebuilt with `VITE_API_BASE=''`, `VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b`, and `VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk`.
- TestFlight public page returns HTTP 200 and “View in TestFlight”. Release ledger records iOS 1.0(30) published; external group build assignment has not been independently verified. Downloaded Android APK manifest confirms `com.meetpr.app`, 0.1.0(6); MD5 `5f414c08bc9de8d49bcde9e4d2a687b4`, matching OSS metadata.
- New entry: `/assets/index-DBH8tlmd.js`; SHA256 `7d4698136d2a3957d5c3a8146aa46e698ed5854cc69e86a48f33c15e7e6755c4`. Both approved URLs and the same-origin API marker are present. All CSS/font/icon assets are byte-identical to the deployed version.
- Verification: web build and 21 onboarding tests pass; backend typecheck, lint, format check and build pass; full backend suite 177 files, 1850 passed / 1 existing skipped. Configuration-only generated-asset restoration; no source logic, dependency, schema or data changes.
- Browser control repeatedly timed out for in-app browser, Chrome tab and native Chrome. No visual verification is claimed. Deployment and independent public-bundle verification are pending below.

## Deployment and final verification

- During CI, backend #356 was independently merged and deployed as `b3e45937ce74dce9f2bf68dad8e02a0168d7f5ed`; run 41405295930 succeeded, including health/login/web smoke. The initial old-base image build (41405338991) was cancelled and never deployed, avoiding rollback of that update. The effective rollback baseline is now `b3e4593`, superseding the initial baseline above. This task did not execute migrations.
- #357 merged as `55554633a2e7d0aa6cf98f2cd09ad2e02db559c0`. Compared with the newly deployed b3e4593 baseline, changes are only generated web HTML/JS and this journal; runtime source, DB migrations and workflow are identical.
- Image build 41405422643 succeeded; integrated CI: 179 test files / 1890 passed / 1 existing skipped. Deployment 41405904341 succeeded with explicit image SHA 55554633a2e7d0aa6cf98f2cd09ad2e02db559c0, retaining the already-deployed 0082 baseline.
- Actual bundled-JS regression in jsdom: old bundle fails on both iPhone and Android (no install button, unavailable message); fixed bundle passes on both (coach resolves, install button exists, unavailable message absent, no JS errors). Fetch is stubbed in this DOM harness; it is not a real-browser screenshot or device-install test.
- Independent public verification: invitation HTML serves index-DBH8tlmd.js; SHA256 matches the approved artifact; both installation URLs and same-origin API marker exist; health HTTP 200; reported invite valid. Android latest.json and downloaded APK agree on CN 0.1.0(6). Verification script exits 0. TestFlight build assignment and visual/device installation remain unverified.
- Raw verification artifacts: `/Users/david/Documents/Codex/2026-11-02/xue-y/work/` (verify-install-live.py, live-verification.json, check-built-page.cjs, image-watch.log, deploy-watch.log).
