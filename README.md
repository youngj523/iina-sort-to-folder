# Sort to Folder (IINA plugin)

An [IINA](https://iina.io) plugin for sorting a batch of videos while you watch them.
Buttons appear on the video, one per folder. Click one to move **the video being played** into that folder and continue with the next one.

## Features

- Set up to 10 destination folders in the plugin preferences. You start with one and add more as needed.
- Each folder has its own on-screen button and its own shortcut. Button labels can be customized; when left empty, the folder name is shown.
- After a move, the next video in the playlist plays and the moved one is removed from the playlist. If the moved video was the last entry, the previous one plays instead.
- A file with the same name in the destination is never overwritten. The moved file is renamed to `name (1).mp4` instead.
- If the video is already in the chosen folder, nothing is moved and the next video plays. The video stays in the playlist.
- The last move can be undone: the file goes back to its original location and playlist position.
- Each player window has its own buttons, so several windows can be sorted at the same time.

| Action | Button | Default shortcut |
| --- | --- | --- |
| Move to Folder 1 to 9 | The folder's button | Ctrl+1 to Ctrl+9 |
| Move to Folder 10 | The folder's button | Ctrl+0 |
| Undo Last Move | Menu: Plugin > Undo Last Move | Ctrl+Z |

## Installation

Requires IINA 1.4.0 or later.

1. Open IINA's Settings > Plugins.
2. Click "Install from GitHub" and enter `youngj523/iina-sort-to-folder`.
3. Accept the permissions and enable the plugin.

The plugin asks for three permissions: showing on-screen messages, drawing the buttons over the video, and file system access (used to move the videos).

## Setting the folders

Open Settings > Plugins > Sort to Folder > Preferences.

- **Add or remove folders**: click Add Folder for another folder, up to 10, or Remove Last Folder to drop the last one. A removed folder is only hidden; its settings come back if you add it again.
- **Pick in a dialog**: click Choose… next to a folder's location. While a video is playing, Plugin > Set Folder 1…, Set Folder 2… and so on in the menu bar do the same.
- **Type the path**: enter a full path such as `~/Movies/Keep`.

The folders must already exist. The plugin does not create them.

## Customizing

These settings are on the same Preferences page and take effect when you return to the player window.

- **Button position**: top, middle or bottom, on the left or right side of the video. The default is middle right. With more than five folders the buttons are drawn smaller so they fit.
- **Shortcuts**: every folder's shortcut and the undo shortcut can be changed. Click a field and press the key combination you want. Press Esc to cancel, or click Clear to have no shortcut. Combinations that IINA or macOS already use, such as Command+Q, cannot be recorded. The plugin's shortcuts take priority over IINA's own key bindings, so a key that IINA already uses for something else runs the plugin's action instead.

## Usage

1. Drag all the videos you want to sort into IINA. They become the playlist.
2. When a video belongs in one of the folders, click its button or press the shortcut.
3. To leave a video where it is, skip to the next one as usual.

## Notes

- Only local files can be moved. Network streams cannot.
- Moving to a different disk copies the file and then deletes the original, so large files take a while. A message appears when the move is done, and no other video can be moved until then.
- To hide the buttons, choose Plugin > Show/Hide On-Screen Buttons. The shortcuts keep working.
- Undo only remembers the most recent move, and it is forgotten when the window closes.

## Development

Link this folder as a development plugin, then restart IINA:

```sh
ln -s "$(pwd)" ~/Library/Application\ Support/com.colliderli.iina/plugins/sort-to-folder.iinaplugin-dev
```

| File | Purpose |
| --- | --- |
| `Info.json` | Plugin metadata, permissions and preference defaults |
| `main.js` | Main script: moving files, playlist handling, menu items and shortcuts |
| `global.js` | Background script that opens the folder dialog for the preferences page |
| `overlay.html` | The buttons shown over the video |
| `preferences.html` | Preferences page |

Log messages are available in IINA under Window > Log Viewer. API documentation: <https://docs.iina.io/>
