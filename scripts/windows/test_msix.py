"""The Microsoft Store package: its manifest, logos and place in the Windows build."""
from pathlib import Path
import importlib.util
import re
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'engine/patches'))
import msix
import series

REPO = Path(__file__).resolve().parents[2]
WORKFLOW = REPO / '.github/workflows/windows-build.yml'
NAMESPACES = {
    'm': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10',
    'uap': 'http://schemas.microsoft.com/appx/manifest/uap/windows10',
    'uap3': 'http://schemas.microsoft.com/appx/manifest/uap/windows10/3',
    'desktop': 'http://schemas.microsoft.com/appx/manifest/desktop/windows10',
    'com': 'http://schemas.microsoft.com/appx/manifest/com/windows10',
    'rescap': 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities',
}


def parse(**identity):
    values = {'name': 'BayBrowser.Bay', 'publisher': 'CN=BayBrowser', 'display_name': 'Bay'} | identity
    text = msix.manifest('1.7.0', values['name'], values['publisher'], values['display_name'], msix.toast_activator())
    return ElementTree.fromstring(text.encode())


def make_assets():
    spec = importlib.util.spec_from_file_location('make_assets', REPO / 'packaging/windows/msix/make-assets.py')
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except ImportError:
        return None
    return module


class ManifestTests(unittest.TestCase):
    def test_store_versions_end_in_zero(self):
        self.assertEqual(msix.package_version('1.7.0'), '1.7.0.0')
        self.assertEqual(msix.package_version('0.1.0.42'), '0.1.0.42')
        for version in ('1.7', '1.7.0.0.1', '1.7.x', '1.70000.0'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                msix.package_version(version)

    def test_identity(self):
        identity = parse().find('m:Identity', NAMESPACES)
        self.assertEqual(identity.attrib, {'Name': 'BayBrowser.Bay', 'Publisher': 'CN=BayBrowser', 'Version': '1.7.0.0',
                                           'ProcessorArchitecture': 'x64'})
        partner_center = 'CN=12345678-90AB-CDEF-1234-567890ABCDEF'
        self.assertEqual(parse(publisher=partner_center).find('m:Identity', NAMESPACES).get('Publisher'), partner_center)
        self.assertEqual(parse(display_name='Bay & Co').find('m:Properties/m:PublisherDisplayName', NAMESPACES).text,
                         'Bay & Co')
        for field, value in (('name', 'a b'), ('name', 'ab'), ('publisher', 'BayBrowser'), ('display_name', ' ')):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                parse(**{field: value})

    def test_runs_bay_with_full_trust(self):
        root = parse()
        application = root.find('m:Applications/m:Application', NAMESPACES)
        self.assertEqual(application.get('Executable'), 'Bay.exe')
        self.assertEqual(application.get('EntryPoint'), 'Windows.FullTrustApplication')
        self.assertIsNotNone(root.find("m:Capabilities/rescap:Capability[@Name='runFullTrust']", NAMESPACES))

    def test_web_links_and_files_open_as_one_argument(self):
        extensions = parse().find('m:Applications/m:Application/m:Extensions', NAMESPACES)
        protocols = extensions.findall('uap3:Extension/uap3:Protocol', NAMESPACES)
        self.assertEqual([protocol.get('Name') for protocol in protocols], ['http', 'https'])
        associations = extensions.findall('uap:Extension/uap3:FileTypeAssociation', NAMESPACES)
        types = [[kind.text for kind in association.findall('uap:SupportedFileTypes/uap:FileType', NAMESPACES)]
                 for association in associations]
        self.assertEqual(types, [['.htm', '.html'], ['.pdf']])
        installer = (REPO / 'packaging/windows/Bay.iss').read_text()
        self.assertIn('--single-argument ""%1""', installer)
        for element in protocols + associations:
            self.assertEqual(element.get('Parameters'), '--single-argument "%1"')

    def test_shortcuts_reach_bay_through_the_alias_the_engine_names(self):
        extensions = parse().find('m:Applications/m:Application/m:Extensions', NAMESPACES)
        alias = extensions.find('uap3:Extension/uap3:AppExecutionAlias/desktop:ExecutionAlias', NAMESPACES)
        self.assertEqual(alias.get('Alias'), 'baybrowser.exe')
        patch = (REPO / 'engine/patches/chromium-bay-msix-win.patch').read_text()
        self.assertIn('FILE_PATH_LITERAL("baybrowser.exe")', patch)
        # The engine names the package's app by the manifest's Application Id.
        application = parse().find('m:Applications/m:Application', NAMESPACES)
        self.assertEqual(application.get('Id'), 'Bay')
        self.assertIn('(<package family name>!Bay)', patch)

    def test_notifications_activate_the_installers_helper(self):
        clsid = re.search(r'AppUserModelToastActivatorCLSID: "([0-9A-F-]+)"',
                          (REPO / 'packaging/windows/Bay.iss').read_text())[1]
        extensions = parse().find('m:Applications/m:Application/m:Extensions', NAMESPACES)
        toast = extensions.find('desktop:Extension/desktop:ToastNotificationActivation', NAMESPACES)
        self.assertEqual(toast.get('ToastActivatorCLSID'), clsid)
        server = extensions.find('com:Extension/com:ComServer/com:ExeServer', NAMESPACES)
        self.assertEqual(server.get('Executable'), 'notification_helper.exe')
        self.assertEqual(server.find('com:Class', NAMESPACES).get('Id'), clsid)

    def test_every_logo_has_each_scale(self):
        assets = make_assets()
        root = parse()
        names = {root.find('m:Properties/m:Logo', NAMESPACES).text}
        for element in root.iter():
            names.update(value for key, value in element.attrib.items() if key.endswith('Logo'))
        files = {path.name for path in msix.ASSETS.iterdir()}
        for name in sorted(names):
            stem = Path(name.replace('\\', '/')).stem
            for scale in (100, 200, 400):
                self.assertIn(f'{stem}.scale-{scale}.png', files)
        for size in (16, 24, 32, 48, 256):
            self.assertIn(f'Square44x44Logo.targetsize-{size}_altform-unplated.png', files)
        if assets:
            expected = {f'{name}.scale-{scale}.png' for name, _, _ in assets.LOGOS for scale in assets.SCALES}
            self.assertLessEqual(expected, files)


class PrepareTests(unittest.TestCase):
    def test_writes_the_layout_and_drops_the_updater(self):
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            for name in ('Bay.exe', 'notification_helper.exe', 'update.ps1', 'update-config.json'):
                (stage / name).write_text('fixture')
            manifest = msix.prepare(stage, '1.7.0', 'BayBrowser.Bay', 'CN=BayBrowser', 'Bay')
            self.assertEqual(manifest, stage / 'AppxManifest.xml')
            self.assertIn(b'\r\n', manifest.read_bytes())
            self.assertTrue((stage / 'Assets/StoreLogo.scale-100.png').is_file())
            self.assertFalse((stage / 'update.ps1').exists())
            self.assertTrue((stage / 'update-config.json').exists())

    def test_refuses_a_folder_without_the_app(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, 'no staged Bay.exe'):
            msix.prepare(directory, '1.7.0', 'BayBrowser.Bay', 'CN=BayBrowser', 'Bay')


class EnginePatchTests(unittest.TestCase):
    def added(self):
        patch = (REPO / 'engine/patches/chromium-bay-msix-win.patch').read_text()
        return '\n'.join(line[1:] for line in patch.splitlines() if line.startswith('+') and not line.startswith('+++'))

    def test_windows_only_after_the_branding_it_builds_on(self):
        steps = [step.name for step in series.read_series('win')]
        self.assertLess(steps.index('chromium-bay-branding-win.patch'), steps.index('chromium-bay-msix-win.patch'))
        for platform in ('mac', 'linux'):
            self.assertNotIn('chromium-bay-msix-win.patch', [step.name for step in series.read_series(platform)])

    def test_every_change_waits_for_a_package_identity(self):
        added = self.added()
        # One lookup each in chrome_elf's data folder, installer/util and the shortcut helper; none are imports.
        self.assertEqual(added.count('::GetProcAddress(::GetModuleHandleW(L"kernel32.dll"),'), 3)
        self.assertIn('IsBayPackage() ? L"Store User Data" : L"User Data"', added)
        self.assertIn('return package_id.empty() ? app_id : package_id;', added)
        self.assertIn('bool activator_registered = packaged || IsToastActivatorRegistered();', added)
        self.assertIn('IsPackageProgId(current_app.get())', added)
        self.assertIn('L"ms-settings:defaultapps?registeredAUMID="', added)


class BuildTests(unittest.TestCase):
    def test_package_script_has_an_msix_mode_that_the_store_signs(self):
        script = (REPO / 'scripts/windows/package.ps1').read_text()
        self.assertIn('[switch]$Msix', script)
        self.assertIn('if ($Msix) { $Unsigned = $true }', script)
        self.assertIn("msix.py') --stage $stage --version $Version", script)
        self.assertLess(script.index('makepri new'), script.index('makeappx pack'))

    def test_the_build_packs_it_without_risking_the_installer(self):
        workflow = WORKFLOW.read_text()
        step = workflow[workflow.index('- name: Package for the Microsoft Store'):workflow.index('\n  publish:\n')]
        self.assertIn('continue-on-error: true', step)
        self.assertIn('package.ps1 -Version $env:VERSION -Msix -OutputDirectory dist/windows-msix', step)
        self.assertIn('sideload-msix.ps1 -Package', step)
        self.assertIn("if: steps.msix.outcome == 'success'", step)
        self.assertLess(workflow.index('name: bay-windows-installer'), workflow.index('name: Package for the Microsoft Store'))


if __name__ == '__main__':
    unittest.main()
