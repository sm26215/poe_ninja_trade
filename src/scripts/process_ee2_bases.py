import json

import requests
from json_loader import save_json
from logger import get_logger

logger = get_logger("process_ee2_bases")

# PoE2 底材 -> Item Class 對照表，來源同 stats（Exiled Exchange 2）。namespace == "ITEM" 即底材。
# 用途：(1) 鍵集合用於把魔法物品名稱（字首 + 底材 + "of 字尾"）還原成底材；
#       (2) 值為 PoE 官方「複製物品」格式的 Item Class（無對應者為 None）。
EE2_ITEMS_URL = "https://raw.githubusercontent.com/Kvan7/Exiled-Exchange-2/master/renderer/public/data/en/items.ndjson"
OUTPUT_PATH = "../data/exiled exchange 2/poe2_bases.min.json"

# EE2 craftable.category -> 官方 Item Class（複數型）。未列出者（通貨、地圖等）為 None。
CATEGORY_TO_CLASS = {
    "Amulet": "Amulets",
    "Belt": "Belts",
    "Body Armour": "Body Armours",
    "Boots": "Boots",
    "Bow": "Bows",
    "Buckler": "Bucklers",
    "Charm": "Charms",
    "Crossbow": "Crossbows",
    "Dagger": "Daggers",
    "Flail": "Flails",
    "Focus": "Foci",
    "Gloves": "Gloves",
    "Helmet": "Helmets",
    "Jewel": "Jewels",
    "One Hand Axe": "One Hand Axes",
    "One Hand Mace": "One Hand Maces",
    "One Hand Sword": "One Hand Swords",
    "Quiver": "Quivers",
    "Ring": "Rings",
    "Sceptre": "Sceptres",
    "Shield": "Shields",
    "Spear": "Spears",
    "Staff": "Staves",
    "Talisman": "Amulets",
    "Two Hand Axe": "Two Hand Axes",
    "Two Hand Mace": "Two Hand Maces",
    "Two Hand Sword": "Two Hand Swords",
    "Wand": "Wands",
    "Warstaff": "Quarterstaves",
}


def item_class(name: str, category: str | None) -> str | None:
    if category == "Flask":
        if "Life Flask" in name:
            return "Life Flasks"
        if "Mana Flask" in name:
            return "Mana Flasks"
        return "Flasks"
    return CATEGORY_TO_CLASS.get(category)


def build_poe2_bases() -> None:
    logger.info(f"Downloading EE2 items from: {EE2_ITEMS_URL}")
    res = requests.get(EE2_ITEMS_URL)
    res.raise_for_status()

    bases = {}
    for line in res.text.split("\n"):
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if obj.get("namespace") == "ITEM" and obj.get("name"):
            category = (obj.get("craftable") or {}).get("category")
            bases[obj["name"]] = item_class(obj["name"], category)

    ordered = {name: bases[name] for name in sorted(bases)}
    save_json(ordered, OUTPUT_PATH, minify=True)
    logger.info(f"Saved {len(ordered)} PoE2 base->class entries to: {OUTPUT_PATH}")


if __name__ == "__main__":
    logger.info("Starting PoE2 base->class extraction...")
    build_poe2_bases()
    logger.info("PoE2 base->class extraction completed!")
