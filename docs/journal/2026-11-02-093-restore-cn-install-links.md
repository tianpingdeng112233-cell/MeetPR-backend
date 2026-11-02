# Restore CN installation links — 2026-11-02

David requested immediate restoration of the latest published installation links after an athlete could not download from the invitation page. This restores the existing spec 093 behavior; no new product behavior or application package is introduced.

- Root cause: the November 1 and November 2 web rebuilds omitted both Vite installation URLs. The deployed `index-C0tMUIgh.js` returned null for both platforms. The reported invite remains valid.
- Backend base: `83a475f`, whose runtime code, database migrations, workflow and web assets match the last successfully deployed `5d8ee71`; differences are documentation only. No new migration or runtime configuration is required. Rollback image: `sha-5d8ee71f1438078127c71c616d4fd13cde4141f0`.
- Web source remains exactly `02a22155fcb98926a40c8377edaf4217103c20c3` (merged web PR #142). Rebuilt with `VITE_API_BASE=''`, `VITE_CN_TESTFLIGHT_URL=https://testflight.apple.com/join/aKmSgx4b`, and `VITE_CN_ANDROID_URL=https://dl.meetpr.cn/android/meetpr-cn.apk`.
- TestFlight public page returns HTTP 200 and “View in TestFlight”. Release ledger records iOS 1.0(30) published; external group build assignment has not been independently verified. Downloaded Android APK manifest confirms `com.meetpr.app`, 0.1.0(6); MD5 `5f414c08bc9de8d49bcde9e4d2a687b4`, matching OSS metadata.
- New entry: `/assets/index-DBH8tlmd.js`; SHA256 `7d4698136d2a3957d5c3a8146aa46e698ed5854cc69e86a48f33c15e7e6755c4`. Both approved URLs and the same-origin API marker are present. All CSS/font/icon assets are byte-identical to the deployed version.
- Verification: web build and 21 onboarding tests pass; backend typecheck, lint, format check and build pass; full backend suite 177 files, 1850 passed / 1 existing skipped. Configuration-only generated-asset restoration; no source logic, dependency, schema or data changes.
- Browser control repeatedly timed out for in-app browser, Chrome tab and native Chrome. No visual verification is claimed. Deployment and independent public-bundle verification are pending below.
