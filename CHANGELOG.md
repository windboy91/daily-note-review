# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [0.2.0]

### Added
- **Add to daily note** action: choose Today, Tomorrow, Next week (Monday) or any date. If the daily note does not exist, a popup offers to create it (optionally from a template).
- **Add to a specific note** action: pick a note with a fuzzy search, or type a name to create a new one. A fixed target note can be set in the button settings.
- **Convert to task** action: status, priority, due / scheduled / start dates, recurrence (with "when done"), tags, creation date and link to the source note. The task can go to a daily note, a specific note or the note itself.
- Settings: daily note template, task format (Tasks plugin emojis or Dataview inline fields), default link / creation date for tasks.
- Per-button line format (`{{link}}`, `{{title}}`, `{{date}}`) for the daily note / specific note actions.

### Changed
- Closing one of the new popups without confirming cancels the action: the note stays in the review queue.
- "Append link to today's note" now offers to create the note when it is missing instead of failing.
- Inserted links follow the Obsidian link settings (shortest path, Markdown links, …).
- Inserting "at the beginning" of a note now goes after the frontmatter.
- Existing installs get the three new buttons added once; they can be removed freely.

## [0.1.0]

- Initial version.
