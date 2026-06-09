import json
import os
import re

from json_loader import save_json
from logger import get_logger

logger = get_logger("process_ee2_stats")

DATA_DIR = "../data/exiled exchange 2"

# PoE2 詞綴類型。前六種與 PoE1 共用，後四種為 PoE2 新增（rune/desecrated/sanctum/skill）。
# 輸出時每種會成為 res 物件中的 "<type>Mods" 欄位，與 background.js 的
# `${mod_type}Mods` 取用方式一致。pseudo 一併保留但 background.js 目前不使用。
MOD_TYPES = [
    "explicit",
    "implicit",
    "fractured",
    "crafted",
    "enchant",
    "rune",
    "desecrated",
    "sanctum",
    "skill",
    "pseudo",
]

# 翻譯語系（檔名 -> 由 download_ee2_stats.py 產生）。缺檔則跳過該語系。
TRANSLATION_LANGS = ["zh-tw", "ko", "ru"]


def _read_ndjson(path: str) -> list:
    if not os.path.exists(path):
        logger.warning(f"Missing file (skipped): {path}")
        return []
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f.read().split("\n") if line.strip()]


def make_string_matching_table(lang: str) -> dict:
    """建立翻譯對照表，key = (ref, value, negate, '#' 數量)，value = 帶 $<num>/$<percent> 佔位的翻譯字串。"""
    logger.info(f"Creating string matching table for language: {lang}")
    entries = _read_ndjson(f"{DATA_DIR}/{lang}_stats.ndjson")

    lang_table = {}
    for entry in entries:
        for matcher in entry.get("matchers", []):
            key = (
                entry.get("ref"),
                matcher.get("value"),
                matcher.get("negate"),
                matcher["string"].count("#"),
            )
            if key in lang_table:
                continue

            res_str = matcher["string"]
            for idx in range(0, 5):
                res_str = res_str.replace("#%", f"$<percent{idx}>", 1)
            for idx in range(0, 5):
                res_str = res_str.replace("#", f"$<num{idx}>", 1)
            lang_table[key] = res_str

    logger.info(f"Created {len(lang_table)} string matching entries for {lang}")
    return lang_table


def en_make_matcher_structure() -> dict:
    """以英文 matcher 字串為 key，組出 res（含數值、各語系翻譯、各類型 trade id 陣列）。"""
    logger.info("Creating English (PoE2) matcher structure...")
    en_entries = _read_ndjson(f"{DATA_DIR}/en_stats.ndjson")
    logger.info(f"Processing {len(en_entries)} English PoE2 entries")

    trans_tables = {lang: make_string_matching_table(lang) for lang in TRANSLATION_LANGS}

    en_table = {}
    matcher_count = 0
    for entry in en_entries:
        ids = (entry.get("trade") or {}).get("ids") or {}
        for matcher in entry.get("matchers", []):
            matcher_count += 1

            trans_key = (
                entry.get("ref"),
                matcher.get("value"),
                matcher.get("negate"),
                matcher["string"].count("#"),
            )

            res = {"value": matcher.get("value")}
            for lang in TRANSLATION_LANGS:
                res[lang] = trans_tables[lang].get(trans_key)
            for mod_type in MOD_TYPES:
                res[f"{mod_type}Mods"] = ids.get(mod_type)

            # 移除 None 欄位（與 PoE1 流程一致，縮小輸出體積）
            en_table[matcher["string"]] = {k: v for k, v in res.items() if v is not None}

    logger.info(
        f"Created matcher structure with {len(en_table)} entries, "
        f"processed {matcher_count} matchers total"
    )
    return en_table


def sort_matcher_structure() -> None:
    """把 matcher 依「最後兩個詞」分桶，並把 # 佔位轉成具名捕獲群組的正則，輸出 poe2_stats(.min).json。

    分桶 key 與正則轉換需與 background.js 的 find_mod_id() 完全一致。
    """
    logger.info("Starting PoE2 matcher structure sorting...")
    en_matcher_structure = en_make_matcher_structure()
    logger.info(f"Sorting {len(en_matcher_structure)} matcher entries")

    en_table = {}
    for key, value in en_matcher_structure.items():
        kl = key.strip().split(" ")
        if len(kl) >= 2:
            k = re.sub(r"(([\+-]?[\d\.]+%?)|(#%)|(#))", "", kl[-2]) + re.sub(
                r"(([\+-]?[\d\.]+%?)|(#%)|(#))", "", kl[-1]
            )
        else:
            k = re.sub(r"(([\+-]?[\d\.]+%?)|(#%)|(#))", "", kl[-1])
        k = k.lower()

        regex = key.strip()
        for idx in range(0, 5):
            regex = regex.replace("#%", f"(?<percent{idx}>[\\+-]?[\\d\\.]+%)", 1)
        for idx in range(0, 5):
            regex = regex.replace("#", f"(?<num{idx}>[\\+-]?[\\d\\.]+)", 1)

        if regex and regex[0] == "+":
            regex = "\\" + regex
        regex = f"^{regex}$"

        en_table.setdefault(k, []).append({"matcher": regex, "res": value})

    max_key, max_len_value = "", 0
    for key, value in en_table.items():
        en_table[key] = sorted(value, key=lambda x: x["matcher"])
        if max_len_value < len(value):
            max_key, max_len_value = key, len(value)

    logger.info(f"Largest bucket '{max_key}' has {max_len_value} matchers")

    save_json(en_table, f"{DATA_DIR}/poe2_stats.json")
    save_json(en_table, f"{DATA_DIR}/poe2_stats.min.json", minify=True)
    logger.info("PoE2 matcher structure sorting completed and saved!")


if __name__ == "__main__":
    logger.info("Starting Exiled Exchange 2 (PoE2) stats processing...")
    sort_matcher_structure()
    logger.info("Exiled Exchange 2 (PoE2) stats processing completed!")
