# Changelog

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
