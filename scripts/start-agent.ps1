<#
  一键启动脚本（Windows / PowerShell）

  做四件事：检查运行环境 → 按需安装依赖 → 提示 LLM 配置状态 → 启动 dev server 并打开浏览器。

  设计原则：
  1. 只做必要动作：依赖已存在就不装；端口已被占用就只提示并打开已有服务，不重复启动；
  2. 不碰任何配置与数据（不写 .env.local、不删 .next、不动 .cache）；
  3. 只在终端打印「是否配置了 LLM」，**不读取也不回显密钥内容**；
  4. 任何一步失败都给中文提示并停住，双击运行时窗口不会直接消失。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# 脚本放在 scripts/ 下，项目根目录是它的上一级
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$port = 3000
$url = "http://localhost:$port"

function Write-Step($message) { Write-Host "[启动] $message" -ForegroundColor Cyan }
function Write-Note($message) { Write-Host "[注意] $message" -ForegroundColor Yellow }

function Test-PortListening($targetPort) {
  return [bool](Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue)
}

try {
  # ---------- 1. 运行环境 ----------
  Write-Step '检查运行环境…'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '未找到 Node.js。请先安装 Node 20 或更高版本（https://nodejs.org），再重新运行本脚本。'
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw '未找到 npm（通常随 Node.js 一起安装）。请检查 Node.js 安装是否完整。'
  }

  $nodeVersion = (node -v).TrimStart('v')
  $majorVersion = [int]($nodeVersion.Split('.')[0])
  if ($majorVersion -lt 20) {
    Write-Note "当前 Node 版本为 $nodeVersion，Next.js 15 建议 20 或更高；若启动报错请先升级 Node。"
  } else {
    Write-Step "Node $nodeVersion，npm $((npm -v))"
  }

  # ---------- 2. 依赖 ----------
  $nodeModules = Join-Path $projectRoot 'node_modules'
  if (Test-Path $nodeModules) {
    Write-Step '依赖已就绪（node_modules 已存在，跳过安装）'
  } else {
    Write-Step '首次启动：安装依赖（npm install，可能需要几分钟）…'
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install 失败，请检查网络或代理后重试。' }
  }

  # ---------- 3. LLM 配置（只看键是否存在，不读值） ----------
  $envFile = Join-Path $projectRoot '.env.local'
  if (-not (Test-Path $envFile)) {
    Write-Note '.env.local 不存在：将以「规则解析 + 模板回复」运行，功能完整可用。'
    Write-Note '需要模型时执行：cp .env.example .env.local，并填写 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL。'
  } else {
    $envText = Get-Content $envFile -Raw
    $configured = $envText -match '(?m)^\s*LLM_BASE_URL\s*=\s*\S' -and
      $envText -match '(?m)^\s*LLM_API_KEY\s*=\s*\S' -and
      $envText -match '(?m)^\s*LLM_MODEL\s*=\s*\S'
    if ($configured) {
      Write-Step '已检测到 LLM 配置：意图解析与回复走模型（右侧时间线会显示「LLM 解析」）'
    } else {
      Write-Note 'LLM 配置不完整（三项需同时非空）：将以「规则解析 + 模板回复」运行，功能完整可用。'
      Write-Note '要演示降级路径，这正是期望状态；要演示模型路径，请补齐 .env.local 里的三项后重启。'
    }
  }

  # ---------- 4. 端口占用 ----------
  if (Test-PortListening $port) {
    Write-Note "端口 $port 已被占用：很可能已有一个 dev server 在运行，本次不重复启动。"
    Write-Step "打开已有服务：$url"
    Start-Process $url
    exit 0
  }

  # ---------- 5. 启动并等待就绪后打开浏览器 ----------
  Write-Step "启动开发服务器：$url（在本窗口按 Ctrl+C 可停止）"
  Write-Step '首次访问会触发编译，通常需要十几秒；就绪后会自动打开浏览器。'

  # 后台轮询端口，就绪后再开浏览器：避免浏览器先打开看到「无法访问」
  Start-Job -ScriptBlock {
    param($targetUrl, $targetPort)
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Seconds 1
      $listening = Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue
      if ($listening) { Start-Process $targetUrl; break }
    }
  } -ArgumentList $url, $port | Out-Null

  npm run dev
}
catch {
  Write-Host ''
  Write-Host "[失败] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  Read-Host '按回车键关闭窗口'
  exit 1
}