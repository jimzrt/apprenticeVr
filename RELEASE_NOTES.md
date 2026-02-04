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
