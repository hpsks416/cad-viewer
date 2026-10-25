# Download occt-import-js (WASM STEP/IGES/BREP parser) from npmmirror into lib/occt/.
# Enables the in-browser STEP import (no Blender / OCP server needed).
# Run once: powershell -NoProfile -ExecutionPolicy Bypass -File tools/download-occt.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path   # tools/
$proj = Split-Path -Parent $root                          # cad-viewer/
$vendor = Join-Path $proj 'lib\occt'
$tmp = Join-Path $proj '_occt_tmp'
$version = '0.0.23'
$tgz = Join-Path $proj "occt-import-js-$version.tgz"
$url = "https://registry.npmmirror.com/occt-import-js/-/occt-import-js-$version.tgz"

Write-Host "Downloading $url"
Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing

Write-Host "Extracting ..."
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
tar -xzf $tgz -C $tmp

New-Item -ItemType Directory -Force -Path $vendor | Out-Null
Copy-Item (Join-Path $tmp 'package\dist\occt-import-js.js')        (Join-Path $vendor 'occt-import-js.js') -Force
Copy-Item (Join-Path $tmp 'package\dist\occt-import-js.wasm')      (Join-Path $vendor 'occt-import-js.wasm') -Force
Copy-Item (Join-Path $tmp 'package\dist\occt-import-js-worker.js') (Join-Path $vendor 'occt-import-js-worker.js') -Force
Copy-Item (Join-Path $tmp 'package\dist\license.occt-import-js.txt') (Join-Path $vendor 'LICENSE.occt-import-js.txt') -Force
Copy-Item (Join-Path $tmp 'package\dist\license.occt.txt')         (Join-Path $vendor 'LICENSE.occt.txt') -Force

Remove-Item -Recurse -Force $tmp
Remove-Item $tgz -Force
Get-ChildItem $proj -Filter 'occt-import-js-*.tgz' -ErrorAction SilentlyContinue | Remove-Item -Force
Write-Host "Done -> $vendor"
