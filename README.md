# Maker Vault

A free, local-first project vault for 3D printing, laser engraving and vinyl cutting.

**➡ Download and try it: https://robbmx07.github.io/Maker-Vault/** · [Quick-start guide (PDF)](docs/tutorial.pdf)

Makers lose track of *how* something was made: the STL is in Downloads, the G-code is on an SD card, the laser
power and speed lived on a sticky note, and last month's perfect print can't be repeated. Maker Vault keeps every
project together — **source files, machine-ready files, the settings that worked, photos, and a log of results** —
and reads settings out of your files so you barely have to type anything.

Everything stays on your computer. There is no account and no cloud.

## Get it running

There are three editions. They share the same interface and the same file readers.

### 1. One HTML file (simplest)

Download **[`maker-vault.html`](maker-vault.html)**, save it somewhere permanent, and open it in Chrome or Edge (Firefox and
Safari should also work but are less tested). That's it: no server, no install, no internet connection needed. The whole app is that single ~57 KB file.

Because there is no server, your vault is kept **inside your browser** (IndexedDB) on this computer. Nothing is
uploaded anywhere. What that means in practice:

- **Make backups.** Clearing your browser's site data, or using a private/incognito window, erases the vault.
  *Settings → Download backup* saves everything (files, settings, run logs) as one zip;
  *Restore from backup* puts it back, even in another browser or on another computer.
- **Keep the file in one place.** Some browsers (Firefox in particular) tie the vault to the file's exact location.
  If you move or rename the file the vault can look empty — your data is still stored under the old path, so move
  the file back, or restore a backup. Hosting the page at a normal web address (for example GitHub Pages) avoids this.
- **Different browsers are separate vaults.** Use backup/restore to move between them.
- Browser storage limits are generous (typically a large share of free disk space) but not unlimited;
  *Settings* shows how much you are using.
- **Files are stored compressed** so the vault takes less room than the folders it replaces. Text-heavy files shrink
  a lot (in tests on real open-source files: G-code about 76%, STL 65–89%, SVG about 75% smaller). 3MF and photos are
  already compressed and are stored as they are, so how much you save depends on what you keep. Every compressed copy
  is verified when it is stored, and downloads and *Export package* always return the original file, byte for byte.
  *Backups* keep the compressed form (smaller, and meant to be restored into Maker Vault).

To rebuild it from source: `npm install && npm run build:html`.

A step-by-step [quick-start guide (PDF)](docs/tutorial.pdf) is included.

#### Publishing the download page (GitHub Pages)

The [`docs/`](docs/) folder is a ready-to-host website: a landing page (`index.html`) whose **Download** button gives
people the app (`maker-vault.html`), plus the tutorial PDF. To put it online:

1. On GitHub open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose branch **main** and folder **/docs**, and click **Save**.
3. After a minute or two the site is live at `https://<your-username>.github.io/<repository-name>/`.

Because the site serves the very same file, people can use the app straight from the page or download it (the two
copies are separate vaults; backup and restore moves data between them). After changing the app, run
`npm run build:html` so both copies (`maker-vault.html` and `docs/maker-vault.html`) stay in sync; the tests check this.

### 2. Standalone desktop app (not published yet)

Ready-made downloads for this edition are **not available yet**, so there is nothing on the Releases page. You can
build one yourself (see “Building the standalone app yourself” below; only the Linux build has been tested) or just
use the single HTML file above.

With a built file, double-click **maker-vault**. Your browser opens with your vault. Keep the small window that
appears open while you use it; close it to quit.

Your library is stored in a normal per-user folder, and you can back it up by copying that folder:

| System  | Location                                        |
| ------- | ----------------------------------------------- |
| Windows | `%APPDATA%\MakerVault`                          |
| macOS   | `~/Library/Application Support/MakerVault`      |
| Linux   | `~/.local/share/maker-vault`                    |

**Portable mode:** create a folder named `data` next to the program and it will keep everything there instead —
handy for running from a USB stick.

**First launch warnings.** The app is not code-signed (certificates cost money), so your OS may warn you once:

- *Windows SmartScreen:* click **More info → Run anyway**.
- *macOS:* right-click the app → **Open** → **Open**. If macOS still refuses, run
  `xattr -d com.apple.quarantine maker-vault-macos-arm64` in Terminal once.

### 3. From source (server edition)

