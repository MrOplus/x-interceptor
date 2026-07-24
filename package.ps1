# Builds the Chrome Web Store upload zip: manifest + src + icons only.
# Uses forward-slash entry names (the zip spec's requirement); PS 5.1's
# Compress-Archive writes backslashes, which some validators reject.
# Usage:  powershell -ExecutionPolicy Bypass -File package.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$out = Join-Path $root "x-interceptor-$version.zip"
if (Test-Path $out) { Remove-Item $out }

$roots = @('manifest.json', 'src', 'icons')
$files = foreach ($item in $roots) {
  $p = Join-Path $root $item
  if (Test-Path $p -PathType Container) {
    Get-ChildItem $p -Recurse -File
  } else {
    Get-Item $p
  }
}

$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
  foreach ($f in $files) {
    $entry = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entry) | Out-Null
    Write-Host "  + $entry"
  }
} finally {
  $zip.Dispose()
}
Write-Host "Built $out"
