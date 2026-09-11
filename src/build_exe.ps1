# 重新打包 TXT2EPUB.exe（单文件、免安装、无运行时依赖）
# 用法：在本目录下执行  powershell -ExecutionPolicy Bypass -File build_exe.ps1
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host "[1/3] 检查依赖 ..."
python -m PyInstaller --version | Out-Null
python -c "import PIL; print('Pillow', PIL.__version__)"

Write-Host "[2/3] 生成图标 ..."
python make_icon.py

Write-Host "[3/3] 打包 ..."
python -m PyInstaller --noconfirm --clean --onefile --windowed `
    --name TXT2EPUB `
    --icon "$here\app.ico" `
    --version-file "$here\version_info.txt" `
    --distpath "$here\dist" `
    --workpath "$here\build" `
    --specpath "$here\build" `
    --exclude-module numpy --exclude-module matplotlib `
    --exclude-module PyQt5 --exclude-module PySide6 `
    --exclude-module IPython --exclude-module pytest `
    "$here\txt2epub.py"

Write-Host ""
Write-Host "完成： $here\dist\TXT2EPUB.exe"
Write-Host "自检： .\dist\TXT2EPUB.exe --selftest"
