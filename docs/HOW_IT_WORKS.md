# How It Works

Technical overview of the **PoE Ninja Redirect to Trade** extension — its architecture, data flow, and the mechanisms behind both Path of Exile 1 and Path of Exile 2 support.

## Overview

The extension adds one-click **Trade** search (and, on PoE 2 builds, a **Copy** to official item text) to [poe.ninja](https://poe.ninja) build pages. It reads the items/gems a build is using, resolves their modifiers to the official trade site's stat IDs, and builds a pre-filled trade search URL.

It is a **Manifest V3** extension with **no content script**. All logic lives in a single background service worker (`src/background.js`); page interaction happens through `chrome.scripting.executeScript`, which injects functions into the page on demand.

## Manifest & permissions

`manifest.json` (MV3):

- `background.service_worker = src/background.js`, `type: module`
- `permissions`: `webRequest` (observe poe.ninja's API calls), `scripting` (inject into pages), `storage` (cache data + settings)
- `host_permissions`: `https://poe.ninja/*` — covers both `/poe1/*` and `/poe2/*`
- `action.default_popup = src/popup.html` — the settings popup

## Two trigger mechanisms

The extension reacts to a poe.ninja page in one of two ways, registered at the bottom of `background.js`:

| Page type | Trigger | Why |
|---|---|---|
| **PoE 1 character pages** and **PoE 2 character (builds) pages** | `chrome.webRequest.onBeforeRequest` filtered by `API_URLS_FILTER` | These pages fetch the character's equipment as JSON; the extension catches that request URL and re-fetches it. |
| **PoE 2 Path-of-Building pages** (`/poe2/pob/<id>`) | `chrome.tabs.onUpdated` (matches `https://poe.ninja/poe2/pob/<id>`) | The `/poe2/pob/raw` fetch fires too early in page load for the MV3 service worker to reliably catch via webRequest, so a tab-load listener is used and the injected script fetches the data itself. |

`API_URLS_FILTER` matches `https://poe.ninja/poe1/api/builds/*/character?*` and `.../profile/characters/*` (and the PoE 2 equivalents).

---

## Flow A — PoE 1 / PoE 2 character pages (`inject_script`)

This is the original tooltip-based flow. `fetch_character_data(details)`:

1. Reads `details.url` (the equipment-data API URL caught by webRequest) and detects the game: `is_poe2 = url.includes("/poe2/")`.
2. Re-fetches that URL to get `equipment_data` (poe.ninja's JSON, in the official PoE item shape).
3. Loads the matcher/query data via `LocalDataLoader` (or `OnlineDataLoader` if "online" mode is set). For PoE 2 it selects the **PoE 2 stat table** (`poe2_stats`) instead of the PoE 1 one.
4. Calls `chrome.scripting.executeScript({ function: inject_script, args: [...] })`, passing the stat tables, query templates, `equipment_data`, and the `game` flag.

`inject_script(...)` runs **in the page**. It:

- Sets up a `MutationObserver` on `document.body` and on the floating-ui portal (`div[data-floating-ui-portal]`), so it catches item **tooltips** as poe.ninja's SPA renders them on hover. A retry attaches the observer to a late-rendered portal.
- For each tooltip (`process_tippy`), it finds the matching item in `equipment_data`, adds per-mod toggle buttons and a **Trade** button.
- Clicking **Trade** builds a trade query (`gen_query`) from the item's mods + filters and opens `https://www.pathofexile.<tld>/trade/search?q=...` (PoE 1) or `/trade2/search/poe2?q=...` (PoE 2).

PoE 2 specifics within this flow: the mod-type list (`mod_types`) is game-aware (PoE 2 adds `rune`/`desecrated`/`sanctum`/`skill`), queries include the item base/name (`gen_query(..., include_base=true)`), and roll values are attached as `value.min`.

> Note: poe.ninja's PoE 2 character-page JSON API was not reachable at the time of writing (the `/poe2/api/builds/...` endpoints returned 404), so in practice PoE 2 builds run through **Flow B** below. The PoE 2 paths in Flow A remain for if/when that API exists.

---

## Flow B — PoE 2 Path-of-Building pages (`inject_pob_panel`)

This is the primary PoE 2 path. A `chrome.tabs.onUpdated` listener detects `https://poe.ninja/poe2/pob/<id>` loads, loads the PoE 2 data (`poe2_stats`, `poe2_bases`, `poe2_gems`), and injects `inject_pob_panel`.

`inject_pob_panel(poe2_stats, poe2_bases, poe2_gems)` runs **in the page** and does everything itself:

1. **Fetch + decode.** `fetch('/poe2/pob/raw/<id>')` returns a **Path of Building 2 export code** — base64 + zlib. It decodes with `atob` + `DecompressionStream("deflate")` and parses the resulting XML with `DOMParser`.
2. **Parse the build:**
   - **Items** — the active `ItemSet` (`<Items activeItemSet>`) → its `<Slot itemId>` entries → `<Item>` nodes.
   - **Jewels** — the active passive-tree spec (`<Tree activeSpec="N">`, a 1-based index into `<Spec>`) → its `<Socket itemId>` entries (jewels are ordinary items, reusing the item parser).
   - **Gems** — the active `SkillSet` (`<Skills activeSkillSet>`) → `<Gem nameSpec level quality>`, filtered to genuinely tradeable gems via `poe2_gems` (drops innate weapon skills, etc.).
3. **Build trade links** (`build_trade_url` / `build_gem_url`): each item searches by base/name + its resolved mods (with min rolls); each gem searches by name + level/quality. Magic items have their base reconstructed from the name via `poe2_bases` (strip the ` of …` suffix, longest-suffix base match).
4. **Render a self-contained panel** (top-right, `id="r2t-pob-panel"`) with Items, Jewels, and Gems sections — **independent of poe.ninja's DOM**, which renders items with ephemeral Tailwind classes that can't be targeted reliably.

Each item/jewel row also has a **Copy** button → see *Official item text* below.

---

## Modifier matching

The core of trade search is mapping a human-readable mod string (e.g. `+157 to maximum Life`) to the trade site's stat ID (e.g. `explicit.stat_3299347043`).

**Stat table format** (`*_stats.min.json`): keyed by the mod's last two words (lowercased, numbers stripped) → a list of `{ matcher, res }`, where `matcher` is a regex with named capture groups (`(?<num0>…)`, `(?<percent0>…)`) and `res` holds the per-type trade IDs (`explicitMods`, `runeMods`, …) plus translations.

**`find_mod_id` / `resolve_mod_id`** derive the bucket key, then test each matcher regex against the mod string. On a hit they return the stat ID(s); the rolled value is read from the matched capture group and applied as `value.min` (single-value mods only — multi-number mods like "Adds X to Y" stay presence-only).

- **PoE 1** uses `en_stats.min.json` (from Awakened PoE Trade), with translations for zh-TW/ko/ru.
- **PoE 2** uses `poe2_stats.min.json` (from Exiled Exchange 2), generated in the same format, with the extra PoE 2 mod buckets.

## Official item text (Copy button)

`build_official_item_text(node)` reconstructs the in-game "copy item" format from PoB data:

- Strips PoB annotations (`{variant}`, `{range}`, `{tags}`, `Prefix:`/`Suffix:` internal lines).
- Filters unique mods to the `Selected Variant`.
- Resolves `(a-b)` ranges to actual rolls via the item's `<ModRange>` fractions.
- Emits `Item Class:` (from the `poe2_bases` base→class map) → `Rarity:` → name → base → properties → requirements → item level → implicit mods (marked `(implicit)`) → explicit mods → flags, with sections separated by `--------`.

The **Copy** button writes this to the clipboard (`navigator.clipboard.writeText`, with a `textarea`/`execCommand` fallback).

---

## Data files & generation

Bundled data lives under `src/data/`. It is cached into `chrome.storage.local` on first use by `LocalDataLoader`.

| File | Game | Source | Generator script |
|---|---|---|---|
| `awakened poe trade/en_stats.min.json` | PoE 1 | [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) | `download_apt_stats.py` + `process_apt_stats.py` |
| `com_preprocessed_gems_data.json`, `tw_preprocessed_gems_data.json` | PoE 1 | poe.ninja / official | `download_gems.py` + `process_gems.py` |
| `query.json`, `query_gems.json` | both | trade query templates | — |
| `exiled exchange 2/poe2_stats.min.json` | PoE 2 | [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2) | `download_ee2_stats.py` + `process_ee2_stats.py` |
| `exiled exchange 2/poe2_bases.min.json` | PoE 2 | Exiled Exchange 2 `items.ndjson` | `process_ee2_bases.py` — a `{base: ItemClass}` map |
| `poe2_gems.min.json` | PoE 2 | official `trade2/data/items` "gem" category | `process_poe2_gems.py` |

`src/scripts/update_data.ps1` runs the download/process scripts (via `uv`) to refresh everything. `OnlineDataLoader` can additionally pull the latest stat/gem tables from the project's GitHub `main` at runtime when "online" mode is selected, gated by GitHub SHA checks and a 5-minute interval.

## Modules

- **`modules/dataloader.js`** — `LocalDataLoader` (bundled data → `chrome.storage.local`) and `OnlineDataLoader` (GitHub-hosted updates). `LocalDataLoader._can_fetch_again` re-loads when any required key is missing (so new data files backfill on update) and when the old array-format `poe2_bases` is found (migrates it to the `{base: class}` map).
- **`modules/storage_utils.js`** — thin `get_status` / `set_status` wrappers over `chrome.storage.local`.
- **`popup.js` / `popup.html`** — the settings UI.

## Settings (popup)

Stored in `chrome.storage.local`, read by the injected scripts:

- **redirect-to** — trade site TLD (`com` / `tw`), used as `pathofexile.<tld>`.
- **lang** — modifier display language (PoE 1 translations: en / zh-tw / ko / ru, with optional bilingual modes).
- **mods-file-mode** — `build-in` (bundled data) or `online` (pull latest from GitHub).
- **trade-type** — trade `status` option (e.g. online/any).
- **debug** — enables verbose `dbg_log` output and on-page debug messages.

## Debugging

Plain `console.log` breadcrumbs are emitted (no debug mode needed):

- **Service-worker console** (`chrome://extensions` → the extension's "service worker"): `[R2T][BG]` lines — webRequest filter match, fetch success, injection start, pob page detected.
- **Page console** (F12 on the poe.ninja tab): `[R2T][PAGE]` lines — inject start, selector found/not-found, `pob fetched+decoded`, and `pob panel injected: N items, N jewels, N gems`.

## Local development

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the repo folder.
2. After editing `background.js` (the service worker), click **Reload** (↻) on the extension card, then refresh the poe.ninja page.
3. To refresh the bundled data, run `src/scripts/update_data.ps1` (requires [`uv`](https://github.com/astral-sh/uv)).

## Known limitations

- PoE 2 character-page JSON API (`/poe2/api/builds/...`) is not currently served by poe.ninja, so PoE 2 support is delivered through the PoB-page panel.
- The Copy/official format omits weapon base damage (Physical Damage/APS), which PoB does not store in the item text.
- A few uncommon PoE 2 mod-text variants do not resolve to a stat ID and are searched by base/name only.
