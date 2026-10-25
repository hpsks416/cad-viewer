# Download classic litegraph.js + css from npmmirror into vendor/litegraph/.
# Run once: powershell -NoProfile -ExecutionPolicy Bypass -File download-litegraph.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $root 'vendor\litegraph'
$tmp = Join-Path $root '_litegraph_tmp'
$version = '0.7.18'
$tgz = Join-Path $root "litegraph.js-$version.tgz"
$url = "https://registry.npmmirror.com/litegraph.js/-/litegraph.js-$version.tgz"

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing

Write-Host "Extracting ..."
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
tar -xzf $tgz -C $tmp

New-Item -ItemType Directory -Force -Path $vendor | Out-Null
Copy-Item (Join-Path $tmp 'package\build\litegraph.js') (Join-Path $vendor 'litegraph.js') -Force
Copy-Item (Join-Path $tmp 'package\css\litegraph.css') (Join-Path $vendor 'litegraph.css') -Force

Remove-Item -Recurse -Force $tmp
Remove-Item $tgz -Force
# clean up any leftover tarballs from previous failed attempts
Get-ChildItem $root -Filter 'litegraph-*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
Write-Host "Done -> $vendor"
