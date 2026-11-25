#!/usr/bin/env python3
"""Turn package.ps1's staged app into an MSIX layout: AppxManifest.xml, the logos, and no self-updater.

    python scripts/windows/msix.py --stage <folder> --version X.Y.Z

The Microsoft Store signs and updates the package, so the in-app updater's script is left out. The identity comes from
Partner Center (Product identity): --name, --publisher (CN=...) and --publisher-display-name, or BAY_MSIX_NAME,
BAY_MSIX_PUBLISHER and BAY_MSIX_PUBLISHER_DISPLAY_NAME. The app's --display-name (BAY_MSIX_DISPLAY_NAME) must be a name
reserved there too. Until the app is reserved, the defaults below build a package for sideloading only.
"""
import argparse
import os
import pathlib
import re
import shutil
import sys
from xml.sax.saxutils import escape, quoteattr

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import winget

REPO = pathlib.Path(__file__).resolve().parents[2]
ASSETS = REPO / 'packaging/windows/msix/Assets'
INSTALLER_SCRIPT = REPO / 'packaging/windows/Bay.iss'
DEFAULT_NAME = 'BayBrowser.Bay'
DEFAULT_PUBLISHER = 'CN=BayBrowser'
DEFAULT_PUBLISHER_DISPLAY_NAME = 'Bay'
DEFAULT_DISPLAY_NAME = 'Bay'
# Windows 10 1809, the oldest Windows 10 Chromium still supports, to Windows 11 24H2.
MIN_VERSION = '10.0.17763.0'
MAX_VERSION_TESTED = '10.0.26100.0'
# Chromium's guard against a URL or file name being read as a switch, as the installer's ProgIDs pass it.
ARGUMENTS = '--single-argument "%1"'
FILE_TYPES = (('html', 'Bay HTML Document', ('.htm', '.html')), ('pdf', 'Bay PDF Document', ('.pdf',)))
# Starts Bay inside the package from outside it: web apps' shortcuts point here (chromium-bay-msix-win.patch).
ALIAS = 'baybrowser.exe'


def package_version(version):
    """MSIX versions have four parts and the Store rejects a package whose last isn't 0, so X.Y.Z becomes X.Y.Z.0."""
    parts = version.split('.')
    if parts[3:] == ['0']:
        parts = parts[:3]
    if len(parts) != 3 or not all(re.fullmatch(r'\d+', part) and int(part) <= 65535 for part in parts):
        raise ValueError(f'version must be X.Y.Z (or X.Y.Z.0), each part at most 65535: {version}')
    return '.'.join(str(int(part)) for part in parts) + '.0'


def toast_activator():
    """The notification helper's COM class, the one the installer's Start menu shortcut names."""
    match = re.search(r'AppUserModelToastActivatorCLSID: "([0-9A-F-]{36})"', INSTALLER_SCRIPT.read_text())
    if not match:
        raise ValueError(f'{INSTALLER_SCRIPT} has no toast activator CLSID')
    return match.group(1)


def check_identity(name, publisher, publisher_display_name, display_name):
    if not re.fullmatch(r'[A-Za-z0-9.-]{3,50}', name):
        raise ValueError(f'package name must be 3 to 50 letters, digits, dots or hyphens: {name}')
    if not re.fullmatch(r'CN=[^,]+(?:, ?[A-Z]+=[^,]+)*', publisher):
        raise ValueError(f'publisher must be a distinguished name starting with CN=: {publisher}')
    if not publisher_display_name.strip():
        raise ValueError('publisher display name is empty')
    if not display_name.strip():
        raise ValueError('display name is empty')


