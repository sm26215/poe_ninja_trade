import { LocalDataLoader, OnlineDataLoader } from "./modules/dataloader.js";
import { get_status, set_status } from "./modules/storage_utils.js";

const API_URLS_FILTER = {
    urls: [
        "https://poe.ninja/poe1/api/builds/*/character?*",
        "https://poe.ninja/poe1/api/profile/characters/*",
        // PoE2 character build pages (same JSON shape as PoE1, if/when present).
        "https://poe.ninja/poe2/api/builds/*/character?*",
        "https://poe.ninja/poe2/api/profile/characters/*"
        // NOTE: PoE2 Path-of-Building share pages (/poe2/pob/<id>) are handled NOT
        // via webRequest (the /poe2/pob/raw fetch fires too early in the page load
        // for the MV3 service worker to reliably catch) but via a tabs.onUpdated
        // listener that injects inject_pob_panel — see the bottom of this file.
    ]
};


/**
 * init key value if needed
 * @returns {None}
 */
async function init_status() {
    for (const slot of ["redirect-to", "lang", "mods-file-mode", "debug"]) {
        const val = await get_status(slot);
        if (val === undefined || val === null) {
            if (slot === "redirect-to") await set_status(slot, "com");
            else if (slot === "lang") await set_status(slot, "en");
            else if (slot === "mods-file-mode") await set_status(slot, "build-in");
            else if (slot === "debug") await set_status(slot, "off");
        }
    }
};

/**
 * 使用 fecth 方法取得該網頁的資料
 * @param {string} target_url 目標網頁，在此應為 poe.ninja 網頁網址
 * @returns {string} @param target_url 轉換為 JSON 的結果
 */
async function fetch_url(target_url) {
    let res;

    await fetch(target_url).then(
        function (response) {
            if (response.status === 200)
                return response.json();
            else
                throw new Error("Request failed: " + response.status);
        }
    ).then(function (data) {
        // console.log(_data);
        res = data;
        console.log(res);
    }).catch(function (error) {
        console.error(error);
    });

    return res;
};

/**
 * 利用取得的角色資訊，內含本專案所需之裝備資料
 * @param {any} details 詳見 google extension webRequest api
 * @return {None}
 */
async function fetch_character_data(details) {
    if (details.tabId === -1) return;

    const api_url = details.url;

    // 偵測目前是 PoE1 還是 PoE2 的 API 請求（poe.ninja 的網址中含有 /poe2/ 即為 PoE2）
    const game = api_url.includes("/poe2/") ? "poe2" : "poe1";
    const is_poe2 = game === "poe2";
    console.log(`[R2T][BG] webRequest filter matched (game=${game}): ${api_url}`);

    const equipment_data = await fetch_url(api_url);
    console.log(`[R2T][BG] fetch success (game=${game}), equipment_data:`, equipment_data);

    const local_loader = new LocalDataLoader();
    const online_loader = new OnlineDataLoader();
    if (await get_status("mods-file-mode") === "online") {
        console.log("Using online data.");
        await online_loader.update_data();
    } else {
        console.log("Using local data.");
    }
    await local_loader.update_data();

    const query_data = await local_loader.get_data("local_query_data");
    const gems_query_data = await local_loader.get_data("local_gems_query_data");

    // PoE2 使用 Exiled Exchange 2 的詞綴表（與 PoE1 的 en_stats 不同庫），僅在 PoE2 時載入。
    // 不論 mods-file-mode 為何都用本地 PoE2 詞綴表（線上來源尚未提供）。
    const poe2_stats_data = is_poe2 ? await local_loader.get_data("local_poe2_stats_data") : null;

    console.log(`[R2T][BG] injection start (game=${game}, poe2_stats=${is_poe2 ? "loaded" : "n/a"}), tabId=${details.tabId}`);

    if (await get_status("mods-file-mode") === "online") {
        try {
            chrome.scripting.executeScript({
                target: { tabId: details.tabId },
                function: inject_script,
                args: [
                    is_poe2 ? poe2_stats_data : await online_loader.get_data("online_stats_data"),
                    await online_loader.get_data("online_gems_data"),
                    await online_loader.get_data("online_tw_gems_data"),
                    query_data,
                    gems_query_data,
                    equipment_data,
                    game
                ],
            });
        } catch (e) {
            console.warn(e);
            chrome.scripting.executeScript({
                target: { tabId: details.tabId },
                function: inject_script,
                args: [
                    is_poe2 ? poe2_stats_data : await local_loader.get_data("local_stats_data"),
                    await local_loader.get_data("local_gems_data"),
                    await local_loader.get_data("local_tw_gems_data"),
                    query_data,
                    gems_query_data,
                    equipment_data,
                    game
                ],
            });
        }
    } else {
        chrome.scripting.executeScript({
            target: { tabId: details.tabId },
            function: inject_script,
            args: [
                await local_loader.get_data("local_stats_data"),
                await local_loader.get_data("local_gems_data"),
                await local_loader.get_data("local_tw_gems_data"),
                query_data,
                gems_query_data,
                equipment_data,
                game
            ],
        });
    }
}

/**
 * 要 inject 進目前 tab 的 script，功能：加入按鈕，轉換物品 mod 到 stats id
 * @param {Object} stats_data 整理過的詞墜表，提升查找效率與準確率
 * @param {Object} gems_data 整理過的寶石詞墜表，提升查找效率與準確率
 * @param {Object} tw_gems_data 整理過的台服寶石詞墜表，提升查找效率與準確率
 * @param {Object} query_data poe trade 的 query 格式，詳見 POE 官網及 query_example.json 示範
 * @param {Object} gems_query_data poe trade 的 query 格式，詳見 POE 官網及 query_example.json 示範
 * @param {Object} equipment_data 抓取到的角色裝備資料，內容來源為 poe.ninja，但格式是 POE 官方定義的
 * @return {None}
 */
