"""winget manifests and the Windows publish step."""
from pathlib import Path
import contextlib
import hashlib
import io
import re
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publish
import winget

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / '.github/workflows/windows-build.yml'

try:
    import yaml
except ImportError:
    yaml = None


def installer(directory, version='1.7.0', data=b'fixture installer'):
    path = Path(directory) / f'Bay-{version}-windows-x64-setup.exe'
    path.write_bytes(data)
    return path


def job(name):
    source = WORKFLOW.read_text()
    match = re.search(r'^  ' + re.escape(name) + r':\n(.*?)(?=^  [a-z]+:\n|\Z)', source, re.M | re.S)
    if not match:
        raise AssertionError(f'Missing workflow job: {name}')
    return match.group(1)


class ManifestTests(unittest.TestCase):
    def write(self, directory):
        output = winget.write(installer(directory), '1.7.0', Path(directory) / 'winget', release_date='2026-11-21')
        return {path.name: path.read_text() for path in output.iterdir()}

    def test_product_code_is_the_installers_uninstall_key(self):
        guid = re.search(r'^AppId=\{\{([0-9A-F-]+)\}$', (REPO / 'packaging/windows/Bay.iss').read_text(), re.M)[1]
        self.assertEqual(winget.product_code(), '{' + guid + '}_is1')

    def test_apps_and_features_name_matches_the_installer(self):
        script = (REPO / 'packaging/windows/Bay.iss').read_text()
        self.assertIn('\nUninstallDisplayName=Bay\n', script)
        self.assertIn('\nAppPublisher=Bay\n', script)
        with tempfile.TemporaryDirectory() as directory:
            text = self.write(directory)['BayBrowser.Bay.installer.yaml']
        self.assertIn('- DisplayName: Bay\n  Publisher: Bay\n', text)

    def test_writes_the_three_manifests_for_the_release_download(self):
        with tempfile.TemporaryDirectory() as directory:
            files = self.write(directory)
        self.assertEqual(sorted(files), ['BayBrowser.Bay.installer.yaml', 'BayBrowser.Bay.locale.en-US.yaml',
                                         'BayBrowser.Bay.yaml'])
        digest = hashlib.sha256(b'fixture installer').hexdigest().upper()
        text = files['BayBrowser.Bay.installer.yaml']
        self.assertIn('  InstallerUrl: https://github.com/krishkalaria12/bay/releases/download/windows-v1.7.0/'
                      'Bay-1.7.0-windows-x64-setup.exe\n', text)
        self.assertIn(f'  InstallerSha256: {digest}\n', text)
        self.assertIn("\nProductCode: '{C345791D-67B8-4C97-AB2B-D6DDE1F93B72}_is1'\n", text)
        self.assertIn('\nInstallerType: inno\nScope: user\n', text)
        self.assertIn('\nReleaseDate: 2026-11-21\n', text)
        self.assertIn('ReleaseNotesUrl: https://github.com/krishkalaria12/bay/releases/tag/windows-v1.7.0\n',
                      files['BayBrowser.Bay.locale.en-US.yaml'])
        for name, kind in (('BayBrowser.Bay.yaml', 'version'), ('BayBrowser.Bay.installer.yaml', 'installer'),
                           ('BayBrowser.Bay.locale.en-US.yaml', 'defaultLocale')):
            self.assertTrue(files[name].startswith(
                f'# yaml-language-server: $schema=https://aka.ms/winget-manifest.{kind}.{winget.MANIFEST_VERSION}.schema.json\n\n'))
            self.assertIn(f'\nManifestType: {kind}\nManifestVersion: {winget.MANIFEST_VERSION}\n', files[name])

    @unittest.skipUnless(yaml, 'PyYAML reads the manifests back')
    def test_manifests_read_back_as_written(self):
        with tempfile.TemporaryDirectory() as directory:
            files = self.write(directory)
        locale = yaml.safe_load(files['BayBrowser.Bay.locale.en-US.yaml'])
        self.assertEqual(locale['PackageVersion'], '1.7.0')
        self.assertEqual(locale['Description'], winget.DESCRIPTION)
        self.assertEqual(locale['Tags'], list(winget.TAGS))
        installer_manifest = yaml.safe_load(files['BayBrowser.Bay.installer.yaml'])
        self.assertEqual(installer_manifest['Installers'][0]['Architecture'], 'x64')
        self.assertEqual(installer_manifest['FileExtensions'], ['htm', 'html', 'pdf'])

    def test_scalars_that_yaml_would_retype_are_quoted(self):
        for value in ('1.7', '42', 'yes', 'No', 'null', 'a: b', '{x}', '#tag', 'trailing '):
            with self.subTest(value=value):
                self.assertEqual(winget.scalar(value), "'" + value + "'")
        self.assertEqual(winget.scalar("it's"), "it's")
        self.assertEqual(winget.scalar('1.7.0'), '1.7.0')
        self.assertEqual(winget.scalar('https://baybrowser.in'), 'https://baybrowser.in')

    def test_refuses_another_version_or_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = installer(directory)
            for version in ('1.7', '1.7.0.1', 'v1.7.0'):
                with self.subTest(version=version), self.assertRaisesRegex(ValueError, 'X.Y.Z'):
                    winget.write(path, version, Path(directory) / 'out')
            with self.assertRaisesRegex(ValueError, "isn't Bay 1.8.0's installer"):
                winget.write(path, '1.8.0', Path(directory) / 'out')

    def test_replaces_an_earlier_versions_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'winget'
            output.mkdir()
            (output / 'BayBrowser.Bay.stale.yaml').write_text('old')
            winget.write(installer(directory), '1.7.0', output)
            self.assertNotIn('BayBrowser.Bay.stale.yaml', [path.name for path in output.iterdir()])


