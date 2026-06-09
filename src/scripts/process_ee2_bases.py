import json

import requests
from json_loader import save_json
from logger import get_logger

logger = get_logger("process_ee2_bases")

# PoE2 底材名稱清單，來源同 stats（Exiled Exchange 2）。用於把魔法物品名稱
# （字首 + 底材 + "of 字尾"）還原成可在 trade 搜尋的底材。namespace == "ITEM" 即底材。
EE2_ITEMS_URL = "https://raw.githubusercontent.com/Kvan7/Exiled-Exchange-2/master/renderer/public/data/en/items.ndjson"
OUTPUT_PATH = "../data/exiled exchange 2/poe2_bases.min.json"


def build_poe2_bases() -> None:
    logger.info(f"Downloading EE2 items from: {EE2_ITEMS_URL}")
    res = requests.get(EE2_ITEMS_URL)
    res.raise_for_status()

    bases = set()
    for line in res.text.split("\n"):
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if obj.get("namespace") == "ITEM" and obj.get("name"):
            bases.add(obj["name"])

    arr = sorted(bases)
    save_json(arr, OUTPUT_PATH, minify=True)
    logger.info(f"Saved {len(arr)} PoE2 base types to: {OUTPUT_PATH}")


if __name__ == "__main__":
    logger.info("Starting PoE2 base-type extraction...")
    build_poe2_bases()
    logger.info("PoE2 base-type extraction completed!")
