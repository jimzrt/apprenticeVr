# v1.3.8

- Improve direct-download reliability with stronger rclone retry/timeout settings and safer transfer concurrency.
- Apply configured download speed limits to direct rclone downloads as bandwidth limits.
- Add adaptive stall detection windows for public downloads to reduce false-positive stall failures.
- Fix retry behavior for `InstallError` items to reuse existing local payloads instead of forcing re-download.
- Improve update fallback flow when completed queue entries are missing by automatically re-queuing download.
- Add `Download Only` action for installed titles from the game details dialog.
- Add FUSE diagnostics in Settings with status check, installer shortcut, and removal guidance shortcut.
- Add startup FUSE warning dialog with remediation options when FUSE is unavailable.

# v1.3.7

- Add persistent Local Library indexing with startup + scheduled rescans to track stored files across app restarts.
- Improve update/reinstall behavior with automatic re-download fallback when local files are missing or outside the active download path.
- Add `Download Only` and `Re-download` queue options with completed-item requeue support.
- Prevent nested duplicate download folders by normalizing release paths during download/fallback flows.
- Fix install pipeline to stop immediately on APK install failure (no OBB push after failed APK install).
- Propagate real ADB install errors (e.g. `INSTALL_FAILED_*`) into queue state and show them as `Install Error` tooltips in list/dialog UI.
- Add status-column icon toggles for filtering Installed / Stored Locally items, including excluded (red strike-through) state.
- Improve sortable header indicators with Fluent sort-line icons for unsorted/asc/desc states.
- Add stalled public-download watchdog handling to avoid queue hangs on zero-progress transfers.

# v1.3.6

- Fix download progress display for direct HTTP downloads by parsing rclone stats output.
- Add Ready to Install filter (stored locally, not installed) with icons and tooltips.
- Keep toolbar controls and status text on a single line; set minimum window width to 1250px.
- Update popularity display to 5-star ratings with half stars.
- Ensure Installed filter reflects actual device installs only.
- Improve trailer fallback UI with thumbnail + YouTube logo and clearer messaging.

# v1.3.5

- Fix downloads on macOS without FUSE by falling back to direct HTTP download.
- Add download sorting (Name, Date Added, Size) and display actual size.
- Restore in-app YouTube trailers in production builds by serving the renderer over localhost.
- Improve rclone error logging and mount readiness checks.