async function inject_script(stats_data, gems_data, tw_gems_data, query_data, gems_query_data, equipment_data, game) {
    function dbg_log(msg) { if (is_debugging) console.log(msg); }
    function dbg_warn(msg) { if (is_debugging) console.warn(msg); }

    // game 由 background 傳入，"poe1" 或 "poe2"；舊版呼叫未帶此參數時預設 poe1
    const is_poe2 = game === "poe2";
    console.log(`[R2T][PAGE] inject_script start (game=${game || "poe1"})`);

    const is_debugging = (await chrome.storage.local.get(["debug"]))["debug"] === "on";
    const redirect_to = (await chrome.storage.local.get(["redirect-to"]))["redirect-to"];
    const trade_type = (await chrome.storage.local.get(["trade-type"]))["trade-type"];
    const now_lang = (await chrome.storage.local.get(["lang"]))["lang"];
    const now_lang_for_lang_matching = now_lang.replace("en-", "");
    const global_mask_cache = new Map();

    dbg_log("[Status] 'PoE Ninja Redirect to Trade' start!")
    dbg_log("[Status] stats_data = ");
    dbg_log(stats_data);
    dbg_log("[Status] gems_data = ");
    dbg_log(gems_data);
    dbg_log("[Status] tw_gems_data = ");
    dbg_log(tw_gems_data);
    dbg_log("[Status] query_data = ");
    dbg_log(query_data);
    dbg_log("[Status] gems_query_data = ");
    dbg_log(gems_query_data);

    // 檢查並開啟更新分頁
    const update_status = await chrome.storage.local.get(["show_update_popup"]);
    if (update_status["show_update_popup"]) {
        chrome.runtime.sendMessage({ action: "open_update_tab" });
        await chrome.storage.local.remove("show_update_popup");
    }

    // PoE1: /trade/search ；PoE2: /trade2/search/poe2（poe2 為 realm 區段，省略 league 時導向預設聯盟）
    const POE_TRADE_URL = is_poe2
        ? `https://www.pathofexile.${redirect_to}/trade2/search/poe2`
        : `https://www.pathofexile.${redirect_to}/trade/search`;
    const BALANCE_ICON = `<path xmlns="http://www.w3.org/2000/svg" d="M14.6302 7L13.0002 3H14.0002V2H9.00024V1H8.00024V2H3.00024V3H4.00024L2.38024 7H2.00024V8H2.15024C2.30663 8.49791 2.623 8.93028 3.05024 9.23C3.47189 9.53576 3.9794 9.7004 4.50024 9.7004C5.02108 9.7004 5.5286 9.53576 5.95024 9.23C6.3776 8.92817 6.69663 8.49696 6.86024 8H7.00024V7H6.55024L4.88024 3H8.00024V11H6.00024L5.61024 11.18L3.61024 13.69L4.00024 14.5H13.0002L13.3902 13.69L11.3902 11.18L11.0002 11H9.00024V3H12.1302L10.4602 7H10.0002V8H10.1502C10.3138 8.49544 10.6294 8.92668 11.0522 9.23236C11.4751 9.53804 11.9835 9.70258 12.5052 9.70258C13.027 9.70258 13.5354 9.53804 13.9582 9.23236C14.3811 8.92668 14.6967 8.49544 14.8602 8H15.0002V7H14.6302ZM5.22024 8.51C4.99971 8.63205 4.75229 8.69734 4.50024 8.7C4.25119 8.69869 4.00667 8.63326 3.79024 8.51C3.56955 8.38903 3.38362 8.21342 3.25024 8H5.75024C5.61799 8.21083 5.436 8.38595 5.22024 8.51ZM5.47024 7H3.47024L4.47024 4.6L5.47024 7ZM10.7602 12L12.0002 13.5H5.00024L6.24024 12H10.7602ZM12.5402 4.62L13.5402 7.02H11.5402L12.5402 4.62ZM13.2202 8.53C13.0016 8.65671 12.7529 8.72233 12.5002 8.72V8.72C12.2506 8.72355 12.0048 8.65778 11.7902 8.53C11.5692 8.40065 11.3837 8.21856 11.2502 8H13.7502C13.6263 8.2225 13.4427 8.40604 13.2202 8.53V8.53Z" fill="#424242"/>`;
    const CHECK_ICON = `<path fill-rule="evenodd" clip-rule="evenodd" d="M14.4315 3.3232L5.96151 13.3232L5.1708 13.2874L1.8208 8.5174L2.63915 7.94268L5.61697 12.1827L13.6684 2.67688L14.4315 3.3232Z" fill="#388A34"/>`;
    const CROSS_ICON = `<path fill-rule="evenodd" clip-rule="evenodd" d="M8.00028 8.70711L11.6467 12.3536L12.3538 11.6465L8.70739 8.00001L12.3538 4.35356L11.6467 3.64645L8.00028 7.2929L4.35384 3.64645L3.64673 4.35356L7.29317 8.00001L3.64673 11.6465L4.35384 12.3536L8.00028 8.70711Z" fill="#E51400"/>`;
    const BLOCK_ICON = `<path d="M8.00024 1C9.38471 1 10.7381 1.41054 11.8892 2.17971C13.0404 2.94888 13.9376 4.04213 14.4674 5.32122C14.9972 6.6003 15.1358 8.00777 14.8657 9.36563C14.5956 10.7235 13.929 11.9708 12.95 12.9497C11.971 13.9287 10.7237 14.5954 9.36587 14.8655C8.00801 15.1356 6.60054 14.997 5.32146 14.4672C4.04237 13.9373 2.94912 13.0401 2.17995 11.889C1.41078 10.7378 1.00024 9.38447 1.00024 8C1.00236 6.14413 1.74054 4.36489 3.05283 3.05259C4.36513 1.7403 6.14438 1.00212 8.00024 1ZM2.00024 8C1.99946 9.41814 2.50396 10.7902 3.42324 11.87L11.8702 3.423C10.9978 2.68282 9.93164 2.20787 8.79785 2.05426C7.66405 1.90065 6.50998 2.0748 5.47201 2.55614C4.43403 3.03748 3.55554 3.80588 2.94033 4.77056C2.32512 5.73523 1.9989 6.85585 2.00024 8ZM14.0002 8C14.001 6.58186 13.4965 5.20983 12.5772 4.13L4.13024 12.577C5.00272 13.3172 6.06885 13.7921 7.20264 13.9457C8.33643 14.0994 9.4905 13.9252 10.5285 13.4439C11.5664 12.9625 12.4449 12.1941 13.0602 11.2294C13.6754 10.2648 14.0016 9.14415 14.0002 8Z" fill="#424242"/>`;
    const EXTERNAL_LINK_ICON = `<path d="M1.50024 1.00006L6.00024 1V2L2.00024 2.00006V14.0001H14.0002V10.0001H15.0002V14.5001L14.5002 15.0001H1.50024L1.00024 14.5001V1.50006L1.50024 1.00006Z" fill="#424242"/> <path d="M15.0003 1.50006L15.0003 8.00003H14.0003L14.0003 2.70716L7.24293 9.46451L6.53583 8.7574L13.2932 2.00006L8.00028 2.00006V1.00006H14.5003L15.0003 1.50006Z" fill="#424242"/>`;

    if (equipment_data["charModel"]) {
        equipment_data = equipment_data["charModel"];
    }

    let lang_matching = {};

    /**
     * 從 STATS_DATA_PATH 尋找 mod_string 對應的 stats id。
     * @param {string} mod_string 要查詢的詞墜（預先處理過），格式是預先處理過的詞墜，用來直接比對查詢 stats id
     * @return {object} 查詢到的 stats res。如果沒有查詢到的話，則為 null
     */
    function find_mod_id(mod_string) {
        let last_two_char = mod_string.trim().split(" ");
        // replace regex 和 ./scripts/transform_apt_stats.py sort_matcher_structure() 的 k.sub() 一致
        if (last_two_char.length >= 2) last_two_char = last_two_char[last_two_char.length - 2].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "") + last_two_char[last_two_char.length - 1].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "");
        else last_two_char = last_two_char[last_two_char.length - 1].replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, "");

        const matchers = stats_data[last_two_char.toLowerCase()];

        if (!matchers) return null;

        for (const matcher of matchers) {
            const match_string = matcher["matcher"];
            const match_regex = RegExp(match_string, "g");

            if (match_regex.test(mod_string)) {
                if (!matcher["res"][now_lang_for_lang_matching]) {
                    return matcher["res"];
                }

                const lang_mod_string = mod_string.replace(match_regex, RegExp(matcher["res"][now_lang_for_lang_matching])).replaceAll("/", "").replaceAll("\\n", "\n");

                // 珠寶換行的詞綴在 tippy 中是用空格分開，ex: "Added Small Passive Skills grant: 12% increased Trap Damage Added Small Passive Skills grant: 12% increased Mine Damage"
                if (mod_string.indexOf("\n") !== -1) lang_matching[mod_string.replace("\n", " ")] = lang_mod_string;
                lang_matching[mod_string] = lang_mod_string;

                return matcher["res"];
            }
        }

        return null;
    };

    /**
     * 將 msg 直接 push_front 到頁面最上方
     * @param {string} msg 要加在頁面最上方的 msg
     * @returns {None}
     */
    function dbg_add_msg_to_page_top(msg) {
        if (!is_debugging) return;

        const new_node = document.createElement("p");
        new_node.setAttribute("style", "width: max-content; max-width: none;");
        new_node.innerHTML = msg;

        document.querySelectorAll("header#header")[0].prepend(new_node);
    };

    /**
     * 英文詞墜翻成中文詞墜
     * @param {string} mod_string 要翻譯的英文詞墜
     * @returns {string} 翻譯成中文的詞墜
     */
    function translate_mod(mod_string) {
        dbg_log(`[Tippy Item] mod_string = "${mod_string}", lang_matching[mod_string] = "${lang_matching[mod_string]}"`);
        if (find_mod_id(mod_string)) { // XXX: 暫時髒寫法
            if (lang_matching[mod_string]) return lang_matching[mod_string];
            else return mod_string;
        }
        return null;
    }

    dbg_log(equipment_data);

    dbg_add_msg_to_page_top("[DEBUGGING]");

    dbg_log(lang_matching);

    // PoE1 與 PoE2 的詞綴類型不同：PoE2 新增 rune/desecrated/sanctum/skill，且沒有 mutated。
    // 這些字串對應 item_data["${type}Mods"] 與 poe2_stats res 的 "${type}Mods" 欄位。
    const mod_types = is_poe2
        ? ["enchant", "implicit", "fractured", "explicit", "crafted", "rune", "desecrated", "sanctum", "skill"]
        : ["enchant", "implicit", "fractured", "explicit", "crafted", "mutated"];

    function clean_empty_entries(obj) {
        for (const key in obj) {
            const value = obj[key];

            if (value === undefined || Number.isNaN(value)) {
                delete obj[key];
            } else if (typeof value === "object" && value !== null) {
                clean_empty_entries(value);

                if (Object.keys(value).length === 0) {
                    delete obj[key];
                }
            }
        }
        return obj;
    }

    function clean_no_filters(obj) {
        for (const key in obj) {
            if (obj[key] !== undefined && obj[key]["filters"] === undefined) {
                delete obj[key];
            }
        }
        return obj;
    }

    function block_other_click_event_for_button(btn) {
        const stop_event = (event) => { event.stopPropagation(); };
        const events_to_block = ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart", "touchend"];
        events_to_block.forEach(evt => {
            btn.addEventListener(evt, stop_event, true);
        });
    }

    function gen_toggle_botton(data_key, button_type, mask_list) {
        let current_state = button_type;

        function select_icon(state) {
            switch (state) {
                case "check": return CHECK_ICON;
                case "cross": return CROSS_ICON;
                case "block": return BLOCK_ICON;
                default: return undefined;
            }
        }

        function select_hover_title(state) {
            switch (state) {
                case "check": return "Click to disable this filter in search";
                case "cross": return "Click to enable this filter in search";
                case "block": return "This filter is currently unavailable";
                default: return undefined;
            }
        }

        function select_cursor_type(state) {
            switch (state) {
                case "check":
                case "cross": return "pointer";
                case "block": return "not-allowed";
                default: return undefined;
            }
        }

        const icon_node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon_node.setAttribute("viewBox", "0 0 16 16");
        icon_node.setAttribute("fill", "currentColor");
        icon_node.setAttribute("width", "100%");
        icon_node.setAttribute("height", "100%");
        icon_node.setAttribute("style", "display: block;");
        icon_node.innerHTML = select_icon(current_state);

        const button_node = document.createElement("button");
        button_node.setAttribute("class", "button filter-btn");
        button_node.setAttribute("role", "button");
        button_node.setAttribute("style", "display: flex; justify-content: center; align-items: center; width: 18px; height: 18px; background-color: ivory; padding: 2px; border: none;");
        button_node.dataset.variant = "plain";
        button_node.dataset.size = "xsmall";
        button_node.dataset.state = current_state;
        button_node.dataset.key = data_key;
        button_node.disabled = (current_state === "block");

        button_node.appendChild(icon_node);

        const new_node = document.createElement("div");
        new_node.setAttribute("title", select_hover_title(current_state));
        new_node.setAttribute("style", `display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; margin-right: 5px; cursor: ${select_cursor_type(current_state)};`);
        new_node.appendChild(button_node);

        block_other_click_event_for_button(new_node);

        new_node.addEventListener("click", () => {
            if (current_state === "block") return;

            current_state = (current_state === "check") ? "cross" : "check";

            icon_node.innerHTML = select_icon(current_state);
            new_node.setAttribute("title", select_hover_title(current_state));
            button_node.dataset.state = current_state;

            if (mask_list) {
                mask_list.set(String(data_key), current_state);
            }
        });

        return new_node;
    }

    function gen_trade_botton(node, mask_list, item_data, is_gem, level, quality) {
        function update_mask_list(node, mask_list) {
            const toggle_btns = node.querySelectorAll("button.filter-btn");
            for (let btn of toggle_btns) {
                const key = btn.dataset.key;
                if (mask_list.has(key)) {
                    mask_list.set(key, btn.dataset.state);
                }
            }
        }

        const icon_node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const text_node = document.createTextNode("Trade");

        icon_node.setAttribute("viewBox", "0 0 16 16");
        icon_node.setAttribute("fill", "currentColor");
        icon_node.setAttribute("width", "10px");
        icon_node.setAttribute("height", "10px");
        icon_node.setAttribute("style", "display: block;");
        icon_node.innerHTML = EXTERNAL_LINK_ICON;

        const button_node = document.createElement("button");
        button_node.setAttribute("class", "button trade-btn");
        button_node.setAttribute("role", "button");
        button_node.setAttribute("style", "display: flex; justify-content: center; align-items: center; gap: 4px; height: 22px; background-color: ivory; padding: 2px 6px; border: none; cursor: pointer;");
        button_node.dataset.variant = "plain";
        button_node.dataset.size = "xsmall";

        button_node.appendChild(icon_node);
        button_node.appendChild(text_node);

        const new_node = document.createElement("div");
        new_node.setAttribute("title", "Redirect to trade website");
        new_node.setAttribute("style", "display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; margin-right: 5px;");
        new_node.appendChild(button_node);

        block_other_click_event_for_button(new_node);

        new_node.addEventListener("click", () => {
            update_mask_list(node, mask_list);
            let url = "";
            if (is_poe2) {
                // PoE2：物品以「底材/名稱 + 可對應到的 mod stats」搜尋；
                // 寶石仍只用名稱（PoE2 寶石不在 gems_data 內）。
                if (is_gem) url = `${POE_TRADE_URL}?q=${gen_poe2_name_query(item_data)}`;
                else url = `${POE_TRADE_URL}?q=${gen_query(mask_list, item_data, is_gem, true)}`;
            } else if (is_gem) {
                let gem_name = "";
                if (item_data.name) gem_name += item_data.name + " ";
                if (item_data.typeLine) gem_name += item_data.typeLine;
                gem_name = gem_name.trim();

                if (item_data.hybrid && item_data.hybrid.baseTypeName) {
                    gem_name += ` (${item_data.hybrid.baseTypeName})`;
                }

                url = `${POE_TRADE_URL}?q=${gen_gem_query(mask_list, gem_name, level, quality, redirect_to)}`;
            } else {
                url = `${POE_TRADE_URL}?q=${gen_query(mask_list, item_data, is_gem)}`;
            }
            window.open(url, '_blank').focus();
            dbg_log(url);
        });

        return new_node;
    }

    function gen_stats_by_item_data(mask_list, item_data, is_gem) {
        function is_check(key) {
            return (mask_list.get(String(key)) === "check");
        }

        // PoE2：從詞綴字串取出實際 roll 值，作為 trade 的 value.min。
        // 僅在恰有單一數值時採用；多值（如「Adds X to Y Damage」）意義不明確，維持只比對詞綴存在。
        function extract_roll_value(mod_string) {
            const nums = (mod_string.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
            return nums.length === 1 ? nums[0] : undefined;
        }

        if (is_gem) return undefined;

        let item_stats = [{
            type: "and",
            filters: [],
            disabled: false,
        }];

        for (const mod_type of mod_types) {
            const mod_type_index = `${mod_type}Mods`;
            const item_mods = item_data[mod_type_index];
            const item_inventoryId = item_data["inventoryId"];

            for (const idx in item_mods) {
                const mod = item_mods[idx];
                const disabled = !is_check(`${mod_type}${idx}`);

                try {
                    var res = find_mod_id(mod);
                } catch (e) {
                    dbg_warn(e);
                    dbg_add_msg_to_page_top(e);
                }

                if (!res) {
                    dbg_warn("[MOD NOT FOUND] mod_type=" + mod_type + ", mod_string='" + mod + "'");
                    dbg_add_msg_to_page_top("[MOD NOT FOUND] mod_type=" + mod_type + ", item_inventoryId=" + item_inventoryId + ", origin mod='" + mod + "'");
                    continue;
                }

                const target_index = mod_type === "mutated" ? "explicitMods" : mod_type_index;
                const mod_ids = res[target_index];
                const value = res["value"];
                // PoE2 才額外帶上實際 roll 值（min）；PoE1 維持原本只比對詞綴存在的行為
                const roll = is_poe2 ? extract_roll_value(mod) : undefined;

                if (!mod_ids) {
                    dbg_warn(item_inventoryId);
                    dbg_warn(item_mods);
                    dbg_warn("[MOD NOT FOUND] mod_type=" + mod_type + ", mod_string='" + mod + "'");
                    dbg_add_msg_to_page_top("[MOD NOT FOUND] mod_type=" + mod_type + ", item_inventoryId=" + item_inventoryId + ", origin mod='" + mod + "'");
                    continue;
                }

                if (mod_ids.length > 1) {
                    const filters = [];
                    for (const mod_id of mod_ids) {
                        if (value) filters.push({ id: mod_id, value: { min: value }, disabled: disabled });
                        else if (roll !== undefined) filters.push({ id: mod_id, value: { min: roll }, disabled: disabled });
                        else filters.push({ id: mod_id, disabled: disabled });
                    }

                    item_stats.push({
                        type: "count",
                        filters: filters,
                        value: { min: 1 },
                    });
                } else {
                    if (value && value === 100) item_stats[0].filters.push({ id: mod_ids[0], value: { min: value }, disabled: disabled });
                    else if (value) item_stats[0].filters.push({ id: mod_ids[0], option: value, disabled: disabled });
                    else if (roll !== undefined) item_stats[0].filters.push({ id: mod_ids[0], value: { min: roll }, disabled: disabled });
                    else item_stats[0].filters.push({ id: mod_ids[0], disabled: disabled });
                }
                dbg_log("[SUCCESS] id=" + mod_ids[0] + ", value=" + value + ", mod_string='" + mod + "'");
            }
        }

        return item_stats;
    }

    function gen_filters_by_item_data(mask_list, item_data, is_gem) {
        function extract_value_by_type(src, type) {
            try {
                for (var ele of src) {
                    if (ele["type"] === type && ele["values"].length === 1) {
                        return ele["values"][0][0];
                    } else if (ele["type"] === type) {
                        let res = [];
                        for (var val of ele["values"]) {
                            res.push(val[0]);
                        }
                        return res;
                    }
                }
                return undefined;
            } catch (e) {
                return undefined;
            }
        }

        function calc_avg_dmg(raw_str) {
            try {
                const split_str = raw_str.split("-");
                return (parseInt(split_str[0]) + parseInt(split_str[1])) / 2;
            } catch (e) {
                return undefined;
            }
        }

        function is_check(key) {
            return (mask_list.get(String(key)) === "check");
        }

        let item_filters = {
            "armour_filters": {
                disabled: false,
                filters: {
                    "block": { min: undefined },
                    "ar": { min: undefined },
                    "ev": { min: undefined },
                    "es": { min: undefined },
                    "ward": { min: undefined },
                }
            },
            "misc_filters": {
                disabled: false,
                filters: {
                    "corrupted": { option: undefined },
                    "ilvl": { min: undefined },
                    "gem_level": { min: undefined },
                    "mirrored": { option: undefined },
                    "quality": { min: undefined },
                    "split": { option: undefined },
                    "synthesised_item": { option: undefined },
                }
            },
            "req_filters": {
                disabled: false,
                filters: {
                    "dex": { min: undefined },
                    "int": { min: undefined },
                    "lvl": { min: undefined },
                    "str": { min: undefined },
                }
            },
            "type_filters": {
                disabled: false,
                filters: {
                    "category": { option: undefined },
                    "rarity": { option: undefined },
                }
            },
            "weapon_filters": {
                disabled: false,
                filters: {
                    "aps": { min: undefined },
                    "crit": { min: undefined },
                    "edps": { min: undefined },
                    "pdps": { min: undefined },
                }
            }
        };

        if (is_gem) return clean_no_filters(clean_empty_entries(item_filters));

        let properties = item_data["properties"];
        let requirements = item_data["requirements"];

        if (is_check(15)) item_filters["armour_filters"]["filters"]["block"]["min"] = parseInt(extract_value_by_type(properties, 15));
        if (is_check(16)) item_filters["armour_filters"]["filters"]["ar"]["min"] = parseInt(extract_value_by_type(properties, 16));
        if (is_check(17)) item_filters["armour_filters"]["filters"]["ev"]["min"] = parseInt(extract_value_by_type(properties, 17));
        if (is_check(18)) item_filters["armour_filters"]["filters"]["es"]["min"] = parseInt(extract_value_by_type(properties, 18));
        if (is_check(54)) item_filters["armour_filters"]["filters"]["ward"]["min"] = parseInt(extract_value_by_type(properties, 54));

        if (is_check("item_level")) item_filters["misc_filters"]["filters"]["ilvl"]["min"] = item_data["ilvl"];
        if (is_check(5)) item_filters["misc_filters"]["filters"]["gem_level"]["min"] = parseInt(extract_value_by_type(properties, 5));
        if (is_check(6)) item_filters["misc_filters"]["filters"]["quality"]["min"] = parseInt(extract_value_by_type(properties, 6));

        if (is_check("requirements") && requirements) {
            item_filters["req_filters"]["filters"]["lvl"]["min"] = parseInt(extract_value_by_type(requirements, 62));
            item_filters["req_filters"]["filters"]["str"]["min"] = parseInt(extract_value_by_type(requirements, 63));
            item_filters["req_filters"]["filters"]["dex"]["min"] = parseInt(extract_value_by_type(requirements, 64));
            item_filters["req_filters"]["filters"]["int"]["min"] = parseInt(extract_value_by_type(requirements, 65));
        }

        if (item_data["rarity"]) {
            item_filters["type_filters"]["filters"]["rarity"]["option"] = item_data["rarity"].toLowerCase();
        }

        if (is_check(13)) item_filters["weapon_filters"]["filters"]["aps"]["min"] = parseFloat(extract_value_by_type(properties, 13));
        if (is_check(12)) item_filters["weapon_filters"]["filters"]["crit"]["min"] = parseFloat(extract_value_by_type(properties, 12));
        if (is_check(10)) {
            const ele_dmg = extract_value_by_type(properties, 10);
            if (ele_dmg !== undefined)
                item_filters["weapon_filters"]["filters"]["edps"]["min"] = (calc_avg_dmg(ele_dmg[0]) + calc_avg_dmg(ele_dmg[1]) + calc_avg_dmg(ele_dmg[2])) * parseFloat(extract_value_by_type(properties, 13));
        }
        if (is_check(9)) item_filters["weapon_filters"]["filters"]["pdps"]["min"] = calc_avg_dmg(extract_value_by_type(properties, 9)) * parseFloat(extract_value_by_type(properties, 13));

        item_filters = clean_empty_entries(item_filters);
        item_filters = clean_no_filters(item_filters);

        return item_filters;
    }

    function gen_status() {
        return { option: trade_type };
    }

    // PoE2 里程碑 1：只用名稱/底材搜尋，不帶任何 mod/filter。
    // item_data.name 為唯一物品名稱（一般物品為空），typeLine 為底材名稱。
    function gen_poe2_name_query(item_data) {
        let res = {
            query: {
                status: gen_status(),
            },
            sort: { price: "asc" }
        };

        if (item_data && item_data["name"]) res.query.name = item_data["name"];
        if (item_data && item_data["typeLine"]) res.query.type = item_data["typeLine"];

        res = clean_empty_entries(res);
        return JSON.stringify(res);
    }

    function gen_query(mask_list, item_data, is_gem, include_base) {
        let res = {
            query: {
                filters: gen_filters_by_item_data(mask_list, item_data, is_gem),
                stats: gen_stats_by_item_data(mask_list, item_data, is_gem),
                status: gen_status(),
            },
            sort: {
                price: "asc"
            }
        };

        // PoE2 會帶上底材/名稱，讓即使沒有任何 mod 對應到時，仍退化為底材搜尋。
        if (include_base && item_data) {
            if (item_data["name"]) res.query.name = item_data["name"];
            if (item_data["typeLine"]) res.query.type = item_data["typeLine"];
        }

        res = clean_empty_entries(res);
        return JSON.stringify(res);
    }

    function gen_gem_query(mask_list, name, level, quality, server_type) {
        function is_check(key) {
            return (mask_list.get(String(key)) === "check");
        }

        let filters = {
            query: {
                status: gen_status(),
                type: {
                    option: undefined,
                    discriminator: "alt_x"
                },
                stats: [],
                filters: {
                    misc_filters: {
                        filters: {}
                    }
                }
            },
            sort: { price: "asc" }
        };

        if (is_check(5) && level !== undefined) {
            filters.query.filters.misc_filters.filters.gem_level = { min: level };
        }
        if (is_check(6) && quality !== undefined) {
            filters.query.filters.misc_filters.filters.quality = { min: quality };
        }

        const gems_info = server_type === "com" ? gems_data[name] : tw_gems_data[name];

        if (gems_info) {
            if (gems_info["disc"]) {
                filters.query.type.option = gems_info["type"];
                filters.query.type.discriminator = gems_info["disc"];
            } else {
                filters.query.type = gems_info["type"];
                delete filters.query.type.discriminator;
            }
        } else {
            filters.query.type = name;
        }

        filters = clean_empty_entries(filters);
        filters = clean_no_filters(filters);

        return JSON.stringify(filters);
    }

    function get_all_deepest_div(node) {
        if (!node) return [];
        const all_divs = node.querySelectorAll("div");
        const deepest_divs = Array.from(all_divs).filter(div => !div.querySelector("div"));
        return deepest_divs;
    }

    function translate_node(node) {
        const divs = get_all_deepest_div(node);

        if (now_lang === "en") return;
        for (const ele of divs) {
            const lang_mod_string = translate_mod(ele.innerText);

            if (!lang_mod_string) continue;

            if (["zh-tw", "ko", "ru"].includes(now_lang)) {
                ele.innerText = lang_mod_string;
            }
            else if (["en-zh-tw", "en-ko", "en-ru"].includes(now_lang) && ele.innerText !== lang_mod_string) {
                ele.innerText += "\n" + lang_mod_string;
            }
        }
    }

    function process_tippy(tippy_node) {
        if (tippy_node.nodeType !== 1) return;
        if (tippy_node.querySelector(".trade-btn")) return;

        function get_item_name(node) {
            try {
                let name = node.querySelector("h1").innerText;
                return name.replace(/\n/g, " ");
            } catch (error) {
                return undefined;
            }
        }

        function get_item_level(node) {
            const regex = /Level:\s*(\d+)/;
            const match = node.innerText.match(regex);
            if (match) {
                return Number(match[1]);
            }
            return undefined;
        }

        function get_item_quality(node) {
            const regex = /Quality:\s*\+(\d+)/;
            const match = node.innerText.match(regex);
            if (match) {
                return Number(match[1]);
            }
            return undefined;
        }

        function gen_mask_list(item_data, is_gem) {
            let placeholder_idx = 1000;
            let res = new Map();

            if (is_gem) {
                if (item_data["properties"]) {
                    for (var ele of item_data["properties"] || []) {
                        switch (ele["type"]) {
                            case 5:
                            case 6:
                                res.set(String(ele["type"]), "check");
                                break;
                            case undefined:
                                res.set(placeholder_idx, "block");
                                placeholder_idx++;
                                break;
                            default:
                                dbg_warn(ele);
                                res.set("unknown", "block");
                                break;
                        }
                    }
                }
                return res;
            }

            for (var ele of item_data["properties"] || []) {
                switch (ele["type"]) {
                    case 6:
                    case 9:
                    case 10:
                    case 12:
                    case 13:
                    case 15:
                    case 16:
                    case 17:
                    case 18:
                    case 54:
                        res.set(String(ele["type"]), "cross");
                        break;
                    case 14:
                        res.set(String(ele["type"]), "block");
                        break;
                    case undefined:
                        res.set(placeholder_idx, "block");
                        placeholder_idx++;
                        break;
                    default:
                        dbg_warn(ele);
                        res.set("unknown", "block");
                        break;
                }
            }

            res.set("item_level", "cross");

            if (item_data["influences"] !== undefined) {
                res.set("influences", "block");
            }

            if (item_data["requirements"] && item_data["requirements"].length > 0 && item_data["requirements"][0]["type"] !== 57) {
                res.set("requirements", "cross");
            } else if (item_data["requirements"] && item_data["requirements"].length > 0) {
                res.set("requirements", "block");
            }

            for (const mod_type of mod_types) {
                if (item_data[`${mod_type}Mods`]) {
                    for (let i = 0; i < item_data[`${mod_type}Mods`].length; i++) {
                        res.set(`${mod_type}${i}`, "check");
                    }
                }
            }

            return res;
        }

        function get_item_data_by_node(node, name, node_level) {
            function get_possible_names(iData) {
                let base = "";
                if (iData["name"]) base += iData["name"] + " ";
                if (iData["typeLine"]) base += iData["typeLine"];
                base = base.trim();

                let names = [base];

                if (iData["hybrid"] && iData["hybrid"]["baseTypeName"]) {
                    names.push(`${base} (${iData["hybrid"]["baseTypeName"]})`);
                }
                return names;
            }

            let candidates = [];

            try {
                for (var item of equipment_data["items"] || []) {
                    if (get_possible_names(item["itemData"]).includes(name)) candidates.push({ data: item["itemData"], is_gem: false });
                }
                for (var item of equipment_data["jewels"] || []) {
                    if (get_possible_names(item["itemData"]).includes(name)) candidates.push({ data: item["itemData"], is_gem: false });
                }
                for (var item of equipment_data["flasks"] || []) {
                    if (get_possible_names(item["itemData"]).includes(name)) candidates.push({ data: item["itemData"], is_gem: false });
                }
                for (var skill_group of equipment_data["skills"] || []) {
                    for (var item of skill_group["allGems"] || []) {
                        if (!item["itemData"]) continue;
                        if (get_possible_names(item["itemData"]).includes(name)) candidates.push({ data: item["itemData"], is_gem: true });
                    }
                }
            } catch (e) {
                return undefined;
            }

            if (candidates.length === 0) return undefined;
            if (candidates.length === 1) return candidates[0];

            let best_match = candidates[0];
            let max_score = -1;
            const node_text = node.innerText.toLowerCase().replace(/\n/g, " ");

            for (let cand of candidates) {
                let score = 0;
                let data = cand.data;

                if (cand.is_gem) {
                    let gem_lvl;
                    if (data.properties) {
                        for (let p of data.properties) {
                            if (p.type === 5 && p.values && p.values[0]) gem_lvl = parseInt(p.values[0][0]);
                        }
                    }
                    if (gem_lvl === node_level) score += 10;
                } else {
                    if (data.ilvl === node_level) score += 10;
                }

                const check_mods = (mod_array) => {
                    if (!mod_array) return;
                    for (let m of mod_array) {
                        // 移除數值僅比對詞彙本身
                        let clean_m = m.replace(/[0-9+\-.%]/g, "").trim().toLowerCase();
                        if (node_text.includes(clean_m)) score += 5;
                    }
                };

                check_mods(data.fracturedMods);
                check_mods(data.explicitMods);
                check_mods(data.implicitMods);

                if (score > max_score) {
                    max_score = score;
                    best_match = cand;
                }
            }

            return best_match;
        }

        translate_node(tippy_node);

        const item_name = get_item_name(tippy_node);
        if (item_name === undefined) return;

        const level = get_item_level(tippy_node);
        const quality = get_item_quality(tippy_node);

        const item_info = get_item_data_by_node(tippy_node, item_name, level);
        if (item_info === undefined && !is_poe2) return;

        // PoE2 里程碑 1：即使在 equipment_data 找不到對應物品（資料結構可能不同），
        // 仍以 tippy 標題的物品名稱做為底材，確保按鈕注入端到端可運作。
        const item_data = item_info ? item_info.data : { typeLine: item_name };
        const is_gem = item_info ? item_info.is_gem : false;

        // 使用官方資料庫的唯一 id，若無則降級為組合屬性
        const cache_key = item_data.id ? item_data.id : (item_name + "_" + (item_data.ilvl || "") + "_" + JSON.stringify(item_data.explicitMods || []));

        // PoE1 與 PoE2 共用同一條路徑：產生 mask_list（gen_mask_list 已對缺少 properties
        // 的情況做防護），Trade 按鈕據此決定哪些 mod 預設啟用。PoE2 找不到對應 mod 時，
        // 會在 gen_query 退化為底材搜尋，因此不會壞掉。
        let mask_list;
        if (global_mask_cache.has(cache_key)) {
            mask_list = global_mask_cache.get(cache_key);
        } else {
            mask_list = gen_mask_list(item_data, is_gem);
            global_mask_cache.set(cache_key, mask_list);
        }

        const article_div = tippy_node.querySelector("article > div");
        if (!article_div) {
            console.log(`[R2T][PAGE] selector NOT found ("article > div") for "${item_name}" — skipping injection`);
            return;
        }
        console.log(`[R2T][PAGE] selector found ("article > div") for "${item_name}" (game=${game || "poe1"})`);

        const mask_target = get_all_deepest_div(article_div);

        const button_keys = Array.from(mask_list.keys());
        const button_values = Array.from(mask_list.values());
        for (var i = 0; i < mask_list.size; i++) {
            if (mask_target[i]) {
                const toggle_btn = gen_toggle_botton(button_keys[i], button_values[i], mask_list);
                mask_target[i].prepend(toggle_btn);
            }
        }

        var trade_button = gen_trade_botton(tippy_node, mask_list, item_data, is_gem, level, quality);

        const last_div = tippy_node.querySelector("article > div:last-child");
        if (last_div) last_div.prepend(trade_button);
    }

    // poe.ninja（PoE1 與 PoE2 共用同一套 floating-ui/tippy 框架）會把彈出視窗
    // 掛在 div[data-floating-ui-portal] 之下。SPA 可能在注入時尚未產生此容器。
    const PORTAL_SELECTOR = "div[data-floating-ui-portal]";

    // 將 tippy_observer 掛到指定 portal，並處理其中已存在的彈出視窗
    function observe_portal(portal) {
        console.log(`[R2T][PAGE] portal container found ("${PORTAL_SELECTOR}") — observing`);
        tippy_observer.observe(portal, { childList: true });
        for (const child of portal.children) {
            process_tippy(child);
        }
    }

    const tippy_observer = new MutationObserver(mutationRecords => {
        for (const mutationRecord of mutationRecords) {
            for (const addedNode of mutationRecord["addedNodes"]) {
                process_tippy(addedNode);

                // 若 portal 容器是後來才被建立的，動態補掛 observer（SPA 延遲渲染的重試機制）
                if (addedNode.nodeType === 1 && addedNode.matches && addedNode.matches(PORTAL_SELECTOR)) {
                    observe_portal(addedNode);
                }
            }
        }
    });

    tippy_observer.observe(document.body, {
        childList: true
    });

    const existing_portals = document.querySelectorAll(PORTAL_SELECTOR);
    if (existing_portals.length > 0) {
        for (const portal of existing_portals) {
            observe_portal(portal);
            process_tippy(portal);
        }
    } else {
        console.log(`[R2T][PAGE] portal container NOT found yet ("${PORTAL_SELECTOR}") — MutationObserver will retry on render`);
    }
};

