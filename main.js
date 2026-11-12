// Sort to Folder — IINA plugin
// Shows two buttons on the video that move the file being played into one of
// two folders chosen in the plugin preferences, then plays the next file.

const { core, console, event, file, menu, mpv, overlay, playlist, preferences, utils } = iina;

const SLOTS = [1, 2];
const MV = "/bin/mv";
const STAT = "/usr/bin/stat";
const MAX_RENAME_ATTEMPTS = 1000;

let busy = false;
let lastMove = null; // { from, to, index } — kept for "Undo Last Move"

// ---------- Path helpers ----------

function normalizeSlashes(p) {
  const collapsed = p.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
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

/** Turns the preference text into an absolute path, or null if it is not one. */
function resolveDir(raw) {
  let p = String(raw == null ? "" : raw).trim();
  if (!p) return null;
  if (p === "~") p = "~/";
  if (p.startsWith("~/")) p = utils.resolvePath(p);
  if (!p || !p.startsWith("/")) return null;
  return normalizeSlashes(p);
}

function isDirectory(p) {
  // Appending "/." fails for a regular file, which tells folders and files apart.
  return file.exists(p + "/.");
}

/** Picks "name (1).ext" style names when the destination already has the file. */
function uniqueTarget(dir, name) {
  let target = dir + "/" + name;
  if (!file.exists(target)) return target;
  const [stem, ext] = splitExt(name);
  for (let i = 1; i < MAX_RENAME_ATTEMPTS; i++) {
    target = dir + "/" + stem + " (" + i + ")" + ext;
    if (!file.exists(target)) return target;
  }
  return null;
}

/**
 * Whether two paths point at the same folder on disk. Comparing device and
 * inode numbers also catches different spellings of one folder: letter case on
 * a case-insensitive volume, or a path that goes through a symlink.
 */
async function isSameDirectory(a, b) {
  if (a === b) return true;
  try {
    const result = await utils.exec(STAT, ["-L", "-f", "%d:%i", a, b]);
    if (result.status !== 0) return false;
    const ids = result.stdout.trim().split("\n");
    return ids.length === 2 && ids[0] === ids[1];
  } catch (err) {
    return false;
  }
}

/** Converts a playlist entry or URL into an absolute local path, or null. */
function toLocalPath(entry) {
  if (typeof entry !== "string" || !entry) return null;
  let p = entry;
  if (p.startsWith("file://")) {
    p = p.slice("file://".length);
    try {
      p = decodeURIComponent(p);
    } catch (err) {
      // Not percent-encoded: use the text as it is.
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    return null;
  } else if (!p.startsWith("/")) {
    const cwd = mpv.getString("working-directory");
    if (!cwd) return null;
    p = cwd + "/" + p;
  }
  return normalizeSlashes(p);
}

function currentFilePath() {
  if (core.status.idle || core.status.isNetworkResource) return null;
  return toLocalPath(mpv.getString("path")) || toLocalPath(core.status.url);
}

// ---------- Settings ----------

function slotConfig(slot) {
  const dir = resolveDir(preferences.get("dir" + slot));
  const customLabel = String(preferences.get("label" + slot) || "").trim();
  return {
    slot,
    dir,
    label: customLabel || (dir ? basename(dir) || dir : ""),
  };
}

function buttonsEnabled() {
  return preferences.get("showButtons") !== false;
}

// ---------- Playlist ----------

// These read mpv's live playlist. IINA's own playlist.list() is a cached copy
// that is not refreshed after an entry is removed, so its indices can be stale.

function playlistCount() {
  return Math.round(mpv.getNumber("playlist-count"));
}

function playlistPos() {
  return Math.round(mpv.getNumber("playlist-pos"));
}

function playlistPathAt(index) {
  return toLocalPath(mpv.getString("playlist/" + index + "/filename"));
}

/** Finds the entry for a path, trying the index it was last seen at first. */
function findPlaylistIndex(path, hint) {
  const count = playlistCount();
  if (hint >= 0 && hint < count && playlistPathAt(hint) === path) return hint;
  for (let i = 0; i < count; i++) {
    if (playlistPathAt(i) === path) return i;
  }
  return -1;
}

/**
 * Drops the moved file from the playlist. If it is still the one playing,
 * playback goes on to the next entry, or back to the previous one when the
 * moved file was last. Returns false when the entry could not be found.
 */
function advanceAfterMove(movedPath, hint) {
  const index = findPlaylistIndex(movedPath, hint);
  if (index < 0) return false;

  const count = playlistCount();
  if (count <= 1) {
    // Stopping also clears the playlist, so no dead entry is left behind.
    core.stop();
    return true;
  }
  if (index === playlistPos()) {
    playlist.play(index < count - 1 ? index + 1 : index - 1);
  }
  playlist.remove(index);
  return true;
}

// ---------- Moving ----------

async function runMove(from, to) {
  let result;
  try {
    result = await utils.exec(MV, ["-n", from, to]);
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
  if (result.status !== 0) {
    return { ok: false, detail: String(result.stderr || "").trim() };
  }
  if (!file.exists(to) || file.exists(from)) {
    return { ok: false, detail: "" };
  }
  return { ok: true };
}

function failureMessage(prefix, result) {
  return prefix + (result.detail ? ": " + result.detail : "");
}

async function moveCurrentTo(slot) {
  if (busy) {
    core.osd("Still moving the previous file, please wait");
    return;
  }
  const cfg = slotConfig(slot);
  if (!cfg.dir) {
    core.osd("Folder " + slot + " is not set. Use Plugin > Set Folder " + slot + "…");
    return;
  }
  if (!isDirectory(cfg.dir)) {
    core.osd("Folder not found: " + cfg.dir);
    return;
  }
  const from = currentFilePath();
  if (!from) {
    core.osd("No local file is playing");
    return;
  }
  if (!file.exists(from)) {
    core.osd("The file is no longer at its original location");
    return;
  }
  const index = playlistPos();

  busy = true;
  try {
    if (await isSameDirectory(dirname(from), cfg.dir)) {
      core.osd("Already in \"" + cfg.label + "\"");
      return;
    }
    const to = uniqueTarget(cfg.dir, basename(from));
    if (!to) {
      core.osd("Too many files with the same name in the destination");
      return;
    }
    const result = await runMove(from, to);
    if (!result.ok) {
      console.error("Move failed: " + from + " -> " + to + " " + result.detail);
      core.osd(failureMessage("Move failed", result));
      return;
    }
    lastMove = { from, to, index };

    let advanced = false;
    try {
      advanced = advanceAfterMove(from, index);
    } catch (err) {
      console.error("Playlist update failed: " + err);
    }
    core.osd(
      "Moved to \"" + cfg.label + "\": " + basename(to) +
        (advanced ? "" : " (playlist was not updated)")
    );
  } finally {
    busy = false;
  }
}

/** Puts a restored file back at its old playlist position and plays it. */
function restoreToPlaylist(path, originalIndex) {
  if (core.status.idle) {
    core.open(path);
    return;
  }
  const count = playlistCount();
  if (originalIndex >= 0 && originalIndex < count) {
    playlist.add(path, originalIndex);
    playlist.play(originalIndex);
  } else {
    playlist.add(path, -1); // -1 appends
    playlist.play(count);
  }
}

async function undoLastMove() {
  if (busy) {
    core.osd("Still moving the previous file, please wait");
    return;
  }
  if (!lastMove) {
    core.osd("Nothing to undo");
    return;
  }
  const { from, to, index } = lastMove;
  if (!file.exists(to)) {
    core.osd("The moved file is gone, cannot undo");
    lastMove = null;
    return;
  }
  if (file.exists(from)) {
    core.osd("A file with the same name is at the original location, cannot undo");
    return;
  }

  busy = true;
  try {
    const result = await runMove(to, from);
    if (!result.ok) {
      core.osd(failureMessage("Undo failed", result));
      return;
    }
    lastMove = null;
    core.osd("Restored: " + basename(from));
    try {
      restoreToPlaylist(from, index);
    } catch (err) {
      console.error("Could not put the file back in the playlist: " + err);
    }
  } finally {
    busy = false;
  }
}

// ---------- On-screen buttons ----------

let overlayRequested = false;
let overlayReady = false;

/** Sends labels to the buttons, and shows or hides them per the preference. */
function refreshOverlay() {
  if (!overlayReady) return;
  const visible = buttonsEnabled();
  // A clickable overlay makes IINA hit-test it on every mouse event, so turn
  // that off together with the buttons.
  overlay.setClickable(visible);
  if (!visible) {
    overlay.hide();
    return;
  }
  const payload = {
    slots: SLOTS.map((slot) => {
      const cfg = slotConfig(slot);
      return { slot, label: cfg.label, configured: !!cfg.dir };
    }),
  };
  // Sent as percent-encoded text: IINA passes objects through a template
  // literal, which breaks on a backtick or "${" in a folder name.
  overlay.postMessage("config", encodeURIComponent(JSON.stringify(payload)));
  overlay.show();
}

function loadOverlay() {
  if (overlayRequested) return;
  overlay.loadFile("overlay.html"); // throws until the player window exists
  overlayRequested = true;
}

function tryLoadOverlay() {
  try {
    loadOverlay();
  } catch (err) {
    // The window is not ready yet; "iina.window-loaded" will call this again.
  }
}

event.on("iina.window-loaded", tryLoadOverlay);
// The window may already be open when the plugin is enabled or reloaded.
tryLoadOverlay();

// IINA ignores overlay calls made before the page has finished loading, so
// message handlers are registered here instead of right after loadFile.
event.on("iina.plugin-overlay-loaded", () => {
  if (!overlayRequested) return;
  overlayReady = true;
  overlay.onMessage("move", (slot) => {
    const n = Number(slot);
    if (SLOTS.includes(n)) moveCurrentTo(n);
  });
  refreshOverlay();
});

// Pick up preference changes when a file loads or when focus returns from the
// Settings window.
event.on("iina.file-loaded", refreshOverlay);
event.on("iina.window-main.changed", refreshOverlay);

// ---------- Menu and shortcuts ----------

async function chooseDir(slot) {
  let chosen;
  try {
    chosen = await utils.chooseFile("Choose folder " + slot, { chooseDir: true });
  } catch (err) {
    return;
  }
  if (!chosen || typeof chosen !== "string") return;
  preferences.set("dir" + slot, normalizeSlashes(chosen));
  preferences.sync();
  refreshOverlay();
  core.osd("Folder " + slot + ": " + chosen);
}

function toggleButtons() {
  const next = !buttonsEnabled();
  preferences.set("showButtons", next);
  preferences.sync();
  refreshOverlay();
  core.osd(next ? "Sort buttons shown" : "Sort buttons hidden");
}

SLOTS.forEach((slot) => {
  menu.addItem(
    menu.item("Move to Folder " + slot, () => moveCurrentTo(slot), { keyBinding: "Ctrl+" + slot })
  );
});
menu.addItem(menu.item("Undo Last Move", () => undoLastMove(), { keyBinding: "Ctrl+z" }));
menu.addItem(menu.separator());
SLOTS.forEach((slot) => {
  menu.addItem(menu.item("Set Folder " + slot + "…", () => chooseDir(slot)));
});
menu.addItem(menu.item("Show/Hide On-Screen Buttons", () => toggleButtons()));
