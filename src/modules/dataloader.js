import { get_status, set_status } from "./storage_utils.js";

class LocalDataLoader {
    static STATS_DATA_PATH = "./data/awakened poe trade/en_stats.min.json";
    static POE2_STATS_DATA_PATH = "./data/exiled exchange 2/poe2_stats.min.json";
    static POE2_BASES_DATA_PATH = "./data/exiled exchange 2/poe2_bases.min.json";
    static POE2_GEMS_DATA_PATH = "./data/poe2_gems.min.json";
    static GEMS_DATA_PATH = "./data/com_preprocessed_gems_data.json";
    static TW_GEMS_DATA_PATH = "./data/tw_preprocessed_gems_data.json";
    static QUERY_PATH = "./data/query.json";
    static GEMS_QUERY_PATH = "./data/query_gems.json";

    async _fetch_json(path) {
        let res = null;

        await fetch(path).then((response) => response.json()).then((json) => res = json);

        return res;
    }

    async _can_fetch_again() {
        // 任一必要資料缺失就重新載入。把 local_poe2_stats_data 也納入檢查，
        // 確保既有安裝在新增 PoE2 詞綴表後會自動補載（否則 query_data 已存在會直接略過）。
        const query_data = await get_status("local_query_data");
        const poe2_stats_data = await get_status("local_poe2_stats_data");
        const poe2_bases_data = await get_status("local_poe2_bases_data");
        const poe2_gems_data = await get_status("local_poe2_gems_data");
        if (
            query_data === undefined || query_data === null ||
            poe2_stats_data === undefined || poe2_stats_data === null ||
            poe2_bases_data === undefined || poe2_bases_data === null ||
            poe2_gems_data === undefined || poe2_gems_data === null
        ) {
            return true;
        }
        // poe2_bases 由舊版的陣列改為 {base: ItemClass} 物件，舊快取需重載以取得 Item Class
        if (Array.isArray(poe2_bases_data)) {
            return true;
        }
        return false;
    }

    async get_data(data_name) {
        console.log("get local data: " + data_name);

        const data = await get_status(data_name);
        if (data === undefined || data === null)
            throw new Error(data_name + " is not available for `data_name`.");
        return data;
    }

    async update_data() {
        if (!(await this._can_fetch_again())) return;

        console.log("Updating local data...");

        const urls = {
            local_stats_data: LocalDataLoader.STATS_DATA_PATH,
            local_poe2_stats_data: LocalDataLoader.POE2_STATS_DATA_PATH,
            local_poe2_bases_data: LocalDataLoader.POE2_BASES_DATA_PATH,
            local_poe2_gems_data: LocalDataLoader.POE2_GEMS_DATA_PATH,
            local_gems_data: LocalDataLoader.GEMS_DATA_PATH,
            local_tw_gems_data: LocalDataLoader.TW_GEMS_DATA_PATH,
            local_query_data: LocalDataLoader.QUERY_PATH,
            local_gems_query_data: LocalDataLoader.GEMS_QUERY_PATH,
        };

        const results = await Promise.all(
            Object.values(urls).map(url =>
                fetch(url).then(response => response.json())
            )
        );

        Object.keys(urls).forEach((key, i) => {
            set_status(key, results[i]);
        });

        console.log("Local data updated successfully.");
    }
}

class OnlineDataLoader {
    static FETCH_ONLINE_URL_INTERVAL = 5 * 60 * 1000;    // ms, 5 min * 60 sec/min * 1000 ms/sec

    static ONLINE_STATS_DATA_VER_CHECK_URL = "https://api.github.com/repos/iwtba4188/poe_ninja_redirect_to_trade/contents/src/data/awakened%20poe%20trade/en_stats.json";
    static ONLINE_GEMS_DATA_VER_CHECK_URL = "https://api.github.com/repos/iwtba4188/poe_ninja_redirect_to_trade/contents/src/data/com_preprocessed_gems_data.json";
    static ONLINE_TW_GEMS_DATA_VER_CHECK_URL = "https://api.github.com/repos/iwtba4188/poe_ninja_redirect_to_trade/contents/src/data/tw_preprocessed_gems_data.json";