/**
 * 注入進 PoE2 PoB 分享頁的腳本（由 tabs.onUpdated 觸發，在頁面情境執行）：
 * 自行抓取並解碼 /poe2/pob/raw/<id>，解析現用裝備組，為每件裝備建立一顆 Trade 按鈕，
 * 集中放在頁面右上角的自帶面板。連結會帶上「名稱/底材 + 可對應到的 explicit mod stats」。
 * 不經 webRequest（該請求在頁面載入早期觸發，MV3 service worker 常來不及攔截）。
 * @param {Object} poe2_stats Exiled Exchange 2 的 PoE2 詞綴表（last-two-words -> matchers）
 * @param {string[]} poe2_bases PoE2 底材名稱清單，用於還原魔法物品的底材
 * @param {string[]} poe2_gems PoE2 可交易寶石名稱清單，用於過濾技能組裡的寶石
 * @return {None}
 */
async function inject_pob_panel(poe2_stats, poe2_bases, poe2_gems) {
    const PANEL_ID = "r2t-pob-panel";
    console.log("[R2T][PAGE] inject_pob_panel start");

    const bases_set = new Set(poe2_bases || []);
    const gems_set = new Set(poe2_gems || []);
    // 魔法物品名稱為「字首 + 底材 + of 字尾」，PoB 不另存底材。先去掉 " of 字尾"，
    // 再用 bases_set 取最長的「字尾相符底材」（從整串往後縮，第一個命中的即最長底材）。
    function extract_magic_base(name) {
        const candidate = name.split(/ of /i)[0].trim();
        const words = candidate.split(/\s+/);
        for (let i = 0; i < words.length; i++) {
            const sub = words.slice(i).join(" ");
            if (bases_set.has(sub)) return sub;
        }
        return null;
    }

    const redirect_to = (await chrome.storage.local.get(["redirect-to"]))["redirect-to"] || "com";
    const trade_type = (await chrome.storage.local.get(["trade-type"]))["trade-type"];
    const POE2_TRADE_URL = `https://www.pathofexile.${redirect_to}/trade2/search/poe2`;

    // 1) 自行抓取並解碼 PoB 匯出碼（base64 + zlib），與頁面相同情境（已驗證可行）
    let xml;
    try {
        const code_id = location.pathname.split("/").filter(Boolean).pop();
        const b64 = await (await fetch(`/poe2/pob/raw/${code_id}`)).text();
        const bytes = Uint8Array.from(atob(b64.trim().replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
        const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate"));
        xml = await new Response(stream).text();
        console.log(`[R2T][PAGE] pob fetched+decoded, xml length=${xml.length}`);
    } catch (e) {
        console.error("[R2T][PAGE] pob fetch/decode failed:", e);
        return;
    }

    let doc;
    try {
        doc = new DOMParser().parseFromString(xml, "text/xml");
    } catch (e) {
        console.error("[R2T][PAGE] PoB XML parse failed:", e);
        return;
    }

    // ---- mod 解析：把 PoB 物品文字中的 explicit mod 對應到 PoE2 trade stat id ----
    // 與 background.js find_mod_id 同樣的 last-two-words 取鍵 + 正則比對邏輯（英文版）
    function strip_num(s) { return s.replace(/(([\+-]?[\d\.]+%?)|(#%)|(#))/, ""); }
    const MOD_ID_ORDER = ["explicitMods", "runeMods", "implicitMods", "fracturedMods", "craftedMods", "desecratedMods", "sanctumMods", "skillMods", "enchantMods"];
    function resolve_mod_id(mod_string) {
        const parts = mod_string.trim().split(" ");
        let key = parts.length >= 2
            ? strip_num(parts[parts.length - 2]) + strip_num(parts[parts.length - 1])
            : strip_num(parts[parts.length - 1]);
        const matchers = poe2_stats[key.toLowerCase()];
        if (!matchers) return null;
        for (const m of matchers) {
            const match = new RegExp(m.matcher).exec(mod_string);
            if (!match) continue;

            let id = null;
            for (const t of MOD_ID_ORDER) if (m.res[t]) { id = m.res[t][0]; break; }
            if (!id) continue;

            // 從具名捕獲群組(num0/percent0...)取出實際 roll 值；只有單一數值時才當作 min，
            // 多值（如「Adds X to Y Damage」）數值意義不明確故維持只比對詞綴存在。
            const nums = [];
            const groups = match.groups || {};
            for (const gk in groups) {
                if (groups[gk] == null) continue;
                const v = parseFloat(String(groups[gk]).replace("%", ""));
                if (!isNaN(v)) nums.push(v);
            }
            return { id, value: nums.length === 1 ? nums[0] : undefined };
        }
        return null;
    }

    // 將 PoB 物品還原成 PoE 官方「複製物品」文字格式（區段以 -------- 分隔）。
    // 處理：去除 PoB 註記({variant}{range}{tags})、依 Selected Variant 過濾唯一物品詞綴、
    // 以 <ModRange> 比例把 (a-b) 範圍還原成實際 roll、implicit 標註 "(implicit)"。
    function title_case(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

    function build_official_item_text(node) {
        const mod_ranges = {};
        for (const mr of node.querySelectorAll("ModRange")) {
            mod_ranges[mr.getAttribute("id")] = parseFloat(mr.getAttribute("range"));
        }
        const raw = node.textContent.split("\n").map(s => s.trim()).filter(Boolean);
        if (!raw.length) return "";

        const sel_variant = (raw.find(l => /^Selected Variant:/.test(l)) || "").match(/(\d+)/);
        const sel = sel_variant ? sel_variant[1] : null;

        let i = 0, rarity_raw = "NORMAL";
        if (raw[0].startsWith("Rarity:")) { rarity_raw = raw[0].slice(7).trim().toUpperCase(); i = 1; }
        const is_magic = rarity_raw === "MAGIC";
        const name = raw[i] || "";
        const next = raw[i + 1] || "";
        const base = is_magic ? (extract_magic_base(name) || name) : ((next && !next.includes(":")) ? next : name);

        const header = ["Rarity: " + title_case(rarity_raw)];
        if (rarity_raw !== "NORMAL" && !is_magic && name && base && name !== base) header.push(name);
        header.push(base);

        const imp_idx = raw.findIndex(l => /^Implicits:\s*\d+/.test(l));
        const n_imp = imp_idx !== -1 ? (parseInt(raw[imp_idx].match(/\d+/)[0], 10) || 0) : 0;
        const header_end = imp_idx !== -1 ? imp_idx : raw.length;

        const PROP = { "Armour": "Armour", "Evasion": "Evasion Rating", "Energy Shield": "Energy Shield", "Ward": "Ward", "Spirit": "Spirit" };
        const props = [];
        let level_req = null, item_level = null;
        const scan_start = i + ((base === next) ? 2 : 1);
        for (let k = scan_start; k < header_end; k++) {
            const l = raw[k]; let m;
            if (/^(Crafted:|Prefix:|Suffix:|Unique ID:|Variant:|Selected Variant:|Sockets:|Rune:)/.test(l)) continue;
            if ((m = l.match(/^Quality:\s*(\d+)/))) { if (+m[1] > 0) props.push("Quality: +" + m[1] + "%"); continue; }
            if ((m = l.match(/^Item Level:\s*(\d+)/))) { item_level = m[1]; continue; }
            if ((m = l.match(/^LevelReq:\s*(\d+)/))) { level_req = m[1]; continue; }
            for (const p in PROP) { const mm = l.match(new RegExp("^" + p + ":\\s*(\\d+)")); if (mm) { props.push(PROP[p] + ": " + mm[1]); break; } }
        }

        function clean_mod(line, num) {
            const vm = line.match(/\{variant:([\d,]+)\}/);
            if (vm && sel && !vm[1].split(",").includes(sel)) return null; // 非選定變體，略過
            let s = line.replace(/^(\{[^}]*\})+/, "").trim();              // 去除前綴註記
            const frac = mod_ranges[String(num)];
            if (frac !== undefined) {
                s = s.replace(/\((\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\)/g,
                    (x, a, b) => String(Math.round(parseFloat(a) + frac * (parseFloat(b) - parseFloat(a)))));
            }
            return s;
        }

        const mod_lines = imp_idx !== -1 ? raw.slice(imp_idx + 1) : [];
        const implicits = [], explicits = [], flags = [];
        let num = 0;
        for (let k = 0; k < mod_lines.length; k++) {
            num++; // <ModRange> id 為 1-based，對應所有詞綴行的順序
            const c = clean_mod(mod_lines[k], num);
            if (c === null) continue;
            if (/^(Corrupted|Mirrored|Split|Synthesised)$/i.test(c)) { flags.push(c); continue; }
            if (k < n_imp) implicits.push(c + " (implicit)");
            else explicits.push(c);
        }

        const sections = [header];
        if (props.length) sections.push(props);
        if (level_req) sections.push(["Requirements:", "Level: " + level_req]);
        if (item_level) sections.push(["Item Level: " + item_level]);
        if (implicits.length) sections.push(implicits);
        if (explicits.length) sections.push(explicits);
        if (flags.length) sections.push(flags);
        return sections.map(s => s.join("\n")).join("\n--------\n");
    }

    // 從 PoB 物品文字取出「實際 explicit mod」：在 "Implicits: N" 之後、跳過 N 行 implicit，其餘為 explicit
    function parse_item_node(node) {
        const lines = node.textContent.split("\n").map(s => s.trim()).filter(Boolean);
        if (!lines.length) return null;

        let i = 0, rarity = null;
        if (lines[0].startsWith("Rarity:")) { rarity = lines[0].slice(7).trim().toUpperCase(); i = 1; }
        const name = lines[i] || "";
        const maybe_base = lines[i + 1] || "";
        // 魔法物品名稱含字首/字尾、且 PoB 不另存底材行，需從名稱還原底材
        let base = (rarity === "MAGIC") ? (extract_magic_base(name) || name)
            : ((maybe_base && !maybe_base.includes(":")) ? maybe_base : name); // 屬性行含冒號

        let mods = [];
        const imp_idx = lines.findIndex(l => /^Implicits:\s*\d+/.test(l));
        if (imp_idx !== -1) {
            const n_imp = parseInt(lines[imp_idx].match(/^Implicits:\s*(\d+)/)[1], 10) || 0;
            mods = lines.slice(imp_idx + 1 + n_imp)              // 跳過 implicit，取 explicit
                .map(l => l.replace(/^(\{[^}]*\})+/, "").trim()) // 去除 PoB 的 {variant}{range}{tags} 註記
                .filter(Boolean)
                // 略過物品旗標行（非詞綴，trade 用獨立 filter 表示）
                .filter(l => !/^(Corrupted|Mirrored|Split|Synthesised|Fractured Item)$/i.test(l));
        }
        return { rarity, name, base, mods, official: build_official_item_text(node) };
    }

    const item_by_id = {};
    for (const node of doc.querySelectorAll("Items > Item")) {
        const id = node.getAttribute("id");
        const parsed = parse_item_node(node);
        if (id && parsed) item_by_id[id] = parsed;
    }

    // 找出現用裝備組（activeItemSet），取其各 Slot 對應的裝備
    const items_root = doc.querySelector("Items");
    const active_id = items_root ? items_root.getAttribute("activeItemSet") : null;
    let active_set = active_id ? doc.querySelector(`ItemSet[id="${active_id}"]`) : null;
    if (!active_set) active_set = doc.querySelector("ItemSet"); // 退而求其次取第一組

    const equipped = [];
    const seen_item_ids = new Set();
    if (active_set) {
        for (const slot of active_set.querySelectorAll("Slot")) {
            const item_id = slot.getAttribute("itemId");
            const slot_name = slot.getAttribute("name") || "";
            if (!item_id || item_id === "0") continue;        // 空欄位
            if (/Swap/i.test(slot_name)) continue;            // 略過備用武器槽，減少雜訊
            if (seen_item_ids.has(item_id)) continue;
            seen_item_ids.add(item_id);
            const it = item_by_id[item_id];
            if (it) equipped.push({ slot: slot_name, ...it });
        }
    }

    // 解析現用技能組（activeSkillSet）裡的寶石：過濾成真正可交易的寶石並去重
    const skills_root = doc.querySelector("Skills");
    const active_skill_id = skills_root ? skills_root.getAttribute("activeSkillSet") : null;
    let active_skill_set = active_skill_id ? doc.querySelector(`SkillSet[id="${active_skill_id}"]`) : null;
    if (!active_skill_set) active_skill_set = doc.querySelector("SkillSet");

    const gems = [];
    const seen_gem_names = new Set();
    if (active_skill_set) {
        for (const gem of active_skill_set.querySelectorAll("Gem")) {
            const name = gem.getAttribute("nameSpec");
            if (!name || gem.getAttribute("enabled") === "false") continue;
            // 只收清單中真正可交易的寶石（排除武器內建技能等），並去重
            if (!gems_set.has(name) || seen_gem_names.has(name)) continue;
            seen_gem_names.add(name);
            gems.push({
                name,
                level: parseInt(gem.getAttribute("level") || "0", 10),
                quality: parseInt(gem.getAttribute("quality") || "0", 10),
            });
        }
    }

    // 珠寶：插在天賦樹插槽，不在裝備欄。<Tree activeSpec="N"> 的 activeSpec 為 1-based 索引，
    // 對應第 N 個 <Spec>，其中 <Socket itemId=".."/> 的 itemId 即該插槽的珠寶物品。
    const tree_root = doc.querySelector("Tree");
    const active_spec_n = tree_root ? parseInt(tree_root.getAttribute("activeSpec") || "0", 10) : 0;
    const specs = doc.querySelectorAll("Spec");
    const active_spec = (active_spec_n >= 1 && active_spec_n <= specs.length) ? specs[active_spec_n - 1] : null;

    const jewels = [];
    const seen_jewel_ids = new Set();
    if (active_spec) {
        for (const socket of active_spec.querySelectorAll("Socket")) {
            const item_id = socket.getAttribute("itemId");
            if (!item_id || item_id === "0" || seen_jewel_ids.has(item_id)) continue;
            seen_jewel_ids.add(item_id);
            const it = item_by_id[item_id];
            if (it) jewels.push({ slot: "Jewel", ...it }); // 珠寶為一般物品，沿用 item 解析/連結
        }
    }

    console.log(`[R2T][PAGE] pob parsed: ${equipped.length} items (activeItemSet=${active_id}), ${jewels.length} jewels (activeSpec=${active_spec_n}), ${gems.length} gems (activeSkillSet=${active_skill_id})`);
    if (equipped.length === 0 && jewels.length === 0 && gems.length === 0) {
        console.log("[R2T][PAGE] nothing parsed — aborting panel");
        return;
    }

    // 依「名稱/底材 + 對應到的 explicit mod stat id」組出 trade2 搜尋連結
    function build_trade_url(item) {
        const query = { query: {}, sort: { price: "asc" } };
        if (trade_type) query.query.status = { option: trade_type };
        if (item.rarity === "UNIQUE" && item.name) query.query.name = item.name;
        if (item.base) query.query.type = item.base;

        const filters = [];
        const seen_ids = new Set();
        for (const mod of item.mods || []) {
            const r = resolve_mod_id(mod);
            if (r && !seen_ids.has(r.id)) {
                seen_ids.add(r.id);
                const f = { id: r.id, disabled: false };
                if (r.value !== undefined) f.value = { min: r.value };
                filters.push(f);
            }
        }
        if (filters.length) query.query.stats = [{ type: "and", filters }];

        return { url: `${POE2_TRADE_URL}?q=${JSON.stringify(query)}`, matched: filters.length, total: (item.mods || []).length };
    }

    // 寶石以名稱(type)搜尋，並帶上等級/品質作為 min。
    // 注意 trade2 結構：gem_level 在 misc_filters，quality 在 type_filters（與 PoE1 不同）。
    function build_gem_url(gem) {
        const query = { query: { type: gem.name }, sort: { price: "asc" } };
        if (trade_type) query.query.status = { option: trade_type };
        const filters = {};
        if (gem.level > 1) filters.misc_filters = { filters: { gem_level: { min: gem.level } } };
        if (gem.quality > 0) filters.type_filters = { filters: { quality: { min: gem.quality } } };
        if (Object.keys(filters).length) query.query.filters = filters;
        return `${POE2_TRADE_URL}?q=${JSON.stringify(query)}`;
    }

    // 移除舊面板（重複注入時）
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("style", [
        "position:fixed", "top:64px", "right:12px", "z-index:99999",
        "width:340px", "max-height:70vh", "overflow:auto",
        "background:#1a1a1a", "color:#eee", "border:1px solid #444",
        "border-radius:8px", "box-shadow:0 4px 16px rgba(0,0,0,.5)",
        "font:12px/1.4 system-ui,sans-serif", "padding:8px"
    ].join(";"));

    const header = document.createElement("div");
    header.setAttribute("style", "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-weight:600;");
    const title = document.createElement("span");
    title.textContent = `Trade (PoB) — ${equipped.length} items, ${jewels.length} jewels, ${gems.length} gems`;
    const close = document.createElement("span");
    close.textContent = "✕";
    close.setAttribute("style", "cursor:pointer;padding:0 4px;color:#aaa;");
    close.addEventListener("click", () => panel.remove());
    header.appendChild(title);
    header.appendChild(close);
    panel.appendChild(header);

    function append_divider(text) {
        const divider = document.createElement("div");
        divider.setAttribute("style", "margin-top:8px;padding-top:6px;border-top:2px solid #555;font-weight:600;color:#cba6f7;");
        divider.textContent = text;
        panel.appendChild(divider);
    }

    // 物品/珠寶共用的列渲染（兩者皆為一般物品），回傳對應到的 mod 數
    function append_item_row(item) {
        const { url, matched, total } = build_trade_url(item);

        const row = document.createElement("div");
        row.setAttribute("style", "display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 0;border-top:1px solid #333;");

        const label = document.createElement("div");
        label.setAttribute("style", "min-width:0;overflow:hidden;");
        const top = document.createElement("div");
        top.setAttribute("style", "color:#9cf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;");
        top.textContent = item.rarity === "UNIQUE" ? item.name : item.base;
        const sub = document.createElement("div");
        sub.setAttribute("style", "color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;");
        const mod_note = total > 0 ? ` · ${matched}/${total} mods` : "";
        sub.textContent = `${item.slot}${item.rarity === "UNIQUE" ? " — " + item.base : ""}${mod_note}`;
        label.appendChild(top);
        label.appendChild(sub);

        const actions = document.createElement("div");
        actions.setAttribute("style", "flex:none;display:flex;gap:4px;");

        // 複製成 PoE 官方「複製物品」文字格式
        const copy_btn = document.createElement("button");
        copy_btn.textContent = "Copy";
        copy_btn.setAttribute("style", "background:#36c;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font:inherit;");
        copy_btn.addEventListener("click", async () => {
            const text = item.official || "";
            try {
                await navigator.clipboard.writeText(text);
            } catch (e) {
                const ta = document.createElement("textarea");
                ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
                document.body.appendChild(ta); ta.select();
                try { document.execCommand("copy"); } catch (e2) { /* noop */ }
                ta.remove();
            }
            copy_btn.textContent = "Copied!";
            setTimeout(() => { copy_btn.textContent = "Copy"; }, 1200);
        });

        const btn = document.createElement("a");
        btn.textContent = "Trade";
        btn.href = url;
        btn.target = "_blank";
        btn.rel = "noopener";
        btn.setAttribute("style", "background:#2a6;color:#fff;text-decoration:none;padding:3px 8px;border-radius:4px;cursor:pointer;");

        actions.appendChild(copy_btn);
        actions.appendChild(btn);

        row.appendChild(label);
        row.appendChild(actions);
        panel.appendChild(row);
        return matched;
    }

    let total_matched = 0;
    for (const item of equipped) total_matched += append_item_row(item);

    // 珠寶區段（沿用 item 列渲染）
    if (jewels.length) {
        append_divider(`Jewels — ${jewels.length}`);
        for (const jewel of jewels) total_matched += append_item_row(jewel);
    }

    // 寶石區段
    if (gems.length) {
        append_divider(`Gems — ${gems.length}`);

        for (const gem of gems) {
            const row = document.createElement("div");
            row.setAttribute("style", "display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 0;border-top:1px solid #333;");

            const label = document.createElement("div");
            label.setAttribute("style", "min-width:0;overflow:hidden;");
            const top = document.createElement("div");
            top.setAttribute("style", "color:#cba6f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;");
            top.textContent = gem.name;
            const sub = document.createElement("div");
            sub.setAttribute("style", "color:#888;font-size:11px;");
            sub.textContent = `Lv ${gem.level}${gem.quality > 0 ? " · Q" + gem.quality : ""}`;
            label.appendChild(top);
            label.appendChild(sub);

            const btn = document.createElement("a");
            btn.textContent = "Trade";
            btn.href = build_gem_url(gem);
            btn.target = "_blank";
            btn.rel = "noopener";
            btn.setAttribute("style", "flex:none;background:#2a6;color:#fff;text-decoration:none;padding:3px 8px;border-radius:4px;cursor:pointer;");

            row.appendChild(label);
            row.appendChild(btn);
            panel.appendChild(row);
        }
    }

    document.body.appendChild(panel);
    console.log(`[R2T][PAGE] pob panel injected: ${equipped.length} items, ${jewels.length} jewels (${total_matched} mod-stats), ${gems.length} gems`);
}

// 初始化所需設定
chrome.runtime.onInstalled.addListener(async (details) => {
    // 檢查是否為擴充功能更新
    if (details.reason === "update") {
        await chrome.storage.local.set({ "show_update_popup": true });
    }

    // 執行原有的初始化邏輯
    await init_status();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "open_update_tab") {
        chrome.tabs.create({ url: "https://github.com/iwtba4188/poe_ninja_redirect_to_trade/releases/tag/v" + chrome.runtime.getManifest().version });
    }
});

// PoE1 / PoE2 角色頁：攔截送出的封包以取得角色裝備資料 API 網址
chrome.webRequest.onBeforeRequest.addListener(fetch_character_data, API_URLS_FILTER);

// PoE2 PoB 分享頁（/poe2/pob/<id>）：改用 tabs.onUpdated 觸發，注入腳本自行抓取並解碼。
// /poe2/pob/raw 在頁面載入早期觸發，MV3 service worker 常來不及用 webRequest 攔截。
const POB_PAGE_RE = /^https:\/\/poe\.ninja\/poe2\/pob\/[^/?#]+/;
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    if (!tab.url || !POB_PAGE_RE.test(tab.url)) return;

    try {
        const local_loader = new LocalDataLoader();
        await local_loader.update_data();
        const poe2_stats = await local_loader.get_data("local_poe2_stats_data");
        const poe2_bases = await local_loader.get_data("local_poe2_bases_data");
        const poe2_gems = await local_loader.get_data("local_poe2_gems_data");

        console.log(`[R2T][BG] pob page detected, injecting: ${tab.url}`);
        chrome.scripting.executeScript({
            target: { tabId },
            function: inject_pob_panel,
            args: [poe2_stats, poe2_bases, poe2_gems],
        });
    } catch (e) {
        console.error("[R2T][BG] pob inject failed:", e);
    }
});