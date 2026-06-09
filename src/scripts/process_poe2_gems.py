import json

import requests
from json_loader import save_json
from logger import get_logger

logger = get_logger("process_poe2_gems")

# PoE2 可交易寶石名稱清單，來源為官方 trade2 資料端點的 "gem" 分類。
# 用於把 PoB 技能組裡的寶石（nameSpec）過濾成真正可在 trade 搜尋的寶石
# （排除武器內建技能、metadata 名稱等）。
TRADE2_ITEMS_URL = "https://www.pathofexile.com/api/trade2/data/items"
OUTPUT_PATH = "../data/poe2_gems.min.json"

# 官方端點會擋掉沒有瀏覽器標頭的請求
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def build_poe2_gems() -> None:
    logger.info(f"Downloading PoE2 trade items from: {TRADE2_ITEMS_URL}")
    res = requests.get(TRADE2_ITEMS_URL, headers=HEADERS)
    res.raise_for_status()
    data = res.json()

    gem_cat = next((c for c in data.get("result", []) if c.get("id") == "gem"), None)
    if gem_cat is None:
        raise RuntimeError("No 'gem' category found in trade2 items data")

    names = sorted({e["type"] for e in gem_cat.get("entries", []) if e.get("type")})
    save_json(names, OUTPUT_PATH, minify=True)
    logger.info(f"Saved {len(names)} PoE2 tradeable gem names to: {OUTPUT_PATH}")


if __name__ == "__main__":
    logger.info("Starting PoE2 gem-name extraction...")
    build_poe2_gems()
    logger.info("PoE2 gem-name extraction completed!")
