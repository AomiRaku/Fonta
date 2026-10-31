# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 羽梦千景 Raku Inkyetta
#
# Regenerates THIRD_PARTY_LICENSES.txt from the Windows dependency graph,
# Cargo.lock metadata and the bundled frontend packages.

param(
  [string]$Output
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Output) {
  $Output = Join-Path $Root "THIRD_PARTY_LICENSES.txt"
}

$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"

Write-Host "Reading cargo metadata..."
$metadataJson = & cargo metadata --manifest-path (Join-Path $Root "src-tauri\Cargo.toml") --format-version 1 2>$null | Out-String
$metadata = $metadataJson | ConvertFrom-Json
$packageByKey = @{}
foreach ($package in $metadata.packages) {
  $packageByKey["$($package.name)@$($package.version)"] = $package
}

Write-Host "Reading Windows dependency graph..."
$treeLines = & cargo tree --manifest-path (Join-Path $Root "src-tauri\Cargo.toml") --target x86_64-pc-windows-msvc --edges normal --prefix none --format "{p}|{l}|{r}" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "cargo tree failed"
}

$textByHash = @{}
$textList = New-Object System.Collections.Generic.List[object]

function Add-LicenseText {
  param(
    [string]$Content,
    [string]$Label
  )
  $normalized = ($Content -replace "`r`n", "`n").Trim() + "`n"
  $hash = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData(
      [System.Text.Encoding]::UTF8.GetBytes($normalized)
    )
  )
  if (-not $textByHash.ContainsKey($hash)) {
    $id = "L{0:D3}" -f ($textList.Count + 1)
    $entry = [PSCustomObject]@{ Id = $id; Label = $Label; Content = $normalized }
    $textByHash[$hash] = $entry
    $textList.Add($entry)
  }
  return $textByHash[$hash]
}

function Get-LicenseFiles {
  param([string]$Directory)
  return @(
    Get-ChildItem -LiteralPath $Directory -File |
      Where-Object { $_.Name -match "^(?i)(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)" } |
      Where-Object { $_.Name -notmatch "\.spdx$" } |
      Sort-Object Name
  )
}

$packages = New-Object System.Collections.Generic.List[object]
$seen = @{}
$missing = New-Object System.Collections.Generic.List[string]

foreach ($line in $treeLines) {
  if (-not $line -or $line -notmatch "\|") { continue }
  $left = ($line -split "\|", 2)[0].Trim()
  if ($left -notmatch "^(?<name>.+?) v(?<version>[^\s(]+)") { continue }
  $name = $Matches.name
  $version = $Matches.version
  if ($name -eq "fontfox") { continue }

  $key = "$name@$version"
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true

  $package = $packageByKey[$key]
  if (-not $package) {
    $missing.Add("$key (metadata missing)")
    continue
  }

  $fields = $line -split "\|", 3
  $license = if ($fields.Count -ge 2) { $fields[1].Trim() } else { "" }
  if (-not $license) { $license = $package.license }
  $repository = if ($fields.Count -ge 3) { $fields[2].Trim() } else { "" }
  if (-not $repository) { $repository = $package.repository }
  $authors = ($package.authors -join "; ").Trim()

  $directory = Split-Path $package.manifest_path -Parent
  $files = Get-LicenseFiles -Directory $directory
  $references = New-Object System.Collections.Generic.List[string]
  foreach ($file in $files) {
    $content = [System.IO.File]::ReadAllText($file.FullName)
    $entry = Add-LicenseText -Content $content -Label $file.Name
    $references.Add("$($entry.Id) ($($file.Name))")
  }

  if ($references.Count -eq 0) {
    $fallbackPath = $null
    switch ($name) {
      "alloc-stdlib" {
        $source = $packageByKey["alloc-no-stdlib@3.0.0"]
        if ($source) {
          $fallbackPath = Join-Path (Split-Path $source.manifest_path -Parent) "LICENSE"
        }
      }
      "selectors" {
        $source = $packageByKey["cssparser@0.37.0"]
        if ($source) {
          $fallbackPath = Join-Path (Split-Path $source.manifest_path -Parent) "LICENSE"
        }
      }
      { $_ -in @("webview2-com", "webview2-com-macros", "webview2-com-sys") } {
        $fallbackPath = Join-Path $PSScriptRoot "licenses\MIT-webview2.txt"
      }
      "clipboard-win" {
        $fallbackPath = Join-Path $PSScriptRoot "licenses\BSL-1.0.txt"
      }
    }
    if ($fallbackPath -and (Test-Path -LiteralPath $fallbackPath)) {
      $entry = Add-LicenseText -Content ([System.IO.File]::ReadAllText($fallbackPath)) -Label (Split-Path $fallbackPath -Leaf)
      $references.Add("$($entry.Id) (fallback)")
    } else {
      $missing.Add("$key")
      continue
    }
  }

  if ($name -like "webview2-com*" -and -not $authors) {
    $authors = "webview2-rs contributors"
  }

  $packages.Add([PSCustomObject]@{
    Name = $name
    Version = $version
    License = $license
    Repository = $repository
    Authors = $authors
    References = $references
  })
}

