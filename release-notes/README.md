# Release notes

Each platform has its own versions and its own notes, which baybrowser.in shows at `/<platform>/release-notes/`:

| Folder | Versions | Read by |
|---|---|---|
| `mac/` | the Mac app's, `v<version>` releases | `scripts/release.sh` (the GitHub release and the update dialog) and the site |
| `linux/` | Linux's, `linux-v<version>` releases | `scripts/linux/release.sh` (the AppStream date) and `publish.sh` (the GitHub release) |
| `windows/` | Windows', from `scripts/windows/package.ps1` | the installer's update manifest |

A file is `<version>.md`: `date: YYYY-MM-DD` and `headline:` frontmatter, then `## Added`, `## Improved` and `## Fixed`
sections of `- **Title.** What changed.` items.
