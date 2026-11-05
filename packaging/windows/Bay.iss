#ifndef AppVersion
  #error AppVersion must be supplied
#endif
#ifndef StageDir
  #error StageDir must be supplied
#endif
#ifndef OutputDir
  #error OutputDir must be supplied
#endif
[Setup]
AppId={{C345791D-67B8-4C97-AB2B-D6DDE1F93B72}
AppName=Bay
AppVersion={#AppVersion}
AppPublisher=Bay
DefaultDirName={localappdata}\Programs\Bay
DefaultGroupName=Bay
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=Bay-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Bay.exe
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes
DisableProgramGroupPage=yes
#ifdef SignToolCommand
SignTool=bay
SignedUninstaller=yes
#endif
[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autoprograms}\Bay"; Filename: "{app}\Bay.exe"; AppUserModelID: "Bay.Browser"; AppUserModelToastActivatorCLSID: "0EA5371B-277F-5D11-90FB-F3047F2B4C73"
Name: "{autodesktop}\Bay"; Filename: "{app}\Bay.exe"; AppUserModelID: "Bay.Browser"; AppUserModelToastActivatorCLSID: "0EA5371B-277F-5D11-90FB-F3047F2B4C73"; Tasks: desktopicon
[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
[Registry]
Root: HKCU; Subkey: "Software\Classes\CLSID\{{0EA5371B-277F-5D11-90FB-F3047F2B4C73}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\CLSID\{{0EA5371B-277F-5D11-90FB-F3047F2B4C73}\LocalServer32"; ValueType: string; ValueData: """{app}\notification_helper.exe"""
Root: HKCU; Subkey: "Software\Classes\CLSID\{{0EA5371B-277F-5D11-90FB-F3047F2B4C73}\LocalServer32"; ValueType: string; ValueName: "ServerExecutable"; ValueData: "{app}\notification_helper.exe"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "Bay"; ValueData: "Software\Clients\StartMenuInternet\Bay\Capabilities"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay"; ValueType: string; ValueData: "Bay"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\DefaultIcon"; ValueType: string; ValueData: "{app}\Bay.exe,0"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\shell\open\command"; ValueType: string; ValueData: """{app}\Bay.exe"""
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Bay"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Browse the web with Bay"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\Bay.exe,0"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities\URLAssociations"; ValueType: string; ValueName: "http"; ValueData: "Bay.HTML"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities\URLAssociations"; ValueType: string; ValueName: "https"; ValueData: "Bay.HTML"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities\FileAssociations"; ValueType: string; ValueName: ".htm"; ValueData: "Bay.HTML"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities\FileAssociations"; ValueType: string; ValueName: ".html"; ValueData: "Bay.HTML"
Root: HKCU; Subkey: "Software\Clients\StartMenuInternet\Bay\Capabilities\FileAssociations"; ValueType: string; ValueName: ".pdf"; ValueData: "Bay.PDF"
Root: HKCU; Subkey: "Software\Classes\Bay.HTML"; ValueType: string; ValueData: "Bay HTML Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Bay.HTML"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Bay.HTML"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Bay.Browser"
Root: HKCU; Subkey: "Software\Classes\Bay.HTML\DefaultIcon"; ValueType: string; ValueData: "{app}\Bay.exe,0"
Root: HKCU; Subkey: "Software\Classes\Bay.HTML\shell\open\command"; ValueType: string; ValueData: """{app}\Bay.exe"" --single-argument ""%1"""
Root: HKCU; Subkey: "Software\Classes\Bay.HTML\Application"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Bay.Browser"
Root: HKCU; Subkey: "Software\Classes\Bay.HTML\Application"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Bay"
Root: HKCU; Subkey: "Software\Classes\Bay.HTML\Application"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Browse the web with Bay"
Root: HKCU; Subkey: "Software\Classes\Bay.HTML\Application"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\Bay.exe,0"
Root: HKCU; Subkey: "Software\Classes\Bay.PDF"; ValueType: string; ValueData: "Bay PDF Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Bay.PDF"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Bay.Browser"
Root: HKCU; Subkey: "Software\Classes\Bay.PDF\DefaultIcon"; ValueType: string; ValueData: "{app}\Bay.exe,0"
Root: HKCU; Subkey: "Software\Classes\Bay.PDF\shell\open\command"; ValueType: string; ValueData: """{app}\Bay.exe"" --single-argument ""%1"""
Root: HKCU; Subkey: "Software\Classes\Bay.PDF\Application"; ValueType: string; ValueName: "AppUserModelId"; ValueData: "Bay.Browser"
Root: HKCU; Subkey: "Software\Classes\Bay.PDF\Application"; ValueType: string; ValueName: "ApplicationName"; ValueData: "Bay"
Root: HKCU; Subkey: "Software\Classes\Bay.PDF\Application"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Browse the web with Bay"
Root: HKCU; Subkey: "Software\Classes\Bay.PDF\Application"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\Bay.exe,0"
Root: HKCU; Subkey: "Software\Classes\Applications\Bay.exe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\Bay.exe\shell\open\command"; ValueType: string; ValueData: """{app}\Bay.exe"" --single-argument ""%1"""
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\Bay.exe"; ValueType: string; ValueData: "{app}\Bay.exe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\Bay.exe"; ValueType: string; ValueName: "Path"; ValueData: "{app}"
Root: HKCU; Subkey: "Software\Classes\.html\OpenWithProgids"; ValueType: string; ValueName: "Bay.HTML"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.htm\OpenWithProgids"; ValueType: string; ValueName: "Bay.HTML"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: string; ValueName: "Bay.PDF"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\AppUserModelId\Bay.Browser"; ValueType: string; ValueName: "DisplayName"; ValueData: "Bay"; Flags: uninsdeletekey
[Run]
Filename: "{app}\Bay.exe"; Description: "Open Bay"; Flags: nowait postinstall skipifsilent
