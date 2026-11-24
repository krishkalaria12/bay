#!/usr/bin/env python3
"""Write Bay's winget manifests (version, installer and en-US locale) for one release.

    python scripts/windows/winget.py --installer dist/windows/Bay-X.Y.Z-windows-x64-setup.exe --version X.Y.Z \
        --output dist/windows/winget

The installer is the one on the GitHub release windows-v<version>, which the manifest points winget at; its SHA-256 is
taken from the file. wingetcreate submits the folder to microsoft/winget-pkgs (scripts/windows/publish.py).
"""
import argparse
import datetime
import hashlib
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
INSTALLER_SCRIPT = REPO / 'packaging/windows/Bay.iss'
IDENTIFIER = 'BayBrowser.Bay'
MANIFEST_VERSION = '1.28.0'
GITHUB = 'krishkalaria12/bay'
SHORT_DESCRIPTION = 'A fast browser with your tabs in a sidebar'
DESCRIPTION = """\
Bay is a browser built around a sidebar. Favorites sit on top, pinned tabs and folders under them, and the day's tabs \
below. Spaces keep work and home apart, each with its own theme and its own sign-ins.
Built on Chromium, so sites and Chrome Web Store extensions work as they do in Chrome. Bay adds Peek and Split View, a \
command bar for addresses, searches and open tabs, built-in ad blocking with uBlock Origin Lite, and import from Arc, \
Chrome, Firefox, Brave and other browsers."""
TAGS = ('browser', 'chromium', 'web-browser', 'sidebar', 'tabs', 'ad-blocker')
# Plain YAML scalars that can't be read as anything but a string, a version with two dots or more, a hash with a
# letter in it, and the date winget-pkgs writes unquoted.
PLAIN = re.compile(r"[A-Za-z][A-Za-z0-9 ._/()+,'-]*|[A-Za-z][A-Za-z0-9+.-]*://[^\s#]+|\d+(?:\.\d+){2,}"
                   r'|[0-9A-F]*[A-F][0-9A-F]*|\d{4}-\d{2}-\d{2}')


# YAML 1.1 reads these as booleans or null.
RESERVED = {'y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null'}


def scalar(value):
    if PLAIN.fullmatch(value) and not value.endswith(' ') and value.lower() not in RESERVED:
        return value
    return "'" + value.replace("'", "''") + "'"


def render(schema, fields):
    """YAML in winget-pkgs' layout: a schema comment, then fields in order. A list is a block sequence, a tuple of
    pairs a mapping inside it, and a value with a newline a literal block."""
    lines = [f'# yaml-language-server: $schema=https://aka.ms/winget-manifest.{schema}.{MANIFEST_VERSION}.schema.json', '']

    def emit(key, value, indent):
        pad = ' ' * indent
        if isinstance(value, list):
            lines.append(f'{pad}{key}:')
            for item in value:
                if isinstance(item, tuple):
                    # A mapping in the list: its fields indented under the dash on its first line.
                    first = len(lines)
                    for name, inner in item:
                        emit(name, inner, indent + 2)
                    lines[first] = pad + '- ' + lines[first][len(pad) + 2:]
                else:
                    lines.append(f'{pad}- {scalar(item)}')
        elif '\n' in value:
            lines.append(f'{pad}{key}: |-')
            lines.extend(f'{pad}  {line}' if line else '' for line in value.split('\n'))
        else:
            lines.append(f'{pad}{key}: {scalar(value)}')

    for key, value in fields:
        emit(key, value, 0)
    return '\n'.join(lines) + '\n'


def product_code(script=INSTALLER_SCRIPT):
    """Inno's uninstall key: the installer's AppId (written {{GUID} in the script) with _is1."""
    match = re.search(r'^AppId=\{(\{[0-9A-F-]{36}\})$', script.read_text(), re.MULTILINE)
    if not match:
        raise ValueError(f'{script} has no AppId GUID')
    return match.group(1) + '_is1'


def manifests(version, sha256, url, release_date, code):
    common = [('PackageIdentifier', IDENTIFIER), ('PackageVersion', version)]
    release = f'https://github.com/{GITHUB}/releases/tag/{release_tag(version)}'
    return {
        f'{IDENTIFIER}.yaml': render('version', common + [
            ('DefaultLocale', 'en-US'), ('ManifestType', 'version'), ('ManifestVersion', MANIFEST_VERSION)]),
        f'{IDENTIFIER}.installer.yaml': render('installer', common + [
            ('InstallerType', 'inno'),
            # The installer is per user (PrivilegesRequired=lowest) and has no machine-wide mode.
            ('Scope', 'user'),
            ('InstallModes', ['interactive', 'silent', 'silentWithProgress']),
            ('UpgradeBehavior', 'install'),
            ('Protocols', ['http', 'https']),
            ('FileExtensions', ['htm', 'html', 'pdf']),
            ('ProductCode', code),
            ('ReleaseDate', release_date),
            ('AppsAndFeaturesEntries', [(('DisplayName', 'Bay'), ('Publisher', 'Bay'), ('ProductCode', code))]),
            ('Installers', [(('Architecture', 'x64'), ('InstallerUrl', url), ('InstallerSha256', sha256.upper()))]),
            ('ManifestType', 'installer'), ('ManifestVersion', MANIFEST_VERSION)]),
        f'{IDENTIFIER}.locale.en-US.yaml': render('defaultLocale', common + [
            ('PackageLocale', 'en-US'),
            # Bay.iss' AppPublisher, which Windows shows in Apps & features.
            ('Publisher', 'Bay'),
            ('PublisherUrl', 'https://baybrowser.in'),
            ('PublisherSupportUrl', f'https://github.com/{GITHUB}/issues'),
            ('Author', 'Krish Kalaria'),
            ('PackageName', 'Bay'),
            ('PackageUrl', 'https://baybrowser.in'),
            ('License', 'Apache-2.0'),
            ('LicenseUrl', f'https://github.com/{GITHUB}/blob/main/LICENSE'),
            ('ShortDescription', SHORT_DESCRIPTION),
            ('Description', DESCRIPTION),
            ('Moniker', 'bay'),
            ('Tags', list(TAGS)),
            ('ReleaseNotesUrl', release),
            ('ManifestType', 'defaultLocale'), ('ManifestVersion', MANIFEST_VERSION)]),
    }


def installer_name(version):
    """package.ps1's installer for a release version."""
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError(f'version must be X.Y.Z: {version}')
    return f'Bay-{version}-windows-x64-setup.exe'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as file:
        for block in iter(lambda: file.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def release_tag(version):
    """Windows has its own versions, apart from the Mac's v<version>, as Linux does with linux-v<version>."""
    return f'windows-v{version}'


def write(installer, version, output, release_date=None):
    name = installer_name(version)
    installer = pathlib.Path(installer)
    if installer.name != name:
        raise ValueError(f"{installer.name} isn't Bay {version}'s installer")
    url = f'https://github.com/{GITHUB}/releases/download/{release_tag(version)}/{name}'
    release_date = release_date or datetime.date.today().isoformat()
    output = pathlib.Path(output)
    output.mkdir(parents=True, exist_ok=True)
    for stale in output.glob('*.yaml'):
        stale.unlink()
    for filename, text in manifests(version, sha256(installer), url, release_date, product_code()).items():
        (output / filename).write_text(text, encoding='utf-8', newline='\n')
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--installer', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--release-date', help='YYYY-MM-DD, default today')
    args = parser.parse_args()
    try:
        print(write(args.installer, args.version, args.output, args.release_date))
    except (OSError, ValueError) as error:
        sys.exit(f'winget: {error}')


if __name__ == '__main__':
    main()
