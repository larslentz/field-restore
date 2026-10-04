Unicode true
RequestExecutionLevel user
Name "Field Restore"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Field Restore"
InstallDirRegKey HKCU "Software\Field Restore" "InstallLocation"
SetCompressor /SOLID lzma
SetCompressorDictSize 64
!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Field Restore.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "Field Restore"
VIAddVersionKey "FileDescription" "Field Restore offline installer (unsigned)"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "Field Restore"
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Field Restore requires 64-bit Windows 10 or Windows 11."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Field Restore requires Windows 10 or Windows 11."
    Abort
  ${EndIf}
  FindWindow $0 "" "Field Restore"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Save your work, finish exports, and close Field Restore before installing an update."
    Abort
  ${EndIf}
FunctionEnd
Section "Field Restore" Main
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}/*"
  WriteUninstaller "$INSTDIR\Uninstall Field Restore.exe"
  CreateDirectory "$SMPROGRAMS\Field Restore"
  CreateShortcut "$SMPROGRAMS\Field Restore\Field Restore.lnk" "$INSTDIR\Field Restore.exe"
  CreateShortcut "$DESKTOP\Field Restore.lnk" "$INSTDIR\Field Restore.exe"
  WriteRegStr HKCU "Software\Field Restore" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Field Restore" "DisplayName" "Field Restore"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Field Restore" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Field Restore" "DisplayIcon" "$INSTDIR\Field Restore.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Field Restore" "UninstallString" '$\"$INSTDIR\Uninstall Field Restore.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Field Restore" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Field Restore" "NoRepair" 1
SectionEnd
Function un.onInit
  FindWindow $0 "" "Field Restore"
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Close Field Restore before uninstalling."
    Abort
  ${EndIf}
FunctionEnd
Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Field Restore.lnk"
  Delete "$SMPROGRAMS\Field Restore\Field Restore.lnk"
  RMDir "$SMPROGRAMS\Field Restore"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Field Restore"
  DeleteRegKey HKCU "Software\Field Restore"
  !include "${UNINSTALL_INCLUDE}"
  Delete "$INSTDIR\Uninstall Field Restore.exe"
  RMDir "$INSTDIR"
  ; Intentionally retain %APPDATA%\Field Restore projects and settings.
SectionEnd