; Custom NSIS installer pages for August (AUG-119, AUG-130, AUG-141).
; Adds a model-storage directory chooser and a GPU engine chooser as installer pages.
; Uses customPageAfterChangeDir (not customHeader, which electron-builder expands AFTER MUI_LANGUAGE where
; MUI_PAGE_* macros are forbidden). The pages come after the install-mode page on purpose: choosing
; "all users" relaunches the installer elevated and that process restarts the page flow, so anything
; shown before the install-mode page would be asked twice (AUG-141).
; Updates (electron-updater runs the installer with --updated, usually also /S) skip both pages and keep
; the choices from the first install: customInit re-reads model-dir / gpu-engine before customInstall persists them.
; User data (AUG-158): <install dir>\data holds sessions, uploads, preferences and the .env with API keys.
; This version's uninstaller (customRemoveFiles) keeps it on updates/reinstalls and silent uninstalls and asks
; on a manual uninstall. Uninstallers up to 0.0.40 wipe the whole folder, so before they run the installer
; renames data to a sibling "<install dir>-data-backup" folder (same volume, atomic) and customInstall moves it
; back. A KeepsUserData registry marker tells the next installer the old uninstaller is safe. A backup that
; cannot be moved back is left in place, never deleted.

!include nsDialogs.nsh
!include FileFunc.nsh

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL ModelDir
  Var /GLOBAL GpuEngine
  Var /GLOBAL AugOldInstDir
  Var /GLOBAL AugDataBackup
!endif

