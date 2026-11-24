#!/usr/bin/env python3
"""Publish a Windows release: add the installer to the GitHub release windows-v<version> and submit it to winget.

    python scripts/windows/publish.py --release dist/windows --version X.Y.Z [--dry-run]

<release> is package.ps1's output (the windows-build workflow's bay-windows-release): the installer and its .sha256.
Windows has its own versions, apart from the Mac's v<version>, as Linux does.

1. creates the release windows-v<version> if it's missing, never as "latest", which the site's /download and the Mac
   appcast follow, and uploads Bay-<version>-windows-x64-setup.exe and its .sha256 to it. A published installer is
   never replaced: winget pins its SHA-256;
2. writes the winget manifests (scripts/windows/winget.py) into <release>/winget, pointing at that upload;
3. opens a pull request on microsoft/winget-pkgs with wingetcreate, unless it already has this version.

GH_TOKEN is the repository's token for the upload. WINGET_CREATE_GITHUB_TOKEN is a classic personal access token with
public_repo: wingetcreate forks winget-pkgs into its account and opens the pull request from there. --dry-run stops
after writing the manifests; it uploads nothing and needs neither token.
"""
import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import winget

REPO = pathlib.Path(__file__).resolve().parents[2]
WINGETCREATE_URL = 'https://github.com/microsoft/winget-create/releases/download/v1.28.1.0/wingetcreate.exe'
WINGETCREATE_SHA256 = '63d980ba79e97042395bd6eb5992c2db9e01e9e7a8a22958a95c288f27310413'


class PublishError(Exception):
    pass


def gh(*args, check=True):
    result = subprocess.run(['gh', *args], capture_output=True, text=True)
    if check and result.returncode:
        raise PublishError(f'gh {" ".join(args)}: {result.stderr.strip()}')
    return result


def check_release(release, version):
    """The installer and its checksum, as package.ps1 wrote them, agreeing with each other."""
    installer = release / winget.installer_name(version)
    checksum = installer.with_name(installer.name + '.sha256')
    for path in (installer, checksum):
        if not path.is_file():
            raise PublishError(f'{release} has no {path.name}: package it with package.ps1 -Version {version}')
    recorded = checksum.read_text(encoding='ascii').split()
    if recorded != [winget.sha256(installer), installer.name]:
        raise PublishError(f"{checksum.name} doesn't match {installer.name}")
    return installer, checksum


def winget_has(version):
    identifier = winget.IDENTIFIER
    path = f'repos/microsoft/winget-pkgs/contents/manifests/{identifier[0].lower()}/{identifier.replace(".", "/")}/{version}'
    result = gh('api', path, '--silent', check=False)
    if result.returncode and 'Not Found' not in result.stderr:
        raise PublishError(f'checking winget-pkgs for {version}: {result.stderr.strip()}')
    return result.returncode == 0


def wingetcreate(directory):
    """The pinned standalone wingetcreate.exe, checked against its published SHA-256."""
    target = pathlib.Path(directory) / 'wingetcreate.exe'
    with urllib.request.urlopen(WINGETCREATE_URL, timeout=120) as response, open(target, 'wb') as file:
        shutil.copyfileobj(response, file)
    if winget.sha256(target) != WINGETCREATE_SHA256:
        raise PublishError(f'{WINGETCREATE_URL} has an unexpected SHA-256')
    return target


def create_release(tag, version, release):
    notes = REPO / f'release-notes/windows/{version}.md'
    if not notes.is_file():
        notes = release / 'notes.md'
        notes.write_text(f'Bay {version} for Windows. Install it with `winget install {winget.IDENTIFIER}`.\n',
                         encoding='utf-8')
    target = os.environ.get('GITHUB_SHA') or subprocess.run(
        ['git', '-C', str(REPO), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    gh('release', 'create', tag, '-R', winget.GITHUB, '--latest=false', '--target', target,
       '--title', f'Bay {version} for Windows', '--notes-file', str(notes))


def publish(release, version, dry_run):
    release = pathlib.Path(release).resolve()
    installer, checksum = check_release(release, version)
    tag = winget.release_tag(version)
    if not dry_run:
        for name in ('GH_TOKEN', 'WINGET_CREATE_GITHUB_TOKEN'):
            if not os.environ.get(name):
                raise PublishError(f'set {name} (docs/releasing.md › Windows)')
        if sys.platform != 'win32':
            raise PublishError('wingetcreate runs on Windows')
        existing = gh('release', 'view', tag, '-R', winget.GITHUB, '--json', 'assets', '--jq', '.assets[].name',
                      check=False)
        has_release = existing.returncode == 0
        if installer.name in existing.stdout.split():
            raise PublishError(f'Bay {version} for Windows is already published ({tag})')
    manifests = winget.write(installer, version, release / 'winget')
    if dry_run:
        print(f'Dry run: nothing uploaded. For {tag}: {installer.name}, {checksum.name}. For winget:')
        for path in sorted(manifests.iterdir()):
            print(f'  {path.name}')
        return
    if not has_release:
        create_release(tag, version, release)
    gh('release', 'upload', tag, '-R', winget.GITHUB, str(installer), str(checksum))
    if winget_has(version):
        print(f'winget-pkgs already has {winget.IDENTIFIER} {version}')
        return
    with tempfile.TemporaryDirectory() as directory:
        tool = wingetcreate(directory)
        title = f'New version: {winget.IDENTIFIER} version {version}'
        result = subprocess.run([str(tool), 'submit', '--no-open', '--prtitle', title, str(manifests)])
        if result.returncode:
            raise PublishError(f'wingetcreate submit exited with {result.returncode}')
    print(f'Published Bay {version} for Windows')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--release', required=True, help="package.ps1's output folder")
    parser.add_argument('--version', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        publish(args.release, args.version, args.dry_run)
    except (OSError, ValueError, PublishError) as error:
        sys.exit(f'publish: {error}')


if __name__ == '__main__':
    main()
