# Open Editor Groups

<img src="media/icon.png" alt="Open Editor Groups" width="128" height="128">

Group and organize your open editors in a tree view — like Open Editors, with folders you control.

Create nested groups, drag files in and out, sort or rearrange by hand, and auto-assign files with regex patterns. Groupings are saved in the workspace so they come back the next time you open the same files.

## Install

Install from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=esancaro.open-editor-groups), or from the Extensions view (`Ctrl+Shift+X`) by searching for **Open Editor Groups**.

## Features

- Tree view in the Explorer sidebar titled **Open Editor Groups**
- Ungrouped open editors appear at the root, below an **Ungrouped** divider (not a folder) so they stay visually separate from groups
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
  - Drag a group onto another group **at the same level** to place it **before** that group (first, between, or up/down the root list). VS Code does not give extensions a drop-bar between rows, so the whole folder row is the target
  - In a multi-root workspace, drop onto a folder section (or a group inside it) to store membership in **that** folder's JSON. Dragging a file from folder A into a group in folder B is allowed
  - To **nest** a group, drop it onto a file or subgroup **inside** the destination, or use **Move to Group**
  - Drop on the view background, the Ungrouped divider, or an ungrouped file to move a group to the **end** of the list
  - Drag files in from the Explorer (they are opened and assigned to the drop target)
  - Multi-select files/groups and drag them together
- A file can belong to **several groups** at once (the same path listed under Issue 1 and Issue 2). When you open it, it shows up in every group it is associated with. Closing a tab hides it from the tree; the association stays in `.vscode/editor-groups.json` until you **Remove from Group**.
- **Add to Group** — add this file to another group and **keep** existing memberships
- **Move to Group** — move **this entry** only; other groups that also list the file are unchanged
- **Add to New Group** (right-click on a file or group) — wraps the item in a new group; works on ungrouped files and on multi-selections
- **Open Files...** / **Open All Files** on a group — pick files from that group (including closed ones) or open them all. Useful when a group is named after an issue and you want to load its classes again.
- **Group by Pattern** — regex rules that show matching **open** files under the group (not stored in JSON). The pattern is matched against the **whole** workspace-relative path, so `.*.js` matches `src/foo.js` but not `package.json`. Groups with a pattern show `.*` next to the open count, a green folder tint, and a check on the **Group by Pattern** menu. The dialog is pre-filled so you can edit; Save (Enter) or the trash button to remove. Also `OEG: Manage Group Patterns`. Typical JS files: `.*\\.js$`.
- Rename, hide, and delete groups (files in a deleted group become ungrouped; nested subgroups are removed too). **Hide Group** takes the group out of the tree; its files show as ungrouped unless they belong to another visible group. **Show Hidden Groups...** (view `…` menu) lists hidden groups by path so you can show them again. Unhiding a subgroup whose parent is also hidden asks to show the parent too.
- Remove a file from a group via context menu ("Remove from Group")
- Close a file (inline **x**) or close all open files in a group (inline **close all**)
- Groups have one **flag** (none → red → yellow → green → none). When none, the outline flag appears on hover beside Close All. When a color is set, that flag stays visible on the row (the folder icon is unchanged so it can still highlight for the active editor). Saved in `editor-groups.json` as `"flag"`
- Unsaved files show a **●** marker, like Open Editors
- The tree **marks the active editor**: visible file rows get a **●** and a highlighted name. Collapsed groups that contain that file also highlight and show `● filename`, so you can see which folders hold it without opening them. VS Code cannot select a hidden child without expanding the folder, so collapsed groups stay closed. If the file is in several expanded groups, the occurrence you were already on is kept instead of jumping to another group
- Group **expanded / collapsed** state is saved in `.vscode/editor-groups.json` and restored when you reopen the folder
- Persistent storage: groupings are saved to `<folder>/.vscode/editor-groups.json`
  - **Single-folder:** groups and ungrouped files at the tree root (no extra header)
  - **Multi-root:** one collapsible section per workspace folder that has a groups file or open editors. Empty roots stay hidden. Title-bar **Create Group** asks which folder; right-click uses that folder
  - The JSON file is created only when you actually save a group in that folder — opening the picker and canceling does nothing
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
7. Your structure + file assignments are saved automatically to that folder's `.vscode/editor-groups.json`.