function Add-FrontendPackage {
  param(
    [string]$Name,
    [string]$Version,
    [string]$License,
    [string]$Repository,
    [string[]]$Files,
    [string]$Note
  )
  $packageDirectory = Join-Path $Root "node_modules\$Name"
  $references = New-Object System.Collections.Generic.List[string]
  foreach ($file in $Files) {
    $path = Join-Path $packageDirectory $file
    if (-not (Test-Path -LiteralPath $path)) {
      throw "Missing frontend license file: $path"
    }
    $entry = Add-LicenseText -Content ([System.IO.File]::ReadAllText($path)) -Label $file
    $references.Add("$($entry.Id) ($(Split-Path $file -Leaf))")
  }
  $packages.Add([PSCustomObject]@{
    Name = $Name
    Version = $Version
    License = $License
    Repository = $Repository
    Authors = ""
    References = $references
    Note = $Note
  })
}

$apiDir = Join-Path $Root "node_modules\@tauri-apps\api"
$apiPackage = Get-Content (Join-Path $apiDir "package.json") -Raw | ConvertFrom-Json
Add-FrontendPackage -Name "@tauri-apps/api" -Version $apiPackage.version -License "Apache-2.0 OR MIT" -Repository "https://tauri.app" -Files @("LICENSE-APACHE-2.0", "LICENSE-MIT") -Note ""

$clipboardDir = Join-Path $Root "node_modules\@tauri-apps\plugin-clipboard-manager"
$clipboardPackage = Get-Content (Join-Path $clipboardDir "package.json") -Raw | ConvertFrom-Json
Add-FrontendPackage -Name "@tauri-apps/plugin-clipboard-manager" -Version $clipboardPackage.version -License "MIT OR Apache-2.0" -Repository "https://tauri.app" -Files @("..\api\LICENSE-APACHE-2.0", "..\api\LICENSE-MIT") -Note "License texts shared with @tauri-apps/api."

$iconsDir = Join-Path $Root "node_modules\@siemens\ix-icons"
$iconsPackage = Get-Content (Join-Path $iconsDir "package.json") -Raw | ConvertFrom-Json
Add-FrontendPackage -Name "@siemens/ix-icons" -Version $iconsPackage.version -License "MIT" -Repository "https://github.com/siemens/ix-icons" -Files @("LICENSE.md") -Note "Copyright (c) 2022 Siemens AG"

if ($missing.Count -gt 0) {
  throw "Missing license text for: $($missing -join ', ')"
}

$sortedPackages = $packages | Sort-Object @{ Expression = { if ($_.Name.StartsWith("@")) { 1 } else { 0 } } }, Name, Version
$date = Get-Date -Format "yyyy-MM-dd"
$out = New-Object System.Collections.Generic.List[string]

$out.Add("THIRD-PARTY LICENSES")
$out.Add("")
$out.Add("FontFox")
$out.Add("Copyright (c) 2026 羽梦千景 Raku Inkyetta")
$out.Add("")
$out.Add("This file lists the third-party components used by the Windows x86_64")
$out.Add("build and the license texts that apply to them. Build-only tools are")
$out.Add("excluded. The dependency list is generated from Cargo.lock, Cargo")
$out.Add("metadata and the bundled frontend packages.")
$out.Add("")
$out.Add("Generated: $date")
$out.Add("")
$out.Add("================================================================================")
$out.Add("DEPENDENCIES")
$out.Add("================================================================================")

$currentGroup = ""
foreach ($package in $sortedPackages) {
  $group = if ($package.Name.StartsWith("@")) { "Frontend Dependencies" } else { "Rust Dependencies" }
  if ($group -ne $currentGroup) {
    $currentGroup = $group
    $out.Add("")
    $out.Add("$group")
    $out.Add("--------------------------------------------------------------------------------")
  }
  $out.Add("")
  $out.Add("$($package.Name) $($package.Version)")
  $out.Add("  License: $($package.License)")
  if ($package.Repository) { $out.Add("  Repository: $($package.Repository)") }
  if ($package.Authors) { $out.Add("  Authors: $($package.Authors)") }
  if ($package.Note) { $out.Add("  Note: $($package.Note)") }
  $out.Add("  License texts: $($package.References -join ', ')")
}

$out.Add("")
$out.Add("================================================================================")
$out.Add("LICENSE TEXTS")
$out.Add("================================================================================")

foreach ($entry in $textList) {
  $out.Add("")
  $out.Add("[$($entry.Id)] $($entry.Label)")
  $out.Add("--------------------------------------------------------------------------------")
  foreach ($line in ($entry.Content -split "`n")) {
    $out.Add($line)
  }
}

[System.IO.File]::WriteAllText($Output, ([string]::Join("`n", $out) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $Output ($($sortedPackages.Count) packages, $($textList.Count) unique license texts)."
