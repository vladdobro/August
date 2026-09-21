; Custom NSIS installer pages for August (AUG-119).
; Adds a model-storage directory chooser before the standard app-directory page.

Var /GLOBAL ModelDir

!macro customHeader
  ; --- Model directory page (replaces the default Welcome page) ---
  !define MUI_PAGE_HEADER_TEXT "Welcome to August Setup"
  !define MUI_PAGE_HEADER_SUBTEXT "Choose where to store the AI speech model"
  !define MUI_DIRECTORYPAGE_TEXT_TOP "August uses a speech recognition model (~900 MB) that will be$\r$\ndownloaded on first launch. Choose a folder with at least 1 GB of free space."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Model storage folder"
  !define MUI_DIRECTORYPAGE_VARIABLE $ModelDir
  !insertmacro MUI_PAGE_DIRECTORY

  ; Skip the default MUI Welcome page — the model-dir page above is the first thing the user sees.
  !define MUI_PAGE_CUSTOMFUNCTION_PRE welcomeSkip
!macroend

Function welcomeSkip
  Abort
FunctionEnd

!macro customInit
  StrCpy $ModelDir "$APPDATA\August\whisper\models"
!macroend

!macro customInstall
  ; Persist the chosen model directory for the Electron main process.
  CreateDirectory "$APPDATA\August"
  FileOpen $0 "$APPDATA\August\model-dir" w
  FileWrite $0 $ModelDir
  FileClose $0
  ; Pre-create the target so the downloader doesn't have to.
  CreateDirectory $ModelDir
!macroend

!macro customUnInstall
  Delete "$APPDATA\August\model-dir"
!macroend
