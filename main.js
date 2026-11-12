// Sort to Folder — IINA plugin
// Shows two buttons on the video that move the file being played into one of
// two folders chosen in the plugin preferences, then plays the next file.

const { core, console, event, file, input, menu, mpv, overlay, playlist, preferences, utils } =
  iina;

const SLOTS = [1, 2];
const MV = "/bin/mv";
const STAT = "/usr/bin/stat";
const MAX_RENAME_ATTEMPTS = 1000;
const SHORTCUT_KEYS = SLOTS.map((slot) => "key" + slot).concat("keyUndo");
const POSITIONS = [
  "top-left",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-right",
];
const DEFAULT_POSITION = "middle-right";

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

function buttonPosition() {
  const value = preferences.get("position");
  return POSITIONS.includes(value) ? value : DEFAULT_POSITION;
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
 * Plays the entry after the given file, keeping the file in the playlist.
 * Returns false when the file is the last entry or is no longer the one playing.
 */
function playNextAfter(path, hint) {
  const index = findPlaylistIndex(path, hint);
  if (index < 0 || index !== playlistPos() || index >= playlistCount() - 1) return false;
  playlist.play(index + 1);
  return true;
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
      // Nothing to move: treat the video as sorted and go on to the next one.
      const skipped = playNextAfter(from, index);
      core.osd(
        "Already in \"" + cfg.label + "\"" + (skipped ? ", playing next" : " (last video)")
      );
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
    position: buttonPosition(),
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

const MODIFIER_NAMES = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };

/**
 * Reads a shortcut preference. IINA matches modifier names exactly, so a
 * hand-edited value such as "ctrl+1" is given the expected capitalization.
 */
function shortcut(key) {
  const parts = String(preferences.get(key) || "").trim().split("+");
  const last = parts.pop();
  return parts
    .map((part) => MODIFIER_NAMES[part.trim().toLowerCase()] || part.trim())
    .concat(last.trim())
    .join("+");
}

/** Menu item options for a shortcut preference; an empty value means no shortcut. */
function shortcutOptions(key) {
  const binding = shortcut(key);
  return binding ? { keyBinding: binding } : {};
}

function shortcutSignature() {
  return SHORTCUT_KEYS.map(shortcut).join("\n");
}

let builtShortcuts = null;

// ---------- High-priority key handling ----------

// A menu shortcut loses to a key that IINA's own key bindings already use.
// Listening with PRIORITY_HIGH runs the plugin's handler before those bindings,
// and returning true stops IINA from handling the key as well.

const DUPLICATE_TRIGGER_MS = 300;
const keyActions = {}; // normalized key -> action, for the current shortcuts
const listenedKeys = new Set();
const lastTriggered = {};

/**
 * Runs a shortcut action once even if the menu item and the key listener both
 * fire for the same key press.
 */
function runShortcutAction(name, action) {
  const now = Date.now();
  if (now - (lastTriggered[name] || 0) < DUPLICATE_TRIGGER_MS) return;
  lastTriggered[name] = now;
  action();
}

function bindKeys(actions) {
  if (!input || typeof input.onKeyDown !== "function") return; // older IINA
  Object.keys(keyActions).forEach((key) => delete keyActions[key]);
  SHORTCUT_KEYS.forEach((name) => {
    const binding = shortcut(name);
    if (!binding) return;
    const key = input.normalizeKeyCode(binding);
    keyActions[key] = actions[name];
    if (listenedKeys.has(key)) return;
    // IINA has no way to remove a listener, so each key gets one listener for
    // good and it looks up whether the key is still assigned.
    listenedKeys.add(key);
    input.onKeyDown(
      key,
      () => {
        const action = keyActions[key];
        if (!action) return false;
        action();
        return true;
      },
      input.PRIORITY_HIGH
    );
  });
}

function buildMenu() {
  const actions = {};
  SLOTS.forEach((slot) => {
    actions["key" + slot] = () => runShortcutAction("key" + slot, () => moveCurrentTo(slot));
  });
  actions.keyUndo = () => runShortcutAction("keyUndo", () => undoLastMove());

  menu.removeAllItems();
  SLOTS.forEach((slot) => {
    menu.addItem(
      menu.item("Move to Folder " + slot, actions["key" + slot], shortcutOptions("key" + slot))
    );
  });
  menu.addItem(menu.item("Undo Last Move", actions.keyUndo, shortcutOptions("keyUndo")));
  menu.addItem(menu.separator());
  SLOTS.forEach((slot) => {
    menu.addItem(menu.item("Set Folder " + slot + "…", () => chooseDir(slot)));
  });
  menu.addItem(menu.item("Show/Hide On-Screen Buttons", () => toggleButtons()));
  bindKeys(actions);
  builtShortcuts = shortcutSignature();
}

/** Rebuilds the menu when a shortcut preference has changed. */
function refreshMenu() {
  if (shortcutSignature() === builtShortcuts) return;
  buildMenu();
  menu.forceUpdate();
}

buildMenu();

// Pick up preference changes when a file loads or when focus returns from the
// Settings window.
function applyPreferences() {
  refreshOverlay();
  refreshMenu();
}

event.on("iina.file-loaded", applyPreferences);
event.on("iina.window-main.changed", applyPreferences);
