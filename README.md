# PoE Ninja Redirect to Trade

A Chrome extension that adds one-click **Trade** search to [poe.ninja](https://poe.ninja) build pages, for both **Path of Exile 1** and **Path of Exile 2**.

## Features

- **PoE 1** — adds a Trade button to equipment, flasks, jewels, and gems on character pages. Searches the official trade site by the item's modifiers (with min roll values), and can filter gems by quality and level. Modifier text can be localized to Chinese, Korean, or Russian.
- **PoE 2** — on Path of Building share pages (`poe.ninja/poe2/pob/<id>`), injects a panel that links each equipped item to the PoE 2 trade site, searching by base/name and the item's modifiers (with min roll values).

## Installation

1. Download the latest [release](https://github.com/iwtba4188/poe_ninja_redirect_to_trade/releases) and extract the ZIP.
2. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
3. Select the extracted folder.

## Usage

- **PoE 1:** open a character page and hover an item — click **Trade** to open the search.
- **PoE 2:** open a `poe.ninja/poe2/pob/<id>` page — a panel appears with a **Trade** button per equipped item.

Open the extension's icon to change the modifier language and other settings.

## Documentation

See [docs/HOW_IT_WORKS.md](./docs/HOW_IT_WORKS.md) for the architecture and data flow (how the extension reads builds and produces trade searches for both PoE 1 and PoE 2).

## Acknowledgements

- Based on the original [poe_ninja_redirect_to_trade](https://github.com/iwtba4188/poe_ninja_redirect_to_trade) by [@iwtba4188](https://github.com/iwtba4188).
- PoE 1 modifier matching uses the data from [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade) by [@SnosMe](https://github.com/SnosMe).
- PoE 2 modifier matching uses the data from [Exiled Exchange 2](https://github.com/Kvan7/Exiled-Exchange-2) by [@Kvan7](https://github.com/Kvan7).