; Legacy uninstallers (<= 0.0.40, no KeepsUserData marker) run RMDir /r on their install folder and delete the
; CUDA engine. Move both aside first; customInstall (augRestoreUserData + the CUDA block) brings them back.
; Silent runs call this from customInit, interactive runs from augInstFilesPre (after the last cancellable page).
!macro augBackupUserData
  Push $R0
  Push $R1
  Push $R2
  StrCpy $AugDataBackup ""
  StrCpy $AugOldInstDir ""
  StrCpy $R1 ""
  ReadRegStr $AugOldInstDir SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepsUserData
  ${if} $AugOldInstDir == ""
    ReadRegStr $AugOldInstDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" KeepsUserData
  ${endIf}
  ${if} $AugOldInstDir == ""
    ReadRegStr $AugOldInstDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $R1 HKLM "${INSTALL_REGISTRY_KEY}" KeepsUserData
  ${endIf}
  StrLen $R2 $AugOldInstDir
  ; A drive root has no sibling folder to move data into.
  ${if} $R1 != "1"
  ${andIf} $R2 > 3
    ${if} ${FileExists} "$AugOldInstDir\data\*.*"
      ; Never reuse a backup left by an earlier failed run.
      StrCpy $AugDataBackup "$AugOldInstDir-data-backup"
      StrCpy $R2 1
      ${While} ${FileExists} "$AugDataBackup\*.*"
        IntOp $R2 $R2 + 1
        StrCpy $AugDataBackup "$AugOldInstDir-data-backup-$R2"
      ${EndWhile}
      ${Do}
        ; The app's server may still be exiting after quitAndInstall; give it up to ~10 s to release files.
        StrCpy $R2 0
        ${Do}
          ClearErrors
          Rename "$AugOldInstDir\data" "$AugDataBackup"
          ${IfNot} ${Errors}
            ${Break}
          ${EndIf}
          IntOp $R2 $R2 + 1
          ${If} $R2 >= 10
            ${Break}
          ${EndIf}
          Sleep 1000
        ${Loop}
        ${IfNot} ${FileExists} "$AugOldInstDir\data\*.*"
          ${Break}
        ${EndIf}
        ; Nothing has been changed yet, so stopping here is safe. Silent updates stop and keep the old version.
        ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "August could not move your sessions and settings aside before replacing the old version:$\r$\n$AugOldInstDir\data$\r$\n$\r$\nClose August and any program using that folder, then click Retry. Cancel stops the installation without changing anything." /SD IDCANCEL IDCANCEL`
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${Loop}
    ${endIf}

    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    ${if} ${FileExists} "$APPDATA\August\whisper\bin\win-x64-cuda\*.*"
    ${andIfNot} ${FileExists} "$APPDATA\August\whisper\win-x64-cuda.update-backup\*.*"
      Rename "$APPDATA\August\whisper\bin\win-x64-cuda" "$APPDATA\August\whisper\win-x64-cuda.update-backup"
    ${endIf}
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; Runs in customInstall, after the new files (including data\tools) are in place. The user's folder comes back
; whole, then every installer-shipped entry of the fresh data folder replaces its old copy.
!macro augRestoreUserData
  ${if} $AugDataBackup != ""
  ${andIf} ${FileExists} "$AugDataBackup\*.*"
    Push $R0
    Push $R1
    Push $R2
    StrCpy $R2 "ok"
    RMDir /r "$INSTDIR\data.new"
    ${if} ${FileExists} "$INSTDIR\data\*.*"
      ClearErrors
      Rename "$INSTDIR\data" "$INSTDIR\data.new"
      ${if} ${Errors}
        StrCpy $R2 "fail"
      ${endIf}
    ${endIf}
    ${if} $R2 == "ok"
      ClearErrors
      Rename "$AugDataBackup" "$INSTDIR\data"
      ${if} ${Errors}
        StrCpy $R2 "fail"
      ${endIf}
    ${endIf}
    ${if} $R2 == "fail"
      ${if} ${FileExists} "$INSTDIR\data.new\*.*"
      ${andIfNot} ${FileExists} "$INSTDIR\data\*.*"
        Rename "$INSTDIR\data.new" "$INSTDIR\data"
      ${endIf}
      DetailPrint "Could not move $AugDataBackup back to $INSTDIR\data; it was left in place."
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "August kept your sessions and settings in:$\r$\n$AugDataBackup$\r$\n$\r$\nbut could not move them back into $INSTDIR\data. Close August and move the contents of that folder into $INSTDIR\data by hand."
      ${endIf}
    ${else}
      FindFirst $R0 $R1 "$INSTDIR\data.new\*.*"
      ${While} $R1 != ""
        ${if} $R1 != "."
        ${andIf} $R1 != ".."
          ${if} ${FileExists} "$INSTDIR\data.new\$R1\*.*"
            RMDir /r "$INSTDIR\data\$R1"
          ${else}
            Delete "$INSTDIR\data\$R1"
          ${endIf}
          ClearErrors
          Rename "$INSTDIR\data.new\$R1" "$INSTDIR\data\$R1"
          ${if} ${Errors}
            CopyFiles /SILENT "$INSTDIR\data.new\$R1" "$INSTDIR\data"
          ${endIf}
        ${endIf}
        FindNext $R0 $R1
      ${EndWhile}
      FindClose $R0
      RMDir /r "$INSTDIR\data.new"
    ${endIf}
    Pop $R2
    Pop $R1
    Pop $R0
  ${endIf}
!macroend

; Both pages are shown after electron-builder's install-mode and install-folder pages.
!macro customPageAfterChangeDir
  ; electron-builder leaves "MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre" pending for its INSTFILES page.
  ; Take it off so our directory page does not consume it, and put it back once our pages are declared.
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif

  ; --- Page 1: model storage directory ---
  !define MUI_PAGE_HEADER_TEXT "August Setup"
  !define MUI_PAGE_HEADER_SUBTEXT "Choose where to store the AI speech model"
  !define MUI_DIRECTORYPAGE_TEXT_TOP "August uses a speech recognition model (~900 MB) that will be$\r$\ndownloaded on first launch. Choose a folder with at least 1 GB of free space."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Model storage folder"
  !define MUI_DIRECTORYPAGE_VARIABLE $ModelDir
  !insertmacro skipPageIfUpdated
  !insertmacro MUI_PAGE_DIRECTORY

  ; --- Page 2: GPU engine selection ---
  Page custom augGpuPageCreate augGpuPageLeave

  ; Our INSTFILES pre-function: electron-builder's instFilesPre (folder sanitising) first, then the legacy data
  ; backup — after every page that can still be cancelled, before the old uninstaller runs.
  !define MUI_PAGE_CUSTOMFUNCTION_PRE augInstFilesPre
  Function augInstFilesPre
    !ifdef allowToChangeInstallationDirectory
      Call instFilesPre
    !endif
    !insertmacro augBackupUserData
  FunctionEnd
!macroend

; An "all users" install switches the shell context to "all", which turns $APPDATA into
; C:\ProgramData. Electron's userData is always the per-user roaming folder, so every
; $APPDATA access below runs in the "current" context (same trick as electron-builder's own
; uninstaller) and then restores the install mode's context.

!macro customInit
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  StrCpy $ModelDir "$APPDATA\August\whisper\models"
  StrCpy $GpuEngine "cpu"
  ; Keep the choices of a previous install (updates skip the pages, so these are what customInstall persists).
  ClearErrors
  FileOpen $0 "$APPDATA\August\model-dir" r
  ${ifNot} ${Errors}
    FileRead $0 $1
    FileClose $0
    ${if} $1 != ""
      StrCpy $ModelDir $1
    ${endIf}
  ${endIf}
  ClearErrors
  FileOpen $0 "$APPDATA\August\gpu-engine" r
  ${ifNot} ${Errors}
    FileRead $0 $1
    FileClose $0
    ${if} $1 == "cuda"
      StrCpy $GpuEngine "cuda"
    ${endIf}
  ${endIf}
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
  ; Silent runs (electron-updater) show no pages, so the legacy data backup happens here. An unelevated silent
  ; update of an "all users" install relaunches itself elevated from the install section; only that copy moves data.
  ${if} ${Silent}
    ${if} $hasPerMachineInstallation != "1"
    ${orIf} ${UAC_IsAdmin}
      !insertmacro augBackupUserData
    ${endIf}
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
Function augGpuPageCreate
  ; Updates keep the engine chosen at first install (see customInit). electron-builder's ${isUpdated}
  ; needs the StdUtils plugin, which is not loaded yet where this file is included, so test --updated directly.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  ${ifNot} ${Errors}
    Abort
  ${endIf}
  nsDialogs::Create 1018
  Pop $0
  ${if} $0 == error
    Abort
  ${endif}

  ${NSD_CreateLabel} 0 0 100% 24u "August can transcribe using the CPU (works everywhere) or an NVIDIA GPU$\r$\n(much faster, requires an NVIDIA graphics card with recent drivers)."
  Pop $0

  ${NSD_CreateRadioButton} 10u 32u 100% 12u "CPU (default — works on any computer)"
  Pop $1
  ${NSD_SetState} $1 ${BST_CHECKED}

  ${NSD_CreateRadioButton} 10u 48u 100% 12u "GPU — NVIDIA (CUDA, downloads ~450 MB on first launch)"
  Pop $2

  nsDialogs::Show
FunctionEnd

Function augGpuPageLeave
  ${NSD_GetState} $2 $0
  ${if} $0 == ${BST_CHECKED}
    StrCpy $GpuEngine "cuda"
  ${else}
    StrCpy $GpuEngine "cpu"
  ${endif}
FunctionEnd
!endif

!macro customInstall
  !insertmacro augRestoreUserData

  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}

  ; --- Persist model directory ---
  StrCpy $2 "$APPDATA\August\model-dir"
  CreateDirectory "$APPDATA\August"
  ClearErrors
  FileOpen $0 $2 w
  ${ifNot} ${Errors}
    FileWrite $0 $ModelDir
    FileClose $0
  ${endIf}
  StrCpy $1 ""
  ClearErrors
  FileOpen $0 $2 r
  ${ifNot} ${Errors}
    FileRead $0 $1
    FileClose $0
  ${endIf}

  ; --- Persist GPU engine choice ---
  StrCpy $3 "$APPDATA\August\gpu-engine"
  ClearErrors
  FileOpen $0 $3 w
  ${ifNot} ${Errors}
    FileWrite $0 $GpuEngine
    FileClose $0
  ${endIf}
  StrCpy $4 ""
  ClearErrors
  FileOpen $0 $3 r
  ${ifNot} ${Errors}
    FileRead $0 $4
    FileClose $0
  ${endIf}

  ; --- Return the CUDA engine moved aside for a legacy uninstaller (augBackupUserData) ---
  ${if} ${FileExists} "$APPDATA\August\whisper\win-x64-cuda.update-backup\*.*"
  ${andIfNot} ${FileExists} "$APPDATA\August\whisper\bin\win-x64-cuda\*.*"
    CreateDirectory "$APPDATA\August\whisper\bin"
    Rename "$APPDATA\August\whisper\win-x64-cuda.update-backup" "$APPDATA\August\whisper\bin\win-x64-cuda"
  ${endIf}

  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  ; Pre-create the target so the downloader doesn't have to.
  CreateDirectory $ModelDir
  ${ifNot} ${FileExists} "$ModelDir\*.*"
  ${orIf} $1 != $ModelDir
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "August could not save the speech model folder you chose:$\r$\n$ModelDir$\r$\n$\r$\nThe model will be downloaded to the default location (%APPDATA%\August\whisper\models) instead. Use a folder path without special characters on a writable drive and reinstall to change it."
    ${endIf}
  ${endIf}

  ; Warn if GPU engine choice could not be saved
  ${if} $4 != $GpuEngine
    ${ifNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "August could not save the GPU engine choice. Transcription will use the CPU by default."
    ${endIf}
  ${endIf}

  ; Tells the next installer that this version's uninstaller keeps <install dir>\data (see augBackupUserData).
  WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepsUserData "1"
!macroend

; The ~900 MB speech model is useless without the app, so a manual uninstall offers to remove it.
; Updates/reinstalls (the old uninstaller runs with --updated) and silent uninstalls keep it, so the
; next version finds the model in place instead of downloading it again. Updates also keep the first-install
; choices (model-dir, gpu-engine) and the downloaded CUDA engine (~642 MB, AUG-158).
!macro customUnInstall
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    Push $R0
    Push $R1
    Push $R2
    StrCpy $R0 "$APPDATA\August\whisper\models"
    ClearErrors
    FileOpen $R1 "$APPDATA\August\model-dir" r
    ${ifNot} ${Errors}
      FileRead $R1 $R2
      FileClose $R1
      ${if} $R2 != ""
        StrCpy $R0 $R2
      ${endIf}
    ${endIf}
    ${if} ${FileExists} "$R0\ggml-large-v3-turbo-q8_0.bin"
    ${orIf} ${FileExists} "$R0\ggml-large-v3-turbo-q8_0.bin.part"
      MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the downloaded speech model (about 900 MB)?$\r$\n$R0" /SD IDNO IDYES augRemoveModel IDNO augKeepModel
      augRemoveModel:
        Delete "$R0\ggml-large-v3-turbo-q8_0.bin"
        Delete "$R0\ggml-large-v3-turbo-q8_0.bin.part"
        RMDir "$R0"
        RMDir "$APPDATA\August\whisper"
      augKeepModel:
    ${endIf}
    Pop $R2
    Pop $R1
    Pop $R0
  ${endIf}
  ${ifNot} ${isUpdated}
    Delete "$APPDATA\August\model-dir"
    Delete "$APPDATA\August\gpu-engine"
    ; Remove downloaded CUDA files if present
    RMDir /r "$APPDATA\August\whisper\bin\win-x64-cuda"
    RMDir /r "$APPDATA\August\whisper\win-x64-cuda.update-backup"
    RMDir "$APPDATA\August\whisper\bin"
  ${endIf}
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

; Replaces electron-builder's default file removal (RMDir /r $INSTDIR), which wiped <install dir>\data on every
; update (AUG-158). Updates/reinstalls (--updated) and silent uninstalls keep data; a manual uninstall asks,
; defaulting to keep.
!macro customRemoveFiles
  Push $R0
  Push $R1
  Push $R2
  StrCpy $R2 "keep"
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
  ${andIf} ${FileExists} "$INSTDIR\data\*.*"
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove your recordings, transcripts and settings (including API keys)?$\r$\n$INSTDIR\data" /SD IDNO IDYES`
      StrCpy $R2 "remove"
    ${EndIf}
  ${endIf}
  ; Move out of $INSTDIR so it can be removed
  SetOutPath $TEMP
  ${if} $R2 == "remove"
    RMDir /r $INSTDIR
  ${else}
    FindFirst $R0 $R1 "$INSTDIR\*.*"
    ${While} $R1 != ""
      ${if} $R1 != "."
      ${andIf} $R1 != ".."
      ${andIf} $R1 != "data"
        ${if} ${FileExists} "$INSTDIR\$R1\*.*"
          RMDir /r "$INSTDIR\$R1"
        ${else}
          Delete "$INSTDIR\$R1"
        ${endIf}
      ${endIf}
      FindNext $R0 $R1
    ${EndWhile}
    FindClose $R0
    ; Removes the folder only when there was no data to keep.
    RMDir $INSTDIR
  ${endIf}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
