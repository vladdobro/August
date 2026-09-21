; Custom NSIS installer pages for August (AUG-119).
; Adds a model-storage directory chooser as the first installer page.
; Uses customWelcomePage (not customHeader) because electron-builder calls
; customHeader AFTER MUI_LANGUAGE, which forbids MUI_PAGE_* macros.

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL ModelDir
!endif

!macro customWelcomePage
  !define MUI_PAGE_HEADER_TEXT "Welcome to August Setup"
  !define MUI_PAGE_HEADER_SUBTEXT "Choose where to store the AI speech model"
  !define MUI_DIRECTORYPAGE_TEXT_TOP "August uses a speech recognition model (~900 MB) that will be$\r$\ndownloaded on first launch. Choose a folder with at least 1 GB of free space."
  !define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Model storage folder"
  !define MUI_DIRECTORYPAGE_VARIABLE $ModelDir
  !insertmacro MUI_PAGE_DIRECTORY
!macroend

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