Next time you open the workspace (and the same files), the files will be placed in the same groups they were in when last saved.

## Commands

Accessible from the view title bar or right-click context menus:

- Create Group (title bar / Command Palette: picks a folder in multi-root; right-click a folder section uses that folder)
- Create Subgroup (right-click on a group)
- Add to Group (keep other memberships)
- Move to Group (this entry only)
- Add to New Group (right-click on file or group — wraps it)
- Open Files... / Open All Files (right-click a group)
- **Backup Open Files** / **Backup All Files** (right-click a group) — zip the group's currently open files, or every file in the group (including closed), as paths relative to the folder root
- **Restore** (right-click a group) — pick a backup zip and overwrite those files on disk (asks to confirm)
- Group by Pattern (`OEG: Group by Pattern` — Command Palette, view `...` menu, or right-click a group)
- Manage Group Patterns (`OEG: Manage Group Patterns`)
- Rename Group
- Hide Group (right-click a group)
- Show Hidden Groups... (view `…` menu or Command Palette)
- Delete Group
- Remove from Group (on a file entry)
- Copy Path / Copy Relative Path / Copy Filename (right-click a file; filename is without the extension)
- Close (on a file entry; also the inline x)
- Close All in Group (on a group; also the inline close-all)
- Refresh
- Sort A-Z / Sort Z-A / Turn Off Sorting (Drag to Reorder) (`OEG: …`, view sort icon, or **Sort** in the view `…` menu)

## Data File

- Location: `<that workspace folder>/.vscode/editor-groups.json` (one file per root in a multi-root workspace)
- Files are stored as paths **relative to that folder** (forward slashes), so moving or renaming the project folder does not break groupings. Files outside the folder stay as full URIs. Never prefixed with another root's name.
- Older files that still contain `file://` URIs are migrated to relative paths on the next save.
- Files not mentioned in the file are treated as ungrouped while they are open. Ungrouped files are not stored, so the JSON only grows with groups you create.
- Auto-group regex is stored on the group as `"pattern"`. Those groups do **not** store file names; matching open files appear in the tree automatically.
- `"expanded": true` means the group is open in the tree. Collapsed groups omit the field.
- `"flag": "red"` | `"yellow"` | `"green"` is the inline status flag. Omit when none is set.
- `"hidden": true` hides the group (and its subgroups) from the tree until you show it again.
- You can edit the JSON manually if needed (e.g. to bulk reorganize), then use the Refresh command.

Example:

```json
{
  "version": 2,
  "groups": [
    {
      "id": "g_abc123",
      "name": "Feature A",
      "expanded": true,
      "children": [
        "src/foo.ts",
        {
          "id": "g_def456",
          "name": "Tests",
          "pattern": ".*\\.test\\.ts$",
          "children": []
        }
      ]
    }
  ],
  "sortMode": "manual"
}
```

## Notes / Limitations (v0.1)

- Tracks text editors, custom editors, and notebooks. Diff editors, terminals, and other non-file tabs are ignored.
- Duplicate files in groups are prevented.
- Pattern matching uses JavaScript regular expressions against the **whole** path relative to that group's folder (unanchored input is wrapped as `^(?:pattern)$`). A file can match more than one pattern group. Pattern groups list currently open matches only; closed files disappear until they are opened again.
- Open editors that are not inside any workspace folder appear under **Other files** (multi-root only, hidden when empty).
- Following the active editor never expands a collapsed group. Those groups are highlighted instead (`● filename`) so you can open the right one.
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
