# The Dev Drive plan

This plan moves the code of this computer to a Dev Drive. Mark does 3 steps with admin rights. The sessions do the other steps. The fleet item is `dev-drive`.

## Why

- Each `pnpm install`, test run and `git` command opens thousands of files. Microsoft Defender and the file system filters examine each open file.
- On 2026-10-20 the non-paged kernel pool grew by 500 MB in one hour during such work. The tags that grew were `FMsl`, `File` and `NtxI`: file objects and the stream lists of the filter manager.
- A Dev Drive is a ReFS volume for code. On a Dev Drive, Defender scans in performance mode (after the open, not during it), and only antivirus filters attach. The other filters of this computer (`CldFlt`, `bindflt`, `wcifs`, `FileInfo` and more) do not attach.
- ReFS has block cloning. pnpm copies a package from its store as a clone, so an install writes almost no data.

## The decisions

| Question | Decision | Reason |
|---|---|---|
| Where is the space? | A new partition. Settings makes `C:` 200 GB smaller. | `C:` has 417 GB free of 952 GB, and keeps 217 GB free for Windows, Docker and WSL. A partition is always mounted after a restart, and it is a little faster than a VHD. |
| Which size? | 200 GB | The moved data is approximately 22 GB at this time (the table below). 200 GB leaves room for growth. |
| Which letter? | `D:` | No volume uses it. |
| What moves? | `~/git`, `~/jarvis`, the pnpm store, the npm cache | These are the code, the build output and the package caches. |
| What stays on `C:`? | `~/.claude`, the tools (Node, Git, VS Code), Docker and WSL data, OneDrive folders | Microsoft tells to keep tools on `C:`. Claude Code writes `~/.claude` while the sessions run. |
| Do the paths change? | No. A junction at each old path points to the new folder. | The fleet registry, each `CLAUDE.md`, the scheduled task of headroom and the Claude Code projects (named by their path) keep their paths. |
| Does `node_modules` move? | No. Each repository installs again from the store on `D:`. | A copy of `node_modules` is slow, and its links point to the old store. A new install uses block cloning. |
| Defender | Performance mode, the default for a trusted Dev Drive. No folder exclusions. | Microsoft recommends it. It keeps real-time protection on all other volumes. |
| Other filters | The default: none. | This computer uses Docker with Linux containers. Their bind mounts go through WSL, not through `bindflt` or `wcifs`. |

## The sizes

Measured on 2026-10-20 with `robocopy /L`:

| Folder | All the files | Without `node_modules` | Moves |
|---|---|---|---|
| `~/git` | 52.5 GB, 3.07 million files | 3.1 GB, 236,012 files | yes |
| `~/jarvis` | 8.0 GB, 311,006 files | 4.5 GB, 26,833 files | yes |
| the pnpm store | 5.1 GB, 317,619 files | | yes |
| the npm cache | 9.4 GB, 283,760 files | | yes |
| `~/.claude/projects` | 7.0 GB, 4,649 files | | no |

- The copy is approximately 22 GB.
- `robocopy` counts each hard link of pnpm as a full file. Thus `node_modules` shows 53 GB, but the store holds only 5.1 GB. On the Dev Drive, pnpm clones the files of the store, and a clone uses almost no new space.
- The 3 million files of `node_modules` are the files that Defender, the search indexer and the inventory scan of Windows examine on `C:`.

## The steps

### Part A: Mark, with admin rights (approximately 10 minutes)

The sessions can continue to work during part A.

1. Make the Dev Drive. Open `Settings` > `System` > `Storage` > `Advanced storage settings` > `Disks & volumes` > `Create dev drive` > `Resize an existing volume`. Select `C:`, and make it 200 GB smaller. Then set the label `Dev`, the letter `D` and the size 200 GB, and select `Format`.

   The same step in an admin PowerShell, if Settings does not show the button:

   ```powershell
   $c = Get-Partition -DriveLetter C
   Resize-Partition -DriveLetter C -Size ($c.Size - 200GB)
   New-Partition -DiskNumber $c.DiskNumber -Size 200GB -DriveLetter D
   Format-Volume -DriveLetter D -DevDrive -NewFileSystemLabel Dev -Confirm:$false
   ```

2. Check the Dev Drive in the admin PowerShell:

   ```powershell
   fsutil devdrv query D:
   ```

   The answer must say that `D:` is a trusted developer volume, protected by the antivirus filter.

3. Tell the organizer: "D: is ready". The sessions do part B.

### Part B: the sessions, with no admin rights (approximately 30 minutes)

1. The organizer tells each session to commit, push and stop, as before a restart. headroom writes the resume plan with `headroom resume-plan`.
2. headroom stops its daemon, because the daemon starts from `~/git/headroom`. `headroom service stop` disables the task, so the task does not start the daemon again during the move:

   ```powershell
   headroom service stop
   ```

