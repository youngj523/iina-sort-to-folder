# Sort to Folder (IINA plugin)

An [IINA](https://iina.io) plugin for sorting a batch of videos while you watch them.
Two buttons appear on the right side of the video. Click one to move **the video being played** into the matching folder and continue with the next one.

## Features

- Set two destination folders in the plugin preferences. Button labels can be customized; when left empty, the folder name is shown.
- After a move, the next video in the playlist plays and the moved one is removed from the playlist. If the moved video was the last entry, the previous one plays instead.
- A file with the same name in the destination is never overwritten. The moved file is renamed to `name (1).mp4` instead.
- The last move can be undone: the file goes back to its original location and playlist position.
- Each player window has its own buttons, so several windows can be sorted at the same time.

| Action | Button | Shortcut |
| --- | --- | --- |
| Move to Folder 1 | Upper button on the right side of the video | Ctrl+1 |
| Move to Folder 2 | Lower button on the right side of the video | Ctrl+2 |
| Undo Last Move | Menu: Plugin > Undo Last Move | Ctrl+Z |

## Installation

Requires IINA 1.4.0 or later.

1. Open IINA's Settings > Plugins.
2. Click "Install from GitHub" and enter `youngj523/iina-sort-to-folder`.
3. Accept the permissions and enable the plugin.

The plugin asks for three permissions: showing on-screen messages, drawing the buttons over the video, and file system access (used to move the videos).

## Setting the folders

Use either way:

- **Pick in a dialog**: while a video is playing, choose Plugin > Set Folder 1… or Set Folder 2… in the menu bar.
- **Type the path**: in Settings > Plugins > Sort to Folder > Preferences, enter a full path such as `~/Movies/Keep`.

The folders must already exist. The plugin does not create them.

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
| `overlay.html` | The two buttons shown over the video |
| `preferences.html` | Preferences page |

Log messages are available in IINA under Window > Log Viewer. API documentation: <https://docs.iina.io/>
