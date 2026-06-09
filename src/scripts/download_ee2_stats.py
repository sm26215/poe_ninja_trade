import os

import requests
from logger import get_logger

logger = get_logger("download_ee2_stats")

# PoE2 stats come from Exiled Exchange 2 (the PoE2 fork of Awakened PoE Trade).
# The ndjson schema is identical to APT's (ref / matchers[].string|value|negate /
# trade.ids.<type>), so it slots straight into our existing matcher pipeline.
# EE2 ships PoE2-only mod buckets too: rune, desecrated, sanctum, skill.

# 我們的檔名 -> EE2 語系資料夾名稱（cmn-Hant 即繁體中文）
lang_code = ["en", "zh-tw", "ko", "ru"]
ee2_lang_dir = ["en", "cmn-Hant", "ko", "ru"]

EE2_BASE = "https://raw.githubusercontent.com/Kvan7/Exiled-Exchange-2/master/renderer/public/data"


logger.info("Starting Exiled Exchange 2 (PoE2) stats download...")

for idx, lang in enumerate(lang_code):
    url = f"{EE2_BASE}/{ee2_lang_dir[idx]}/stats.ndjson"
    logger.info(f"Downloading {lang} PoE2 stats from: {url}")

    res = requests.get(url)
    if res.status_code != 200:
        logger.warning(f"Skip {lang}: HTTP {res.status_code} from {url}")
        continue

    save_dir = "../data/exiled exchange 2"
    os.makedirs(save_dir, exist_ok=True)
    save_path = f"{save_dir}/{lang}_stats.ndjson"
    # 直接寫入原始 ndjson（真實換行），勿經 save_json（那會 JSON 編碼成單行字串）
    with open(save_path, "w", encoding="utf-8") as f:
        f.write(res.text)
    logger.info(f"Saved {lang} PoE2 stats to: {save_path}")

logger.info("Exiled Exchange 2 (PoE2) stats download completed!")
