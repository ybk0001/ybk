Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!ifndef PAYLOAD
!error "PAYLOAD is required"
!endif
Name "企业项目收付款管理 本地版（候选）"
OutFile "${OUTPUT}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\EnterpriseProjectManagerLocal"
SetCompressor /SOLID lzma
CRCCheck on
ShowInstDetails show
!define MUI_WELCOMEPAGE_TEXT "适用于3—5人团队，账本和附件保存在公司自己的电脑或NAS。$\r$\n$\r$\n这是商业化候选版。安装或升级前，请关闭本地版程序并导出完整备份。$\r$\n$\r$\n更新只安装程序，不上传资料、不下载组件、不重置账号或账本。现有3.0版本不受影响。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  FindWindow $0 "Chrome_WidgetWin_1" "企业项目收付款管理 本地版"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先关闭本地版程序，再安装更新。"
    Abort
  ${EndIf}
FunctionEnd

Section "安装本地版"
  ${If} ${FileExists} "$INSTDIR\versions\${VERSION}\installed.ini"
    MessageBox MB_OK|MB_ICONINFORMATION "此版本已经安装。请从桌面快捷方式打开，或使用更新版本的安装包。"
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR\versions\${VERSION}"
  ClearErrors
  File /r "${PAYLOAD}\*"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "程序文件写入失败。旧版快捷方式和业务数据未更改，请检查磁盘空间后重试。"
    Abort
  ${EndIf}
  WriteINIStr "$INSTDIR\versions\${VERSION}\installed.ini" "Product" "Version" "${VERSION}"
  WriteINIStr "$INSTDIR\installation.ini" "Product" "CurrentVersion" "${VERSION}"
  WriteUninstaller "$INSTDIR\卸载本地版.exe"
  CreateDirectory "$SMPROGRAMS\企业项目收付款管理 本地版"
  CreateShortcut "$DESKTOP\企业项目收付款管理 本地版（候选）.lnk" "$INSTDIR\versions\${VERSION}\企业项目收付款管理 本地版.exe"
  CreateShortcut "$SMPROGRAMS\企业项目收付款管理 本地版\打开本地版.lnk" "$INSTDIR\versions\${VERSION}\企业项目收付款管理 本地版.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EnterpriseProjectManagerLocal" "DisplayName" "企业项目收付款管理 本地版（候选）"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EnterpriseProjectManagerLocal" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EnterpriseProjectManagerLocal" "UninstallString" '$\"$INSTDIR\卸载本地版.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EnterpriseProjectManagerLocal" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EnterpriseProjectManagerLocal" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  ReadINIStr $0 "$INSTDIR\installation.ini" "Product" "CurrentVersion"
  ${If} $0 != "${VERSION}"
    MessageBox MB_OK|MB_ICONSTOP "当前版本与卸载程序不一致，请使用当前安装目录里的卸载程序。"
    Abort
  ${EndIf}
  ; Only this installer-owned version is removed. Business AppData and NAS are never touched.
  Delete "$DESKTOP\企业项目收付款管理 本地版（候选）.lnk"
  Delete "$SMPROGRAMS\企业项目收付款管理 本地版\打开本地版.lnk"
  RMDir "$SMPROGRAMS\企业项目收付款管理 本地版"
  RMDir /r "$INSTDIR\versions\${VERSION}"
  RMDir "$INSTDIR\versions"
  Delete "$INSTDIR\installation.ini"
  Delete "$INSTDIR\卸载本地版.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\EnterpriseProjectManagerLocal"
SectionEnd
