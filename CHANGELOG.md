# Changelog

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
