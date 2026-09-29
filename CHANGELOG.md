# Changelog

All notable changes to Mindspace are documented here.

## 4.0.0 — 2026-09-29

### Added

- Edge-aware tool palette placement with above/below and left/right flipping.
- Click, touch, hover, and keyboard access to the floating mascot orb.
- Undo and redo history for up to 60 board changes.
- Fit-to-content, duplicate, and bring-to-front actions.
- Keyboard shortcuts for history, duplication, fitting, selection, and tools.
- New original chibi mascot icon in 16, 32, 48, and 128 pixel sizes.
- Automated repository validation and release documentation.

### Improved

- Right-click menu placement now uses measured dimensions and viewport clamping.
- Short screens receive scrollable tool and context menus.
- Drawing erasure now uses transparency and remains correct across theme changes.
- Text editing autosaves without waiting for the element to lose focus.
- Backups now retain the canvas view and receive bounded schema validation on import.
- Link favicons use the browser's internal favicon API instead of remote host access.
- Local-font management was consolidated and made more resilient.
- Motion respects the operating system's reduced-motion preference.

### Security and privacy

- Removed broad `<all_urls>` host access and unused context-menu permission.
- Removed external Google Fonts loading.
- Escaped and sanitized imported note, task, link, image, and identifier data.
- Added backup size and content bounds.
