Task 3 report: Extension always syncs scrape status while the app is up

Implemented:
- Added failing selftest coverage for finished-session tooltip counts.
- Kept scrape progress tooltip/progress visible for finished sessions with totals.
- Kept the red busy dot limited to running or unfinished jobs.
- Updated background idle polling to use the 5s busy interval while online.
- Preserved the latest scrape status after watch completion and refreshed title/icons from idle polls.
- Bumped the extension manifest version to 0.1.7.

Verification:
- `node extension/iconProgress.selftest.js` failed before implementation with `finished session keeps fraction`.
- `node extension/iconProgress.selftest.js` passed after implementation.
- `node --check extension/background.js` passed.
- Cursor lints reported no errors for the edited extension files.
