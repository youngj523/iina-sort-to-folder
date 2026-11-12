// Sort to Folder — IINA plugin
// 在播放畫面上顯示兩個按鈕，把目前播放的影片移動到偏好設定中指定的資料夾。

const { core, console, event, file, menu, mpv, overlay, playlist, preferences, utils } = iina;

const SLOTS = [1, 2];
const MV = "/bin/mv";

let busy = false;
let lastMove = null; // { from, to }，供「復原上次移動」使用

// ---------- 路徑工具 ----------

function stripTrailingSlash(p) {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function dirname(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function basename(p) {
  return p.slice(p.lastIndexOf("/") + 1);
}

function splitExt(name) {
  const i = name.lastIndexOf(".");
  return i <= 0 ? [name, ""] : [name.slice(0, i), name.slice(i)];
}

/** 把偏好設定中的文字轉成絕對路徑；格式不對時回傳 null。 */
function resolveDir(raw) {
  let p = String(raw == null ? "" : raw).trim();
  if (!p) return null;
  if (p === "~") p = "~/";
  if (p.startsWith("~/")) p = utils.resolvePath(p);
  if (!p || !p.startsWith("/")) return null;
  return stripTrailingSlash(p);
}

function isDirectory(p) {
  // 對一般檔案加上 "/." 會查不到，藉此分辨資料夾與檔案
  return file.exists(p + "/.");
}

/** 目的地已有同名檔案時，改用「名稱 (1).副檔名」這類不重複的檔名。 */
function uniqueTarget(dir, name) {
  let target = dir + "/" + name;
  if (!file.exists(target)) return target;
  const [stem, ext] = splitExt(name);
  for (let i = 1; i < 1000; i++) {
    target = dir + "/" + stem + " (" + i + ")" + ext;
    if (!file.exists(target)) return target;
  }
  return null;
}

/** 取得目前播放檔案在磁碟上的絕對路徑；不是本機檔案時回傳 null。 */
function currentFilePath() {
  if (core.status.idle) return null;
  if (core.status.isNetworkResource) return null;
  let p = mpv.getString("path");
  if (!p || !p.startsWith("/")) {
    const url = core.status.url;
    if (typeof url === "string" && url.startsWith("file://")) {
      p = url.slice("file://".length);
    }
  }
  return p && p.startsWith("/") ? p : null;
}

// ---------- 設定 ----------

function slotConfig(slot) {
  const dir = resolveDir(preferences.get("dir" + slot));
  const customLabel = String(preferences.get("label" + slot) || "").trim();
  return {
    slot,
    dir,
    label: customLabel || (dir ? basename(dir) || dir : ""),
  };
}

function osd(message) {
  core.osd(message);
}

// ---------- 播放清單 ----------

/** 檔案移走後：播放下一部，並把已移走的項目從播放清單移除。 */
function advanceAfterMove(movedPath) {
  const items = playlist.list();
  const index = items.findIndex((item) => item.filename === movedPath);
  if (index < 0) return;

  if (items.length <= 1) {
    core.stop();
    return;
  }
  if (items[index].isPlaying) {
    if (index < items.length - 1) {
      playlist.playNext();
    } else {
      // 已經是最後一部：回到清單開頭，繼續處理先前跳過的影片
      playlist.play(0);
    }
  }
  playlist.remove(index);
}

// ---------- 移動 ----------

async function runMove(from, to) {
  let result;
  try {
    result = await utils.exec(MV, ["-n", from, to]);
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
  if (!result || result.status !== 0) {
    return { ok: false, detail: result ? String(result.stderr || "").trim() : "" };
  }
  if (!file.exists(to) || file.exists(from)) {
    return { ok: false, detail: "" };
  }
  return { ok: true };
}

async function moveCurrentTo(slot) {
  if (busy) return;
  const cfg = slotConfig(slot);
  if (!cfg.dir) {
    osd("尚未設定資料夾 " + slot + "，請到 外掛 選單選擇「設定資料夾 " + slot + "…」");
    return;
  }
  if (!isDirectory(cfg.dir)) {
    osd("找不到資料夾：" + cfg.dir);
    return;
  }
  const from = currentFilePath();
  if (!from) {
    osd("目前沒有可移動的本機影片");
    return;
  }
  if (!file.exists(from)) {
    osd("找不到原始檔案，可能已被移動");
    return;
  }
  if (stripTrailingSlash(dirname(from)) === cfg.dir) {
    osd("影片已經在「" + cfg.label + "」裡了");
    return;
  }
  const to = uniqueTarget(cfg.dir, basename(from));
  if (!to) {
    osd("目的地有太多同名檔案，未移動");
    return;
  }

  busy = true;
  try {
    const result = await runMove(from, to);
    if (!result.ok) {
      console.error("move failed: " + from + " -> " + to + " " + (result.detail || ""));
      osd("移動失敗" + (result.detail ? "：" + result.detail : ""));
      return;
    }
    lastMove = { from, to };
    osd("已移動到「" + cfg.label + "」：" + basename(to));
    try {
      advanceAfterMove(from);
    } catch (err) {
      console.error("advance failed: " + err);
    }
  } finally {
    busy = false;
  }
}

async function undoLastMove() {
  if (busy) return;
  if (!lastMove) {
    osd("沒有可復原的移動");
    return;
  }
  const { from, to } = lastMove;
  if (!file.exists(to)) {
    osd("找不到剛才移動的檔案，無法復原");
    lastMove = null;
    return;
  }
  if (file.exists(from)) {
    osd("原位置已有同名檔案，無法復原");
    return;
  }

  busy = true;
  try {
    const result = await runMove(to, from);
    if (!result.ok) {
      osd("復原失敗" + (result.detail ? "：" + result.detail : ""));
      return;
    }
    lastMove = null;
    osd("已復原：" + basename(from));
    try {
      // 把影片放回播放清單並回到這一部
      if (core.status.idle) {
        core.open(from);
      } else {
        const index = Math.max(0, playlist.list().findIndex((item) => item.isPlaying));
        playlist.add(from, index);
        playlist.play(index);
      }
    } catch (err) {
      console.error("re-add failed: " + err);
    }
  } finally {
    busy = false;
  }
}

// ---------- 畫面上的按鈕 ----------

let overlayLoaded = false;

function pushConfig() {
  if (!overlayLoaded) return;
  const payload = {
    visible: preferences.get("showButtons") !== false,
    slots: SLOTS.map((slot) => {
      const cfg = slotConfig(slot);
      return { slot, label: cfg.label, configured: !!cfg.dir };
    }),
  };
  // 編碼成純文字再送出，避免資料夾名稱中的特殊符號在傳遞時出錯
  overlay.postMessage("config", encodeURIComponent(JSON.stringify(payload)));
}

function registerOverlayHandlers() {
  overlay.onMessage("move", (slot) => {
    const n = Number(slot);
    if (SLOTS.includes(n)) moveCurrentTo(n);
  });
  overlay.onMessage("ready", () => pushConfig());
}

function initOverlay() {
  if (overlayLoaded) return;
  overlay.loadFile("overlay.html");
  overlayLoaded = true;
  overlay.setClickable(true);
  overlay.show();
  registerOverlayHandlers();
}

event.on("iina.window-loaded", () => {
  try {
    initOverlay();
  } catch (err) {
    console.error("overlay init failed: " + err);
  }
});

// 外掛在視窗開啟後才被啟用（或重新載入）時，視窗載入事件不會再來，所以這裡先試一次
try {
  initOverlay();
} catch (err) {
  // 視窗還沒準備好，等上面的事件即可
}

event.on("iina.plugin-overlay-loaded", () => {
  if (!overlayLoaded) return;
  // 頁面載入完成後再註冊一次，確保訊息處理一定生效
  registerOverlayHandlers();
  overlay.show();
  pushConfig();
});

// 換檔、或從設定視窗切回播放視窗時，更新按鈕文字
event.on("iina.file-loaded", () => pushConfig());
event.on("iina.window-main.changed", () => pushConfig());

// ---------- 選單與快速鍵 ----------

async function chooseDir(slot) {
  let chosen;
  try {
    chosen = await utils.chooseFile("選擇資料夾 " + slot, { chooseDir: true });
  } catch (err) {
    return;
  }
  if (!chosen || typeof chosen !== "string") return;
  preferences.set("dir" + slot, stripTrailingSlash(chosen));
  if (typeof preferences.sync === "function") preferences.sync();
  pushConfig();
  osd("資料夾 " + slot + "：" + chosen);
}

function toggleButtons() {
  const next = preferences.get("showButtons") === false;
  preferences.set("showButtons", next);
  if (typeof preferences.sync === "function") preferences.sync();
  pushConfig();
  osd(next ? "已顯示分類按鈕" : "已隱藏分類按鈕");
}

menu.addItem(menu.item("移動到資料夾 1", () => moveCurrentTo(1), { keyBinding: "Ctrl+1" }));
menu.addItem(menu.item("移動到資料夾 2", () => moveCurrentTo(2), { keyBinding: "Ctrl+2" }));
menu.addItem(menu.item("復原上次移動", () => undoLastMove(), { keyBinding: "Ctrl+z" }));
menu.addItem(menu.separator());
menu.addItem(menu.item("設定資料夾 1…", () => chooseDir(1)));
menu.addItem(menu.item("設定資料夾 2…", () => chooseDir(2)));
menu.addItem(menu.item("顯示／隱藏畫面上的按鈕", () => toggleButtons()));