def manifest(version, name, publisher, publisher_display_name, clsid, display_name=DEFAULT_DISPLAY_NAME):
    check_identity(name, publisher, publisher_display_name, display_name)
    arguments = quoteattr(ARGUMENTS)
    protocols = ''.join(f"""
        <uap3:Extension Category="windows.protocol">
          <uap3:Protocol Name="{scheme}" Parameters={arguments}>
            <uap:DisplayName>Bay</uap:DisplayName>
          </uap3:Protocol>
        </uap3:Extension>""" for scheme in ('http', 'https'))
    file_types = ''
    for association, label, extensions in FILE_TYPES:
        supported = ''.join(f'<uap:FileType>{extension}</uap:FileType>' for extension in extensions)
        file_types += f"""
        <uap:Extension Category="windows.fileTypeAssociation">
          <uap3:FileTypeAssociation Name="{association}" Parameters={arguments}>
            <uap:DisplayName>{label}</uap:DisplayName>
            <uap:SupportedFileTypes>{supported}</uap:SupportedFileTypes>
          </uap3:FileTypeAssociation>
        </uap:Extension>"""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!-- Written by scripts/windows/msix.py. -->
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:com="http://schemas.microsoft.com/appx/manifest/com/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 desktop com rescap">
  <Identity Name={quoteattr(name)} Publisher={quoteattr(publisher)} Version="{package_version(version)}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>{escape(display_name)}</DisplayName>
    <PublisherDisplayName>{escape(publisher_display_name)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="{MIN_VERSION}" MaxVersionTested="{MAX_VERSION_TESTED}" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="Bay" Executable="Bay.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName={quoteattr(display_name)} Description={quoteattr(winget.SHORT_DESCRIPTION)} BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile ShortName="Bay" Wide310x150Logo="Assets\\Wide310x150Logo.png"
          Square71x71Logo="Assets\\Square71x71Logo.png" Square310x310Logo="Assets\\Square310x310Logo.png" />
      </uap:VisualElements>
      <Extensions>{protocols}{file_types}
        <uap3:Extension Category="windows.appExecutionAlias" Executable="Bay.exe" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias>
            <desktop:ExecutionAlias Alias="{ALIAS}" />
          </uap3:AppExecutionAlias>
        </uap3:Extension>
        <desktop:Extension Category="windows.toastNotificationActivation">
          <desktop:ToastNotificationActivation ToastActivatorCLSID="{clsid}" />
        </desktop:Extension>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:ExeServer Executable="notification_helper.exe" DisplayName="Bay notifications">
              <com:Class Id="{clsid}" DisplayName="Bay notifications" />
            </com:ExeServer>
          </com:ComServer>
        </com:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"""


def prepare(stage, version, name, publisher, publisher_display_name, display_name=DEFAULT_DISPLAY_NAME):
    stage = pathlib.Path(stage)
    if not (stage / 'Bay.exe').is_file() or not (stage / 'notification_helper.exe').is_file():
        raise ValueError(f'{stage} has no staged Bay.exe and notification_helper.exe')
    text = manifest(version, name, publisher, publisher_display_name, toast_activator(), display_name)
    (stage / 'AppxManifest.xml').write_text(text, encoding='utf-8', newline='\r\n')
    shutil.copytree(ASSETS, stage / 'Assets', dirs_exist_ok=True)
    (stage / 'update.ps1').unlink(missing_ok=True)
    return stage / 'AppxManifest.xml'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--stage', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--name', default=os.environ.get('BAY_MSIX_NAME') or DEFAULT_NAME)
    parser.add_argument('--publisher', default=os.environ.get('BAY_MSIX_PUBLISHER') or DEFAULT_PUBLISHER)
    parser.add_argument('--publisher-display-name',
                        default=os.environ.get('BAY_MSIX_PUBLISHER_DISPLAY_NAME') or DEFAULT_PUBLISHER_DISPLAY_NAME)
    parser.add_argument('--display-name', default=os.environ.get('BAY_MSIX_DISPLAY_NAME') or DEFAULT_DISPLAY_NAME)
    args = parser.parse_args()
    try:
        print(prepare(args.stage, args.version, args.name, args.publisher, args.publisher_display_name,
                      args.display_name))
    except (OSError, ValueError) as error:
        sys.exit(f'msix: {error}')


if __name__ == '__main__':
    main()
