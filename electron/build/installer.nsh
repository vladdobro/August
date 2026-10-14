; Custom NSIS installer pages for August (AUG-119, AUG-130).
; Adds a model-storage directory chooser and a GPU engine chooser as installer pages.
; Uses customWelcomePage (not customHeader) because electron-builder calls
; customHeader AFTER MUI_LANGUAGE, which forbids MUI_PAGE_* macros.

!include nsDialogs.nsh

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL ModelDir
  Var /GLOBAL GpuEngine
!endif

; --- Page 1: model storage directory ---
!macro customWelcomePage
  !define MUI_PAGE_HEADER_TEXT "Welcome to August Setup"
  !define MUI_PAGE_HEADER_SUBTEXT "Choose where to store the AI speech model"
  !define MUI_DIRECTORYPAGE_TEXT_TOP "August uses a speech recognition model (~900 MB) that will be$\r$\ndownloaded on first launch. Choose a folder with at least 1 GB of free space."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Model storage folder"
  !define MUI_DIRECTORYPAGE_VARIABLE $ModelDir
  !insertmacro MUI_PAGE_DIRECTORY

  ; --- Page 2: GPU engine selection ---
  Page custom augGpuPageCreate augGpuPageLeave
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
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!ifndef BUILD_UNINSTALLER
Function augGpuPageCreate
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
!macroend

; The ~900 MB speech model is useless without the app, so a manual uninstall offers to remove it.
; Updates/reinstalls (the old uninstaller runs with --updated) and silent uninstalls keep it, so the
; next version finds the model in place instead of downloading it again.
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
  Delete "$APPDATA\August\model-dir"
  Delete "$APPDATA\August\gpu-engine"
  ; Remove downloaded CUDA files if present
  RMDir /r "$APPDATA\August\whisper\bin\win-x64-cuda"
  RMDir "$APPDATA\August\whisper\bin"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend
