[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$NasDataRoot,

  [string]$Confirmation = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$requiredText = "我确认所有4.0服务均已停止并清理遗留锁"

if (-not (Test-Path -LiteralPath $NasDataRoot -PathType Container)) { throw "业务数据目录不可访问：$NasDataRoot" }
$dataRoot = (Get-Item -LiteralPath $NasDataRoot).FullName.TrimEnd("\", "/")
$lockDir = Join-Path $dataRoot ".epm4-server-lock"
if (-not (Test-Path -LiteralPath $lockDir -PathType Container)) { Write-Output "没有遗留锁，无需清理。"; exit 0 }

$lockInfo = Get-Item -LiteralPath $lockDir -Force
if (($lockInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "锁路径是链接或重解析点，拒绝清理：$lockDir" }
$children = @(Get-ChildItem -LiteralPath $lockDir -Force)
if ($children.Count -ne 1 -or $children[0].Name -ne "owner.json" -or $children[0].PSIsContainer) { throw "锁目录包含非预期内容，拒绝清理：$lockDir" }

try {
  $owner = Get-Content -LiteralPath $children[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Output "遗留锁：主机 $($owner.hostname)，进程 $($owner.pid)，启动于 $($owner.startedAt)"
} catch {
  throw "owner.json 无法解析，拒绝自动清理：$($_.Exception.Message)"
}

if ($Confirmation -cne $requiredText) {
  Write-Output "未清理。确认所有主机上的4.0服务都已停止后，使用："
  Write-Output "-Confirmation '$requiredText'"
  exit 2
}

Remove-Item -LiteralPath $children[0].FullName -Force
Remove-Item -LiteralPath $lockDir -Force
Write-Output "遗留锁已清理；未修改任何业务 JSON 或附件。请重新运行只读预检。"
