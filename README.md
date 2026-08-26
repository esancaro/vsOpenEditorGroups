# Open Editor Groups

<img src="media/icon.png" alt="Open Editor Groups" width="128" height="128">

Group and organize your open editors in a tree view — like Open Editors, with folders you control.

Create nested groups, drag files in and out, sort or rearrange by hand, and auto-assign files with regex patterns. Groupings are saved in the workspace so they come back the next time you open the same files.

## Install

Install from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=esancaro.open-editor-groups), or from the Extensions view (`Ctrl+Shift+X`) by searching for **Open Editor Groups**.

## Features

- Tree view in the Explorer sidebar titled **Open Editor Groups**
- Ungrouped open editors appear directly at the root level (no group wrapper)
- Create groups at the root via the **+** (Create Group) button in the view title
- Create **sub-groups** via context menu (right-click) on any existing group
- **Sort** (header icon changes with the mode):
  - **↑ A-Z** — sort by file name ascending
  - **↓ Z-A** — sort by file name descending
  - **Off** (gripper icon) — no sorting; drag a file onto another file to reorder, like moving items in Explorer
  - Click the icon to cycle A-Z → Z-A → Off. Or use **Sort** in the view `…` menu, or `OEG: Turn Off Sorting (Drag to Reorder)`
  - Dragging a file onto a sibling while A-Z/Z-A is on automatically turns sorting off so the new order sticks
- **Drag and drop**:
  - Drag file entries (ungrouped or grouped) into any group
  - With sorting **Off**, drag a file onto another file to place it there (inside a group or in the ungrouped list)
  - Drag a file out of a group onto the view background or an ungrouped file to ungroup it
  - Drag groups into other groups to nest them (reparent)
  - Drop on the view background or on ungrouped files to move items back to ungrouped root
  - Drag files in from the Explorer (they are opened and assigned to the drop target)
  - Multi-select files/groups and drag them together
- "Add to Group" (right-click on a file, group, editor tab, or editor title) — pick an existing group from a list. Nested groups appear as `Parent / Child`
- "Add to New Group" (right-click on a file or group) — wraps the item in a new group; works on ungrouped files and on multi-selections
- **Group by Pattern** (`OEG: Group by Pattern`) — regex rules that auto-add a file to a group when it is opened, if it is not already in any group. Nested destinations use `Parent / Child`. Manage or delete rules with `OEG: Manage Group Patterns`.
- Rename and delete groups (files in a deleted group become ungrouped; nested subgroups are removed too)
- Move a grouped file back to ungrouped via context menu ("Move to Ungrouped")
- Close a file (inline **x**) or close all open files in a group (inline **close all**)
- Unsaved files show a **●** marker, like Open Editors
- Persistent storage: groupings are saved to `.vscode/editor-groups.json` in your workspace
  - When you reopen a file later, if it was previously assigned to a group it will automatically appear under that group again
- Automatically stays in sync with currently open editors/tabs
- File renames/moves inside VS Code update stored URIs so grouped files stay grouped

## Usage

1. Open a workspace/folder.
2. Open some files (they will initially appear under the view as ungrouped at the root).
3. Click the **+** icon in the "Open Editor Groups" view header to create a top-level group. Give it a name.
4. Drag one or more file lines from the ungrouped section into your new group.
   - Or right-click a file → **Add to Group** and pick `Parent / Child` from the list.
   - Or right-click any ungrouped (or grouped) file/group entry → **Add to New Group** to instantly wrap it.
   - You can also drag files from the Explorer into a group.
5. Right-click a group → **Create Subgroup** to nest further.
6. Drag groups around to reorganize the hierarchy.
7. Your structure + file assignments are saved automatically to `.vscode/editor-groups.json`.

Next time you open the workspace (and the same files), the files will be placed in the same groups they were in when last saved.

## Commands

Accessible from the view title bar or right-click context menus:

- Create Group (top-level, via title bar + button)
- Create Subgroup (right-click on a group)
- Add to Group (right-click on file, group, or editor tab — pick an existing group)
- Add to New Group (right-click on file or group — wraps it)
- Group by Pattern (`OEG: Group by Pattern` — Command Palette, view `...` menu, or right-click a group)
- Manage Group Patterns (`OEG: Manage Group Patterns`)
- Rename Group
- Delete Group
- Move to Ungrouped (on a file entry)
- Copy Path / Copy Relative Path / Copy Filename (right-click a file; filename is without the extension)
- Close (on a file entry; also the inline x)
- Close All in Group (on a group; also the inline close-all)
- Refresh
- Sort A-Z / Sort Z-A / Turn Off Sorting (Drag to Reorder) (`OEG: …`, view sort icon, or **Sort** in the view `…` menu)

## Data File

- Location: `<workspace>/.vscode/editor-groups.json`
- Files are stored as **workspace-relative paths** (forward slashes), so moving or renaming the project folder does not break groupings. Files outside the workspace stay as full URIs.
- Older files that still contain `file://` URIs are migrated to relative paths on the next save.
- Files not mentioned in the file are treated as ungrouped.
- Auto-group regex rules are stored in `patterns`.
- You can edit the JSON manually if needed (e.g. to bulk reorganize), then use the Refresh command.

Example:

```json
{
  "version": 2,
  "groups": [
    {
      "id": "g_abc123",
      "name": "Feature A",
      "children": [
        "src/foo.ts",
        {
          "id": "g_def456",
          "name": "Utils",
          "children": [
            "src/utils/bar.ts"
          ]
        }
      ]
    }
  ],
  "sortMode": "manual",
  "ungroupedOrder": [],
  "patterns": [
    {
      "pattern": ".*\\.test\\.ts$",
      "groupId": "g_abc123",
      "group": "Feature A"
    }
  ]
}
```

## Notes / Limitations (v0.1)

- Tracks text editors, custom editors, and notebooks. Diff editors, terminals, and other non-file tabs are ignored.
- In multi-root workspaces the JSON is stored under the first workspace folder's `.vscode`.
- Duplicate files in groups are prevented.
- Pattern matching uses JavaScript regular expressions against the workspace-relative path. First matching rule wins. Ungrouping a file does not re-apply the rule until that file is closed and opened again.
- Renames done through VS Code are tracked. Renames that happen only on disk (outside VS Code) are not.

## Privacy

Grouping data is stored only in your workspace file `.vscode/editor-groups.json`. The extension does not send telemetry or network requests.

## Development

- Clone / open this folder in VS Code.
- `npm install`
- `npm run compile` (or use the watch task)
- Press F5 to launch a new Extension Development Host window.
- The **Open Editor Groups** view appears in the Explorer panel.

### Package a VSIX

```bash
npm run package
```

Install the generated `.vsix` in VS Code with **Extensions: Install from VSIX…**.

### Publish to the Marketplace

1. Create a publisher named `esancaro` at [Visual Studio Marketplace Management](https://marketplace.visualstudio.com/manage) (Azure DevOps PAT with **Marketplace → Manage**).
2. `npx vsce login esancaro`
3. `npm run publish:marketplace`

To publish a version bump: `npx vsce publish minor` (or `patch` / `major`).

## License

[MIT](LICENSE) © Esteban Castro
