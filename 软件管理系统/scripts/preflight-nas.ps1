[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$NasDataRoot,

  [string]$ApplicationRoot = (Split-Path -Parent $PSScriptRoot),

  [switch]$AllowWriteProbe,

  [string]$WriteProbeConfirmation = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$requiredBaseFiles = @("projects.json", "customers.json", "suppliers.json", "users.json", "settings.json")
$ledgerFiles = @(
  "inventory.json", "expenses.json", "processes.json", "todos.json", "product-templates.json",
  "settlement-batches.json", "invoices.json", "supplier-statements.json", "tax-reconciliations.json",
  "supplier-payments.json", "bank-transactions.json", "customer-receipts.json", "audit-log.json", "sessions.json"
)
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
  param([string]$Code, [ValidateSet("PASS", "WARN", "BLOCK")][string]$Status, [string]$Detail)
  $checks.Add([PSCustomObject]@{ Code = $Code; Status = $Status; Detail = $Detail })
}

function Stop-WithReport {
  param([string]$Code, [string]$Detail)
  Add-Check $Code "BLOCK" $Detail
  $checks | Format-Table -AutoSize | Out-String | Write-Output
  exit 2
}

Write-Output "企业项目收付款管理系统 4.0 · NAS 部署前检查"
Write-Output "检查时间：$([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz'))"
Write-Output "默认模式：只读（不会创建、修改或删除 NAS 文件）"

if (-not (Test-Path -LiteralPath $NasDataRoot -PathType Container)) {
  Stop-WithReport "DATA_ROOT" "无法访问数据目录：$NasDataRoot。请先在运行服务的 Windows 账号中连接 NAS 映射或改用 UNC 路径。"
}