Requires [Node.js](https://nodejs.org) 22.13 or newer. There are no runtime packages to install.

```bash
npm start
# → http://127.0.0.1:4747  (the library is stored in ./data)
```

Environment variables: `VAULT_DATA` (library folder), `PORT` (default 4747), `VAULT_NO_OPEN=1` (don't open a browser).

If Maker Vault is already running, starting it again just opens the running copy, so two programs never write to
the same library.

### Building the standalone app yourself

```bash
npm install          # dev tools only (esbuild, postject); the app itself has no dependencies
npm run build:sea    # → dist/maker-vault-<os>-<arch>
```

The result is a single ~120 MB file containing the Node runtime, the server and the UI. It can only be built for
the operating system you run the command on; `.github/workflows/release.yml` builds all three and attaches them to
a GitHub Release when you push a tag like `v0.1.0`.

## What it does

- **Drag & drop anything.** `Bracket.stl`, `Bracket_0.2mm_PETG_MK4_1h.gcode` and `Bracket.3mf` are grouped into one
  project automatically. Or import a whole folder of existing files — safe to re-run, nothing is duplicated, your
  originals are never touched.
- **Settings are read for you** into a *recipe* (best tested with PrusaSlicer; the others are newer):
  - G-code: layer height, temperatures, infill, filament, print time, weight. **Tested on real PrusaSlicer files.**
    OrcaSlicer, Bambu Studio and Cura headers are also recognised but have not been tested on real files.
  - 3MF: the same, plus the embedded preview image becomes the project cover when the file has one. **Tested on a
    real PrusaSlicer 3MF.** Bambu Studio / OrcaSlicer 3MFs are read when they contain project settings; the sample
    files tested contained few.
  - LightBurn `.lbrn/.lbrn2`: per-layer mode, speed, power, passes, line interval. Implemented from the file format
    and tested only on hand-made samples, so treat it as experimental.
  - SVG (cutting and laser designs): real-world size in mm, path count, stroke colours (layers)
  - STL: bounding box in mm and triangle count
- **Run log.** After each print or burn, log how it went. The recipe is snapshotted with the run, so when a print
  fails you can *compare any two runs* and see exactly which settings changed.
- **Materials.** Track spools and sheets; grams used on a run are deducted from the remaining amount.
- **Custom fields.** Settings → add anything you care about (bed surface, wood species, vinyl brand, customer…),
  as text, number, checkbox or dropdown, for all machines or just one.
- **Search** across names, notes, tags, file names and recipe values. Filter by machine and tag.
- **Export package.** One click gives a zip with the files, a `recipe.json` and a readable `README.md` — great for
  sharing a project or archiving it.

Cricut Design Space can't be read directly: it keeps projects in Cricut's cloud. Keep the SVG (or PNG) files you upload to Design Space here, with your material notes and results.

## Branding (optional)

To show a "free from …" credit and link in the footer, copy `maker-vault.config.example.json` to
`maker-vault.config.json` and edit it. When you build the standalone app, that file is **baked into the
executable**, so every download carries your branding. A `maker-vault.config.json` placed next to the program
overrides it.

## Security notes

The server binds to `127.0.0.1` only and rejects requests whose `Host` or `Origin` is not local, so other websites
you visit cannot read or change your vault. If you set `HOST=0.0.0.0` to use it from other devices on your network,
those checks are relaxed — only do that on a network you trust, because there is no login.

## Development

```bash
npm test      # parsers, API, import, export, security checks
npm run dev   # restart on change
```

The server is dependency-free (built-in `node:sqlite`, `node:http`, `node:zlib`). The UI is plain ES modules in
`public/` with no build step.

## Limitations

- Zip export and backup do not support archives larger than 4 GB (no zip64); export projects one at a time if you hit it.
- The HTML edition keeps data in browser storage (see above), so it depends on you making backups.
- The HTML edition has been tested in Chromium (Chrome/Edge engine); Firefox and Safari should work but are untested.
- Reading settings is best tested with PrusaSlicer. Cura, OrcaSlicer, Bambu Studio and LightBurn support has not been verified on real-world files yet. Slicer formats also change; if a file's settings aren't detected, the file is still stored and you can add the recipe by hand.
- `node:sqlite` is marked experimental by Node. The app hides that one warning; nothing else is affected.
- Windows and macOS builds are produced by the workflow and have not been run by hand yet; the Linux build has.

## License

Copyright (c) 2026 Bert's CNC Woodworking. Released under the [MIT License](LICENSE): you may use, copy, modify and share it, as long as the copyright notice and license text stay with it.
