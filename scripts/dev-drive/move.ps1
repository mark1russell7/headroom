<#
.SYNOPSIS
  Moves one folder to a Dev Drive and leaves a junction at the old path, so each path stays valid.

.DESCRIPTION
  The plan is docs/DEV-DRIVE.md. This script needs no admin rights. Start it only when no program uses the folder:
  no Claude Code session, no editor, no daemon, no Docker bind mount.

  1. It copies the folder to the target with robocopy, without node_modules (pnpm installs them again on the
     Dev Drive, with block cloning) and without junctions.
  2. It compares the files of the source and of the target, without node_modules.
  3. It renames the source to <name>.before-devdrive. It deletes nothing.
  4. It makes a junction at the old path to the target.

  Without -Apply, it only prints what it would do, and the size of the copy.

.EXAMPLE
  .\move.ps1 -Source C:\Users\<you>\git -Target D:\git
  .\move.ps1 -Source C:\Users\<you>\git -Target D:\git -Apply
#>
param(
  [Parameter(Mandatory)] [string]$Source,
  [Parameter(Mandatory)] [string]$Target,
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'

$source = (Resolve-Path $Source).Path.TrimEnd('\')
$item = Get-Item $source -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$source is already a junction or a link. Nothing to move." }
$drive = (Split-Path -Qualifier $Target).TrimEnd(':')
$volume = Get-Volume -DriveLetter $drive -ErrorAction SilentlyContinue
if (-not $volume) { throw "No volume has the letter ${drive}:. Make the Dev Drive first (docs/DEV-DRIVE.md, part A)." }
if ($volume.FileSystem -ne 'ReFS') { throw "The target drive ${drive}: is $($volume.FileSystem), not ReFS. Make the Dev Drive first (docs/DEV-DRIVE.md, part A)." }
if (Test-Path $Target) { if ((Get-ChildItem $Target -Force | Measure-Object).Count -gt 0) { throw "$Target exists and is not empty." } }
$backup = "$source.before-devdrive"
if (Test-Path $backup) { throw "$backup exists. Remove or rename it first." }

$robocopy = @('/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/XD', 'node_modules', '/R:1', '/W:1', '/MT:8', '/NFL', '/NDL', '/NP', '/BYTES')
# The summary of robocopy has the columns Total, Copied, Skipped: the second column is what a copy would write.
function Count([string]$from, [string]$to) {
  $out = robocopy $from $to @robocopy /L /NJH
  $files = ($out | Select-String '^\s*Files\s*:\s*(\d+)\s+(\d+)').Matches.Groups[2].Value
  $bytes = ($out | Select-String '^\s*Bytes\s*:\s*(\d+)\s+(\d+)').Matches.Groups[2].Value
  return [pscustomobject]@{ Files = [long]$files; GB = [math]::Round([double]$bytes / 1GB, 1) }
}

$plan = Count $source $Target
"Source:  $source"
"Target:  $Target (ReFS, $([math]::Round($volume.SizeRemaining / 1GB)) GB free)"
"Copy:    $($plan.Files) files, $($plan.GB) GB, without node_modules"
"Backup:  $backup"
if ($plan.GB -gt ($volume.SizeRemaining / 1GB) * 0.9) { throw "The target has not enough free space for the copy." }
if (-not $Apply) { "Dry run. Start again with -Apply to move."; return }

$log = Join-Path $env:TEMP ("dev-drive-move-{0}.log" -f (Split-Path -Leaf $source))
New-Item -ItemType Directory -Force $Target | Out-Null
robocopy $source $Target @robocopy "/LOG:$log" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with the code $LASTEXITCODE. The log: $log. The source is unchanged." }

# A second list from the source to the target must find nothing more to copy.
$left = Count $source $Target
if ($left.Files -ne 0) { throw "$($left.Files) files differ after the copy. The log: $log. The source is unchanged." }
"Copied and checked. The log: $log"

Rename-Item -Path $source -NewName (Split-Path -Leaf $backup)
New-Item -ItemType Junction -Path $source -Target $Target | Out-Null
"Junction: $source -> $Target"
"Next: pnpm install in each repository (docs/DEV-DRIVE.md, step 5). Delete $backup only after a day of normal work, and only with the word of Mark."
