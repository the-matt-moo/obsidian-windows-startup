# Changelog

## 0.2.5 - 12-10-2026

### Added

- Added configurable startup delays using a hidden Windows Script Host launcher.
- Added optional startup targeting by vault name or ID.
- Added GitHub Actions artifact attestations for release assets.

### Fixed

- Preserved disabled state and startup options when switching between direct and delayed launches.
- Rejected unowned startup commands and rolled back failed updates.