    static STATS_DATA_URL = "https://raw.githubusercontent.com/iwtba4188/poe_ninja_redirect_to_trade/main/src/data/awakened%20poe%20trade/en_stats.min.json";
    static GEMS_DATA_URL = "https://raw.githubusercontent.com/iwtba4188/poe_ninja_redirect_to_trade/main/src/data/com_preprocessed_gems_data.json";
    static TW_GEMS_DATA_URL = "https://raw.githubusercontent.com/iwtba4188/poe_ninja_redirect_to_trade/main/src/data/tw_preprocessed_gems_data.json";

    /**
     * 每經過 FETCH_ONLINE_URL_INTERVAL 才能再次確認 GitHub 狀態，避免 429 Too Many Requests
     * @returns {Boolean} 是否可以再次傳送請求了
     */
    async _can_fetch_again() {
        const now_time = Date.now();
        const last_fetch_time = await get_status("last-fetch-time");

        if (!last_fetch_time || ((now_time - Number(last_fetch_time)) >= OnlineDataLoader.FETCH_ONLINE_URL_INTERVAL)) {
            await set_status("last-fetch-time", now_time);
            return true;
        }

        return false;
    }

    /**
     * 確認上次 fet`ch 的 online 詞綴表的 sha 和 online 的是否一致
     * @returns {Boolean} 線上詞綴表是否有更新
     */
    async _has_newer_data_version() {
        const local_stats_data_sha = await get_status("stats-data-sha");
        const local_gems_data_sha = await get_status("gems-data-sha");
        const local_tw_gems_data_sha = await get_status("tw-gems-data-sha");

        const github_stats_data_sha = (await this._fetch_json(OnlineDataLoader.ONLINE_STATS_DATA_VER_CHECK_URL)).sha;
        const github_gems_data_sha = (await this._fetch_json(OnlineDataLoader.ONLINE_GEMS_DATA_VER_CHECK_URL)).sha;
        const github_tw_gems_data_sha = (await this._fetch_json(OnlineDataLoader.ONLINE_TW_GEMS_DATA_VER_CHECK_URL)).sha;

        const local_shas = [local_stats_data_sha, local_gems_data_sha, local_tw_gems_data_sha];
        const github_shas = [github_stats_data_sha, github_gems_data_sha, github_tw_gems_data_sha];
        const slot_keys = ["stats-data-sha", "gems-data-sha", "tw-gems-data-sha"];

        let flag = false;
        for (let i = 0; i < 3; i++) {
            if (!local_shas[i] || local_shas[i] !== github_shas[i]) {
                flag = true;
                await set_status(slot_keys[i], github_shas[i]);
            }
        }

        return flag;
    };

    /**
     * 使用 fecth 方法取得該網頁的資料
     * @param {string} target_uri 目標網頁或 local file
     * @returns {string} @param target_uri 轉換為 JSON 的結果
     */
    async _fetch_json(target_uri) {
        let res;

        await fetch(target_uri).then(
            function (response) {
                if (response.status === 200 || /^./.test(target_uri))
                    return response.json();
                else
                    throw new Error("Request failed: " + response.status);
            }
        ).then(function (data) {
            res = data;
            // console.log(res);
        }).catch(function (error) {
            console.error(error);
        });

        return res;
    }

    async get_data(data_name) {
        console.log("get online data: " + data_name);

        const data = await get_status(data_name);
        if (data === undefined || data === null)
            throw new Error(data_name + " is not available for `data_name`.");
        return data;
    }

    /**
     * 更新線上詞綴表的資料
     * @returns {None}
     */
    async update_data() {
        if (!(await this._can_fetch_again()) || !(await this._has_newer_data_version())) return;

        console.log("Updating online data...");

        const urls = {
            online_stats_data: OnlineDataLoader.STATS_DATA_URL,
            online_gems_data: OnlineDataLoader.GEMS_DATA_URL,
            online_tw_gems_data: OnlineDataLoader.TW_GEMS_DATA_URL
        };

        const results = await Promise.all(
            Object.values(urls).map(url =>
                fetch(url).then(response => response.json())
            )
        );

        Object.keys(urls).forEach((key, i) => {
            set_status(key, results[i]);
        });

        console.log("Online data updated successfully.");
    }

}

export { LocalDataLoader, OnlineDataLoader };