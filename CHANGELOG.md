# Changelog

## 0.1.6

- Multi-root workspaces: one `.vscode/editor-groups.json` per folder, relative paths local to that folder
- Empty workspace folders stay hidden until they have a group file or an open editor
- Title-bar Create Group asks which folder; right-click uses that folder. JSON is created only when a group is saved
- Drag a group onto a sibling group to insert it **before** that group (reorder at root or in a parent). Nest by dropping onto a child inside the destination, or use Move to Group

## 0.1.5

- Following the active editor only selects the file in **already expanded** groups (or Ungrouped). Collapsed groups stay closed
- If the same file is in several groups, keep the occurrence you were already on instead of jumping to another group
- Group expanded / collapsed state is stored in `editor-groups.json` as `"expanded": true`
- The active editor is marked with **●** and a highlighted name on every visible file row (not only tree selection)
- Collapsed groups that contain the active file highlight their name and show `● filename` so you can find it without opening every group

## 0.1.4

- Pattern is matched against the whole relative path, so `.*.js` does not also match `.json`
- **Group by Pattern** context menu now shows a check when the group has a pattern

## 0.1.3

- **Ungrouped** divider between group folders and ungrouped files (not a folder)
- Closed grouped files hide from the tree when the tab is closed; associations stay in JSON
- File context menu: **Remove from Group**
- Ungrouped files are not persisted
- Groups with a pattern show `.*` beside the open count, a green folder, and a check on **Group by Pattern**
- Pattern dialog is pre-filled; Save / Enter to update, trash button to remove
- Pattern is stored on the group; matching files are not persisted in `children`

## 0.1.2

- A file can belong to several groups at once (separate entries for the same path)
- **Add to Group** keeps existing memberships; **Move to Group** moves only this entry
- Closed files are hidden in the tree (like ungrouped) but stay associated; reopen or use **Open Files...** / **Open All Files**
- Group context menu: **Open Files...** (pick list) and **Open All Files**
- Ungrouped files are not persisted; any open file not listed in a group is ungrouped
- File context menu: **Remove from Group** (was Move to Ungrouped)

## 0.1.1

- Copy Path, Copy Relative Path, and Copy Filename (without extension) on file context menus

## 0.1.0

Initial marketplace release.

- Open Editor Groups view in Explorer
- Nested groups with drag and drop
- Add to Group / Add to New Group
- Auto-group by regex pattern
- Sort A-Z, Z-A, or turn sorting off and reorder by dragging
- Persist groups as workspace-relative paths in `.vscode/editor-groups.json`
- Close editors from the view, dirty-file markers, multi-select