class PublishTests(unittest.TestCase):
    def release(self, directory, recorded=None):
        path = installer(directory)
        digest = recorded or hashlib.sha256(path.read_bytes()).hexdigest()
        Path(f'{path}.sha256').write_text(f'{digest}  {path.name}\n', encoding='ascii')
        return Path(directory)

    def test_dry_run_writes_the_manifests_and_uploads_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            release = self.release(directory)
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                publish.publish(release, '1.7.0', dry_run=True)
            self.assertIn('Dry run: nothing uploaded', output.getvalue())
            self.assertEqual(len(list((release / 'winget').glob('*.yaml'))), 3)

    def test_refuses_a_checksum_for_another_file(self):
        with tempfile.TemporaryDirectory() as directory:
            release = self.release(directory, recorded='0' * 64)
            with self.assertRaisesRegex(publish.PublishError, "doesn't match"):
                publish.publish(release, '1.7.0', dry_run=True)

    def test_refuses_a_release_without_the_installer(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(publish.PublishError, 'has no'):
            publish.publish(directory, '1.7.0', dry_run=True)

    def publish_with(self, directory, assets):
        """Runs a real publish against a stand-in gh, returning its calls; assets is None for no release yet."""
        calls = []

        def gh(*args, check=True):
            calls.append(args)
            if args[:2] == ('release', 'view'):
                if assets is None:
                    return mock.Mock(returncode=1, stdout='', stderr='release not found')
                return mock.Mock(returncode=0, stdout=''.join(f'{name}\n' for name in assets), stderr='')
            return mock.Mock(returncode=0, stdout='', stderr='')

        environment = {'GH_TOKEN': 'x', 'WINGET_CREATE_GITHUB_TOKEN': 'x', 'GITHUB_SHA': 'abc123'}
        with mock.patch.object(publish, 'gh', gh), mock.patch.object(publish, 'winget_has', return_value=True), \
                mock.patch.object(publish.sys, 'platform', 'win32'), mock.patch.dict(publish.os.environ, environment), \
                contextlib.redirect_stdout(io.StringIO()):
            publish.publish(self.release(directory), '1.7.0', dry_run=False)
        return calls

    def test_creates_its_own_release_that_isnt_latest(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = self.publish_with(directory, None)
        create = next(call for call in calls if call[:2] == ('release', 'create'))
        self.assertEqual(create[2], 'windows-v1.7.0')
        self.assertIn('--latest=false', create)
        self.assertEqual(create[create.index('--target') + 1], 'abc123')
        self.assertEqual(create[create.index('--title') + 1], 'Bay 1.7.0 for Windows')
        upload = next(call for call in calls if call[:2] == ('release', 'upload'))
        self.assertEqual(upload[2], 'windows-v1.7.0')
        self.assertNotIn('--clobber', upload)

    def test_adds_to_an_existing_release_without_recreating_it(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = self.publish_with(directory, ['notes.txt'])
        self.assertFalse([call for call in calls if call[:2] == ('release', 'create')])
        self.assertTrue([call for call in calls if call[:2] == ('release', 'upload')])

    def test_never_replaces_a_published_installer(self):
        with tempfile.TemporaryDirectory() as directory, \
                self.assertRaisesRegex(publish.PublishError, r'already published \(windows-v1\.7\.0\)'):
            self.publish_with(directory, ['Bay-1.7.0-windows-x64-setup.exe'])

    def test_wingetcreate_is_pinned(self):
        self.assertRegex(publish.WINGETCREATE_URL, r'/releases/download/v[\d.]+/wingetcreate\.exe$')
        self.assertRegex(publish.WINGETCREATE_SHA256, r'^[0-9a-f]{64}$')


class WorkflowTests(unittest.TestCase):
    def test_a_release_packages_its_version_and_needs_the_launch_check(self):
        installer_job = job('installer')
        self.assertIn("CHANNEL: ${{ needs.plan.outputs.publish == 'true' && 'stable' || 'beta' }}", installer_job)
        self.assertIn('package.ps1 -Version $env:VERSION -Channel $env:CHANNEL -Unsigned', installer_job)
        self.assertIn("continue-on-error: ${{ needs.plan.outputs.publish != 'true' }}", installer_job)

    def test_publish_runs_only_for_a_release_with_the_token(self):
        publish_job = job('publish')
        self.assertIn("if: needs.plan.outputs.publish == 'true'", publish_job)
        self.assertIn('WINGET_CREATE_GITHUB_TOKEN: ${{ secrets.WINGET_TOKEN }}', publish_job)
        self.assertIn('python scripts/windows/publish.py --release dist/windows --version $env:VERSION', publish_job)
        plan = job('plan')
        self.assertIn('gh release view "windows-v$VERSION"', plan)
        self.assertIn('grep -qxF "Bay-$VERSION-windows-x64-setup.exe"', plan)
        self.assertIn("HAS_WINGET_TOKEN: ${{ secrets.WINGET_TOKEN != '' }}", plan)


if __name__ == '__main__':
    unittest.main()