3. Close VS Code, and quit Docker Desktop completely: right-click its icon in the notification area, and click `Quit Docker Desktop`. When you only close its window, Docker Desktop continues to hold the folders of the compose projects open. No program can use `~/git` or `~/jarvis` during the move. A shell whose folder is in `~/git` also blocks the move: the session that moves sets its shell folder to `C:\Users\<you>` first.
4. Move each folder. The script makes a copy without `node_modules`, compares it, keeps the old folder as `<name>.before-devdrive`, and makes the junction. Without `-Apply`, it only prints its plan.

   ```powershell
   .\scripts\dev-drive\move.ps1 -Source C:\Users\<you>\git -Target D:\git
   .\scripts\dev-drive\move.ps1 -Source C:\Users\<you>\git -Target D:\git -Apply
   .\scripts\dev-drive\move.ps1 -Source C:\Users\<you>\jarvis -Target D:\jarvis -Apply
   ```

   Run the first command from a copy of the script outside `~/git`, for example from `C:\Users\<you>\dev-drive-move.ps1`. The move renames `~/git`.

5. Move the package caches, and install again:

   ```powershell
   robocopy "$env:LOCALAPPDATA\pnpm\store" D:\packages\pnpm-store /E /MT:8 /NFL /NDL /NP
   pnpm config set store-dir D:\packages\pnpm-store --location=global
   robocopy "$env:LOCALAPPDATA\npm-cache" D:\packages\npm-cache /E /MT:8 /NFL /NDL /NP
   setx npm_config_cache D:\packages\npm-cache
   ```

   Then, in each repository with a `pnpm-lock.yaml`, one at a time: `headroom run --mem 1g -- pnpm install --frozen-lockfile --offline`.

6. Start headroom again:

   ```powershell
   headroom service start
   headroom service status
   ```

7. The organizer starts the sessions from the resume plan. Each session runs one quick check: a typecheck or the tests of one package.
8. After one day of normal work, headroom lists the old folders and their sizes: `~/git.before-devdrive`, `~/jarvis.before-devdrive` and the old caches. Mark decides if they go.

## Lessons from the move

### The `cue.mod/pkg` junctions

`scripts/dev-drive/move.ps1` copies with `robocopy /XJ`, and `/XJ` skips junctions. In the repositories that use `@mark1russell7/cue`, the folder `cue.mod/pkg/mark1russell7.cue` is a junction to `node_modules/@mark1russell7/cue`. Thus the copy does not have it, and CUE cannot find the package.

After the install, make the junction again in each repository that has a `cue.mod` folder:

```powershell
New-Item -ItemType Directory -Force cue.mod\pkg | Out-Null
New-Item -ItemType Junction -Path cue.mod\pkg\mark1russell7.cue -Target (Resolve-Path node_modules\@mark1russell7\cue)
```

`pnpm exec cue-config generate` also makes this junction. But it also writes `package.json`, `tsconfig.json` and `.gitignore` again. Thus use the two commands above when only the junction is missing.

### Docker Desktop holds folders open

Docker Desktop holds the folders of the compose projects open. Thus the move cannot rename a folder that a compose project uses. A closed window is not sufficient. Before the move, quit Docker Desktop completely: right-click its icon in the notification area, and click `Quit Docker Desktop`.

## Undo

Each step keeps the old data, so an undo takes some minutes:

1. Remove the junction: `Remove-Item C:\Users\<you>\git` (this removes the link, not `D:\git`).
2. Give the old folder its name again: `Rename-Item C:\Users\<you>\git.before-devdrive git`.
3. Set the caches back: `pnpm config delete store-dir --location=global` and `setx npm_config_cache ""`.
4. Mark can delete the Dev Drive in `Settings` > `Disks & volumes`, and extend `C:` again in `Disk Management`.

## What to expect

- Faster installs, builds and tests, because Defender scans after the open and fewer filters attach.
- A smaller kernel pool under heavy file work. headroom shows it on its dashboard and in `headroom pool-tags`.
- ReFS uses a little more memory than NTFS. Microsoft recommends 16 GB. This computer has 28 GB.
- Node gives real paths, so an error message shows `D:\git\...` in place of `C:\Users\<you>\git\...`. Both paths name the same file.

## The pool tags and their drivers

A pool tag names the driver that uses the memory. `headroom pool-tags --drivers` finds the driver of a tag in the driver files. It does not find the tags of ReFS, because ReFS does not keep them as text. This table gives the tags that grew on this computer:

| Tags | Driver | What it is | When it grew |
|---|---|---|---|
| `MSb+`, `MSpa`, `MSde`, `MSeb`, `MSPi`, `Refx` | `refs.sys` (`MSb+` also in `refsv1.sys`) | ReFS: the B+ trees, the pages and the other metadata of Minstore, for the files of the Dev Drive `D:` | 2026-10-29: approximately 900 MB in one hour after the restart, during many full test runs on `D:` (also 2026-10-27: 5 searches of 35 repositories at the same time took approximately 5 GB) |
| `FMsl`, `File`, `NtxI` | the filter manager (`fltmgr.sys`) and the file objects | The stream lists and the file objects of each open file | 2026-10-20, on `C:` (before the Dev Drive), and again 2026-10-29 |
| `DAL3`, `File` | `amdkmdag.sys` | The AMD display driver: two file objects for each new process (README, "Process starts") | 2026-10-24 and 2026-10-28 |

How to read an alert:

- The `MS*` and `Refx` tags grow: heavy file work on `D:`. Find the session with the most file work. Move its full test suites and wide searches to CI, or do them one at a time.
- `DAL3` or `File` grow with many process starts: the AMD leak. The alert names the owners with the most starts.
- After the file work stops, watch the pool for one hour. If it gets smaller, it was a cache. If it stays, plan a restart.
