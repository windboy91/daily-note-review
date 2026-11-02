# Daily Note Review

Bring notes back into a simple daily review and sort them with custom actions.
*Ramène des notes dans une revue quotidienne simple et trie-les avec des actions personnalisées.*

## New in 0.2.0 / Nouveautés

| Action | What it does / Ce que ça fait |
| --- | --- |
| **Add to daily note** | Today, tomorrow, next week (Monday) or a date picker. Offers to create the daily note if missing. / Aujourd’hui, demain, semaine prochaine (lundi) ou une date. Propose de créer la note si elle n’existe pas. |
| **Add to a specific note** | Fuzzy note picker, or type a name to create one; or fix the target in the button settings. / Sélecteur de note (ou création), ou note cible fixée dans les réglages. |
| **Convert to task** | Status, priority, 📅 due, ⏳ scheduled, 🛫 start, 🔁 recurrence, tags, ➕ creation date, link to the note. Tasks-plugin emojis or Dataview fields. / Statut, priorité, dates, récurrence, tags, lien. Format Tasks ou Dataview. |

Add them from **Settings → Daily Note Review → Actions** (existing installs get them automatically once).

## Installation

- **BRAT**: add `windboy91/daily-note-review`.
- **Manual**: download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/daily-note-review/`.

## Development

```bash
npm install
npm run dev          # watch mode
npm run build        # production bundle -> main.js
npm run typecheck    # tsc --noEmit
```

## Releasing

```bash
npm version minor    # bumps package.json, manifest.json and versions.json, creates the git tag
git push --follow-tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which builds the plugin and publishes `main.js`, `manifest.json` and `styles.css` as release assets. The tag must be exactly the manifest version (no `v` prefix).
