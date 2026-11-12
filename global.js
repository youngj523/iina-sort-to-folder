// Sort to Folder — global entry
// The preferences page cannot open a folder dialog itself: it can only read
// and write preferences. So its "Choose…" buttons write a request into the
// preferences, and this script, which runs for as long as IINA does, picks the
// request up, shows the dialog and stores the chosen folder.

const { console, preferences, utils } = iina;

const POLL_INTERVAL_MS = 400;
// A request left over from an earlier session must not open a dialog on launch.
const REQUEST_MAX_AGE_MS = 5000;
const MAX_FOLDERS = 10;

/** Parses "slot:timestamp" and returns the slot if the request is fresh. */
function pendingSlot() {
  const request = String(preferences.get("pickRequest") || "");
  if (!request) return null;
  preferences.set("pickRequest", "");
  const [slotText, timeText] = request.split(":");
  const slot = Number(slotText);
  const age = Date.now() - Number(timeText);
  if (!(Number.isInteger(slot) && slot >= 1 && slot <= MAX_FOLDERS) || !(age >= 0 && age <= REQUEST_MAX_AGE_MS)) return null;
  return slot;
}

async function chooseFolder(slot) {
  try {
    // IINA never reports a cancelled dialog: the promise just stays pending.
    const chosen = await utils.chooseFile("Choose folder " + slot, { chooseDir: true });
    if (!chosen || typeof chosen !== "string") return;
    const path = chosen.length > 1 ? chosen.replace(/\/+$/, "") : chosen;
    preferences.set("dir" + slot, path);
    preferences.sync();
  } catch (err) {
    console.error("Could not choose a folder: " + err);
  }
}

setInterval(() => {
  const slot = pendingSlot();
  if (slot !== null) chooseFolder(slot);
}, POLL_INTERVAL_MS);