$dataRoot = (Get-Item -LiteralPath $NasDataRoot).FullName.TrimEnd("\", "/")
$appRoot = (Get-Item -LiteralPath $ApplicationRoot).FullName.TrimEnd("\", "/")
Add-Check "DATA_ROOT" "PASS" "数据目录可读：$dataRoot"

$serverLock = Join-Path $dataRoot ".epm4-server-lock"
if (Test-Path -LiteralPath $serverLock) {
  $ownerText = "锁信息不可读"
  try {
    $owner = Get-Content -LiteralPath (Join-Path $serverLock "owner.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $ownerText = "主机 $($owner.hostname)，进程 $($owner.pid)，启动于 $($owner.startedAt)"
  } catch {}
  Add-Check "SINGLE_HOST_LOCK" "BLOCK" "检测到4.0服务锁（$ownerText）。预检和正式切换前必须先停止现有服务；不得直接启动第二台主机。"
} else {
  Add-Check "SINGLE_HOST_LOCK" "PASS" "未检测到正在使用此数据目录的4.0服务。"
}

if ($appRoot.StartsWith($dataRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $appRoot.Equals($dataRoot, [StringComparison]::OrdinalIgnoreCase)) {
  Add-Check "CODE_DATA_SEPARATION" "BLOCK" "应用程序目录不能放在业务数据目录内；代码应部署在唯一主机本地磁盘。"
} else {
  Add-Check "CODE_DATA_SEPARATION" "PASS" "应用程序与业务数据目录已分离。"
}

foreach ($name in $requiredBaseFiles) {
  $target = Join-Path $dataRoot $name
  if (Test-Path -LiteralPath $target -PathType Leaf) { Add-Check "BASE_FILE" "PASS" $name }
  else { Add-Check "BASE_FILE" "BLOCK" "缺少 3.0 基线文件：$name" }
}

foreach ($name in $ledgerFiles) {
  $target = Join-Path $dataRoot $name
  if (Test-Path -LiteralPath $target -PathType Leaf) { Add-Check "V4_FILE" "PASS" $name }
  else { Add-Check "V4_FILE" "WARN" "尚无 $name；首次正式启动会创建空账本，部署前完整备份中不会包含该文件。" }
}

$jsonNames = @($requiredBaseFiles + $ledgerFiles | Select-Object -Unique)
foreach ($name in $jsonNames) {
  $target = Join-Path $dataRoot $name
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue }
  try {
    $raw = Get-Content -LiteralPath $target -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { throw "文件为空" }
    $parsed = $raw | ConvertFrom-Json
    if ($name -ne "settings.json" -and -not $raw.TrimStart().StartsWith("[")) { throw "顶层必须是数组" }
    $count = if ($name -eq "settings.json") { 1 } else { @($parsed).Count }
    $digest = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.Substring(0, 12)
    Add-Check "JSON" "PASS" "$name：$count 条，SHA256 $digest…"
  } catch {
    Add-Check "JSON" "BLOCK" "$name 无法解析：$($_.Exception.Message)"
  }
}

try {
  $settingsPath = Join-Path $dataRoot "settings.json"
  $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $archiveRoot = [string]$settings.archiveRoot
  if ([string]::IsNullOrWhiteSpace($archiveRoot)) {
    Add-Check "ARCHIVE_ROOT" "BLOCK" "settings.json 未配置 archiveRoot。"
  } elseif (Test-Path -LiteralPath $archiveRoot -PathType Container) {
    Add-Check "ARCHIVE_ROOT" "PASS" "项目附件目录可读：$archiveRoot"
  } else {
    Add-Check "ARCHIVE_ROOT" "BLOCK" "项目附件目录在当前主机不可访问：$archiveRoot"
  }
} catch {
  Add-Check "ARCHIVE_ROOT" "BLOCK" "无法检查附件目录：$($_.Exception.Message)"
}

try {
  $acl = Get-Acl -LiteralPath $dataRoot
  $unsafe = @($acl.Access | Where-Object {
    $_.AccessControlType -eq "Allow" -and
    $_.IdentityReference.Value -match "(^|\\)(Everyone|Everyone)$|S-1-1-0" -and
    ($_.FileSystemRights.ToString() -match "Write|Modify|FullControl")
  })
  if ($unsafe.Count) { Add-Check "ACL" "BLOCK" "数据目录允许 Everyone 写入；应改为专用服务账号与授权员工组。" }
  else { Add-Check "ACL" "PASS" "未发现 Everyone 写权限；仍需在 NAS 管理界面复核共享层权限。" }
} catch {
  Add-Check "ACL" "WARN" "Windows 无法读取 ACL：$($_.Exception.Message)。必须在 NAS 管理界面人工复核。"
}

try {
  $driveName = (Split-Path -Qualifier $dataRoot).TrimEnd(":")
  $drive = if ($driveName) { Get-PSDrive -Name $driveName -ErrorAction Stop } else { $null }
  if ($drive -and $null -ne $drive.Free) {
    $freeGb = [Math]::Round($drive.Free / 1GB, 2)
    if ($freeGb -lt 1) { Add-Check "FREE_SPACE" "BLOCK" "可用空间仅 $freeGb GB。" }
    elseif ($freeGb -lt 5) { Add-Check "FREE_SPACE" "WARN" "可用空间仅 $freeGb GB，完整备份和恢复可能不足。" }
    else { Add-Check "FREE_SPACE" "PASS" "可用空间 $freeGb GB。" }
  } else { Add-Check "FREE_SPACE" "WARN" "无法从当前路径读取 NAS 可用空间，需在 NAS 管理界面确认至少保留 5 GB。" }
} catch {
  Add-Check "FREE_SPACE" "WARN" "无法读取 NAS 可用空间，需在 NAS 管理界面确认至少保留 5 GB。"
}

if ($AllowWriteProbe) {
  $requiredText = "我确认对NAS执行可删除写入测试"
  if ($WriteProbeConfirmation -cne $requiredText) {
    Add-Check "WRITE_PROBE" "BLOCK" "写入探测已拒绝：必须同时传入 -WriteProbeConfirmation '$requiredText'。"
  } else {
    $probe = Join-Path $dataRoot (".__epm4-write-probe-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
      [IO.File]::WriteAllText($probe, "epm4 write probe", [Text.UTF8Encoding]::new($false))
      Remove-Item -LiteralPath $probe -Force
      Add-Check "WRITE_PROBE" "PASS" "专用服务账号可创建并删除探测文件。"
    } catch {
      if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
      Add-Check "WRITE_PROBE" "BLOCK" "写入/删除探测失败：$($_.Exception.Message)"
    }
  }
} else {
  Add-Check "WRITE_PROBE" "WARN" "未执行写入探测；正式切换前需在明确授权后单独执行。"
}

Write-Output ""
$checks | Format-Table -AutoSize -Wrap | Out-String | Write-Output
$blocked = @($checks | Where-Object Status -eq "BLOCK").Count
$warnings = @($checks | Where-Object Status -eq "WARN").Count
Write-Output "结论：阻断 $blocked 项，提醒 $warnings 项。"
if ($blocked) { exit 2 }
exit 0
